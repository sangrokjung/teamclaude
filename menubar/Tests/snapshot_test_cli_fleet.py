# menubar/Tests/snapshot_test_cli_fleet.py
"""빌드된 cc-menubar의 --dashboard-snapshot이 CLI 탭 머신 표(cliFleet·cliLocal)와 링크 버튼(links)을 실제로 그리는지 본다.
build.sh가 mv 직전의 후보 바이너리(CC_MENUBAR_BINARY)로 실행한다(러너의 test_*.py 글롭 밖).

- 머신 6대(정상·주의·로그인 필요·수집 실패·꺼짐·멈춤)가 한 장에, 상태를 글자로도 말한다.
- 링크 제목이 하단 막대에 그려진다. 링크가 없으면 그리지 않는다.
- 수집 파일이 없으면(cliLocal) 이 맥 한 줄과 "이 맥만" 안내.
- 깨진 cliFleet 픽스처는 비정상 종료한다(조용히 이 맥 한 줄로 성공하지 않는다).
- 영어 화면에 한글이 없다."""
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
BINARY = pathlib.Path(os.environ.get("CC_MENUBAR_BINARY", str(ROOT / "menubar" / ".build" / "cc-menubar")))
sys.path.insert(0, str(ROOT / "menubar" / "Tests"))
import make_dash_fixture  # noqa: E402


def fixture(*flags):
    saved = sys.argv
    sys.argv = ["make_dash_fixture.py", "-", *flags]
    try:
        return make_dash_fixture.build()
    finally:
        sys.argv = saved


@unittest.skipUnless(BINARY.exists(), f"binary not built: {BINARY}")
class CliFleetSnapshotTests(unittest.TestCase):
    def render(self, data, lang="ko"):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "fixture.json"
            path.write_text(json.dumps(data, ensure_ascii=False))
            out = pathlib.Path(tmp) / "out.png"
            result = subprocess.run([str(BINARY), "--dashboard-snapshot", str(path), str(out), "--tab", "cli"],
                                    capture_output=True, text=True, timeout=120,
                                    env={**os.environ, "CC_MENUBAR_LANG": lang})
            texts = [line.split("=", 1)[1] for line in result.stdout.splitlines() if line.startswith("TEXT cli=")]
            return result, texts, out.exists() and out.stat().st_size > 0

    def test_fleet_table_draws_every_machine_and_state_word(self):
        result, texts, rendered = self.render(fixture("--cli-fleet", "--links"))
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue(rendered)
        joined = "\n".join(texts)
        for word in ("본체", "studio-a", "mini-b", "studio-c", "laptop", "mini-d",
                     "정상", "주의", "문제", "수집 실패", "꺼짐", "멈춤 7분",
                     "로그인 필요", "갱신 필요", "남음 12%", "미설치",
                     "한도 숫자를 주지 않아 % 기준", "마지막 사용", "오늘", "AI 비용 대시보드"):
            with self.subTest(word=word):
                self.assertIn(word, joined)
        self.assertNotIn("이 맥만", joined, "the hub file exists, so this is not the local-only view")

    def test_local_only_view_without_links(self):
        result, texts, rendered = self.render(fixture("--cli-local"))
        self.assertEqual(0, result.returncode, result.stderr)
        joined = "\n".join(texts)
        self.assertIn("worker-a", joined)
        self.assertIn("이 맥만", joined)
        self.assertNotIn("AI 비용 대시보드", joined, "no links file → no button")

    def test_bad_link_scheme_hides_the_button(self):
        data = fixture("--cli-local")
        data["links"] = [{"title": "AI 비용 대시보드", "url": "file:///etc/hosts"}]
        result, texts, _ = self.render(data)
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertNotIn("AI 비용 대시보드", "\n".join(texts))

    def test_malformed_cli_fleet_fails(self):
        data = fixture()
        data["cliFleet"] = {"hosts": "bad"}
        result, _, rendered = self.render(data)
        self.assertNotEqual(0, result.returncode)
        self.assertIn("cliFleet", result.stderr)
        self.assertFalse(rendered)

    def test_english_table_has_no_hangul(self):
        data = fixture("--cli-fleet")
        data["links"] = [{"title": "AI cost dashboard", "url": "http://100.x.y.z:8790/"}]
        result, texts, _ = self.render(data, lang="en")
        self.assertEqual(0, result.returncode, result.stderr)
        joined = "\n".join(texts)
        self.assertIn("AI cost dashboard", joined)
        self.assertIn("Login needed", joined)
        self.assertIsNone(re.search(r"[가-힣]", joined), joined)


if __name__ == "__main__":
    unittest.main()
