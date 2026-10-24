# menubar/Tests/test_tool_notice_wiring.py
"""미설치 공통 상태(외부 배포 R1·R4)가 모든 소비 지점에 배선됐는지 소스로 고정한다.

계산해 놓고 화면 일부에만 넘기면 나머지 카드는 오류나 빈 카드를 그린다. 높이 계산·배치·헤더 요약·
요약 띠·메뉴바 제목·로더가 같은 판정(AppDelegate.currentToolNotices)을 보는지 확인한다.
실제 그리기는 snapshot_test_empty_home.py(빌드 게이트)와 ToolNoticeTests.swift가 본다."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / "menubar" / "Sources"
MAIN = SOURCES / "main.swift"


def function_body(source, signature):
    start = source.index(signature)
    brace = source.index("{", start)
    depth = 0
    for index in range(brace, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(signature)


def call_args(source, start):
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "(":
            depth += 1
        elif source[index] == ")":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(start)


class ToolNoticeWiringTests(unittest.TestCase):
    def setUp(self):
        self.main = MAIN.read_text()

    def test_notices_have_no_default_so_every_call_site_passes_them(self):
        # 기본값이 있으면 호출부가 조용히 빈 안내를 본다(burnModel과 같은 교훈, 2026-09-27).
        self.assertNotIn("notices: DashboardToolNotices = ", self.main)
        for pattern in (r"StatusMenuDashboardView\.preferredHeight", r"dashboard\.configure", r"view\.configure",
                        r"dashboard\.updateContent", r"\bconfigure"):
            for match in re.finditer(pattern + r"\(", self.main):
                args = call_args(self.main, match.end() - 1)
                if "teamClaude:" not in args:
                    continue
                with self.subTest(pattern=pattern, pos=match.start()):
                    self.assertIn("notices:", args)

    def test_app_call_sites_use_the_one_judgement(self):
        self.assertGreaterEqual(self.main.count("notices: currentToolNotices"), 5)
        self.assertIn("var currentToolNotices: DashboardToolNotices", self.main)

    def test_section_layout_and_summary_use_the_notices(self):
        # 탭 본문 높이와 배치가 같은 한 목록(sectionBodies)을 본다. 섹션마다 미설치면 안내 카드 높이를 쓴다.
        self.assertEqual(self.main.count('height: bodyHeight("claude"'), 1)
        for section in ("codex", "higgsfield", "usage"):
            self.assertIn(f'bodyHeight("{section}"', self.main)
        self.assertIn("ToolNoticeView(frame:", self.main)
        self.assertIn("|| notices != renderedNotices", self.main)
        self.assertIn("dashboardNoticeSummary(", self.main)

    def test_overview_receives_notices_on_build_and_refresh(self):
        # 예전 요약 띠 자리(개요 탭)도 같은 판정을 받는다. 빌드·갱신 두 경로 모두.
        configure = function_body(self.main, "    func configure(")
        update = function_body(self.main, "    func updateContent(")
        for body in (configure, update):
            self.assertIn("Self.overviewModel(teamClaude: teamClaude, teamCodex: teamCodex, grok: grok, agy: agy,", body)
            self.assertIn("burnModel: burnModel, notices: notices, now: now)", body)
        builder = (SOURCES / "DashboardOverviewBuilder.swift").read_text()
        self.assertIn('let claudeNotice = input.notices.sections["claude"]', builder)
        self.assertIn('let codexNotice = input.notices.sections["codex"]', builder)
        overview = (SOURCES / "OverviewTabView.swift").read_text()
        self.assertIn('ToolNoticeDrawLog.record("summary-\\(notice.tool.rawValue)", notice)', overview)

    def test_title_omits_missing_tools(self):
        slots = function_body(self.main, "func displaySlots(")
        self.assertIn("teamClaudeNotice == nil", slots)
        self.assertIn("codexNotice == nil", slots)
        self.assertIn("teamCodexNotice == nil", slots)

    def test_loaders_do_not_run_missing_tools(self):
        usage = function_body(self.main, "func loadUsageInBackground(")
        self.assertLess(usage.index("guard ccusageInstalled()"), usage.index("loadCcusageDaily(timeoutSeconds:"))
        higgs = function_body(self.main, "func loadHiggsfieldInBackground(")
        self.assertLess(higgs.index("higgsfieldBinCandidates().isEmpty"), higgs.index("fetchHiggsfieldCredits()"))
        grok = function_body(self.main, "func loadGrokUsageInBackground(")
        self.assertIn("grokPresenceNotice()", grok)
        self.assertIn("self.currentGrokSlot = nil", grok)
        agy = function_body(self.main, "func loadAgyUsageInBackground(")
        self.assertIn("agyCardModel(for: agyToolNotice())", agy)

    def test_usage_failure_reaches_every_usage_consumer(self):
        # 실행 실패·시간 초과·해석 실패를 "데이터 없음"으로 축약하지 않는다(외부 리뷰 2026-10-24).
        # 두 로더가 같은 판정(loadCcusageDaily)을 남기고, 판정은 안내 카드·헤더 요약·사용량 카드 꼬리말에 모두 닿아야 한다.
        for name in ("func loadUsageInBackground(", "func loadUsageQuickInBackground("):
            body = function_body(self.main, name)
            with self.subTest(loader=name):
                self.assertIn("loadCcusageDaily(timeoutSeconds: timeout, outputLimitBytes: outputLimit, clock: clock)", body)
                self.assertIn("self.usageLoadOutcome = daily.outcome", body)
                self.assertNotIn('runCcusageRaw("daily")', body)
        self.assertNotIn("usageLoadFinished", self.main)
        self.assertIn("ccusageToolNotice(installed: $0, outcome: usageLoadOutcome", self.main)
        # 앱이 대시보드에 넘기는 꼬리말은 사용량 꼬리말을 더한 dashboardStaleNotes 하나다.
        self.assertNotIn("laneStaleNotes: laneStaleNotes,\n            parallelCount: parallelCount,\n            active: isActive", self.main)
        self.assertEqual(self.main.count("laneStaleNotes: dashboardStaleNotes"), 3)
        # 구조가 바뀌어 configure를 다시 부를 때도 꼬리말을 넘긴다(빠뜨리면 그 갱신에서 표시가 사라진다).
        update = function_body(self.main, "func updateContent(")
        self.assertIn("laneStaleNotes: laneStaleNotes,", update)
        self.assertIn('usageView?.staleNote = laneStaleNotes["usage"]', update)
        configure = function_body(self.main, "func configure(\n        teamClaude: TeamClaudeHealth?")
        # Phase 2: 사용량 카드는 소진 탭 문서 안에서 usageDashboard로 만든다(그리는 자리만 옮겼다).
        self.assertIn('usageDashboard.staleNote = laneStaleNotes["usage"]', configure)
        self.assertEqual(self.main.count("notices: notices, staleNotes: laneStaleNotes)"), 2)

    def test_subscription_collector_reaches_the_burn_model(self):
        burn = function_body(self.main, "func refreshBurnModel(")
        self.assertIn("collectorNotice: subscriptionCollectorToolNotice(home:", burn)
        self.assertIn("teamClaudeNotice == nil", burn)
        self.assertIn("teamCodexNotice == nil", burn)

    def test_empty_home_snapshot_uses_the_app_judgement(self):
        snapshot = self.main[self.main.index('"--empty-home-snapshot"'):]
        snapshot = snapshot[:snapshot.index("exit(0)")]
        self.assertIn("AppDelegate()", snapshot)
        self.assertIn("delegate.currentToolNotices", snapshot)
        self.assertIn("grokPresenceNotice()", snapshot)
        self.assertIn("loadTeamClaudeHealth()", snapshot)
        self.assertIn("loadTeamCodexPoolHealth()", snapshot)
        self.assertIn("loadCodexHealth()", snapshot)
        build = (ROOT / "menubar" / "build.sh").read_text()
        self.assertIn("snapshot_test_empty_home.py", build)


if __name__ == "__main__":
    unittest.main()
