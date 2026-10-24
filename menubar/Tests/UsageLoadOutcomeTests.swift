// menubar/Tests/UsageLoadOutcomeTests.swift
import Cocoa

// ccusage 수집 실패가 "데이터 없음"으로 조용히 축약되지 않는지, 실제 로더(AppDelegate.loadUsageInBackground)와
// 실제 판정(currentToolNotices)·실제 대시보드(StatusMenuDashboardView)를 거쳐 확인한다.
// npx 자리에 가짜 실행 파일(CC_MENUBAR_NPX_BIN)을 두고, 같은 폴더의 mode 파일로 실패 모양을 바꾼다.
// main.swift의 선언부를 함께 컴파일해야 하므로 짝인 test_usage_load_outcome.py가 빌드·실행한다.
@main
struct UsageLoadOutcomeTests {
    static var fakeDir = ""

    static func setMode(_ mode: String) {
        try! mode.write(toFile: fakeDir + "/mode", atomically: true, encoding: .utf8)
    }

    static func runFull(_ delegate: AppDelegate) {
        delegate.loadUsageInBackground()
        let deadline = Date().addingTimeInterval(20)
        while delegate.isFetching && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        precondition(!delegate.isFetching, "사용량 로더가 끝나지 않았다")
    }

    static func runQuick(_ delegate: AppDelegate) {
        delegate.loadUsageQuickInBackground(reason: "test")
        let deadline = Date().addingTimeInterval(20)
        while delegate.isFetchingUsageQuick && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        precondition(!delegate.isFetchingUsageQuick, "quick 사용량 로더가 끝나지 않았다")
    }

    /// 앱과 같은 판정으로 대시보드 한 장을 그린다. 그려진 안내와 섹션 요약을 돌려준다.
    static func render(_ delegate: AppDelegate) -> (drawn: String?, summary: String, cardNote: String?) {
        ToolNoticeDrawLog.reset()
        let notices = delegate.currentToolNotices
        let view = StatusMenuDashboardView(frame: NSRect(
            x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth,
            height: StatusMenuDashboardView.preferredHeight(
                teamClaude: nil, codex: nil, teamCodex: nil, usage: delegate.currentData, higgsfield: nil,
                burnModel: delegate.currentBurnModel, notices: notices)))
        view.configure(teamClaude: nil, codex: nil, teamCodex: nil, usage: delegate.currentData, higgsfield: nil,
                       burnModel: delegate.currentBurnModel, notices: notices,
                       laneStaleNotes: delegate.dashboardStaleNotes,
                       parallelCount: 0, active: false, isMeasuringTeamClaude: false,
                       teamClaudeMeasureDetail: nil, onMeasureTeamClaude: nil)
        view.layoutSubtreeIfNeeded()
        let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
        view.cacheDisplay(in: view.bounds, to: rep)
        let summary = view.sections.first(where: { $0.id == "usage" })?.summary ?? ""
        let card = view.subviews.compactMap { $0 as? UsageDashboardView }.first
        return (ToolNoticeDrawLog.drawn["usage"], summary, card?.staleNote)
    }

    static func main() {
        _ = NSApplication.shared
        ToolNoticeDrawLog.isEnabled = true
        fakeDir = CommandLine.arguments[1]
        let delegate = AppDelegate()
        // 운영은 60초. 시간 초과 경로를 빨리 밟으려고 줄인다(가짜 npx는 TERM을 무시하고 30초 잔다).
        delegate.ccusageTimeoutSeconds = 1

        // MARK: 수집기 실패는 "데이터 없음"이 아니다
        let cases = [("exit", "종료 코드 3"), ("garbage", "출력 해석 실패"), ("empty", "빈 출력"), ("hang", "1초 시간 초과")]
        for (mode, why) in cases {
            setMode(mode)
            delegate.currentData = nil
            runFull(delegate)
            let notice = delegate.currentToolNotices.sections["usage"]
            precondition(notice != nil, "\(why): 안내가 없다")
            precondition(notice?.kind != .noData, "\(why): 실패가 데이터 없음으로 보였다 — \(notice?.headline ?? "nil")")
            precondition(notice?.headline == "사용량 확인 필요", "\(why): \(notice?.headline ?? "nil")")
            precondition(notice?.kind == .loadFailed)
            precondition(notice?.detail.contains(why) == true, "\(why): 원인이 안내에 없다 — \(notice?.detail ?? "nil")")
            let drawn = render(delegate)
            precondition(drawn.drawn == "사용량 확인 필요", "\(why): 카드가 그린 안내 \(drawn.drawn ?? "nil")")
            precondition(drawn.summary == "사용량 확인 필요", "\(why): 헤더 요약 \(drawn.summary)")
        }

        // 시간 초과는 제한 안에 끝나야 한다(가짜 npx의 30초 잠을 기다리지 않는다).
        setMode("hang")
        let hangStarted = Date()
        runFull(delegate)
        precondition(Date().timeIntervalSince(hangStarted) < 6, "시간 초과 경로가 제한을 넘겼다")

        // MARK: 성공적으로 읽은 빈 결과만 "데이터 없음"
        setMode("nodata")
        delegate.currentData = nil
        runFull(delegate)
        precondition(delegate.currentToolNotices.sections["usage"]?.headline == "사용량 데이터 없음")

        // MARK: 정상 결과는 안내 없이 값을 그린다
        setMode("today")
        runFull(delegate)
        precondition(delegate.currentData?.today != nil, "정상 출력이 반영되지 않았다")
        precondition(delegate.currentToolNotices.sections["usage"] == nil)
        let fresh = render(delegate)
        precondition(!fresh.summary.contains("갱신 실패") && fresh.cardNote == nil)

        // MARK: 이전 값이 있는데 갱신이 실패하면 값은 두고 낡았다고 표시한다
        setMode("exit")
        runFull(delegate)
        precondition(delegate.currentData?.today != nil, "실패가 이전 값을 지웠다")
        precondition(delegate.currentToolNotices.sections["usage"] == nil, "이전 값이 있으면 본문을 안내로 바꾸지 않는다")
        let stale = render(delegate)
        precondition(stale.summary.contains("갱신 실패"), "헤더 요약에 낡은 값 표시가 없다: \(stale.summary)")
        precondition(stale.summary.hasPrefix("오늘 "), "헤더 요약이 이전 값을 잃었다: \(stale.summary)")
        precondition(stale.cardNote == "갱신 실패(종료 코드 3) · 이전 값", "카드 꼬리말: \(stale.cardNote ?? "nil")")

        // MARK: quick 로더도 같은 판정을 남긴다
        setMode("today")
        runFull(delegate)
        precondition(delegate.dashboardStaleNotes["usage"] == nil, "성공 뒤에도 낡은 표시가 남았다")
        setMode("garbage")
        runQuick(delegate)
        precondition(delegate.usageLoadOutcome == .failed(.unparsable), "\(String(describing: delegate.usageLoadOutcome))")
        precondition(delegate.dashboardStaleNotes["usage"] == "갱신 실패(출력 해석 실패) · 이전 값")
        delegate.currentData = nil
        setMode("exit")
        runQuick(delegate)
        precondition(delegate.currentToolNotices.sections["usage"]?.headline == "사용량 확인 필요")

        print("UsageLoadOutcomeTests: ok")
    }
}
