import http.server
import json
import pathlib
import subprocess
import tempfile
import threading
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]


class StatusHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.requests.append(dict(self.headers))
        mode = self.server.mode
        if mode == "redirect":
            self.send_response(302)
            self.send_header("Location", self.server.destination)
            self.end_headers()
            return
        self.send_response(503 if mode == "error" else 200)
        self.end_headers()
        if mode == "malformed":
            self.wfile.write(b"invalid JSON")
            return
        authenticated = (
            self.headers.get("x-api-key") == "fixture-value"
            and self.headers.get("x-teamcodex-status-identity") == "1"
        )
        rows = [{"name": "fixture-account"}] if authenticated else [{}]
        self.wfile.write(json.dumps({"accounts": rows}).encode())

    def log_message(self, *_):
        pass


def excerpt(source, start, end):
    return source.split(start, 1)[1].split(end, 1)[0]


class TeamClaudeStatusIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="teamclaude-identity-")
        cls.binary = pathlib.Path(cls.temp.name) / "status-test"
        main = (ROOT / "menubar/Sources/main.swift").read_text()
        shared = (ROOT / "menubar/Sources/TeamCodexPoolStatus.swift").read_text()
        helpers = "func tcString" + excerpt(main, "func tcString", "func tcArray")
        fetch = "func fetchTeamClaudeStatus" + excerpt(
            main, "func fetchTeamClaudeStatus", "func triggerTeamClaudeQuotaProbe"
        )
        transport = "func teamCodexStatusRequest" + excerpt(
            shared, "func teamCodexStatusRequest", "func loadTeamCodexPoolHealth"
        )
        # Stop at the loader's last statement so the slice stays inside loadTeamClaudeHealth()
        # (the first "let accounts =" after it now lives in parseTeamClaudeHealth).
        loader = excerpt(main, "func loadTeamClaudeHealth()", "return parseTeamClaudeHealth(")
        call = "let status = " + loader.split("let status = ", 1)[1]
        source = pathlib.Path(cls.temp.name) / "main.swift"
        source.write_text(
            "import Foundation\n" + helpers + transport + fetch
            + '\nlet port = Int(CommandLine.arguments[1])!\n'
            + 'let config: [String: Any]? = ["proxy": ["apiKey": CommandLine.arguments[2]]]\n'
            + call
            + '\nif let status {\n'
            + 'let data = try JSONSerialization.data(withJSONObject: status)\n'
            + 'print(String(decoding: data, as: UTF8.self))\n'
            + '} else { print("null") }\n'
        )
        subprocess.run(["swiftc", str(source), "-o", str(cls.binary)], check=True, timeout=600)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), StatusHandler)
        self.server.requests = []
        self.server.mode = "normal"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def fetch(self, key="fixture-value"):
        result = subprocess.run(
            [str(self.binary), str(self.server.server_port), key],
            capture_output=True, text=True, check=True, timeout=10,
        )
        return json.loads(result.stdout)

    def test_configured_key_restores_account_identity(self):
        self.assertEqual(self.fetch(), {"accounts": [{"name": "fixture-account"}]})

    def test_empty_key_does_not_send_identity_headers(self):
        self.assertEqual(self.fetch(""), {"accounts": [{}]})
        headers = {key.lower(): value for key, value in self.server.requests[0].items()}
        self.assertNotIn("x-api-key", headers)
        self.assertNotIn("x-teamcodex-status-identity", headers)

    def test_http_and_json_errors_return_nil(self):
        for mode in ["error", "malformed"]:
            with self.subTest(mode=mode):
                self.server.mode = mode
                self.assertIsNone(self.fetch())

    def test_redirect_does_not_forward_credentials(self):
        sink = http.server.ThreadingHTTPServer(("127.0.0.1", 0), StatusHandler)
        sink.requests = []
        sink.mode = "normal"
        thread = threading.Thread(target=sink.serve_forever, daemon=True)
        thread.start()
        try:
            self.server.mode = "redirect"
            self.server.destination = f"http://127.0.0.1:{sink.server_port}/unexpected"
            self.assertIsNone(self.fetch())
            self.assertEqual(len(self.server.requests), 1)
            self.assertEqual(sink.requests, [])
        finally:
            sink.shutdown()
            sink.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
