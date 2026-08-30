import hashlib
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.request import HTTPRedirectHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[3]
SESSION_ID = "3cd98898-9177-450e-a2f9-6c42422e07d5"
def runtime_config_path():
    configured = os.environ.get("TEAMCLAUDE_CONFIG")
    if configured:
        return Path(configured)
    config_dir = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    filename = (
        "teamcodex.json"
        if os.environ.get("TEAMCLAUDE_PROVIDER") == "codex"
        else "teamclaude.json"
    )
    return config_dir / filename


def runtime_status_url(config_path):
    try:
        config = json.loads(config_path.read_text())
    except (OSError, json.JSONDecodeError):
        config = {}
    proxy = config.get("proxy") if isinstance(config, dict) else None
    port = proxy.get("port") if isinstance(proxy, dict) else None
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        port = 3457 if config.get("provider") == "codex" else 3456
    return f"http://127.0.0.1:{port}/teamclaude/status"


CONFIG = runtime_config_path()
IMMUTABLE_CREDENTIAL_PATHS = (
    CONFIG,
    Path.home() / ".claude" / ".credentials.json",
    Path.home() / ".codex" / "auth.json",
    Path.home() / ".grok" / "auth.json",
)
SENSITIVE_KEYS = {
    "token",
    "authtoken",
    "idtoken",
    "bearertoken",
    "sessiontoken",
    "accesstoken",
    "refreshtoken",
    "credential",
    "credentials",
    "apikey",
    "xapikey",
    "authorization",
    "secret",
    "clientsecret",
    "password",
    "cookie",
    "bearer",
    "privatekey",
}
SAFE_USAGE_KEYS = {
    "codexusageat",
    "tokenslimit",
    "tokensremaining",
    "tokensreset",
    "totalinputtokens",
    "totaloutputtokens",
}


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def file_fingerprint(path):
    if not path.exists():
        return None
    stat = path.stat()
    return stat.st_mode, stat.st_size, hashlib.sha256(path.read_bytes()).digest()


def sensitive_keys(value):
    if isinstance(value, dict):
        for key, child in value.items():
            normalized_key = "".join(character for character in str(key).lower() if character.isalnum())
            sensitive_family = (
                normalized_key in SENSITIVE_KEYS
                or normalized_key not in SAFE_USAGE_KEYS
                and any(
                    marker in normalized_key
                    for marker in ("token", "apikey", "authorization", "credential")
                )
            )
            if sensitive_family:
                yield str(key)
            yield from sensitive_keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from sensitive_keys(child)


class LiveAccountReviewTests(unittest.TestCase):
    def test_runtime_config_path_matches_application_precedence(self):
        with patch.dict(os.environ, {"TEAMCLAUDE_CONFIG": "/tmp/explicit.json"}, clear=True):
            self.assertEqual(runtime_config_path(), Path("/tmp/explicit.json"))

        with patch.dict(
            os.environ,
            {"XDG_CONFIG_HOME": "/tmp/xdg", "TEAMCLAUDE_PROVIDER": "codex"},
            clear=True,
        ):
            self.assertEqual(runtime_config_path(), Path("/tmp/xdg/teamcodex.json"))

    def test_runtime_status_url_uses_configured_target(self):
        with TemporaryDirectory() as directory:
            config_path = Path(directory) / "proxy.json"
            config_path.write_text(json.dumps({"provider": "codex", "proxy": {"port": 41234}}))
            self.assertEqual(
                runtime_status_url(config_path),
                "http://127.0.0.1:41234/teamclaude/status",
            )

            config_path.write_text(json.dumps({"provider": "codex"}))
            self.assertEqual(
                runtime_status_url(config_path),
                "http://127.0.0.1:3457/teamclaude/status",
            )

    def test_sensitive_keys_rejects_nested_token_shapes(self):
        payload = {
            "safe": [
                {"token": "secret"},
                {"auth_token": "secret"},
                {"api-key": "secret"},
                {"x_api_key": "secret"},
                {"API Key": "secret"},
                {"access_tokens": "secret"},
                {"oauthTokenValue": "secret"},
                {"apiKeys": "secret"},
                {"authorizationHeader": "secret"},
                {"secret": "secret"},
                {"client_secret": "secret"},
                {"password": "secret"},
                {"cookie": "secret"},
                {"bearer": "secret"},
                {"private-key": "secret"},
            ]
        }
        self.assertEqual(
            list(sensitive_keys(payload)),
            [
                "token",
                "auth_token",
                "api-key",
                "x_api_key",
                "API Key",
                "access_tokens",
                "oauthTokenValue",
                "apiKeys",
                "authorizationHeader",
                "secret",
                "client_secret",
                "password",
                "cookie",
                "bearer",
                "private-key",
            ],
        )
        self.assertEqual(
            list(sensitive_keys({key: 1 for key in SAFE_USAGE_KEYS})),
            [],
        )

    def test_imported_handoff_and_live_status(self):
        handoff = ROOT / "docs" / "agent-handoffs" / "current.md"
        self.assertTrue(handoff.is_file())
        self.assertIn(SESSION_ID, handoff.read_text())
        credential_state_before = {
            path: file_fingerprint(path) for path in IMMUTABLE_CREDENTIAL_PATHS
        }

        opener = build_opener(NoRedirectHandler())
        status_url = runtime_status_url(CONFIG)
        request = Request(status_url, method="GET")
        with opener.open(request, timeout=10) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.geturl(), status_url)
            status = json.load(response)

        self.assertEqual(list(sensitive_keys(status)), [])
        accounts = status["accounts"]
        active_count = sum(account.get("status") == "active" for account in accounts)
        error_count = sum(account.get("status") == "error" for account in accounts)
        self.assertGreater(len(accounts), 0)
        self.assertTrue(all(account.get("status") for account in accounts))
        self.assertEqual(active_count, len(accounts))
        self.assertEqual(error_count, 0)
        for path, before in credential_state_before.items():
            self.assertTrue(
                file_fingerprint(path) == before,
                f"read-only status request changed credential/config file: {path}",
            )


if __name__ == "__main__":
    unittest.main()
