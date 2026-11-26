// menubar/Tests/AgyEmptyLaneStaleTests.swift
import Cocoa

// 적대 재검토 3차(2026-11-27) Important: agy /usage가 매번 성공하지만 Gemini 레인이 없는 응답만 돌려줄 때,
// 실제 로더(AppDelegate.loadAgyUsageInBackground) → 감시기(reportStaleLanes) → 이 맥 줄(withStaleNotes)을 거친
// 최종 문구에 "갱신 없음"이 붙지 않고 경고 로그도 남지 않는지 본다. agy 자리에 가짜 실행 파일(CC_MENUBAR_AGY_BIN)을 둔다.
// main.swift의 선언부를 함께 컴파일해야 하므로 짝인 test_agy_empty_lane_stale.py가 빌드·실행한다.
@main
struct AgyEmptyLaneStaleTests {
    static var fakeDir = ""

    static func setMode(_ mode: String) {
        try! mode.write(toFile: fakeDir + "/mode", atomically: true, encoding: .utf8)
    }

    static func fetch(_ delegate: AppDelegate, until done: (AppDelegate) -> Bool) {
        delegate.loadAgyUsageInBackground(force: true)
        let deadline = Date().addingTimeInterval(60)
        while !done(delegate) && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        precondition(done(delegate), "agy 조회가 끝나지 않았다: \(delegate.currentAgyCard)")
    }

    static func main() {
        guard let dir = ProcessInfo.processInfo.environment["AGY_FAKE_DIR"] else { preconditionFailure("AGY_FAKE_DIR") }
        fakeDir = dir
        L10n.language = .ko
        _ = NSApplication.shared
        let delegate = AppDelegate()

        // 1) Gemini 레인이 있는 정상 응답.
        setMode("gemini")
        fetch(delegate) { $0.currentAgyCard.groups.count == 1 }
        // 그 성공은 15분 전이었고, 그 뒤로는 매분 Claude·GPT 레인만 정상으로 돌아왔다고 둔다.
        delegate.agyLastSuccessAt = Date().addingTimeInterval(-900)
        // 2) 성공한 응답이지만 Gemini 레인이 없다(확인한 빈 상태).
        setMode("claude")
        fetch(delegate) { $0.currentAgyCard.message == L10n.agyNoGeminiLane }

        // 3) 감시기 → 이 맥 줄 최종 문구.
        let now = Date()
        delegate.reportStaleLanes(now: now)
        let local = CliFleetTable.localRow(delegate.cliTracker.state(host: "this-mac", now: now), now: now)
        let shown = CliQuotaLanesView.withStaleNotes(local, delegate.dashboardStaleNotes)

        var failures: [String] = []
        if let note = delegate.dashboardStaleNotes["agy"] { failures.append("agy stale note on a successful read: \(note)") }
        if delegate.lastLaneStaleLogAt["agy"] != nil { failures.append("LANE-STALE warning was logged for agy") }
        if shown.agy.word != L10n.cliNoGemini { failures.append("local row agy word: \(shown.agy.word ?? "nil")") }
        if shown.agy.word?.contains("갱신 없음") == true { failures.append("local row says no update: \(shown.agy.word!)") }
        if failures.isEmpty {
            print("AgyEmptyLaneStaleTests OK")
        } else {
            failures.forEach { print("FAIL: \($0)") }
            exit(1)
        }
    }
}
