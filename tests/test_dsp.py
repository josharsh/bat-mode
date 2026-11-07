import unittest

import numpy as np

from batmode.dsp import Doppler, FS, WINDOW


class DopplerTests(unittest.TestCase):
    def setUp(self):
        self.rng = np.random.default_rng(1729)
        self.detector = Doppler()
        self.t = np.arange(WINDOW) / FS
        self.detector.calibrate([self.spectrum() for _ in range(60)])

    def spectrum(self, shift=0, amplitude=0, noise=.0001, carrier=.1):
        signal = carrier * np.sin(2 * np.pi * self.detector.frequency * self.t)
        if amplitude:
            signal += amplitude * np.sin(2 * np.pi * (self.detector.frequency + shift) * self.t + .43)
        signal += self.rng.normal(0, noise, WINDOW)
        return self.detector.spectrum(signal)

    def feed_motion(self, shift):
        return [self.detector.analyze(self.spectrum(shift, .002)) for _ in range(12)]

    def test_stationary_carrier_does_not_move(self):
        for _ in range(150):
            self.assertEqual(self.detector.analyze(self.spectrum())["velocity"], 0)

    def test_toward_and_away_have_opposite_velocity(self):
        toward = self.feed_motion(93.75)[-1]
        self.assertEqual(toward["direction"], "toward")
        self.assertGreater(toward["velocity"], .5)
        away = self.feed_motion(-93.75)[-1]
        self.assertEqual(away["direction"], "away")
        self.assertLess(away["velocity"], -.5)

    def test_release_freezes_quickly(self):
        self.feed_motion(93.75)
        for _ in range(5):
            result = self.detector.analyze(self.spectrum())
        self.assertEqual(result["velocity"], 0)

    def test_probe_off_cannot_drive_scene_even_with_motion(self):
        self.feed_motion(93.75)
        result = self.detector.analyze(self.spectrum(93.75, .002), probe=False)
        self.assertEqual(result["velocity"], 0)
        self.assertEqual(result["direction"], "still")
        self.assertTrue(len(result["bins"]) > 50)

    def test_silent_microphone_cannot_pass(self):
        result = self.detector.analyze(self.detector.spectrum(np.zeros(WINDOW)))
        self.assertFalse(result["signal_ok"])
        self.assertEqual(result["velocity"], 0)

    def test_volume_change_is_not_a_gesture(self):
        for _ in range(30):
            result = self.detector.analyze(self.spectrum(carrier=.2, noise=.0002))
            self.assertEqual(result["direction"], "still")

    def test_clipping_disables_motion(self):
        result = self.detector.analyze(self.spectrum(93.75, .2, carrier=1))
        self.assertTrue(result["clipped"])
        self.assertEqual(result["velocity"], 0)

    def test_no_calibration_cannot_drive(self):
        detector = Doppler()
        result = detector.analyze(self.spectrum(93.75, .002))
        self.assertEqual(result["velocity"], 0)

    def test_broadband_noise_does_not_choose_a_direction(self):
        outputs = [self.detector.analyze(self.spectrum(noise=.001)) for _ in range(80)]
        self.assertLessEqual(sum(abs(x["velocity"]) > .1 for x in outputs), 2)

    def test_not_enough_calibration_data_rejected(self):
        with self.assertRaises(ValueError):
            self.detector.calibrate([self.spectrum()])


if __name__ == "__main__":
    unittest.main()
