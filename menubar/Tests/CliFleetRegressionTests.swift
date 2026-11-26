import Foundation

// 적대 재검토(2026-11-27, 6584ba94) 지적을 화면 값으로 고정한다. 직전 커밋의 공개 API만 써서,
// 고치기 전 코드에서도 컴파일되고 틀린 표시를 실패로 드러낸다(컴파일 실패가 아닌 RED).
// 실패를 모두 모아 출력하고 하나라도 있으면 1로 끝낸다.
@main
struct CliFleetRegressionTests {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)
    static var failures: [String] = []

    static func check(_ condition: Bool, _ message: @autoclosure () -> String) {
        if !condition { failures.append(message()) }
    }

    static func main() {
        L10n.language = .ko
        swiftParserRejectsTooManyLanes()
        partialScanLastUsedIsNotDefinite()
        emptyLaneSuccessIsNotFetchLag()
        schemaMustBeJSONIntegerOne()
        if failures.isEmpty {
            print("CliFleetRegressionTests OK")
        } else {
            failures.forEach { print("FAIL: \($0)") }
            exit(1)
        }
    }

    static func snapshotObject(groups: Int = 1) -> [String: Any] {
        [
            "schema": 1, "host": "node-a", "written_at": Int(now.timeIntervalSince1970) - 20,
            "grok": ["installed": true, "auth": "ok", "usage_pct": 12, "last_used": "2027-01-15T07:57:00Z", "sessions_today": 3],
            "agy": ["installed": true, "auth": "ok",
                    "groups": (0..<groups).map { ["name": "Gemini \($0)", "weekly_remaining_pct": 80] },
                    "last_used": "2027-01-15T06:00:00Z", "conversations_today": 2],
        ]
    }

    // I3: 레인이 32개를 넘는 호스트는 조용히 자르지 않고 그 호스트를 parse로 둔다(수집기와 같은 규칙).
    static func swiftParserRejectsTooManyLanes() {
        let report = CliFleetReport.parse(object: [
            "collected_at": now.timeIntervalSince1970 - 10,
            "hosts": [["name": "many", "ok": true, "status": snapshotObject(groups: 33)],
                      ["name": "fine", "ok": true, "status": snapshotObject(groups: 32)]],
        ])
        let many = report?.hosts.first { $0.name == "many" }
        check(many?.ok == false && many?.error == "parse",
              "33 lanes must be a parse error, got ok=\(String(describing: many?.ok)) lanes=\(many?.status?.agy.groups.count ?? -1)")
        check(report?.hosts.first { $0.name == "fine" }?.status?.agy.groups.count == 32, "32 lanes are accepted")
    }

    // I4: 열거 상한에 걸린 부분 스캔이면 마지막 사용도 확정하지 않는다(본체 줄·이 맥 줄 모두).
    static func partialScanLastUsedIsNotDefinite() {
        guard var status = CliStatusSnapshot.parse(snapshotObject()) else { return check(false, "fixture must parse") }
        status.grok.sessionsTodayPartial = true
        status.agy.conversationsTodayPartial = true
        let fleet = CliFleetTable.row(name: "node-a", status: status, hostError: nil, now: now)
        check(fleet.grokLastUsed == "미확인" && fleet.agyLastUsed == "미확인",
              "fleet row last used must be unconfirmed on a partial scan, got \(fleet.grokLastUsed) / \(fleet.agyLastUsed)")
        let local = CliFleetTable.localRow(CliLocalCliState(host: "this-mac", grok: status.grok, agy: status.agy), now: now)
        check(local.grokLastUsed == "미확인" && local.agyLastUsed == "미확인",
              "local row last used must be unconfirmed on a partial scan, got \(local.grokLastUsed) / \(local.agyLastUsed)")
        status.grok.sessionsTodayPartial = false
        check(CliFleetTable.row(name: "x", status: status, hostError: nil, now: now).grokLastUsed == "3분 전", "a full scan stays definite")
    }

    // 재검토 새 지적: 성공한 /usage에 Gemini 레인이 없으면 "확인한 빈 상태"다. 성공 시각을 갱신하고 조회 지연을 띄우지 않는다.
    static func emptyLaneSuccessIsNotFetchLag() {
        var tracker = CliLocalTracker()
        let gemini = AgyQuotaGroup(name: "Gemini Models", weekly: AgyQuotaBucket(remaining: 0.8, resetAt: nil), fiveHour: nil)
        let claude = AgyQuotaGroup(name: "Claude Models", weekly: AgyQuotaBucket(remaining: 1, resetAt: nil), fiveHour: nil)
        tracker.recordAgy(.ready([gemini]), now: now.addingTimeInterval(-900))
        tracker.recordAgy(.ready([claude]), now: now)
        let agy = tracker.state(host: "w", now: now).agy
        check(agy?.lastOkAt == now, "a successful read updates last_ok_at, got \(String(describing: agy?.lastOkAt))")
        check(agy?.fetchFailed == false, "a successful read is not a failure")
        guard let snapshot = tracker.state(host: "w", now: now).snapshot else { return check(false, "snapshot") }
        let row = CliFleetTable.row(name: "w", status: snapshot, hostError: nil, now: now)
        check(row.agy.word == "Gemini 없음", "confirmed empty lanes say so, got \(row.agy.word ?? "nil")")
        // 반대로 실패 뒤 앞선 값을 지키는 중이면 여전히 지연이다.
        tracker.recordAgy(.ready([gemini]), now: now.addingTimeInterval(-900))
        tracker.recordAgy(.failed, now: now)
        let kept = CliFleetTable.row(name: "w", status: tracker.state(host: "w", now: now).snapshot!, hostError: nil, now: now)
        check(kept.agy.word == "조회 지연 15분", "a preserved value still shows its age, got \(kept.agy.word ?? "nil")")
    }

    // M3: schema는 JSON 정수 1만. 1.0이나 Double에서 1로 반올림되는 고정밀 소수는 거부한다.
    static func schemaMustBeJSONIntegerOne() {
        let base = String(decoding: try! JSONSerialization.data(withJSONObject: snapshotObject(), options: [.sortedKeys]), as: UTF8.self)
        check(base.contains("\"schema\":1,"), "fixture text")
        for literal in ["1.0", "1.00000000000000001", "1e0"] {
            let text = base.replacingOccurrences(of: "\"schema\":1,", with: "\"schema\":\(literal),")
            let object = try! JSONSerialization.jsonObject(with: Data(text.utf8))
            check(CliStatusSnapshot.parse(object) == nil, "schema \(literal) must be rejected")
        }
        check(CliStatusSnapshot.parse(try! JSONSerialization.jsonObject(with: Data(base.utf8))) != nil, "integer 1 is accepted")
    }
}
