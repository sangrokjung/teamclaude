"""Release 워크플로(외부 배포 R7·A6) 계약을 텍스트로 고정한다(PyYAML 없이도 돈다).

태그 menubar-v*와 workflow_dispatch 둘 다에서 테스트 → 유니버설 패키징 → 아티팩트 업로드를 하고,
Release 초안은 태그일 때만, 공개(draft 해제)는 하지 않는다. 사용자 입력은 env로만 넘긴다."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "menubar-release.yml"


class ReleaseWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text()

    def test_triggers(self):
        self.assertIn("tags: ['menubar-v*']", self.text)
        self.assertIn("workflow_dispatch:", self.text)

    def test_tests_then_package_then_upload(self):
        order = [self.text.index("bash menubar/run-tests.sh"), self.text.index("bash menubar/package-app.sh"),
                 self.text.index("actions/upload-artifact@v4")]
        self.assertEqual(order, sorted(order))
        self.assertIn("menubar/.build/dist/*.zip", self.text)
        self.assertIn("menubar/.build/dist/*.sha256", self.text)
        self.assertIn("if-no-files-found: error", self.text)
        self.assertIn("lipo -archs", self.text)

    def test_release_is_draft_and_only_on_tags(self):
        release = self.text[self.text.index("draft-release:"):]
        self.assertIn("if: startsWith(github.ref, 'refs/tags/menubar-v')", release)
        self.assertIn("--draft", release)
        self.assertNotIn("--draft=false", self.text)
        self.assertNotIn("gh release edit", self.text)
        # 쓰기 권한은 Release 잡에만 준다.
        top = self.text[:self.text.index("jobs:")]
        self.assertIn("contents: read", top)
        self.assertEqual(1, self.text.count("contents: write"))
        self.assertIn("contents: write", release)

    def test_untrusted_inputs_go_through_env_only(self):
        for line in self.text.splitlines():
            stripped = line.strip()
            if stripped.startswith("run:") or (stripped and not stripped.endswith(":") and "${{" in stripped
                                                 and not re.match(r"^[A-Z_]+: \$\{\{", stripped)
                                                 and not stripped.startswith(("group:", "if:"))):
                self.assertNotIn("${{ inputs", stripped, line)
                self.assertNotIn("${{ github.event", stripped, line)

    def test_artifact_sweep_present(self):
        self.assertIn("/Users/[a-z]", self.text)


if __name__ == "__main__":
    unittest.main()
