# menubar/Tests/test_dashboard_wiring.py
"""패널 배선 회귀(소스 정규식). A안 패널은 머리·탭 5개·하단 막대가 고정이고 탭 본문만 안쪽 스크롤 뷰 하나에서
움직인다. 탭 안 섹션 배치는 DashboardSections.swift의 순수 함수가 맡는다. 섹션별 안쪽 NSScrollView와 936/596
상한, 탭 전환 때 메뉴 항목 뷰를 갈아 끼우는 코드가 되살아나면 여기서 잡는다."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / "menubar" / "Sources"
MAIN = SOURCES / "main.swift"
SECTIONS = SOURCES / "DashboardSections.swift"
PALETTE = SOURCES / "TeamClaudePalette.swift"


def class_body(source, name):
    match = re.search(r"final class " + re.escape(name) + r"\b(?P<body>.*?)\nfinal class ", source, re.DOTALL)
    assert match is not None, f"{name} must remain discoverable"
    return match.group("body")


class DashboardWiringTests(unittest.TestCase):
    def setUp(self):
        self.main = MAIN.read_text()

    def test_no_per_section_clamp_remains(self):
        self.assertNotIn("maxTeamHeight", self.main)
        self.assertNotIn("maxMenuDashboardHeight", self.main)

    def test_panel_body_is_the_only_scroll_view(self):
        body = class_body(self.main, "StatusMenuDashboardView")
        self.assertEqual(1, body.count("NSScrollView("), "the tab body is the one scroll view; sections render at full height")
        self.assertNotIn("enclosingScrollView", body)
        self.assertIn("private(set) var sections: [DashboardSection]", body)
        self.assertIn("DashboardSectionHeaderView(", body)
        self.assertIn("dashboardSectionLayout(startY:", body)
        self.assertIn("dashboardSectionBodyY(", body)
        # 탭을 바꾸면 스크롤 뷰의 문서만 갈아 끼운다. 메뉴 항목의 뷰는 그대로다.
        select = body[body.index("    func selectTab("):]
        select = select[:select.index("\n    }\n")]
        self.assertNotIn("item.view", select)
        self.assertIn("showSelectedTab(", select)

    def test_menu_hosting_is_one_helper(self):
        self.assertEqual(1, self.main.count("func hostDashboard("), "both hosting sites must share one helper")
        host = self.main[self.main.index("    func hostDashboard("):]
        host = host[:host.index("\n    }\n")]
        self.assertIn("if item.view !== dashboard {", host)
        self.assertIn("dashboard.restoreBodyScroll(previousScrollOrigin)", host)
        self.assertNotIn("NSScrollView(", host)
        self.assertIn("verticalScrollElasticity = .allowed", self.main)
        self.assertNotIn("verticalScrollElasticity = .none", self.main)
        for site in ("func updateCachedMenuPresentation()", "func menuWillOpen(_ menu: NSMenu)"):
            self.assertIn(site, self.main)
        rebuild = self.main.split("func menuWillOpen(_ menu: NSMenu)", 1)[1].split("func menuDidClose", 1)[0]
        self.assertIn("hostDashboard(dashboard, in: dashboardItem, previousScrollOrigin: nil)", rebuild)
        refresh = self.main.split("func updateCachedMenuPresentation()", 1)[1].split("func menuWillOpen", 1)[0]
        self.assertIn("hostDashboard(dashboard, in: dashboardItem, previousScrollOrigin: previousScrollOrigin)", refresh)

    def test_panel_height_fits_the_screen(self):
        # 높이는 가장 긴 탭에 맞추되 화면을 넘지 않는다. 공유 파라미터에 기본값을 두지 않는다(호출부가 화면 상한을 잊지 않게).
        signature = self.main[self.main.index("    static func preferredHeight(teamClaude:"):]
        signature = signature[:signature.index("{")]
        self.assertIn("maxBodyHeight: CGFloat, tab: DashboardTab? = nil", signature)
        self.assertNotIn("maxBodyHeight: CGFloat =", signature)
        self.assertIn("func dashboardMaxBodyHeight() -> CGFloat", self.main)
        self.assertGreaterEqual(self.main.count("maxBodyHeight: dashboardMaxBodyHeight()")
                                + self.main.count("dashboard.maxBodyHeight = dashboardMaxBodyHeight()"), 1)

    def test_sections_file_uses_the_palette_only(self):
        sections = SECTIONS.read_text()
        self.assertNotIn("NSColor(", sections)
        self.assertNotIn("NSFont.", sections)
        self.assertIn("TeamClaudePalette.", sections)
        for symbol in ("struct DashboardSection", "func dashboardSectionLayout(",
                       "func dashboardSectionBodyY(", "final class DashboardSectionHeaderView"):
            self.assertIn(symbol, sections)

    def test_palette_lives_in_its_own_file(self):
        self.assertTrue(PALETTE.exists())
        self.assertIn("enum TeamClaudePalette", PALETTE.read_text())
        self.assertNotIn("enum TeamClaudePalette", self.main)

    def test_height_and_configure_share_one_section_list(self):
        body = class_body(self.main, "StatusMenuDashboardView")
        bodies = body[body.index("    static func sectionBodies("):]
        bodies = bodies[:bodies.index("\n    }\n")]
        ids = re.findall(r'\(id: "([a-z]+)", title: ', bodies)
        self.assertEqual(ids, ["claude", "codex", "burn", "usage", "cli", "higgsfield", "vocabulary"],
                         "every former dashboard section keeps a place in one tab")
        self.assertIn("sectionBodies(", body[body.index("    static func tabContentHeights("):])
        configure = body[body.index("    func configure("):]
        configure = configure[:configure.index("\n    }\n")]
        self.assertIn("Self.sectionBodies(", configure)
        self.assertIn("Self.overviewModel(", configure)
        tabs = (SOURCES / "DashboardPanel.swift").read_text()
        for section in ("overview", "claude", "codex", "burn", "usage", "cli", "higgsfield", "vocabulary"):
            self.assertIn(f'"{section}"', tabs[tabs.index("var sectionIDs"):tabs.index("static func containing")])


class DashboardRefreshCostTests(unittest.TestCase):
    """성능 회귀: Codex 세션 스캔은 10초 틱 밖(60초 타이머, background QoS), 열린 대시보드 리드로는 합쳐서 한 번."""

    def setUp(self):
        self.main = (SOURCES / "main.swift").read_text()

    def test_fast_tick_no_longer_scans_codex_sessions(self):
        start = self.main.index("func loadFastStatusInBackground()")
        end = self.main.index("\n    }\n", start)
        self.assertNotIn("loadCodexStatusInBackground", self.main[start:end])
        self.assertIn("codexScanTimer = Timer.scheduledTimer(withTimeInterval: 60.0", self.main)
        # 기동 킥(refresh)은 스캔을 한 번 돌려야 한다 — 죽은 loadInBackground()에 넣으면 런치 후 60초 동안 Codex 상태가 빈다.
        start = self.main.index("    func refresh() {")
        end = self.main.index("\n    }\n", start)
        self.assertIn("loadCodexStatusInBackground()", self.main[start:end])

    def test_codex_scan_runs_at_background_qos(self):
        start = self.main.index("func loadCodexStatusInBackground()")
        end = self.main.index("\n    }\n\n", start)
        self.assertIn("DispatchQueue.global(qos: .background)", self.main[start:end])
        self.assertNotIn("qos: .utility", self.main[start:end])
        self.assertIn("scan=files:", self.main[start:end])

    def test_open_dashboard_redraws_are_coalesced(self):
        self.assertIn("func scheduleDashboardRefresh(reason: String, immediate: Bool = false)", self.main)
        self.assertGreaterEqual(self.main.count("scheduleDashboardRefresh(reason:"), 12)
        self.assertEqual(0, self.main.count("refreshOpenDashboard()"), "call sites must go through scheduleDashboardRefresh")
        self.assertIn('print("DASHBOARD-REFRESH: reason=', self.main)
        # 닫힌 메뉴는 30초 단위로만 캐시를 데우고, 메뉴를 열 때 대기 중인 갱신을 그 자리에서 반영한다.
        self.assertIn("let closedMenuRefreshWindow: TimeInterval = 30", self.main)
        # 스로틀 의미론: 대기 항목이 있으면 유지(재예약 금지). 디바운스면 10초 로더 완료가 30초 창을 영원히 밀어낸다.
        sched_start = self.main.index("    func scheduleDashboardRefresh(")
        sched_end = self.main.index("\n    }\n", sched_start)
        sched = self.main[sched_start:sched_end]
        self.assertIn("if pendingDashboardRefresh != nil { return }", sched)
        self.assertLess(sched.index("if pendingDashboardRefresh != nil { return }"), sched.index("DispatchWorkItem"))
        self.assertIn("openDashboardView != nil ? 0.3 : closedMenuRefreshWindow", self.main)
        open_start = self.main.index("    func menuWillOpen(")
        open_end = self.main.index("menu.removeAllItems()", open_start)
        self.assertIn('flushPendingDashboardRefresh(reason: "menuWillOpen")', self.main[open_start:open_end])
        # 닫힌 메뉴 경로는 updateContent를 한 번만(캐시 프레젠테이션 안에서) 돌린다 — 예전엔 두 번이라 10초마다 300~800ms를 썼다.
        start = self.main.index('    func refreshOpenDashboard(reason: String = "direct") {')
        end = self.main.index("\n    }\n", start)
        body = self.main[start:end]
        self.assertLess(body.index("if openDashboardView == nil {"), body.index("dashboard.updateContent("))
        self.assertEqual(1, body.count("dashboard.updateContent("))
        host_start = self.main.index("    func hostDashboard(")
        host_end = self.main.index("\n    }\n", host_start)
        self.assertIn("if item.view !== dashboard {", self.main[host_start:host_end])

class HiggsfieldTimerWiringTests(unittest.TestCase):
    """힉스필드 조회는 주기 타이머가 있어야 한다.

    기동 시 1회만 부르면 그 한 번의 실패가 영구 공백이 된다(2026-09-24 실측: 데몬 로그 347분
    동안 조회 1회, 크레딧 칸이 계속 비어 있었다).
    """

    def setUp(self):
        self.main = MAIN.read_text()

    def test_periodic_timer_is_scheduled(self):
        self.assertIn("higgsfieldTimer = Timer.scheduledTimer", self.main)
        self.assertIn("self?.loadHiggsfieldInBackground(force: true)", self.main)
        self.assertIn("RunLoop.main.add(t, forMode: .common)", self.main)

    def test_interval_is_a_named_constant(self):
        # 타이머는 force로 부른다 — 간격과 스로틀이 같은 값이라 force가 없으면 한 틱씩 걸러진다.
        self.assertIn("withTimeInterval: higgsfieldFetchInterval", self.main)
        self.assertIn("< higgsfieldFetchInterval", self.main)
        self.assertNotIn("timeIntervalSince(last) < 600", self.main)


class AgyLaneWiringTests(unittest.TestCase):
    """agy 카드는 Gemini 레인만 올린다(memory-policy: 타 벤더 모델 선택 금지)."""

    def test_card_filters_to_the_gemini_lane(self):
        self.assertIn("agyVisibleGroups(groups)", MAIN.read_text())
        self.assertIn("func agyVisibleGroups", (SOURCES / "AgyUsage.swift").read_text())


class CliLaneHealthWiringTests(unittest.TestCase):
    """CLI 쿼터 레인(grok·agy·힉스필드)이 조용히 죽지 않게 하는 불변식.

    같은 계열 사고가 세 번 났다 — agy는 데몬 수명 내내 실패했고(작업 폴더), 힉스필드는 주기
    조회가 없었고(기동 1회), grok은 만료를 '로그인'으로만 보여줬다. 공통 원인은 '값 없음'과
    '죽었음'을 구분하지 못한 것이다. 레인을 새로 붙일 때 이 세 가지를 빠뜨리면 여기서 걸린다.
    """

    LANES = (
        ("grok", "grokTimer", "loadGrokUsageInBackground", "grokUsageFetchInterval"),
        ("agy", "agyTimer", "loadAgyUsageInBackground", "agyUsageFetchInterval"),
        ("higgsfield", "higgsfieldTimer", "loadHiggsfieldInBackground", "higgsfieldFetchInterval"),
    )

    def setUp(self):
        self.main = MAIN.read_text()

    def test_every_lane_has_a_periodic_timer(self):
        for name, timer, loader, interval in self.LANES:
            with self.subTest(lane=name):
                self.assertIn(f"{timer} = Timer.scheduledTimer", self.main)
                self.assertIn(f"withTimeInterval: {interval}", self.main)
                self.assertIn(f"self?.{loader}(", self.main)

    def test_every_lane_records_its_own_success_time(self):
        # 시도 시각(last*FetchedAt)만으로는 '계속 실패 중'을 알 수 없다.
        # 선언만 남고 대입이 사라지면 영원히 nil이 되므로 대입 자체를 본다.
        for name, _, _, _ in self.LANES:
            with self.subTest(lane=name):
                self.assertRegex(self.main, rf"\b{name}LastSuccessAt\s*=\s*Date\(\)")

    def test_stale_state_reaches_every_lane_view(self):
        # 계산해 두고 화면 일부에만 넘기면 나머지 카드는 낡은 값을 최신값처럼 보인다.
        self.assertIn('higgsView.staleNote = laneStaleNotes["higgsfield"]', self.main)
        self.assertIn('higgsfieldView?.staleNote = laneStaleNotes["higgsfield"]', self.main)
        higgs = (SOURCES / "HiggsfieldCreditsView.swift").read_text()
        self.assertIn("var staleNote: String?", higgs)
        # 그리기와 접근성 둘 다에 반영돼야 한다.
        self.assertIn("if let staleNote { label +=", higgs)
        self.assertIn("PanelDraw.text(staleNote,", higgs)

    def test_stale_tail_survives_the_empty_agy_path(self):
        # 기동 후 한 번도 성공하지 못한 경우가 조기 반환으로 빠져나가던 자리다.
        card = (SOURCES / "CliQuotaCards.swift").read_text()
        empty_branch = card[card.index("guard let group = agy.groups.first"):]
        self.assertIn('staleNotes["agy"]', empty_branch[:600])

    def test_stale_state_reaches_the_screen(self):
        # 지연이 로그에만 남으면 화면은 멀쩡해 보인다. 그게 이번 사고들의 공통 모양이었다.
        self.assertIn("staleNotes", (SOURCES / "CliQuotaCards.swift").read_text())
        self.assertIn("laneStaleNotes", self.main)
        self.assertIn('scheduleDashboardRefresh(reason: "lane-stale")', self.main)

    def test_empty_state_words_are_unified(self):
        vocab = (SOURCES / "StatusVocabulary.swift").read_text()
        table = (SOURCES / "L10n.swift").read_text()
        for key, word in (("vocabChecking", "확인 중"), ("vocabNeedsCheck", "확인 필요"), ("vocabNotMeasured", "측정 전")):
            self.assertIn(f"L10n.{key}", vocab)
            self.assertIn(f't("{word}", ', table)
        # 띄어쓰기가 갈린 옛 표기가 되살아나면 잡는다.
        # 화면에 그리는 자리에서 옛 붙여쓰기 표기가 되살아나면 잡는다(진단 출력 문자열은 대상이 아니다).
        for old in ('percentText(sessionPercent) : "확인필요"', ': "측정전",', ': "동기화중",'):
            self.assertNotIn(old, self.main)

    def test_subscription_entry_lives_in_the_expanded_row(self):
        # 기록 없는 계정이 대다수라 행마다 같은 문구를 남기면 노이즈가 된다. 입력 진입점은 펼친 행의 상세 칸에 둔다.
        table = class_body(self.main, "TeamClaudeTableView")
        self.assertIn("var expandedAccount: String?", table)
        self.assertIn("} else if index == expanded {", table)
        self.assertIn("L10n.subscriptionRecord", table)
        self.assertIn("openRecordDialog()", table)
        self.assertIn("func openRecordDialog()", (SOURCES / "AccountSubscriptionButton.swift").read_text())
        # 발견 경로 한 줄: 범례가 "행을 누르면 구독·동시 요청"을 말한다.
        self.assertIn("L10n.legendRowClick", table)
        self.assertIn("행을 누르면 구독", (SOURCES / "L10n.swift").read_text())

    def test_config_reads_are_cached(self):
        # 계정마다 설정 파일을 읽고 파싱하면 1초 타이머가 도는 동안 메인 스레드에서
        # 그 일이 초당 계정 수만큼 반복된다(적대 리뷰 2026-09-24).
        source = (SOURCES / "AccountSubscription.swift").read_text()
        self.assertIn("AccountSubscriptionFileCache", source)
        self.assertIn("modificationDate", source)
        self.assertEqual(source.count("Data(contentsOf: url)"), 1,
                         "파일 읽기는 캐시 한 곳을 거쳐야 한다")
        # 구독 모니터 캐시도 같은 경로를 타야 한다 — 이쪽은 계정마다 SHA256까지 돈다.
        self.assertIn("AccountSubscriptionFileCache.shared.json(at: url, maxBytes: 1_048_576)", source)

    def test_extra_agy_lanes_are_counted_not_dropped(self):
        card = (SOURCES / "CliQuotaCards.swift").read_text()
        self.assertIn("agy.groups.count > 1", card)

    def test_every_lane_logs_each_cycle(self):
        # 한 레인만 조용하면 "조회가 도는가"를 로그로 답할 수 없다.
        for marker in ('print("GROK-SLOT:', 'print("AGY:', 'print("HIGGSFIELD:'):
            with self.subTest(marker=marker):
                self.assertIn(marker, self.main)

    def test_partial_fetch_is_not_recorded_as_success(self):
        # 일부 페이지만 받은 응답은 error가 nil이라, 그것까지 성공으로 적으면
        # 반쪽 상태가 계속돼도 지연 경보가 영영 뜨지 않는다(astra 지적 2026-09-24).
        self.assertIn("data.error == nil && data.partialError == nil", self.main)

    def test_stale_cooldown_is_per_lane(self):
        # 쿨다운이 전역 하나면 한 레인이 경보한 직후 다른 레인이 10분간 묻힌다.
        self.assertIn("lastLaneStaleLogAt: [String: Date]", self.main)
        self.assertIn("lastLaneStaleLogAt[notice.name]", self.main)

    def test_stale_lanes_are_reported(self):
        self.assertIn("func reportStaleLanes", self.main)
        self.assertIn("reportStaleLanes()", self.main)
        self.assertIn("laneStaleMessages(", self.main)
        for name, _, _, _ in self.LANES:
            with self.subTest(lane=name):
                self.assertIn(f'LaneHealth(name: "{name}"', self.main)

    def test_grok_separates_expiry_from_logged_out(self):
        grok = (SOURCES / "GrokUsage.swift").read_text()
        self.assertIn("case expired", grok)
        self.assertIn("candidates.isEmpty ? .login : .expired", grok)
        self.assertIn("L10n.grokRefreshNeeded", self.main)
        self.assertIn('t("Grok 갱신 필요", ', (SOURCES / "L10n.swift").read_text())


class AccountRowLinesWiringTests(unittest.TestCase):
    """계정 행 보조 줄(2행 사유·3행 구독)은 조건부다 — 17행에 같은 '미확인' 문구가 반복되면 문제 계정이 묻힌다.

    행 높이가 행마다 달라졌으므로 높이 계산(teamContentHeight)·버튼 배치(layout)·그리기(draw)가 같은 판정
    (TeamClaudeHealth.rowLines → TeamClaudeRowLines.swift)을 써야 한다. 한 경로만 고정 72pt로 되돌아가면 여기서 잡는다.
    """

    def setUp(self):
        self.main = MAIN.read_text()
        self.table = class_body(self.main, "TeamClaudeTableView")
        self.dashboard = class_body(self.main, "StatusMenuDashboardView")

    def _method(self, body, signature):
        start = body.index(signature)
        return body[start:body.index("\n    }\n", start)]

    def test_height_layout_and_draw_share_one_judgement(self):
        height = self._method(self.dashboard, "static func teamContentHeight(")
        self.assertIn("TeamClaudeTableView.contentHeight(health, expanded: nil, now: now)", height)
        content = self._method(self.table, "static func contentHeight(")
        self.assertIn("health.rowLines(now: now, availability: availability)", content)
        self.assertIn("teamClaudeGroupedLayout(groups: availability.map(teamClaudeRowGroup)", content)
        self.assertIn("teamClaudeCardBaseHeight(hostLine:", content)
        self.assertNotIn("* 72", height, "row height is per row now, not a fixed multiple")
        self.assertNotIn("* 72", self.table)
        layout = self._method(self.table, "override func layout()")
        self.assertIn("health.rowLines(now: evaluatedAt)", layout)
        self.assertIn("teamClaudeGroupedLayout(", layout)
        self.assertIn("teamClaudeSubscriptionLineY(lines[index])", layout)
        draw = self.table[self.table.index("override func draw("):]
        self.assertIn("health.rowLines(now: evaluatedAt, availability: availability)", draw)
        self.assertIn("teamClaudeGroupedLayout(groups: groups, lines: lines, expanded: expanded)", draw)
        self.assertIn("teamClaudeRowHeight(lines[i], expanded: isExpanded)", draw)
        self.assertIn("teamClaudeReasonLineY(lines[i])", draw)

    def test_judgement_lives_outside_main(self):
        rows = (SOURCES / "TeamClaudeRowLines.swift").read_text()
        for symbol in ("func teamClaudeReasonLineIsInformative(", "func accountSubscriptionLineIsInformative(",
                       "func teamClaudeRowHeight(", "func teamClaudeRowOrigins(", "func teamClaudeRowsHeight(",
                       "func teamClaudeGroupedLayout(", "enum TeamClaudeRowReason", "enum TeamClaudeColumns"):
            self.assertIn(symbol, rows)
        availability = (SOURCES / "TeamClaudeAvailability.swift").read_text()
        self.assertIn("func rowLines(", availability)
        # 생략 가능한 사유 문구는 상수를 거쳐야 한다. 문자열을 두 파일에 따로 두면 한쪽만 고쳐져 판정이 빗나간다.
        for literal in ('"한도 기준 확인 필요"', '"오프라인 · 확인 필요"', '"최신 한도 측정 필요"',
                        '"Fable 사용 가능"', '"Opus 사용 가능"'):
            self.assertNotIn(literal, availability)

    def test_row_height_change_is_relayed_to_the_dashboard(self):
        # 시간 경과·구독 자동 조회로 줄 판정이 바뀌면 표 혼자 못 늘어난다. 대시보드 재구성까지 이어져야 한다.
        self.assertIn("onContentHeightChange", self.table)
        self.assertIn("table.onContentHeightChange = { [weak self] in self?.onTeamRowsChange?() }", self.dashboard)
        # 행을 펼치면 표·Claude 탭 문서 높이를 다시 잡는다(펼친 행은 재구성을 지나도 유지).
        self.assertIn("table.onExpansionChange = { [weak self] in self?.relayoutClaudeTab() }", self.dashboard)
        self.assertIn("table.expandedAccount = expandedClaudeAccount", self.dashboard)
        self.assertIn("Self.teamContentHeight(teamClaude) != renderedTeamHeight", self.dashboard)
        self.assertIn('scheduleDashboardRefresh(reason: "team-rows")', self.main)

    def test_cli_lanes_share_one_card(self):
        # Grok·agy는 레인당 한 줄. 카드 두 장(96 + 4 + 168pt)으로 되돌아가면 잡는다.
        cli = (SOURCES / "CliQuotaCards.swift").read_text()
        self.assertEqual(1, cli.count("final class "), "one card holds both lanes")
        self.assertIn("final class CliQuotaLanesView", cli)
        self.assertIn("static let cliHeight: CGFloat = CliQuotaLanesView.fixedHeight", self.dashboard)
        for legacy in ("GrokQuotaCardView", "AgyQuotaCardView"):
            self.assertNotIn(legacy, self.main)
            self.assertNotIn(legacy, cli)



class PanelStructureTests(unittest.TestCase):
    """A안 구조: 맨 위 요약 띠 대신 개요 탭, 표는 상태별 묶음, 리셋은 열 머리에 한 번, 경고색은 98% 라우팅 문턱.
    표 상단 기하는 TeamClaudeCardMetrics 하나에서 나와 높이·배치·그리기가 같은 값을 쓴다."""

    def setUp(self):
        self.main = MAIN.read_text()
        self.table = class_body(self.main, "TeamClaudeTableView")
        self.dashboard = class_body(self.main, "StatusMenuDashboardView")
        self.overview = (SOURCES / "OverviewTabView.swift").read_text()
        self.builder = (SOURCES / "DashboardOverviewBuilder.swift").read_text()
        self.palette = PALETTE.read_text()

    def test_overview_replaces_the_summary_band(self):
        self.assertNotIn("final class ServiceAvailabilitySummaryView", self.main)
        self.assertIn("final class OverviewTabView", self.overview)
        # 예전 띠의 세 숫자(Claude Fable · Claude Opus · Codex)가 개요에 그대로 있다.
        self.assertIn("health.opusAvailability(now: now)", self.builder)
        self.assertIn("fableReady = availability.filter { $0.state == .ready }.count", self.builder)
        self.assertIn("pool.usableCount", self.builder)
        for lane in ('name: "Claude Fable"', 'name: "Codex"', 'name: "Grok"', 'name: "agy"'):
            self.assertIn(lane, self.builder)
        self.assertIn("ofSize: 52", self.palette, "the hero number is the one big figure")

    def test_table_groups_rows_and_states_resets_once(self):
        draw = self.table[self.table.index("override func draw("):]
        self.assertIn("teamClaudeRowGroup", draw)
        for title in ("L10n.groupReady", "L10n.groupLimited", "L10n.groupCheck", "L10n.groupExcluded"):
            self.assertIn(title, draw)
        self.assertIn("L10n.resetIn(", draw, "column heads carry the reset")
        # 계정별 문제 사유는 어떤 경우에도 그린다.
        self.assertIn("teamAccountErrorReasonLabel(row.errorReason)", draw)
        self.assertIn("issue.compactText", draw)
        self.assertIn("formatTeamClaudeProbe(row.probedAt)", draw)
        self.assertNotIn("row.source.map", draw, "the credential type (oauth) is neither a measurement nor a status")

    def test_warning_color_follows_the_routing_threshold(self):
        drawing = (SOURCES / "PanelDrawing.swift").read_text()
        self.assertIn("let panelRoutingThresholdPercent: Double = 98", drawing)
        self.assertIn("percent >= thresholdPercent", drawing)
        draw = self.table[self.table.index("override func draw("):]
        self.assertNotIn("percent >= 90", draw)
        self.assertNotIn("percent >= 70", draw)
        self.assertIn("thresholdPercent: threshold", draw)

    def test_numbers_are_right_aligned(self):
        drawing = (SOURCES / "PanelDrawing.swift").read_text()
        meter = drawing[drawing.index("static func meterWithValue("):]
        self.assertIn("right(value, rect.maxX", meter[:meter.index("\n    }\n")])
        draw = self.table[self.table.index("override func draw("):]
        self.assertIn("PanelDraw.meterWithValue(cell", draw)

    def test_card_metrics_are_shared_by_height_layout_and_draw(self):
        layout = self.table[self.table.index("override func layout()"):]
        layout = layout[:layout.index("\n    }\n")]
        self.assertIn("TeamClaudeCardMetrics.rowsTop(hostLine:", layout)
        draw = self.table[self.table.index("override func draw("):]
        self.assertIn("TeamClaudeCardMetrics.rowsTop(hostLine:", draw)
        self.assertIn("TeamClaudeCardMetrics.stripY(hostLine:", draw)
        self.assertIn("TeamClaudeCardMetrics.tableHeadY(hostLine:", draw)
        for literal in ("tableY + 34", "statY + 88", "topY + 14", "innerX + 790"):
            self.assertNotIn(literal, self.table, f"a hard-coded offset would diverge from the shared metrics: {literal}")

    def test_actions_moved_to_the_footer_list(self):
        # 예전 동작 행(새로고침·측정·가져오기·OAuth 두 가지·서버 재시작·로그인 시 열기·종료)이 하나도 빠지지 않는다.
        actions = self.main[self.main.index("    func dashboardActions(menu: NSMenu)"):]
        actions = actions[:actions.index("\n    }\n")]
        for target in ("refreshAction()", "measureTeamClaudeAction()", "importClaudeCodeAccountAction()",
                       "addClaudeOAuthAccountAction()", "addCodexOAuthAccountAction()", "restartTeamClaudeAction()",
                       "toggleLoginItem()", "quitAction()"):
            self.assertIn(target, actions)
        self.assertIn("menubarLoginItemAvailable(bundlePath: Bundle.main.bundlePath)", actions)
        # 로그인 시 열기는 메뉴를 닫지 않으므로 토글 결과 문구를 돌려줘야 열린 목록의 detail이 바뀐다(LoginItemTests가 동작을 본다).
        self.assertIn("menubarLoginItemAction(", actions)
        self.assertIn("return self?.toggleLoginItem()", actions)
        on_run = self.main[self.main.index("actionList.onRun = {"):]
        on_run = on_run[:on_run.index("\n        }\n")]
        self.assertIn("let detail = action.run()", on_run)
        self.assertIn("self.actionList.updateDetail(id: action.id, detail: detail)", on_run)
        self.assertNotIn("final class MenuActionRowView", self.main)
        self.assertIn("addDashboardShortcutItems(to: menu)", self.main)


class SubscriptionBurnWiringTests(unittest.TestCase):
    """구독·소진 섹션이 모든 소비 지점에 연결됐는지 본다.

    상태를 계산해 놓고 화면 일부에만 전달하는 실수가 이 저장소에서 다섯 번 났다
    (2026-09-24 적대 리뷰). 섹션 등록·높이·갱신·이력·스냅샷을 각각 단언한다.
    """

    def setUp(self):
        self.main = MAIN.read_text()

    def test_section_is_registered_in_both_lists(self):
        # 높이 계산과 배치가 같은 섹션 목록을 봐야 섹션이 잘리지 않는다.
        self.assertEqual(self.main.count('(id: "burn", title: L10n.sectionBurn'), 1, "one list feeds height and layout")
        self.assertIn("sectionBodies(", self.main[self.main.index("    static func tabContentHeights("):])

    def test_every_height_call_passes_the_model(self):
        """높이 계산과 그리기가 다른 모델을 보면 화면이 그만큼 잘린다.

        기본값이 있으면 호출부가 조용히 빈 모델을 본다. 실제로 그렇게 잘렸다
        (2026-09-27: 계산 114pt 대 그리기 236pt). 기본값을 없애 컴파일러가
        강제하게 했고, 그 계약이 되살아나지 않도록 여기서 고정한다.
        """
        self.assertNotIn(
            "burnModel: SubscriptionBurnModel = SubscriptionBurnModel(", self.main,
            "burnModel에 기본값을 두면 호출부가 다른 모델을 볼 수 있다")
        for call in re.finditer(r"StatusMenuDashboardView\.preferredHeight\(", self.main):
            tail = self.main[call.end():call.end() + 400]
            with self.subTest(pos=call.start()):
                self.assertIn("burnModel:", tail[:tail.index(")")+1] if ")" in tail else tail)

    def test_height_uses_the_view_metric(self):
        self.assertIn("SubscriptionBurnView.preferredHeight(", self.main)

    def test_model_reaches_the_view_on_refresh(self):
        self.assertIn("burnView?.model = burnModel", self.main)

    def test_history_is_recorded_from_polling(self):
        self.assertIn("quotaCycleBoundary(", self.main)
        self.assertIn("quotaDropBoundary(", self.main)
        self.assertIn("quotaHistoryTrimmed(", self.main)

    def test_every_paid_lane_reaches_the_model(self):
        # 픽스처에는 있는데 실제 경로에 없으면 렌더 검증이 누락을 가린다.
        # Codex가 정확히 그렇게 빠져 있었다(적대 리뷰 2026-09-24).
        body = self.main[self.main.index("func refreshBurnModel("):]
        head = body[:body.index("\n    func ", 10)]
        for lane in ('"claude"', '"codex"', '"agy"', '"grok"'):
            with self.subTest(lane=lane):
                self.assertIn(lane, head)

    def test_unsubscribed_accounts_are_neither_paid_nor_errors(self):
        # 실측(2026-09-27): 오류 6개가 전부 구독 종료였다. 오류로 세면 "재인증"을 권하고,
        # 지불로 세면 월 지출이 $1,200 부풀려진다.
        # 두 풀은 종료 표식이 다르다. 한쪽만 보면 다른 풀의 종료 계정이 지불로 잡힌다
        # (Codex end-date-reached 2개가 그렇게 잡혀 있었다).
        self.assertIn('subscriptionEnded: $0.errorReason == "subscription-disabled"', self.main)
        self.assertIn("subscriptionEnded: $0.isSubscriptionRetired(now: now)", self.main)
        self.assertIn("paidAccounts: subscribed.count", self.main)
        self.assertIn("unsubscribedAccounts: unsubscribed.count", self.main)
        # 계정당 한 칸. 해지이면서 꺼 둠인 계정을 두 번 세지 않는다.
        self.assertIn('disabledAccounts: subscribed.filter { $0.status != "error" && !$0.enabled }', self.main)

    def test_currency_symbol_reaches_the_screen(self):
        self.assertIn("currency: subscriptionCurrency()", self.main)
        self.assertIn("currency: model.currency", (SOURCES / "SubscriptionBurnView.swift").read_text())

    def test_dead_pool_is_not_reported_as_exhausted(self):
        # 살아 있는 계정이 없으면 "한도 소진"이 아니라 "잴 수 없음"이다.
        self.assertIn("!measured.isEmpty && measured.count == live.count", self.main)

    def test_cycles_are_recorded_per_account(self):
        # 계정마다 리셋 시각이 다르므로 풀 전체를 한 경계로 닫으면 평균이 섞인다.
        self.assertIn('account: String? = nil', self.main)
        self.assertIn('\\(account ?? "-")', self.main)

    def test_snapshot_can_render_the_section(self):
        # 실패 화면은 실패했을 때만 나타나 평소 스냅샷에 걸리지 않는다.
        self.assertIn('fixture["burn"]', self.main)



if __name__ == "__main__":
    unittest.main()
