# menubar/Tests/snapshot_test_locale.py
"""화면 언어 스냅샷(외부 배포 A5).

빌드된 cc-menubar로 대시보드 다섯 탭을 픽스처(make_dash_fixture.py --codex)와 빈 HOME으로 그리고,
실제로 그려진 글자(TEXT 줄, DrawnTextRecorder가 NSString·NSAttributedString 그리기와 컨트롤 제목에서 모은다)를 본다.
- 영어(CC_MENUBAR_LANG=en): 한글 0자.
- 한국어(CC_MENUBAR_LANG=ko): A안 문구가 그대로 그려진다.

build.sh가 mv 직전의 후보 바이너리(CC_MENUBAR_BINARY)로 실행하고, run-tests.sh에서는 test_locale_snapshot.py가
지금 소스로 새로 컴파일한 바이너리로 실행한다(러너 요약에 나타나도록)."""
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
TESTS = ROOT / "menubar" / "Tests"
DEFAULT_BINARY = ROOT / "menubar" / ".build" / "cc-menubar"
BINARY = pathlib.Path(os.environ.get("CC_MENUBAR_BINARY", str(DEFAULT_BINARY)))
HANGUL = re.compile(r"[가-힣ㄱ-ㆎ]")
TABS = ["overview", "claude", "codex", "burn", "cli"]

# A안(261024-menubar-a)에서 가져온 한국어 문구. 탭마다 하나 이상.
A_COPY = {
    "overview": ["개요", "소진", "TeamClaude 사용량", "지금 라우팅 가능", "Claude 계정 12개가 지금 요청을 받습니다.",
                 "Claude 풀 · 주간 사용률", "손볼 것 4", "사람이 움직여야 풀리는 계정", "주간 소진 전망", "재인증", "구독 확인",
                 "새로고침", "동작", "Fable 주간까지 여유"],
    "claude": ["사용 가능", "한도 대기", "제외", "세션 5시간", "Fable 주간", "라우팅 중", "리셋되면 돌아옴", "사람이 손봐야 돌아옴",
               "창 경과 눈금", "98%부터 라우팅 대기"],
    "codex": ["계정마다 창이 따로 돕니다", "5시간", "7일"],
    "burn": ["월 합계", "기여 없는 계정", "서비스별 판정", "먼저 할 일", "고칠 수 있는 것부터", "목표 사용률 100%"],
    "cli": ["CLI 쿼터", "값이 없을 때 쓰는 말", "확인 중", "확인 필요", "동기화 중", "측정 전"],
}


def texts(stdout):
    out = {tab: [] for tab in TABS}
    for line in stdout.splitlines():
        if line.startswith("TEXT "):
            tab, _, value = line[5:].partition("=")
            out.setdefault(tab, []).append(value)
    return out


def ensure_binary():
    if BINARY.exists():
        return
    if "CC_MENUBAR_BINARY" in os.environ:
        raise FileNotFoundError(f"CC_MENUBAR_BINARY={BINARY} does not exist")
    subprocess.run(["bash", str(ROOT / "menubar" / "build.sh")], cwd=ROOT, check=True, timeout=900,
                   env={**os.environ, "CC_MENUBAR_SKIP_TESTS": "1", "CC_MENUBAR_SKIP_SNAPSHOT": "1"})


class LocaleSnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ensure_binary()
        cls.tmp = tempfile.TemporaryDirectory(prefix="cc-menubar-locale-")
        work = pathlib.Path(cls.tmp.name)
        fixture = work / "fixture.json"
        subprocess.run([sys.executable, str(TESTS / "make_dash_fixture.py"), str(fixture), "--codex"],
                       check=True, capture_output=True, timeout=60)
        cls.runs = {}
        for lang in ("en", "ko"):
            result = subprocess.run([str(BINARY), "--dashboard-snapshot", str(fixture), str(work / f"panel-{lang}.png")],
                                    capture_output=True, text=True, timeout=120,
                                    env={**os.environ, "CC_MENUBAR_LANG": lang})
            cls.runs[lang] = result
        # 빈 HOME(미설치 안내)도 영어로 한 번 그린다.
        sys.path.insert(0, str(TESTS))
        import snapshot_test_empty_home as empty_home
        home = work / "home"
        home.mkdir()
        env = {**empty_home.isolated_env(str(home)), "CC_MENUBAR_LANG": "en"}
        cls.empty_en = subprocess.run([str(BINARY), "--empty-home-snapshot", str(work / "empty-en.png")], cwd=home,
                                      capture_output=True, text=True, timeout=120, env=env)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_both_languages_render_every_tab(self):
        for lang, result in self.runs.items():
            with self.subTest(lang=lang):
                self.assertEqual(0, result.returncode, result.stderr[-2000:])
                drawn = texts(result.stdout)
                for tab in TABS:
                    self.assertGreater(len(drawn[tab]), 5, f"{lang}/{tab} drew almost nothing")

    def test_english_draws_zero_hangul(self):
        for name, stdout in (("dashboard", self.runs["en"].stdout), ("empty-home", self.empty_en.stdout)):
            for tab, values in texts(stdout).items():
                with self.subTest(source=name, tab=tab):
                    offenders = [value for value in values if HANGUL.search(value)]
                    self.assertEqual([], offenders)
        self.assertEqual(0, self.empty_en.returncode, self.empty_en.stderr[-2000:])
        # 미설치 안내도 영어다(카드 제목이 실제로 그려졌는지까지).
        self.assertIn("DRAWN claude=TeamClaude Not installed", self.empty_en.stdout)

    def test_korean_draws_the_a_copy(self):
        drawn = texts(self.runs["ko"].stdout)
        for tab, phrases in A_COPY.items():
            joined = "\n".join(drawn[tab])
            for phrase in phrases:
                with self.subTest(tab=tab, phrase=phrase):
                    self.assertIn(phrase, joined)

    def test_english_uses_the_same_layout(self):
        # 같은 픽스처면 언어와 무관하게 탭 수와 개요의 큰 숫자가 같다.
        en, ko = texts(self.runs["en"].stdout), texts(self.runs["ko"].stdout)
        self.assertEqual(set(en), set(ko))
        self.assertIn("12", en["overview"])
        self.assertIn("Routable now", "\n".join(en["overview"]))


if __name__ == "__main__":
    unittest.main()
