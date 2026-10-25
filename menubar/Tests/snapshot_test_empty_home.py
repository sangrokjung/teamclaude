# menubar/Tests/snapshot_test_empty_home.py
"""빈 HOME 스냅샷(외부 배포 A1).

도구가 하나도 없는 맥을 흉내 낸다. HOME·CFFIXED_USER_HOME을 빈 폴더로 두고, 이 맥에 실제로 깔린
도구(Homebrew·fnm 등)를 찾지 않도록 CC_MENUBAR_<TOOL>_BIN을 없는 경로로, 프록시 기본 포트를 닫힌
포트로 돌린다. 빌드된 cc-menubar가 실제 로더와 실제 판정으로 대시보드를 그린 뒤 카드마다 실제로
그려진 안내(DRAWN), 섹션 헤더 요약(SECTION), 메뉴바 제목 슬롯(TITLE-SLOTS)을 출력한다.
소비 지점마다 같은 미설치 상태가 도달했는지 각각 확인한다.

build.sh가 mv 직전의 후보 바이너리(CC_MENUBAR_BINARY)로 실행한다(러너의 test_*.py 글롭 밖)."""
import os
import pathlib
import socket
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_BINARY = ROOT / "menubar" / ".build" / "cc-menubar"
BINARY = pathlib.Path(os.environ.get("CC_MENUBAR_BINARY", str(DEFAULT_BINARY)))

TOOLS = ["AGY", "HIGGSFIELD", "NPX", "GROK", "CLAUDE", "TEAMCLAUDE", "TEAMCODEX"]

EXPECTED_DRAWN = {
    "claude": "TeamClaude 미설치",
    "codex": "Codex·TeamCodex 미설치",
    "higgsfield": "Higgsfield 미설치",
    "usage": "사용량 미설치",
    "grok": "Grok 미설치",
    "agy": "agy 미설치",
    "subscription": "수집기 미설치(선택 기능)",
    # 맨 위 "지금 사용 가능" 띠도 같은 상태를 말한다.
    "summary-teamclaude": "TeamClaude 미설치",
    "summary-codex": "Codex·TeamCodex 미설치",
}

# A안 탭마다 그 탭의 미설치 안내가 실제로 그려져야 한다(탭에 숨은 카드가 오류·빈 카드로 남지 않게).
EXPECTED_TAB_DRAWN = {
    "overview": {"summary-teamclaude", "summary-codex"},
    "claude": {"claude"},
    "codex": {"codex"},
    "burn": {"subscription", "usage"},
    "cli": {"grok", "agy", "higgsfield"},
}

EXPECTED_SECTIONS = {
    "burn": "수집기 미설치(선택 기능)",
    "claude": "TeamClaude 미설치",
    "codex": "Codex·TeamCodex 미설치",
    "higgsfield": "Higgsfield 미설치",
    "usage": "사용량 미설치",
}


def closed_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def isolated_env(home):
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("CC_MENUBAR_") and key not in ("TEAMCLAUDE_CONFIG", "XDG_CONFIG_HOME",
                                                                "NPM_CONFIG_PREFIX", "npm_config_prefix")}
    env["HOME"] = home
    env["CFFIXED_USER_HOME"] = home
    # 아래 기대 문구는 한국어다. 기계의 시스템 언어(CI는 영어)와 무관하게 판정하도록 고정한다. 영어는 snapshot_test_locale.py가 본다.
    env["CC_MENUBAR_LANG"] = "ko"
    for tool in TOOLS:
        env[f"CC_MENUBAR_{tool}_BIN"] = f"{home}/missing/{tool.lower()}"
    env["CC_MENUBAR_TEAMCLAUDE_PORT"] = str(closed_port())
    env["CC_MENUBAR_TEAMCODEX_PORT"] = str(closed_port())
    return env


def parse(stdout, prefix):
    out = {}
    for line in stdout.splitlines():
        if line.startswith(prefix + " "):
            key, _, value = line[len(prefix) + 1:].partition("=")
            out[key] = value
    return out


class EmptyHomeSnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if BINARY.exists():
            pass
        elif "CC_MENUBAR_BINARY" in os.environ:
            raise FileNotFoundError(f"CC_MENUBAR_BINARY={BINARY} does not exist")
        else:
            subprocess.run(["bash", str(ROOT / "menubar" / "build.sh")], cwd=ROOT, check=True, timeout=900,
                           env={**os.environ, "CC_MENUBAR_SKIP_TESTS": "1", "CC_MENUBAR_SKIP_SNAPSHOT": "1"})
        cls.tmp = tempfile.TemporaryDirectory(prefix="cc-menubar-empty-home-")
        home = cls.tmp.name
        out = pathlib.Path(home) / "snapshot.png"
        cls.png = out
        cls.result = subprocess.run([str(BINARY), "--empty-home-snapshot", str(out)], cwd=home,
                                    capture_output=True, text=True, timeout=120, env=isolated_env(home))
        cls.home = pathlib.Path(home)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_renders_without_crash(self):
        self.assertEqual(0, self.result.returncode, self.result.stdout[-2000:] + self.result.stderr[-2000:])
        self.assertNotIn("CRASH", self.result.stderr)
        self.assertTrue(self.png.exists() and self.png.stat().st_size > 1000)

    def test_every_card_draws_the_not_installed_state(self):
        drawn = parse(self.result.stdout, "DRAWN")
        for card, headline in EXPECTED_DRAWN.items():
            with self.subTest(card=card):
                self.assertEqual(headline, drawn.get(card), self.result.stdout)

    def test_each_tab_draws_its_not_installed_cards(self):
        tabs = {key: set(filter(None, value.split(","))) for key, value in parse(self.result.stdout, "TAB-DRAWN").items()}
        self.assertEqual(set(EXPECTED_TAB_DRAWN), set(tabs), self.result.stdout)
        for tab, cards in EXPECTED_TAB_DRAWN.items():
            with self.subTest(tab=tab):
                self.assertTrue(cards <= tabs[tab], f"{tab}: {tabs[tab]}")

    def test_section_headers_say_the_same_state(self):
        sections = parse(self.result.stdout, "SECTION")
        for section, summary in EXPECTED_SECTIONS.items():
            with self.subTest(section=section):
                self.assertEqual(summary, sections.get(section), self.result.stdout)
        # CLI 쿼터 섹션은 레인 카드가 안내를 그린다(위 grok·agy).
        self.assertIn("cli", sections)

    def test_title_does_not_report_missing_tools_as_failures(self):
        titles = [line for line in self.result.stdout.splitlines() if line.startswith("TITLE-SLOTS ")]
        self.assertEqual(1, len(titles), self.result.stdout)
        for word in ("Claude", "Codex", "Grok", "로그인", "오프라인", "주의"):
            self.assertNotIn(word, titles[0])

    def test_burn_table_has_no_lanes_for_missing_pools(self):
        lanes = [line for line in self.result.stdout.splitlines() if line.startswith("BURN-LANES")]
        self.assertEqual(["BURN-LANES "], lanes, self.result.stdout)

    def test_no_raw_error_strings(self):
        for word in ("error", "Error", "실행 실패", "찾지 못했습니다", "No such file"):
            self.assertNotIn(word, "\n".join(parse(self.result.stdout, "DRAWN").values()))

    def test_empty_home_is_not_written_with_tool_state(self):
        # 빈 HOME에서 앱이 사용자 설정·토큰 파일을 만들어 내지 않는다.
        self.assertFalse((self.home / ".config" / "teamclaude.json").exists())
        self.assertFalse((self.home / ".config" / "teamcodex.json").exists())



class LiveSnapshotReadOnlyTests(unittest.TestCase):
    """--live-snapshot(실데이터 경로 스냅샷)은 실행 중인 앱과 같은 로더로 읽고 탭 다섯 장을 쓴 뒤 끝난다.
    빈 HOME(도구 없음, 프록시 포트 닫힘)에서도 멈추지 않고, 출력 폴더 밖에는 아무 파일도 만들지 않는다(읽기 전용)."""

    @classmethod
    def setUpClass(cls):
        if not BINARY.exists():
            raise unittest.SkipTest(f"{BINARY} missing (EmptyHomeSnapshotTests builds it)")
        cls.tmp = tempfile.TemporaryDirectory(prefix="cc-menubar-live-home-")
        cls.home = pathlib.Path(cls.tmp.name) / "home"
        cls.home.mkdir()
        cls.out = pathlib.Path(cls.tmp.name) / "out"
        cls.out.mkdir()
        cls.result = subprocess.run([str(BINARY), "--live-snapshot", str(cls.out / "live.png")], cwd=str(cls.home),
                                    capture_output=True, text=True, timeout=240, env=isolated_env(str(cls.home)))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_writes_five_tabs_and_exits(self):
        self.assertEqual(0, self.result.returncode, self.result.stdout[-2000:] + self.result.stderr[-2000:])
        names = sorted(path.name for path in self.out.iterdir())
        self.assertEqual(["live-burn.png", "live-claude.png", "live-cli.png", "live-codex.png", "live.png"], names)
        self.assertIn("LIVE-SNAPSHOT-LOAD:", self.result.stdout)
        self.assertIn("all lanes loaded", self.result.stdout)
        self.assertIn("LIVE-SNAPSHOT: ", self.result.stdout)

    def test_read_only_home(self):
        # 읽기 전용: HOME 아래에 쿼터 이력·캐시·로그·설정·UserDefaults 파일을 하나도 만들지 않는다.
        created = [str(path.relative_to(self.home)) for path in self.home.rglob("*")]
        self.assertEqual([], created, self.result.stdout[-2000:])



class LiveSnapshotTimeoutTests(unittest.TestCase):
    """로더가 시간 안에 끝나지 않으면 부분 데이터를 정상 스냅샷처럼 내놓지 않는다: 이미지를 쓰지 않고 3으로 끝난다."""

    def test_unfinished_lanes_fail_without_images(self):
        if not BINARY.exists():
            self.skipTest(f"{BINARY} missing (EmptyHomeSnapshotTests builds it)")
        with tempfile.TemporaryDirectory(prefix="cc-menubar-live-timeout-") as temp:
            home = pathlib.Path(temp) / "home"
            home.mkdir()
            out = pathlib.Path(temp) / "out"
            out.mkdir()
            # 이전 성공 실행이 남긴 이미지는 실패 때 지워져야 한다(낡은 스냅샷을 새것으로 오인하지 않게).
            for stale in ("live.png", "live-claude.png", "live-burn.png"):
                (out / stale).write_bytes(b"stale")
            keep = out / "unrelated.txt"
            keep.write_text("keep")
            env = isolated_env(str(home))
            env["CC_MENUBAR_LIVE_SNAPSHOT_TIMEOUT"] = "0"
            result = subprocess.run([str(BINARY), "--live-snapshot", str(out / "live.png")], cwd=str(home),
                                    capture_output=True, text=True, timeout=120, env=env)
            self.assertEqual(3, result.returncode, result.stdout[-2000:] + result.stderr[-2000:])
            self.assertIn("still loading=", result.stdout)
            self.assertEqual(["unrelated.txt"], sorted(path.name for path in out.iterdir()))


if __name__ == "__main__":
    unittest.main()
