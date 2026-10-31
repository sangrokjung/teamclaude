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
        testWaitingSortedByReturn(fixture: fixture, input: input, now: now)
        testProjectionOnlyForFastAccounts(fixture: fixture, input: input, now: now)
        testWeeklyOnlyAccount(fixture: fixture, input: input, now: now)
        testWeeklyOnlyRetryAfter(now: now)
        print("DashboardOverviewBuilderTests: counts, lanes, todos, waiting, notices passed")
    }

    static func testFixtureModel(_ model: OverviewModel) {
        // 큰 숫자: 지금 요청을 받는 계정(acct-01…12) / 전체 17
        precondition(model.routable == 12 && model.total == 17, "routable \(model.routable)/\(model.total)")
        precondition(model.headline == "Claude 계정 12개가 지금 요청을 받습니다.", model.headline)
        precondition(model.resetLine.contains("세션 창") && model.resetLine.contains("주간 창") && model.resetLine.hasSuffix("리셋"),
                     model.resetLine)
        precondition(model.claudeNotice == nil && model.codexNotice == nil)

        // 상태별 수: 큰 숫자와 같은 라우팅 판정
        precondition(model.readyCount == 12 && model.waitCount == 2 && model.excludedCount == 3,
                     "ready \(model.readyCount) wait \(model.waitCount) excluded \(model.excludedCount)")
        precondition(model.sessionWaitCount == 0 && model.weeklyWaitCount == 2 && model.otherWaitCount == 0)
        precondition(model.hasLedger)

        // 지금 받는 계정: 세션 많이 찬 순(acct-12 68% … acct-01 24%). 세션 창은 4시간 뒤 리셋 → 20% 지남.
        precondition(model.live.map(\.name) == (1...12).reversed().map { String(format: "acct-%02d", $0) }, "\(model.live.map(\.name))")
        let top = model.live[0]
        precondition(abs((top.sessionElapsed ?? 0) - 0.2) < 0.01, "\(String(describing: top.sessionElapsed))")
        precondition(top.sessionResetClock != nil && (top.sessionRemainingSeconds ?? 0) > 3.9 * 3_600)
        precondition(top.weekly.label == L10n.weeklyShort && top.weekly.percent != nil && top.fable.label == "Fable")
        // 68%를 20% 지난 창에서 썼다 → 리셋 전에 98%에 닿는다.
        precondition(top.projection != nil, "acct-12 must warn")

        // 제외: 손볼 것과 같은 세 계정이라 목록은 다시 그리지 않는다.
        precondition(model.excluded.map(\.name) == ["acct-13", "acct-14", "acct-15"], "\(model.excluded.map(\.name))")
        precondition(model.excluded.allSatisfy(\.inTodos))

        // 복귀 대기: 한도에 걸린 두 계정, 둘 다 주간 창까지 찼다 → 주간 가득(6일 뒤 복귀)
        precondition(model.waiting.map(\.name) == ["acct-16", "acct-17"], "\(model.waiting.map(\.name))")
        precondition(model.waiting.allSatisfy { $0.cause == .weekly && ($0.returnSeconds ?? 0) > 5 * 86_400 && $0.returnClock != nil })
        precondition(model.nextReturn?.name == "acct-16")

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
        // 구독 기록이 없는 인증 오류는 재인증을 유지하고 해지 기록 안내를 붙인다(시안 B 2차본).
        precondition(model.todos[0].reason == "\(L10n.todoReasonReauth) · \(L10n.subTodoReauthHint)", model.todos[0].reason)
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
        precondition(!model.hasLedger && model.routable == 0 && model.waiting.isEmpty)
        precondition(model.lanes[0].value == L10n.notInstalled && model.lanes[0].quiet)
        precondition(model.lanes[1].value == L10n.notInstalled && model.lanes[1].quiet)
        precondition(model.todos.isEmpty, "a notice hides the section's todos too: \(model.todos.map(\.name))")
    }

    /// 값이 아직 없으면 숫자를 지어내지 않는다.
    static func testMissingSources(_ input: DashboardOverviewInput) {
        let model = makeOverviewModel(DashboardOverviewInput(teamClaude: nil, teamCodex: nil, grok: input.grok, agy: input.agy,
                                                             burn: SubscriptionBurnModel(usages: [], rates: [:], recommendations: []),
                                                             notices: DashboardToolNotices(), now: input.now))
        precondition(!model.hasLedger && model.todos.isEmpty && model.total == 0)
        precondition(model.lanes[0].value == StatusVocabulary.checking && model.lanes[0].quiet)
        precondition(model.lanes[1].value == StatusVocabulary.none && model.lanes[1].quiet)
        precondition(model.burnLines.isEmpty && model.burnAside == nil)
    }

    static func rebuilt(_ status: [String: Any], input: DashboardOverviewInput, now: Date) -> OverviewModel {
        let health = parseTeamClaudeHealth(config: nil, server: nil, status: status, port: 3456, now: now)
        return makeOverviewModel(DashboardOverviewInput(teamClaude: health, teamCodex: input.teamCodex,
                                                        grok: input.grok, agy: input.agy, burn: input.burn,
                                                        notices: input.notices, now: now))
    }

    /// 복귀 대기는 빨리 풀리는 순이다. 원인 태그는 판정의 blockedWindows로 나눈다:
    /// 세션만 → 세션 가득(세션 리셋에 복귀), 주간 포함 → 주간 가득(주간 리셋), 막힌 창 없음(throttled) → 일시 대기(복귀 시각 모름, 맨 뒤).
    static func testWaitingSortedByReturn(fixture: [String: Any], input: DashboardOverviewInput, now: Date) {
        guard var status = fixture["teamclaude"] as? [String: Any],
              var accounts = status["accounts"] as? [[String: Any]],
              let index = accounts.firstIndex(where: { $0["name"] as? String == "acct-17" }),
              var quota = accounts[index]["quota"] as? [String: Any] else {
            preconditionFailure("fixture must carry acct-17")
        }
        // acct-17: 세션 98%만 막혔다(주간 43%) → 4시간 뒤 복귀. acct-16은 세션·주간이 함께 막혀 6일 뒤 복귀.
        quota["unified7d"] = 0.43
        accounts[index]["quota"] = quota
        status["accounts"] = accounts
        let model = rebuilt(status, input: input, now: now)
        precondition(model.waiting.map(\.name) == ["acct-17", "acct-16"], "sooner first: \(model.waiting.map(\.name))")
        precondition(model.waiting.map(\.cause) == [.session, .weekly], "\(model.waiting.map(\.cause))")
        precondition(model.sessionWaitCount == 1 && model.weeklyWaitCount == 1 && model.otherWaitCount == 0)
        let session = model.waiting[0]
        precondition(session.weeklyPercent == 43, "session-full rows carry the weekly percent: \(String(describing: session.weeklyPercent))")
        precondition((session.returnSeconds ?? 0) > 3.9 * 3_600 && (session.returnSeconds ?? 0) <= 4 * 3_600, "\(String(describing: session.returnSeconds))")
        precondition(model.waiting[1].weeklyPercent == nil, "weekly-full rows do not repeat the weekly bar")
        precondition(model.nextReturn?.name == "acct-17")
        precondition(OverviewWaitCause.session.tag == "세션 가득" && OverviewWaitCause.weekly.tag == "주간 가득")

        // 사용률과 무관하게 throttled로 기다리는 계정은 일시 대기 — 복귀 시각을 창으로 말할 수 없어 맨 뒤.
        accounts[index]["status"] = "throttled"
        quota["unified5h"] = 0.43
        quota["unified7d"] = 0.20
        accounts[index]["quota"] = quota
        status["accounts"] = accounts
        let throttled = rebuilt(status, input: input, now: now)
        precondition(throttled.waiting.map(\.name) == ["acct-16", "acct-17"], "\(throttled.waiting.map(\.name))")
        precondition(throttled.waiting.map(\.cause) == [.weekly, .other], "\(throttled.waiting.map(\.cause))")
        precondition(throttled.waiting[1].returnSeconds == nil && throttled.waiting[1].note == L10n.stateLimited)
        precondition(throttled.otherWaitCount == 1 && throttled.waitCount == 2)
        precondition(OverviewWaitCause.other.tag == "일시 대기")
    }

    /// 속도 경고: 지금 속도(세션 사용률 ÷ 지난 비율)로 리셋 전에 98%에 닿는 계정만.
    static func testProjectionOnlyForFastAccounts(fixture: [String: Any], input: DashboardOverviewInput, now: Date) {
        guard var status = fixture["teamclaude"] as? [String: Any],
              var accounts = status["accounts"] as? [[String: Any]],
              let index = accounts.firstIndex(where: { $0["name"] as? String == "acct-01" }),
              var quota = accounts[index]["quota"] as? [String: Any] else {
            preconditionFailure("fixture must carry acct-01")
        }
        // 20% 지난 창에서 5% → 리셋 때 25%. 경고하지 않는다.
        quota["unified5h"] = 0.05
        accounts[index]["quota"] = quota
        status["accounts"] = accounts
        let model = rebuilt(status, input: input, now: now)
        guard let slow = model.live.first(where: { $0.name == "acct-01" }),
              let fast = model.live.first(where: { $0.name == "acct-12" }) else { preconditionFailure("live accounts") }
        precondition(slow.projection == nil, "slow account must not warn: \(String(describing: slow.projection))")
        guard let projection = fast.projection else { preconditionFailure("fast account must warn") }
        // 68% / 0.2 → 창 끝이면 340%. 98%에는 창의 28.8% 지점(=지금부터 약 26분 뒤)에 닿는다.
        precondition(abs(projection.hitsLimitInSeconds - (0.98 / 3.4 - 0.2) * 5 * 3_600) < 120, "\(projection.hitsLimitInSeconds)")
        precondition(projection.earlierBySeconds > 3 * 3_600)
        precondition(model.live.last?.name == "acct-01", "lowest session last: \(model.live.map(\.name))")
    }

    /// 5시간 창이 없는 계정(검증된 Ultra, spec A6). 프록시가 quota.sessionWindowStated=false를 준다.
    /// 세션 칸은 "없음", 가용·손볼 것·대기는 주간 창만으로, 세션 속도 경고는 없다.
    static func weeklyOnlyStatus(_ fixture: [String: Any], name: String = "acct-01",
                                 edit: (inout [String: Any]) -> Void) -> [String: Any] {
        guard var status = fixture["teamclaude"] as? [String: Any],
              var accounts = status["accounts"] as? [[String: Any]],
              let index = accounts.firstIndex(where: { $0["name"] as? String == name }),
              var quota = accounts[index]["quota"] as? [String: Any] else {
            preconditionFailure("fixture must carry \(name)")
        }
        quota.removeValue(forKey: "unified5h")
        quota.removeValue(forKey: "unified5hReset")
        quota["sessionWindowStated"] = false
        edit(&quota)
        accounts[index]["quota"] = quota
        status["accounts"] = accounts
        return status
    }

    static func testWeeklyOnlyAccount(fixture: [String: Any], input: DashboardOverviewInput, now: Date) {
        // 1. 주간 34%만 있는 계정: 사용 가능, 측정 문제 없음, 세션 값 없음.
        let status = weeklyOnlyStatus(fixture) { _ in }
        let health = parseTeamClaudeHealth(config: nil, server: nil, status: status, port: 3456, now: now)
        guard let row = health.accounts.first(where: { $0.name == "acct-01" }) else { preconditionFailure("acct-01") }
        precondition(row.sessionWindowAbsent && row.sessionPercent == nil && row.sessionResetSeconds == nil && row.sessionResetAt == nil)
        precondition(row.isUsable, "weekly-only account at 34% is usable")
        precondition(row.measurementIssue == nil, "no 5h window is not a measurement issue: \(String(describing: row.measurementIssue))")
        precondition(health.accounts.filter { $0.name != "acct-01" }.allSatisfy { !$0.sessionWindowAbsent }, "other rows keep the session window")

        let model = rebuilt(status, input: input, now: now)
        precondition(model.routable == 12, "weekly-only account still routes: \(model.routable)")
        guard let live = model.live.first(where: { $0.name == "acct-01" }) else { preconditionFailure("acct-01 must be live: \(model.live.map(\.name))") }
        precondition(live.sessionWindowAbsent && live.sessionPercent == nil && live.projection == nil, "no session pace warning")
        precondition(live.sessionResetClock == nil && live.sessionRemainingSeconds == nil)
        precondition(live.weekly.percent != nil && abs((live.weekly.percent ?? 0) - 34) < 0.01, "\(String(describing: live.weekly.percent))")
        precondition(!model.todos.contains { $0.name == "acct-01" } && !model.waiting.contains { $0.name == "acct-01" })
        precondition(model.live.filter { $0.name != "acct-01" }.allSatisfy { !$0.sessionWindowAbsent })

        // 2. 합치기(이전 응답과 병합)를 거쳐도 라우팅 측정은 현재 것이고 플래그가 남는다.
        let merged = teamClaudeHealthMergingQuota(candidate: health, previous: nil)
        guard let mergedRow = merged.accounts.first(where: { $0.name == "acct-01" }) else { preconditionFailure("merged acct-01") }
        precondition(mergedRow.sessionWindowAbsent && mergedRow.isUsable && mergedRow.measurementIssue == nil)
        precondition(mergedRow.routingMeasurementCurrent == true, "a weekly-only row must not fall back to measurement-stale")
        precondition(mergedRow.fableMeasurementCurrent, "Fable lane is current without a session window too")
        let retained = teamClaudeRetainingQuota(candidate: health, previous: merged)
        precondition(retained.accounts.first(where: { $0.name == "acct-01" })?.sessionWindowAbsent == true, "offline retention keeps the flag")

        // 3. 주간 99%: 사용 가능이 아니라 주간 가득으로 기다린다.
        let full = rebuilt(weeklyOnlyStatus(fixture) { $0["unified7d"] = 0.99 }, input: input, now: now)
        precondition(full.routable == 11, "weekly-full weekly-only account is not routable: \(full.routable)")
        guard let waiting = full.waiting.first(where: { $0.name == "acct-01" }) else { preconditionFailure("acct-01 must wait: \(full.waiting.map(\.name))") }
        precondition(waiting.cause == .weekly && (waiting.returnSeconds ?? 0) > 5 * 86_400, "\(waiting.cause)")
        let fullHealth = parseTeamClaudeHealth(config: nil, server: nil, status: weeklyOnlyStatus(fixture) { $0["unified7d"] = 0.99 },
                                               port: 3456, now: now)
        precondition(fullHealth.accounts.first(where: { $0.name == "acct-01" })?.isUsable == false)

        // 4. 플래그 false인데 남은 5시간 값(99%)이 실려 와도 무시한다(세션 가득으로 막지 않는다).
        let lingering = weeklyOnlyStatus(fixture) {
            $0["unified5h"] = 0.99
            $0["unified5hReset"] = Int64(now.timeIntervalSince1970 * 1000) + 3_600_000
        }
        let lingeringModel = rebuilt(lingering, input: input, now: now)
        precondition(lingeringModel.live.first(where: { $0.name == "acct-01" })?.sessionWindowAbsent == true,
                     "lingering 5h value must not block a weekly-only account: \(lingeringModel.waiting.map(\.name))")

        // 5. 검증 해제·롤백: 5시간 헤더가 돌아와 플래그가 true면 세션 막대가 다시 나온다.
        let back = weeklyOnlyStatus(fixture) {
            $0["sessionWindowStated"] = true
            $0["unified5h"] = 0.24
            $0["unified5hReset"] = Int64(now.timeIntervalSince1970 * 1000) + 4 * 3_600_000
        }
        let backHealth = parseTeamClaudeHealth(config: nil, server: nil, status: back, port: 3456, now: now)
        guard let backRow = backHealth.accounts.first(where: { $0.name == "acct-01" }) else { preconditionFailure("acct-01") }
        precondition(!backRow.sessionWindowAbsent && abs((backRow.sessionPercent ?? 0) - 24) < 0.01)

        // 6. 구버전 프록시(필드 없음)·문자열 "false": 지금 동작 그대로(세션 누락은 측정 필요).
        for value in [nil, "false" as Any] {
            let old = weeklyOnlyStatus(fixture) {
                if let value { $0["sessionWindowStated"] = value } else { $0.removeValue(forKey: "sessionWindowStated") }
            }
            let oldHealth = parseTeamClaudeHealth(config: nil, server: nil, status: old, port: 3456, now: now)
            guard let oldRow = oldHealth.accounts.first(where: { $0.name == "acct-01" }) else { preconditionFailure("acct-01") }
            precondition(!oldRow.sessionWindowAbsent && !oldRow.isUsable && oldRow.measurementIssue == .sessionMissing,
                         "\(String(describing: value)): \(String(describing: oldRow.measurementIssue))")
        }
    }

    /// 재시도 시각(전원 막힘일 때 복귀까지 초)은 플래그 false 계정의 남은 5시간 값을 쓰지 않는다.
    static func testWeeklyOnlyRetryAfter(now: Date) {
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        func account(_ flag: Any?) -> [String: Any] {
            var quota: [String: Any] = ["unified5h": 0.99, "unified5hReset": nowMs + 3_600_000,
                                        "unified7d": 0.4, "unified7dReset": nowMs + 6 * 86_400_000]
            if let flag { quota["sessionWindowStated"] = flag }
            return ["name": "ultra-1", "enabled": true, "status": "active", "quota": quota]
        }
        let normal = computeTeamClaudeRetryAfterSeconds(accounts: [account(nil)], threshold: 0.98, nowMs: nowMs)
        precondition(normal != nil && abs((normal ?? 0) - 3_600) <= 1, "a normal 5h-full account waits for the 5h reset: \(String(describing: normal))")
        let absent = computeTeamClaudeRetryAfterSeconds(accounts: [account(false)], threshold: 0.98, nowMs: nowMs)
        precondition(absent == nil, "a weekly-only account is not blocked by a lingering 5h value: \(String(describing: absent))")
        var weeklyFull = account(false)
        var quota = weeklyFull["quota"] as! [String: Any]
        quota["unified7d"] = 0.99
        weeklyFull["quota"] = quota
        let weekly = computeTeamClaudeRetryAfterSeconds(accounts: [weeklyFull], threshold: 0.98, nowMs: nowMs)
        precondition(weekly != nil && abs((weekly ?? 0) - 6 * 86_400) <= 1, "weekly-full waits for the weekly reset: \(String(describing: weekly))")
    }
}
