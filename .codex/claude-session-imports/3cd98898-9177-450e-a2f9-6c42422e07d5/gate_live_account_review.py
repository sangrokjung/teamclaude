import hashlib
import json
import unittest
from pathlib import Path
from urllib.request import HTTPRedirectHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[3]
SESSION_ID = "3cd98898-9177-450e-a2f9-6c42422e07d5"
CONFIG = Path("/Users/sangrok/.config/teamclaude.json")
STATUS_URL = "http://127.0.0.1:3456/teamclaude/status"
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
            ],
        )
        self.assertEqual(
            list(sensitive_keys({key: 1 for key in SAFE_USAGE_KEYS})),
            [],
        )

    def test_imported_handoff_and_live_status(self):
        handoff = ROOT / ".codex" / "claude-session-imports" / SESSION_ID / "handoff.md"
        self.assertTrue(handoff.is_file())
        self.assertIn(SESSION_ID, handoff.read_text())
        credential_state_before = {
            path: file_fingerprint(path) for path in IMMUTABLE_CREDENTIAL_PATHS
        }

        opener = build_opener(NoRedirectHandler())
        request = Request(STATUS_URL, method="GET")
        with opener.open(request, timeout=10) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.geturl(), STATUS_URL)
            status = json.load(response)

        self.assertEqual(list(sensitive_keys(status)), [])
        accounts = status["accounts"]
        active_count = sum(account.get("status") == "active" for account in accounts)
        error_count = sum(account.get("status") == "error" for account in accounts)
        self.assertEqual(len(accounts), 16)
        self.assertTrue(all(account.get("status") for account in accounts))
        self.assertEqual(active_count, 16)
        self.assertEqual(error_count, 0)
        for path, before in credential_state_before.items():
            self.assertTrue(
                file_fingerprint(path) == before,
                f"read-only status request changed credential/config file: {path}",
            )


if __name__ == "__main__":
    unittest.main()
