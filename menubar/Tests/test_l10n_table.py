# menubar/Tests/test_l10n_table.py
"""화면 문구 표(R5)를 소스로 고정한다.

- L10n.swift의 모든 t("한국어", "English") 쌍은 영어 쪽에 한글이 없다(A5의 표 쪽 절반).
- 언어 판정은 CC_MENUBAR_LANG → Locale.preferredLanguages 첫 항목 순서다.
- 테스트 러너는 언어를 한국어로 고정한다. 기존 테스트가 한국어 문구를 단언하고, CI 러너의 시스템 언어는 영어다.
실제 그려진 화면의 한글 0자는 snapshot_test_locale.py(빌드 게이트)가 본다."""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCES = ROOT / "menubar" / "Sources"
TABLE = SOURCES / "L10n.swift"
HANGUL = re.compile(r"[가-힣ㄱ-ㆎ]")
LITERAL = r'"(?:[^"\\]|\\.)*"'
PAIR = re.compile(r"\bt\(\s*(" + LITERAL + r")\s*,\s*(" + LITERAL + r")\s*\)")


class L10nTableTests(unittest.TestCase):
    def setUp(self):
        self.table = TABLE.read_text()

    def test_every_pair_has_hangul_free_english(self):
        pairs = PAIR.findall(self.table)
        self.assertGreater(len(pairs), 50, "the table should hold the panel copy")
        for ko, en in pairs:
            with self.subTest(ko=ko):
                self.assertIsNone(HANGUL.search(en), en)
                self.assertNotEqual(en, '""')

    def test_every_t_call_is_a_literal_pair(self):
        # t(변수, 변수)처럼 쓰면 위 검사가 그 문구를 보지 못한다.
        calls = re.findall(r"\bt\(", self.table)
        self.assertEqual(len(calls) - 1, len(PAIR.findall(self.table)),
                         "every t(...) call except the definition must be a literal pair")

    def test_language_resolution_order(self):
        self.assertIn('environment["CC_MENUBAR_LANG"]', self.table)
        self.assertIn("Locale.preferredLanguages", self.table)
        self.assertIn('hasPrefix("ko")', self.table)

    def test_runner_pins_korean_for_existing_assertions(self):
        runner = (ROOT / "menubar" / "run-tests.sh").read_text()
        self.assertIn('export CC_MENUBAR_LANG="${CC_MENUBAR_LANG:-ko}"', runner)


if __name__ == "__main__":
    unittest.main()
