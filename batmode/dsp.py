"""Continuous Doppler sensing, independent of audio devices and the web server.

Signals are relative to the transmitted carrier. Calibration estimates a separate
noise distribution for every FFT bin; no gesture is inferred from volume alone.
This measures radial motion, not a hand's identity or absolute position.
"""

import numpy as np

FS = 48000
WINDOW = 8192
HOP = 1024
CANDIDATES = (18375.0, 18750.0, 19125.0, 19500.0)


class Doppler:
    def __init__(self, frequency=19125.0, sensitivity=8.0):
        self.frequency = frequency
        self.sensitivity = sensitivity
        n = np.arange(WINDOW)
        # Four-term Blackman-Harris: suppress the direct carrier's sidelobes.
        a = 2 * np.pi * n / (WINDOW - 1)
        self.window = .35875 - .48829 * np.cos(a) + .14128 * np.cos(2*a) - .01168 * np.cos(3*a)
        frequencies = np.fft.rfftfreq(WINDOW, 1 / FS)
        self.indices = np.flatnonzero(np.abs(frequencies - frequency) <= 350)
        self.offsets = frequencies[self.indices] - frequency
        self.lower = (self.offsets < -28) & (self.offsets > -310)
        self.upper = (self.offsets > 28) & (self.offsets < 310)
        self.center = np.abs(self.offsets) < 12
        self.baseline = None
        self.spread = None
        self.direction = 0
        self.streak = 0
        self.velocity = 0.0

    def spectrum(self, samples):
        if len(samples) != WINDOW:
            raise ValueError(f"Expected {WINDOW} audio samples")
        magnitude = np.abs(np.fft.rfft(samples * self.window)) * 2 / self.window.sum()
        db = 20 * np.log10(np.maximum(magnitude[self.indices], 1e-12))
        carrier = float(db[self.center].max())
        floor = float(np.median(db[self.lower | self.upper]))
        return {
            "relative": db - carrier,
            "carrier_db": carrier,
            "snr_db": carrier - floor,
            "rms": float(np.sqrt(np.mean(samples ** 2))),
            "clipped": bool(np.max(np.abs(samples)) >= .985),
        }

    def calibrate(self, spectra):
        if len(spectra) < 12:
            raise ValueError("Calibration needs at least 12 quiet frames")
        frames = np.array([s["relative"] for s in spectra])
        self.baseline = np.median(frames, axis=0)
        self.spread = np.maximum(1.5, 1.4826 * np.median(np.abs(frames - self.baseline), axis=0))
        self.reset_motion()

    def reset_motion(self):
        self.direction = self.streak = 0
        self.velocity = 0.0

    def analyze(self, spectrum, probe=True):
        rel = spectrum["relative"]
        healthy = spectrum["snr_db"] > 16 and spectrum["carrier_db"] > -85 and not spectrum["clipped"]
        result = {
            "bins": np.round(np.clip(rel, -100, 6), 1).tolist(),
            "offsets": np.round(self.offsets, 1).tolist(),
            "carrier_db": round(spectrum["carrier_db"], 1),
            "snr_db": round(spectrum["snr_db"], 1),
            "clipped": spectrum["clipped"],
            "signal_ok": bool(healthy),
            "lower": 0.0, "upper": 0.0, "velocity": 0.0,
            "direction": "still", "confidence": 0.0,
        }
        if self.baseline is None or not healthy or not probe:
            self.reset_motion()
            return result

        # Require a cluster of bins above the measured idle spectrum, preventing
        # an isolated random noise bin from steering the scene.
        delta = np.convolve(rel - self.baseline - self.spread, [.25, .5, .25], mode="same")
        lower = float(delta[self.lower].max())
        upper = float(delta[self.upper].max())
        result.update(lower=round(max(0, lower), 1), upper=round(max(0, upper), 1))
        winner = 1 if upper > lower else -1
        mask = self.upper if winner > 0 else self.lower
        peak_index = np.flatnonzero(mask)[np.argmax(delta[mask])]
        strength = max(lower, upper)
        active = strength > self.sensitivity and abs(upper - lower) > 3 and rel[peak_index] > -60
        direction = winner if active else 0
        self.streak = self.streak + 1 if direction == self.direction else 1
        self.direction = direction
        target = 0.0
        if active and self.streak >= 3:
            confidence = float(np.clip((strength - self.sensitivity) / 14, 0, 1))
            # This is an interaction rate, deliberately not a distance estimate.
            target = winner * float(np.clip(abs(self.offsets[peak_index]) / 100, .35, 1.6))
            result["confidence"] = round(confidence, 2)
        self.velocity = .55 * self.velocity + .45 * target if target else .35 * self.velocity
        if abs(self.velocity) < .045:
            self.velocity = 0.0
        result["velocity"] = round(self.velocity, 3)
        result["direction"] = "toward" if self.velocity > .1 else "away" if self.velocity < -.1 else "still"
        if not active:
            self.baseline += .001 * np.clip(rel - self.baseline, -2, 2)
        return result
