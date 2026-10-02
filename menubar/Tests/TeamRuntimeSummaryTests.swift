import Foundation

@main
struct TeamRuntimeSummaryTests {
    static func main() {
        let seoul = TimeZone(identifier: "Asia/Seoul")!
        let full: [String: Any] = [
            "artifact": "eeb99bae2f5d", "version": "1.3.0", "uptimeMs": 3_900_000,
            "workerRestarts": 2, "lastWorkerRestartAt": "2026-09-22T05:10:00.000Z",
            "lastWorkerRestartReason": "health-check",
        ]
        let fullText = teamRuntimeSummary(full, timeZone: seoul)
        precondition(fullText == "빌드 eeb99bae2f5d · 가동 1시간 5분 · 워커 재시작 2회 (마지막 9/22 14:10)", fullText ?? "nil")
        let shortText = teamRuntimeSummary(full, short: true, timeZone: seoul)
        precondition(shortText == "빌드 eeb99bae2f5d · 재시작 2회", shortText ?? "nil")
        precondition(teamRuntimeSummary(["version": "1.3.0"], timeZone: seoul) == "v1.3.0")
        precondition(teamRuntimeSummary(["uptimeMs": 90_000_000], timeZone: seoul) == "빌드 미상 · 가동 1일 1시간")
        precondition(teamRuntimeSummary(nil, timeZone: seoul) == nil)
        precondition(teamRuntimeSummary("junk", timeZone: seoul) == nil)
        testServerLineFallsBackFullThenShortThenBase()
        testUptimeTextRejectsNonFinite()
        print("TeamRuntimeSummaryTests: full, short, partial, nil, server line, non-finite passed")
    }

    static func testServerLineFallsBackFullThenShortThenBase() {
        let measure: (String) -> CGFloat = { CGFloat($0.count) * 10 }
        let base = "port 3456  ·  pid 1  ·  연동 정상"          // 29 chars → 290
        let full = "빌드 eeb99bae2f5d · 가동 1일 1시간 · 워커 재시작 2회 (마지막 9/22 14:10)"   // with base: 90 chars → 900
        let short = "빌드 eeb99bae2f5d · 재시작 2회"                                              // with base: 58 chars → 580
        let wide = teamServerLine(base: base, full: full, short: short, maxWidth: 2000, measure: measure)
        precondition(wide == "\(base)  ·  \(full)", wide)
        let medium = teamServerLine(base: base, full: full, short: short, maxWidth: 600, measure: measure)
        precondition(medium == "\(base)  ·  \(short)", medium)
        let narrow = teamServerLine(base: base, full: full, short: short, maxWidth: 300, measure: measure)
        precondition(narrow == base, narrow)
        let none = teamServerLine(base: base, full: nil, short: nil, maxWidth: 2000, measure: measure)
        precondition(none == base, none)
    }

    static func testUptimeTextRejectsNonFinite() {
        precondition(teamRuntimeUptimeText(.nan) == "0분", teamRuntimeUptimeText(.nan))
        precondition(teamRuntimeUptimeText(.infinity) == "0분", teamRuntimeUptimeText(.infinity))
    }
}
