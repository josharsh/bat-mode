"""Loopback-only web UI and bounded, live-only signal stream."""

import argparse
import json
import mimetypes
import re
import signal
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .audio import AudioEngine

STATIC = Path(__file__).parent / "static"


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, engine):
        self.engine = engine
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if args and str(args[1] if len(args) > 1 else "").startswith("5"):
            super().log_message(fmt, *args)

    def valid_host(self):
        allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        return self.headers.get("Host") in allowed

    def response(self, code, body, kind="application/json", headers=None):
        content = json.dumps(body, allow_nan=False).encode() if kind == "application/json" else body
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.valid_host():
            return self.response(403, {"error": "This server is only available on localhost."})
        path = urlparse(self.path).path
        if path == "/api/state":
            return self.response(200, self.server.engine.snapshot())
        if path == "/api/devices":
            try:
                return self.response(200, self.server.engine.devices())
            except Exception as exc:
                return self.response(503, {"error": str(exc)})
        if path == "/api/events":
            if self.command == "HEAD":
                return self.response(405, {"error": "Use GET for the event stream"})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                while True:
                    state = self.server.engine.snapshot()
                    self.wfile.write(b"data: " + json.dumps(state, allow_nan=False).encode() + b"\n\n")
                    self.wfile.flush()
                    time.sleep(1 / 30)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            self.close_connection = True
            return
        file = (STATIC / ("index.html" if path == "/" else unquote(path).lstrip("/"))).resolve()
        if STATIC.resolve() not in file.parents or not file.is_file():
            return self.response(404, {"error": "Not found"})
        kind = mimetypes.guess_type(str(file))[0] or "application/octet-stream"
        content = file.read_bytes()
        headers = {"Accept-Ranges": "bytes"}
        requested = self.headers.get("Range")
        if requested:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested)
            size = len(content)
            start, end = 0, size - 1
            if match and any(match.groups()):
                left, right = match.groups()
                if left:
                    start = int(left)
                    end = min(int(right), size - 1) if right else size - 1
                else:
                    start = max(0, size - int(right))
            else:
                start = size
            if start >= size or end < start:
                return self.response(416, b"", kind, {**headers, "Content-Range": f"bytes */{size}"})
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
            return self.response(206, content[start:end + 1], kind, headers)
        return self.response(200, content, kind, headers)

    def do_POST(self):
        if not self.valid_host():
            return self.response(403, {"error": "Invalid host"})
        # Other websites cannot start local audio. Browser commands must originate
        # here; command-line clients may omit Origin but still send JSON.
        origin = self.headers.get("Origin")
        allowed = {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"}
        if origin and origin not in allowed:
            return self.response(403, {"error": "Commands must originate from the local demo."})
        if self.headers.get_content_type() != "application/json":
            return self.response(415, {"error": "Expected application/json"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 4096:
                return self.response(413, {"error": "Request too large"})
            payload = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(payload, dict):
                raise ValueError("Expected an object")
            path = urlparse(self.path).path
            engine = self.server.engine
            if path == "/api/start":
                engine.start(payload.get("input_device"), payload.get("output_device"), float(payload.get("level", .12)))
            elif path == "/api/stop":
                engine.stop()
            elif path == "/api/settings":
                engine.configure(payload)
            elif path == "/api/heartbeat":
                engine.touch()
            else:
                return self.response(404, {"error": "Unknown command"})
            self.response(200, engine.snapshot())
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self.response(400, {"error": str(exc)})
        except Exception as exc:
            self.response(503, {"error": str(exc)})


def main():
    parser = argparse.ArgumentParser(description="Bat Mode · Rewind time with your hand")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser automatically")
    args = parser.parse_args()
    engine = AudioEngine()
    try:
        server = Server(("127.0.0.1", args.port), engine)
    except OSError as exc:
        parser.exit(1, f"Could not open port {args.port}: {exc}. Try --port {args.port + 1}\n")
    url = f"http://127.0.0.1:{server.server_port}"
    print(f"\n  BAT MODE\n  {url}\n\n  Open the page and click Start sonar.\n  Audio stays on your computer. Camera is never accessed.\n  Ctrl+C stops the server and sound.\n", flush=True)
    if not args.no_open:
        threading.Timer(.5, lambda: webbrowser.open(url)).start()

    def terminate(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, terminate)
    try:
        server.serve_forever(poll_interval=.2)
    except KeyboardInterrupt:
        pass
    finally:
        engine.stop()
        server.server_close()


if __name__ == "__main__":
    main()
