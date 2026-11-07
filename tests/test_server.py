import http.client
import json
import threading
import unittest

from batmode.audio import AudioEngine
from batmode.server import Server


class LocalServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server(("127.0.0.1", 0), AudioEngine())
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, method="GET", body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_initial_state_does_not_open_audio(self):
        status, headers, body = self.request("/api/state")
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(body)["running"])

    def test_local_page_serves_and_blocks_camera(self):
        status, headers, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Start sonar", body)
        self.assertIn("camera=()", headers["Permissions-Policy"])

    def test_other_origin_cannot_start_microphone(self):
        status, _, _ = self.request("/api/start", "POST", "{}", {"Origin": "https://example.com", "Content-Type": "application/json"})
        self.assertEqual(status, 403)
        self.assertFalse(self.server.engine.snapshot()["running"])

    def test_foreign_host_rejected(self):
        status, _, _ = self.request("/api/state", headers={"Host": "evil.example"})
        self.assertEqual(status, 403)

    def test_no_files_outside_static_directory(self):
        for path in ("/../server.py", "/%2e%2e/audio.py", "/pyproject.toml"):
            self.assertEqual(self.request(path)[0], 404)

    def test_invalid_configuration_returns_error(self):
        status, _, _ = self.request("/api/settings", "POST", '{"sensitivity":100}', {"Content-Type": "application/json"})
        self.assertEqual(status, 400)

    def test_probe_requires_live_ready_state(self):
        status, _, _ = self.request("/api/settings", "POST", '{"probe":true}', {"Content-Type": "application/json"})
        self.assertEqual(status, 400)

    def test_heartbeat_keeps_local_session_alive(self):
        status, _, _ = self.request("/api/heartbeat", "POST", '{}', {"Content-Type": "application/json"})
        self.assertEqual(status, 200)

    def test_byte_ranges_support_video_seeking(self):
        _, _, complete = self.request("/favicon.svg")
        status, headers, part = self.request("/favicon.svg", headers={"Range": "bytes=10-19"})
        self.assertEqual(status, 206)
        self.assertEqual(part, complete[10:20])
        self.assertEqual(headers["Content-Range"], f"bytes 10-19/{len(complete)}")
        status, _, suffix = self.request("/favicon.svg", headers={"Range": "bytes=-12"})
        self.assertEqual(status, 206)
        self.assertEqual(suffix, complete[-12:])

    def test_invalid_ranges_are_rejected(self):
        for value in ("bytes=999999-", "bytes=20-10", "bytes=-0", "bytes=a-b"):
            self.assertEqual(self.request("/favicon.svg", headers={"Range": value})[0], 416)

    def test_head_returns_metadata_without_body(self):
        status, headers, body = self.request("/favicon.svg", "HEAD")
        self.assertEqual(status, 200)
        self.assertGreater(int(headers["Content-Length"]), 0)
        self.assertEqual(body, b"")


if __name__ == "__main__":
    unittest.main()
