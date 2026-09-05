import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
ENTRY = ROOT / "src" / "teamclaude.js"


class RemoveCliTests(unittest.TestCase):
    def test_teamclaude_uses_claude_fleet_inside_codex_environment(self):
        with tempfile.TemporaryDirectory(prefix="teamclaude-remove-") as directory:
            root = Path(directory)
            command = root / "teamclaude"
            claude_config = root / "teamclaude.json"
            codex_config = root / "teamcodex.json"
            command.symlink_to(ENTRY)

            def config(names):
                return {
                    "proxy": {"host": "127.0.0.1", "port": 65530, "apiKey": "test-key"},
                    "accounts": [
                        {"name": name, "type": "apikey", "apiKey": f"key-{name}"}
                        for name in names
                    ],
                }

            claude_config.write_text(json.dumps(config(["keeper", "yoon"])))
            codex = config(["codex-keeper"])
            codex["provider"] = "codex"
            codex_config.write_text(json.dumps(codex))
            env = {
                **os.environ,
                "XDG_CONFIG_HOME": directory,
                "TEAMCLAUDE_PROVIDER": "codex",
            }
            env.pop("TEAMCLAUDE_CONFIG", None)

            result = subprocess.run(
                [str(command), "remove", "yoon"],
                capture_output=True,
                env=env,
                text=True,
                timeout=15,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Removed account "yoon"', result.stdout)
            self.assertEqual(
                [account["name"] for account in json.loads(claude_config.read_text())["accounts"]],
                ["keeper"],
            )
            self.assertEqual(
                [account["name"] for account in json.loads(codex_config.read_text())["accounts"]],
                ["codex-keeper"],
            )


if __name__ == "__main__":
    unittest.main()
