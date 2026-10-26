// menubar/Tests/DashboardOverviewBuilderTests.swift
import Cocoa

// makeOverviewModel 직접 검사(Phase 2 리뷰 증거 공백). 개요 탭이 그리는 숫자·레인·손볼 것이
// 스냅샷과 같은 픽스처(make_dash_fixture.py --codex)에서 기대한 대로 나오는지 본다.
// TeamClaudeHealth가 main.swift에 있어 러너가 직접 못 돌린다 — test_dashboard_overview_builder.py가
// main.swift 진입점 앞부분을 잘라 붙여 컴파일하고 픽스처 경로를 넘긴다.
@main
struct DashboardOverviewBuilderTests {
    static func main() {
        _ = NSApplication.shared
        L10n.language = .ko
        guard CommandLine.arguments.count > 1,
              let data = FileManager.default.contents(atPath: CommandLine.arguments[1]),
              let fixture = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            preconditionFailure("usage: DashboardOverviewBuilderTests <fixture.json from make_dash_fixture.py --codex>")
        }
        let now = Date()
        let health = parseTeamClaudeHealth(config: nil, server: nil, status: fixture["teamclaude"] as? [String: Any], port: 3456, now: now)
        guard let codexRaw = fixture["teamcodex"],
              let codexData = try? JSONSerialization.data(withJSONObject: codexRaw),
              let codex = try? teamCodexPoolHealth(from: codexData, port: 3457, serverPid: nil) else {
            preconditionFailure("fixture must carry the TeamCodex pool (--codex)")
        }
        let burn = subscriptionBurnFixture(fixture["burn"] as? [String: Any])
        let input = DashboardOverviewInput(teamClaude: health, teamCodex: codex,
                                           grok: GrokCardModel(headline: "Grok 21%", detail: nil),
                                           agy: AgyCardModel(message: nil, groups: []),
                                           burn: burn, notices: DashboardToolNotices(), now: now)
        testFixtureModel(makeOverviewModel(input))
        testNoticesReplaceLanes(input)
        testMissingSources(input)
        testWaitGroupsSplitSessionFromWeekly(fixture: fixture, input: input, now: now)
        print("DashboardOverviewBuilderTests: counts, lanes, todos, waiting, notices passed")
    }

    static func testFixtureModel(_ model: OverviewModel) {
        // 큰 숫자: 지금 요청을 받는 계정(acct-01…12) / 전체 17
        precondition(model.routable == 12 && model.total == 17, "routable \(model.routable)/\(model.total)")
        precondition(model.headline == "Claude 계정 12개가 지금 요청을 받습니다.", model.headline)
        precondition(model.resetLine.contains("세션 창") && model.resetLine.contains("주간 창") && model.resetLine.hasSuffix("리셋"),
                     model.resetLine)
        precondition(model.claudeNotice == nil && model.codexNotice == nil)

        // 띠: 계정마다 한 칸, 상태별 수
        precondition(model.strip.count == 17)
        precondition(model.strip.map(\.name) == (1...17).map { String(format: "acct-%02d", $0) })
        precondition(model.readyCount == 12 && model.waitCount == 2 && model.excludedCount == 3,
                     "ready \(model.readyCount) wait \(model.waitCount) excluded \(model.excludedCount)")
        precondition(model.strip.filter(\.excluded).map(\.name) == ["acct-13", "acct-14", "acct-15"])
        precondition(model.elapsedCaption?.hasPrefix("주간 창 ") == true, model.elapsedCaption ?? "nil")

        // 기다리면 풀림: 한도에 걸린 두 계정
        precondition(model.waitingNames == ["acct-16", "acct-17"], "\(model.waitingNames)")
        precondition(model.waitingCaption != nil)
        // 두 계정 모두 주간 창이 찼다 → 주간 한도 묶음 하나(며칠 뒤 복귀)
        precondition(model.waitGroups.map(\.window) == [.weekly] && model.waitGroups[0].count == 2, "\(model.waitGroups)")
        precondition(model.waitingCaption?.hasPrefix("기다리면 풀림 — 주간 한도 2개 ") == true, model.waitingCaption ?? "nil")

        // 레인 4개
        precondition(model.lanes.map(\.name) == ["Claude Fable", "Codex", "Grok", "agy"])
        precondition(model.lanes.map(\.tab) == [.claude, .codex, .cli, .cli])
        let claude = model.lanes[0], codexLane = model.lanes[1], grok = model.lanes[2], agy = model.lanes[3]
        precondition(claude.value == "12" && claude.unit == "/ 17" && !claude.quiet, "\(claude)")
        precondition(codexLane.value == "3" && codexLane.unit == "/ 5" && !codexLane.quiet, "\(codexLane)")
        precondition(grok.value == "21%" && grok.note == L10n.usageRate && !grok.quiet, "\(grok)")
        precondition(agy.quiet && agy.note == L10n.waitingForValue, "\(agy)")

        // 손볼 것: 사람이 움직여야 풀리는 계정. 오류가 먼저, 꺼 둔 계정, 그다음 Codex 되돌리기.
        let todos = model.todos.map { "\($0.provider)/\($0.name)" }
        precondition(todos == ["anthropic/acct-13", "anthropic/acct-14", "anthropic/acct-15", "codex/codex-05"], "\(todos)")
        precondition(model.todos[0].action == .reauthenticate && model.todos[0].primary && model.todos[0].tone == .error)
        precondition(model.todos[0].reason == L10n.todoReasonReauth, model.todos[0].reason)
        precondition(model.todos[1].action == .subscriptionRecord && !model.todos[1].primary)
        precondition(model.todos[1].reason == L10n.todoReasonOrgBlocked, model.todos[1].reason)
        precondition(model.todos[2].action == .none && model.todos[2].actionTitle == nil)
        precondition(model.todos[2].reason == L10n.todoReasonDisabled, model.todos[2].reason)
        precondition(model.todos[3].action == .codexRecover(.reauth) && model.todos[3].label.hasPrefix("Codex · "))
        precondition(!model.todos.contains { $0.name == "acct-16" || $0.name == "acct-17" }, "waiting accounts are not todos")

        // 소진 미리보기: 레인 4개의 판정 문구
        precondition(model.burnLines.count == 4, "\(model.burnLines.count)")
        precondition(model.burnLines.allSatisfy { !$0.verdict.isEmpty && !$0.projection.isEmpty })
    }

    /// 미설치 안내가 있으면 그 섹션의 숫자 대신 안내를 쓴다(Phase 1 R1).
    static func testNoticesReplaceLanes(_ input: DashboardOverviewInput) {
        guard let claudeNotice = teamClaudeToolNotice(configPresent: false, serverReachable: false, accountCount: 0),
              let codexNotice = teamCodexToolNotice(configPresent: false, serverReachable: false, accountCount: 0) else {
            preconditionFailure("tool notices for TeamClaude and Codex must exist")
        }
        let notices = DashboardToolNotices(sections: ["claude": claudeNotice, "codex": codexNotice])
        let model = makeOverviewModel(DashboardOverviewInput(teamClaude: input.teamClaude, teamCodex: input.teamCodex,
                                                             grok: input.grok, agy: input.agy, burn: input.burn,
                                                             notices: notices, now: input.now))
        precondition(model.claudeNotice == claudeNotice && model.codexNotice == codexNotice)
        precondition(model.strip.isEmpty && model.routable == 0 && model.waitingNames.isEmpty)
        precondition(model.lanes[0].value == L10n.notInstalled && model.lanes[0].quiet)
        precondition(model.lanes[1].value == L10n.notInstalled && model.lanes[1].quiet)
        precondition(model.todos.isEmpty, "a notice hides the section's todos too: \(model.todos.map(\.name))")
    }

    /// 값이 아직 없으면 숫자를 지어내지 않는다.
    static func testMissingSources(_ input: DashboardOverviewInput) {
        let model = makeOverviewModel(DashboardOverviewInput(teamClaude: nil, teamCodex: nil, grok: input.grok, agy: input.agy,
                                                             burn: SubscriptionBurnModel(usages: [], rates: [:], recommendations: []),
                                                             notices: DashboardToolNotices(), now: input.now))
        precondition(model.strip.isEmpty && model.todos.isEmpty && model.total == 0)
        precondition(model.lanes[0].value == StatusVocabulary.checking && model.lanes[0].quiet)
        precondition(model.lanes[1].value == StatusVocabulary.none && model.lanes[1].quiet)
        precondition(model.burnLines.isEmpty && model.burnAside == nil)
    }

    /// 실사용 QA 2026-10-26: 주간 43%인데 세션 창이 찬 계정이 막대에서 "왜 대기인지" 보이지 않았다.
    /// 세션 창이 막은 계정은 세션 한도 묶음(몇 시간)으로, 주간이 찬 계정은 주간 한도 묶음(며칠)으로 센다.
    static func testWaitGroupsSplitSessionFromWeekly(fixture: [String: Any], input: DashboardOverviewInput, now: Date) {
        guard var status = fixture["teamclaude"] as? [String: Any],
              var accounts = status["accounts"] as? [[String: Any]],
              let index = accounts.firstIndex(where: { $0["name"] as? String == "acct-17" }),
              var quota = accounts[index]["quota"] as? [String: Any] else {
            preconditionFailure("fixture must carry acct-17")
        }
        quota["unified7d"] = 0.43
        accounts[index]["quota"] = quota
        status["accounts"] = accounts
        let health = parseTeamClaudeHealth(config: nil, server: nil, status: status, port: 3456, now: now)
        let model = makeOverviewModel(DashboardOverviewInput(teamClaude: health, teamCodex: input.teamCodex,
                                                             grok: input.grok, agy: input.agy, burn: input.burn,
                                                             notices: input.notices, now: now))
        precondition(model.waitingNames == ["acct-16", "acct-17"], "\(model.waitingNames)")
        precondition(model.waitGroups.map(\.window) == [.session, .weekly], "\(model.waitGroups)")
        precondition(model.waitGroups.map(\.count) == [1, 1], "\(model.waitGroups)")
        // 세션 창은 픽스처에서 4시간 뒤, 주간 창은 6일 뒤에 리셋된다.
        let caption = model.waitingCaption ?? ""
        precondition(caption.contains("세션 한도 1개 3시간") || caption.contains("세션 한도 1개 4시간"), caption)
        precondition(caption.contains("주간 한도 1개 5일") || caption.contains("주간 한도 1개 6일"), caption)
        // 주간 43% 칸의 채움은 호박색이 아니다(색은 주간 문턱만 말한다) — 상태는 위 띠가 대기로 말한다.
        let column = model.strip.first { $0.name == "acct-17" }!
        precondition(column.tone == .wait && overviewStripStateBand(column.tone) == .wait)
        precondition(overviewStripStateBand(.ready) == .ready && overviewStripStateBand(.error) == nil)

        // 사용률과 무관하게 throttled로 기다리는 계정은 세션 한도로 세지 않고 일시 대기로 센다(검토 지적).
        accounts[index]["status"] = "throttled"
        quota["unified5h"] = 0.43
        quota["unified7d"] = 0.20
        accounts[index]["quota"] = quota
        status["accounts"] = accounts
        let throttledHealth = parseTeamClaudeHealth(config: nil, server: nil, status: status, port: 3456, now: now)
        let throttled = makeOverviewModel(DashboardOverviewInput(teamClaude: throttledHealth, teamCodex: input.teamCodex,
                                                                 grok: input.grok, agy: input.agy, burn: input.burn,
                                                                 notices: input.notices, now: now))
        precondition(throttled.waitGroups.map(\.window) == [.weekly, .other], "\(throttled.waitGroups)")
        precondition(throttled.waitingCaption?.contains("일시 대기 1개") == true, throttled.waitingCaption ?? "nil")
    }
}
