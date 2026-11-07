"""Explicitly started duplex audio. No recording, cloud calls, or camera access."""

import threading
import time
from collections import deque

import numpy as np
import sounddevice as sd

from .dsp import CANDIDATES, Doppler, FS, HOP, WINDOW


class AudioEngine:
    def __init__(self):
        self.lock = threading.RLock()
        self.control_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.last_client = time.monotonic()
        self.frequency = CANDIDATES[2]
        self.level = .12
        self.probe = True
        self.sensitivity = 8.0
        self.recalibrate = False
        self.skip_check = False
        self.state = self.idle_state()

    @staticmethod
    def idle_state():
        return {"phase": "idle", "message": "Your hand is the remote.", "running": False,
                "velocity": 0, "direction": "still", "probe": False, "verified": False,
                "bins": [], "offsets": [], "snr_db": 0, "carrier_db": -120,
                "lower": 0, "upper": 0, "progress": 0, "signal_ok": False,
                "frequency": 19125, "sensitivity": 8, "audio_warnings": 0}

    def snapshot(self):
        with self.lock:
            return dict(self.state)

    def update(self, **values):
        with self.lock:
            self.state.update(values, updated_at=time.time())

    def touch(self):
        self.last_client = time.monotonic()

    @staticmethod
    def devices():
        devices = sd.query_devices()
        def pick(kind):
            key = "max_input_channels" if kind == "input" else "max_output_channels"
            fallback = int(sd.default.device[0 if kind == "input" else 1])
            eligible = [(i, d) for i, d in enumerate(devices) if d[key] > 0]
            for i, d in eligible:
                if "macbook" in d["name"].lower() or "built-in" in d["name"].lower():
                    return i
            return fallback
        return {"inputs": [{"id": i, "name": d["name"]} for i, d in enumerate(devices) if d["max_input_channels"]],
                "outputs": [{"id": i, "name": d["name"]} for i, d in enumerate(devices) if d["max_output_channels"]],
                "default_input": pick("input"), "default_output": pick("output")}

    def start(self, input_device=None, output_device=None, level=.12):
        with self.control_lock:
            self._stop()
            if not np.isfinite(level) or not .01 <= level <= .25:
                raise ValueError("Tone level must be between 0.01 and 0.25")
            defaults = self.devices()
            input_device = defaults["default_input"] if input_device is None else int(input_device)
            output_device = defaults["default_output"] if output_device is None else int(output_device)
            sd.check_input_settings(device=input_device, channels=1, samplerate=FS, dtype="float32")
            sd.check_output_settings(device=output_device, channels=1, samplerate=FS, dtype="float32")
            self.level, self.probe = level, True
            self.recalibrate = self.skip_check = False
            self.stop_event.clear()
            self.touch()
            self.update(phase="starting", running=True, message="Opening your speakers and microphone…",
                        verified=False, velocity=0, direction="still", probe=True,
                        input_name=sd.query_devices(input_device)["name"],
                        output_name=sd.query_devices(output_device)["name"])
            self.thread = threading.Thread(target=self._run, args=(input_device, output_device), daemon=True)
            self.thread.start()

    def _stop(self):
        self.stop_event.set()
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=4)
            if self.thread.is_alive():
                raise RuntimeError("Audio is still stopping; try again in a moment.")
        self.thread = None
        self.probe = False
        self.update(**self.idle_state())

    def stop(self):
        with self.control_lock:
            self._stop()

    def configure(self, payload):
        if "sensitivity" in payload:
            value = float(payload["sensitivity"])
            if not np.isfinite(value) or not 4 <= value <= 20:
                raise ValueError("Motion threshold must be between 4 and 20 dB")
            self.sensitivity = value
            self.update(sensitivity=value)
        if "probe" in payload:
            if not isinstance(payload["probe"], bool):
                raise ValueError("probe must be true or false")
            if self.snapshot()["phase"] not in ("ready", "probe_off"):
                raise ValueError("Finish calibration before switching the probe")
            self.probe = payload["probe"]
        if payload.get("recalibrate"):
            if not self.snapshot()["running"]:
                raise ValueError("Start sonar before recalibrating")
            self.probe = True
            self.recalibrate = True
        if payload.get("skip_check"):
            self.skip_check = True

    def _run(self, input_device, output_device):
        buffer = deque(maxlen=WINDOW // HOP + 2)
        buffer_lock = threading.Lock()
        phase = 0.0
        emitted_level = 0.0
        samples_received = 0
        warnings = 0

        def callback(indata, outdata, frames, timing, status):
            nonlocal phase, emitted_level, samples_received, warnings
            target = self.level if self.probe and not self.stop_event.is_set() else 0.0
            ramp = np.linspace(emitted_level, target, frames)
            emitted_level = target
            angles = phase + (2 * np.pi * self.frequency / FS) * np.arange(frames)
            outdata[:, 0] = ramp * np.sin(angles)
            phase = (phase + 2 * np.pi * self.frequency / FS * frames) % (2 * np.pi)
            with buffer_lock:
                buffer.append(indata[:, 0].copy())
                samples_received += frames
                warnings += bool(status)

        try:
            with sd.Stream(samplerate=FS, blocksize=HOP, channels=(1, 1), dtype="float32",
                           device=(input_device, output_device), latency="low", callback=callback) as stream:
                self.update(latency_ms=round(sum(stream.latency) * 1000), sample_rate=FS,
                            window_ms=round(WINDOW / FS * 1000))
                scan_index = -1
                scan_scores = []
                collected = []
                stage = "scan"
                stage_start = time.monotonic()
                detector = Doppler()
                previous_samples = 0
                checked = {"toward": False, "away": False}
                check_count = 0
                probe_was_on = True
                probe_resume_at = 0
                while not self.stop_event.wait(.012):
                    now = time.monotonic()
                    if now - self.last_client > 8:
                        self.update(phase="idle", running=False, velocity=0, probe=False,
                                    message="Stopped because the demo disconnected.")
                        break
                    if not stream.active:
                        raise RuntimeError("The audio device disconnected. Reconnect it and start again.")
                    if self.recalibrate:
                        self.recalibrate = False
                        self.skip_check = False
                        stage, scan_index = "scan", -1
                        scan_scores, collected = [], []
                        checked = {"toward": False, "away": False}
                        check_count = 0
                        stage_start = now
                        self.update(verified=False, velocity=0, direction="still")
                    if stage == "scan" and (scan_index == -1 or now - stage_start > .65):
                        if scan_index >= 0:
                            score = float(np.median([s["snr_db"] if s["carrier_db"] > -85 else 0 for s in collected])) if collected else 0
                            scan_scores.append((score, self.frequency))
                        scan_index += 1
                        collected = []
                        stage_start = now
                        if scan_index < len(CANDIDATES):
                            self.frequency = CANDIDATES[scan_index]
                            detector = Doppler(self.frequency, self.sensitivity)
                            self.update(phase="scanning", message="Hold still. Finding the clearest echo…",
                                        progress=scan_index / len(CANDIDATES), frequency=self.frequency)
                        else:
                            best, self.frequency = max(scan_scores)
                            if best < 16:
                                raise RuntimeError("The probe is too weak. Select built-in speakers and microphone, use moderate system volume, and set macOS Mic Mode to Standard. Then try again.")
                            detector = Doppler(self.frequency, self.sensitivity)
                            stage = "baseline"
                            self.update(phase="baseline", progress=0, message="Stay still for two seconds. Learning the room…", frequency=self.frequency)
                    with buffer_lock:
                        if samples_received == previous_samples or sum(map(len, buffer)) < WINDOW:
                            continue
                        previous_samples = samples_received
                        audio = np.concatenate(buffer)[-WINDOW:]
                    spectrum = detector.spectrum(audio)
                    detector.sensitivity = self.sensitivity
                    elapsed = now - stage_start
                    if stage in ("scan", "baseline") and elapsed > .28:
                        collected.append(spectrum)
                    if stage == "baseline":
                        self.update(progress=min(1, elapsed / 2.4))
                        if elapsed > 2.4:
                            detector.calibrate(collected)
                            stage, stage_start = "toward", now
                            self.update(phase="toward", progress=0, message="Push your palm toward the screen, about 20–50 cm away.")
                    if self.probe and not probe_was_on:
                        probe_resume_at = now + .3
                        detector.reset_motion()
                    probe_was_on = self.probe
                    measurement = detector.analyze(spectrum, probe=self.probe and now >= probe_resume_at)
                    self.update(**measurement, frequency=self.frequency, probe=self.probe,
                                sensitivity=self.sensitivity, audio_warnings=warnings,
                                cpu_load=round(stream.cpu_load, 3))
                    if stage in ("toward", "away"):
                        check_count = check_count + 1 if measurement["direction"] == stage and elapsed > .5 else 0
                        self.update(progress=min(1, check_count / 4))
                        if check_count >= 4:
                            checked[stage] = True
                            if stage == "toward":
                                stage, stage_start, check_count = "away", now, 0
                                self.update(phase="away", progress=0, message="Now pull your hand back toward you.")
                            else:
                                stage = "ready"
                        if self.skip_check:
                            stage = "ready"
                        if stage == "ready":
                            detector.reset_motion()
                            self.update(phase="ready", verified=all(checked.values()), progress=1, velocity=0,
                                        checked=checked, message="Move your hand. Move through time.")
                        elif elapsed > 15:
                            self.update(message="Use a clear palm movement near the speakers. Adjust sensitivity, retry, or skip this check.")
                    elif stage == "ready":
                        self.update(phase="ready" if self.probe else "probe_off",
                                    message="Move your hand. Move through time." if self.probe else "Probe is off. The microphone is still measuring.")
        except Exception as exc:
            self.update(phase="error", running=False, velocity=0, direction="still", probe=False,
                        message=str(exc))
        finally:
            self.probe = False
            self.update(running=False, velocity=0, probe=False)
