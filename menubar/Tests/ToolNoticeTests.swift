// menubar/Tests/ToolNoticeTests.swift
import Cocoa

// 도구·데이터가 없을 때의 공통 상태(R1, R4) 회귀 검사.
// 판정 함수와, 그 상태를 그리는 소비 지점(공통 안내 카드·CLI 레인·구독 카드·섹션 요약)을 각각 확인한다.
@main
struct ToolNoticeTests {
    static func render(_ view: NSView) {
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            preconditionFailure("bitmap 생성 실패")
        }
        view.cacheDisplay(in: view.bounds, to: rep)
    }

    static func main() {
        _ = NSApplication.shared

        // MARK: 판정 — 도구별로 "없음"을 하나의 상태로 모은다
        let claude = teamClaudeToolNotice(configPresent: false, serverReachable: false, accountCount: 0)
        precondition(claude?.kind == .notInstalled && claude?.tool == .teamclaude)
        precondition(claude?.headline == "TeamClaude 미설치", claude?.headline ?? "nil")
        // 설정이 있거나 서버가 살아 있으면 미설치가 아니다(서버 꺼짐은 기존 화면이 다룬다).
        precondition(teamClaudeToolNotice(configPresent: true, serverReachable: false, accountCount: 0) == nil)
        precondition(teamClaudeToolNotice(configPresent: false, serverReachable: true, accountCount: 0) == nil)
        precondition(teamClaudeToolNotice(configPresent: false, serverReachable: false, accountCount: 2) == nil)

        precondition(teamCodexToolNotice(configPresent: false, serverReachable: false, accountCount: 0)?.headline
            == "TeamCodex 미설치")
        precondition(teamCodexToolNotice(configPresent: true, serverReachable: false, accountCount: 0) == nil)

        precondition(codexToolNotice(authPresent: false, configPresent: false, scannedLogFiles: 0, totalCalls: 0)?.headline
            == "Codex 미설치")
        precondition(codexToolNotice(authPresent: true, configPresent: false, scannedLogFiles: 0, totalCalls: 0) == nil)
        precondition(codexToolNotice(authPresent: false, configPresent: false, scannedLogFiles: 3, totalCalls: 0) == nil)
        // 호출 기록(calls.jsonl)만 있어도 쓸 수 있는 데이터다.
        precondition(codexToolNotice(authPresent: false, configPresent: false, scannedLogFiles: 0, totalCalls: 5) == nil)

        let codexBoth = codexSectionToolNotice(
            codex: codexToolNotice(authPresent: false, configPresent: false, scannedLogFiles: 0, totalCalls: 0),
            teamCodex: teamCodexToolNotice(configPresent: false, serverReachable: false, accountCount: 0))
        precondition(codexBoth?.headline == "Codex·TeamCodex 미설치", codexBoth?.headline ?? "nil")
        // 둘 중 하나라도 있으면 섹션을 안내로 바꾸지 않는다.
        precondition(codexSectionToolNotice(codex: nil,
            teamCodex: teamCodexToolNotice(configPresent: false, serverReachable: false, accountCount: 0)) == nil)

        let higgs = higgsfieldToolNotice(installed: false)
        precondition(higgs?.headline == "Higgsfield 미설치")
        precondition(higgs?.detail.contains("CC_MENUBAR_HIGGSFIELD_BIN") == true, higgs?.detail ?? "nil")
        precondition(higgsfieldToolNotice(installed: true) == nil)

        precondition(ccusageToolNotice(installed: false, outcome: nil, hasData: false)?.kind == .notInstalled)
        precondition(ccusageToolNotice(installed: false, outcome: nil, hasData: false)?.detail.contains("CC_MENUBAR_NPX_BIN") == true)
        precondition(ccusageToolNotice(installed: true, outcome: .noData, hasData: false)?.kind == .noData)
        precondition(ccusageToolNotice(installed: true, outcome: .noData, hasData: false)?.headline == "사용량 데이터 없음")
        // 아직 읽는 중이면 기존 "확인 중" 화면을 둔다.
        precondition(ccusageToolNotice(installed: true, outcome: nil, hasData: false) == nil)
        precondition(ccusageToolNotice(installed: true, outcome: .loaded, hasData: true) == nil)
        // 실행·해석 실패는 "데이터 없음"이 아니라 확인 필요다. 이전 값이 있으면 본문은 두고 꼬리말로 낡았다고 표시한다.
        let failed = ccusageToolNotice(installed: true, outcome: .failed(.exitStatus(3)), hasData: false)
        precondition(failed?.kind == .loadFailed && failed?.headline == "사용량 확인 필요", failed?.headline ?? "nil")
        precondition(failed?.detail.contains("종료 코드 3") == true, failed?.detail ?? "nil")
        precondition(ccusageToolNotice(installed: true, outcome: .failed(.unparsable), hasData: true) == nil)
        precondition(ccusageStaleNote(outcome: .failed(.timeout(seconds: 60)), hasData: true) == "갱신 실패(60초 시간 초과) · 이전 값")
        precondition(ccusageStaleNote(outcome: .failed(.timeout(seconds: 60)), hasData: false) == nil)
        precondition(ccusageStaleNote(outcome: .loaded, hasData: true) == nil)
        precondition(ccusageStaleNote(outcome: nil, hasData: true) == nil)
        // 지난 기록은 있는데 오늘 날짜 항목이 없으면 오늘이 0으로 보이는 이유를 붙인다. 기록이 아예 없으면 안내 카드 몫.
        precondition(ccusageStaleNote(outcome: .noData, hasData: true) == "오늘 사용 기록 없음")
        precondition(ccusageStaleNote(outcome: .noData, hasData: false) == nil)
        precondition(ccusageToolNotice(installed: true, outcome: .noData, hasData: true) == nil)

        // daily는 읽었는데 weekly·monthly가 실패하면 부분 결과라고 밝힌다. 같은 원인은 한 번에, 다르면 나눠 적는다.
        let monthlyFlood = [CcusageAuxFailure(command: .monthly, failure: .outputTooLarge)]
        precondition(ccusageStaleNote(outcome: .loaded, hasData: true, partial: monthlyFlood)
                     == "일부 갱신 실패(월간: 출력 크기 상한 초과) · 일별만 최신")
        let bothExit = [CcusageAuxFailure(command: .weekly, failure: .exitStatus(3)),
                        CcusageAuxFailure(command: .monthly, failure: .exitStatus(3))]
        precondition(ccusageStaleNote(outcome: .loaded, hasData: true, partial: bothExit)
                     == "일부 갱신 실패(주간/월간: 종료 코드 3) · 일별만 최신")
        let mixed = [CcusageAuxFailure(command: .weekly, failure: .timeout(seconds: 60)),
                     CcusageAuxFailure(command: .monthly, failure: .unparsable)]
        precondition(ccusageStaleNote(outcome: .loaded, hasData: true, partial: mixed)
                     == "일부 갱신 실패(주간: 60초 시간 초과, 월간: 출력 해석 실패) · 일별만 최신")
        // 오늘 항목 없음과 겹치면 둘 다 적는다. daily 자체가 실패했으면 그 꼬리말이 우선한다. 값이 없으면 안내 카드 몫.
        precondition(ccusageStaleNote(outcome: .noData, hasData: true, partial: monthlyFlood)
                     == "오늘 사용 기록 없음 · 일부 갱신 실패(월간: 출력 크기 상한 초과) · 일별만 최신")
        precondition(ccusageStaleNote(outcome: .failed(.exitStatus(3)), hasData: true, partial: monthlyFlood)
                     == "갱신 실패(종료 코드 3) · 이전 값")
        precondition(ccusageStaleNote(outcome: .loaded, hasData: false, partial: monthlyFlood) == nil)
        precondition(ccusageStaleNote(outcome: .loaded, hasData: true, partial: []) == nil)

        // 판정 순서: 실행 → 시간 초과 → 종료 코드 → 빈 출력 → 해석. 해석한 빈 결과만 noData.
        func outcome(launched: Bool = true, timedOut: Bool = false, exit: Int32 = 0, bytes: Int = 10,
                     parsed: Bool? = true, tooLarge: Bool = false) -> CcusageLoadOutcome {
            ccusageLoadOutcome(launched: launched, timedOut: timedOut, timeoutSeconds: 60, exitStatus: exit,
                               outputBytes: bytes, parsedHasToday: parsed, outputTooLarge: tooLarge)
        }
        precondition(outcome() == .loaded)
        precondition(outcome(parsed: false) == .noData)
        precondition(outcome(parsed: nil) == .failed(.unparsable))
        precondition(outcome(bytes: 0, parsed: nil) == .failed(.emptyOutput))
        precondition(outcome(exit: 1, parsed: false) == .failed(.exitStatus(1)))
        precondition(outcome(timedOut: true, exit: 137, parsed: false) == .failed(.timeout(seconds: 60)))
        precondition(outcome(launched: false, bytes: 0, parsed: nil) == .failed(.launch))
        // 출력 크기 상한 초과는 끊어서 생긴 종료 코드·빈 출력보다 앞선다.
        precondition(outcome(exit: 137, bytes: 0, parsed: nil, tooLarge: true) == .failed(.outputTooLarge))
        precondition(outcome(launched: false, bytes: 0, parsed: nil, tooLarge: true) == .failed(.launch))
        precondition(ccusageToolNotice(installed: true, outcome: .failed(.outputTooLarge), hasData: false)?.detail
            == "ccusage 출력 크기 상한 초과 · 다음 갱신 때 다시 시도합니다")

        precondition(grokToolNotice(cliInstalled: false, authPresent: false)?.headline == "Grok 미설치")
        // CLI는 있는데 인증 파일이 없으면 기존 "Grok 로그인"이 맞다.
        precondition(grokToolNotice(cliInstalled: true, authPresent: false) == nil)
        precondition(grokToolNotice(cliInstalled: false, authPresent: true) == nil)

        precondition(agyToolNotice().headline == "agy 미설치")
        precondition(agyToolNotice().detail.contains("CC_MENUBAR_AGY_BIN"))

        // R4: 구독 수집기 상태 파일이 없으면 선택 기능 미설치로 안내한다.
        let collector = subscriptionCollectorToolNotice(stateFileExists: false)
        precondition(collector?.headline == "수집기 미설치(선택 기능)", collector?.headline ?? "nil")
        precondition(subscriptionCollectorToolNotice(stateFileExists: true) == nil)
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("cc-menubar-notice-\(getpid())")
        try? FileManager.default.removeItem(at: tmp)
        let state = tmp.appendingPathComponent(".local/state/cc-menubar/subscription-monitor.json")
        precondition(subscriptionCollectorToolNotice(home: tmp.path)?.headline == "수집기 미설치(선택 기능)")
        try? FileManager.default.createDirectory(at: state.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: state.path, contents: Data("{}".utf8))
        precondition(subscriptionCollectorToolNotice(home: tmp.path) == nil)
        try? FileManager.default.removeItem(at: tmp)

        // 원시 오류 문자열을 그대로 내보내지 않는다.
        for notice in [claude, higgs, collector, codexBoth].compactMap({ $0 }) {
            precondition(!notice.headline.lowercased().contains("error"), notice.headline)
            precondition(!notice.detail.isEmpty, notice.headline)
        }

        // MARK: 섹션 배치 — 안내가 있으면 본문은 안내 카드 높이, 요약은 안내 제목
        var notices = DashboardToolNotices()
        precondition(notices.isEmpty)
        notices.sections["claude"] = claude
        precondition(dashboardNoticeBodyHeight(section: "claude", natural: 0, notices: notices) == ToolNoticeView.preferredHeight,
                     "health가 없어 0이던 섹션도 안내 카드로 보여야 한다")
        precondition(dashboardNoticeBodyHeight(section: "usage", natural: 176, notices: notices) == 176)
        precondition(dashboardNoticeSummary(section: "claude", natural: "계정 3", notices: notices) == "TeamClaude 미설치")
        precondition(dashboardNoticeSummary(section: "usage", natural: "오늘 1", notices: notices) == "오늘 1")
        precondition(dashboardNoticeSummary(section: "burn", natural: nil,
                                            notices: DashboardToolNotices(sections: ["burn": collector!]))
                     == "수집기 미설치(선택 기능)")

        // MARK: 소비 지점 1 — 공통 안내 카드가 실제로 그린다
        ToolNoticeDrawLog.isEnabled = true
        ToolNoticeDrawLog.reset()
        let card = ToolNoticeView(frame: NSRect(x: 0, y: 0, width: 880, height: ToolNoticeView.preferredHeight))
        card.cardID = "claude"
        card.notice = claude
        render(card)
        precondition(ToolNoticeDrawLog.drawn["claude"] == "TeamClaude 미설치", "\(ToolNoticeDrawLog.drawn)")
        precondition(card.accessibilityLabel()?.contains("TeamClaude 미설치") == true)

        // MARK: 소비 지점 2 — CLI 레인(Grok·agy)이 같은 상태를 그린다
        let lanes = CliQuotaLanesView(frame: NSRect(x: 0, y: 0, width: 880, height: CliQuotaLanesView.fixedHeight))
        lanes.grok = grokCardModel(for: grokToolNotice(cliInstalled: false, authPresent: false)!)
        lanes.agy = agyCardModel(for: agyToolNotice())
        render(lanes)
        precondition(ToolNoticeDrawLog.drawn["grok"] == "Grok 미설치", "\(ToolNoticeDrawLog.drawn)")
        precondition(ToolNoticeDrawLog.drawn["agy"] == "agy 미설치", "\(ToolNoticeDrawLog.drawn)")
        precondition(lanes.grok.headline == "Grok 미설치")
        precondition(lanes.accessibilityLabel()?.contains("agy 미설치") == true, lanes.accessibilityLabel() ?? "nil")

        // MARK: 소비 지점 3 — 구독 카드가 수집기 안내를 그리고, 그 줄만큼 높이가 는다
        let plain = SubscriptionBurnModel(usages: [], rates: [:], recommendations: [])
        let noted = SubscriptionBurnModel(usages: [], rates: [:], recommendations: [], collectorNotice: collector)
        precondition(SubscriptionBurnView.preferredHeight(noted) > SubscriptionBurnView.preferredHeight(plain))
        let burn = SubscriptionBurnView(frame: NSRect(x: 0, y: 0, width: 880,
                                                      height: SubscriptionBurnView.preferredHeight(noted)))
        burn.model = noted
        render(burn)
        precondition(ToolNoticeDrawLog.drawn["subscription"] == "수집기 미설치(선택 기능)", "\(ToolNoticeDrawLog.drawn)")

        // 꺼 두면 기록하지 않는다(운영 경로에 비용을 남기지 않는다).
        ToolNoticeDrawLog.isEnabled = false
        ToolNoticeDrawLog.reset()
        render(card)
        precondition(ToolNoticeDrawLog.drawn.isEmpty)

        print("ToolNoticeTests: ok")
    }
}
