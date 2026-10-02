import Cocoa
import CryptoKit

@main
struct SubscriptionMonitorTests {
    static func main() throws {
        let parser = ISO8601DateFormatter()
        let now = parser.date(from: "2026-09-10T00:00:00Z")!
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appendingPathComponent("monitor.json")
        let uuid = "monitor-account-test"
        let key = SHA256.hash(data: Data(("anthropic:" + uuid).utf8)).map { String(format: "%02x", $0) }.joined()
        var event: [String: Any] = ["kind": "cancel", "eventAt": "2026-09-08T04:40:00Z", "endsOn": "2026-09-23"]
        var row: [String: Any] = ["status": "ok", "lastSuccessAt": "2026-09-09T23:59:00Z", "event": event]
        var root: [String: Any] = ["version": 1, "checkedAt": "2026-09-10T00:00:00Z", "accounts": [key: row]]
        func write() throws {
            root["accounts"] = [key: row]
            try JSONSerialization.data(withJSONObject: root).write(to: url)
        }
        func overlay(_ saved: AccountSubscriptionDetails = AccountSubscriptionDetails(plan: "Max 20×", tracksCancellation: true)) -> AccountSubscriptionDetails {
            accountSubscriptionMonitored(saved, uuid: uuid, url: url, now: now)
        }
        try write()
        let automatic = overlay()
        precondition(automatic.confirmation?.state == .scheduled && automatic.automaticallyConfirmed)
        precondition(accountSubscriptionLabel(automatic, now: now).contains("자동확인"))
        let unknown = accountSubscriptionMonitored(automatic, uuid: "other-account", url: url, now: now)
        precondition(unknown.confirmation?.date == automatic.confirmation?.date)
        var manual = AccountSubscriptionDetails(plan: "Max", tracksCancellation: true,
            confirmation: AccountSubscriptionConfirmation(state: .renewing, date: "2026-10-04", checkedAt: now.addingTimeInterval(-3600), source: "billing-page"))
        precondition(overlay(manual).confirmation?.state == .renewing)
        manual.confirmation = AccountSubscriptionConfirmation(state: .scheduled, date: "2026-09-23", checkedAt: now.addingTimeInterval(-3600), source: "confirmation-email")
        precondition(overlay(manual).automaticallyConfirmed)
        for status in ["error", "busy", "login-required"] {
            row["status"] = status; try write()
            let failure = overlay()
            precondition(failure.confirmation?.checkedAt == automatic.confirmation?.checkedAt)
            precondition(failure.monitorStatus != "자동확인")
            precondition(accountSubscriptionLabel(failure, now: now).hasPrefix(status == "error" ? "조회 실패" : status == "busy" ? "조회 대기" : "로그인 필요"))
        }
        row["lastSuccessAt"] = "2026-09-08T23:00:00Z"; row["status"] = "error"; try write()
        let preserved = overlay(manual)
        precondition(preserved.confirmation?.checkedAt == manual.confirmation?.checkedAt)
        precondition(!preserved.automaticallyConfirmed)
        row["status"] = "ok"
        root["checkedAt"] = "2026-09-09T12:00:00Z"
        row["lastSuccessAt"] = "2026-09-09T11:59:00Z"; try write()
        precondition(overlay().monitorStatus == "조회 지연")
        root["checkedAt"] = "2026-09-10T00:00:00Z"
        row["lastSuccessAt"] = "2026-09-09T23:59:00Z"
        event = ["kind": "join", "eventAt": "2026-09-09T23:30:00Z"]
        row["event"] = event; try write()
        manual.paymentDate = "2026-10-01"
        precondition(overlay(manual).confirmation == nil && overlay(manual).paymentDate == nil)
        manual.confirmation = AccountSubscriptionConfirmation(state: .scheduled, date: "2026-09-23",
            checkedAt: parser.date(from: "2026-09-09T23:30:10Z")!, source: "user-confirmed")
        row["event"] = ["kind": "join", "eventAt": "2026-09-09T23:30:50.000Z"]; try write()
        precondition(overlay(manual).confirmation == nil)
        row["event"] = ["kind": "join", "eventAt": "2026-09-09T23:30:05.000Z"]; try write()
        precondition(overlay(manual).confirmation?.state == .scheduled)
        event = ["kind": "cancel", "eventAt": "2026-09-08T04:40:00Z", "endsOn": "2026-02-30"]
        row["event"] = event; try write()
        precondition(overlay().confirmation == nil)
        row["lastSuccessAt"] = "2026-09-11T00:00:00Z"; try write()
        precondition(overlay().confirmation == nil)
        // 실제 NSButton에 긴 라벨 및 오류 상태가 전달되는지 확인한다.
        row.removeValue(forKey: "event"); row.removeValue(forKey: "lastSuccessAt"); row["status"] = "login-required"; try write()
        let suite = "monitor-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = AccountSubscriptionStore(defaults: defaults, configURL: folder.appendingPathComponent("missing.json"), monitorURL: url, clock: { now })
        let button = AccountSubscriptionButton(provider: "anthropic", accountUuid: uuid, accountName: "검증 계정", plan: "max_20x", store: store)
        precondition(button.title.hasPrefix("로그인 필요"))
        precondition(button.toolTip?.contains("메일 로그인 필요") == true)
        precondition(button.attributedTitle.size().width < 690)
        // 서버의 오래된 해지 기록은 더 최신 재가입·직접 확인을 덮지 않는다.
        row = ["status": "ok", "lastSuccessAt": "2026-09-09T23:59:00Z",
               "event": ["kind": "join", "eventAt": "2026-09-09T23:30:00Z"]]
        try write()
        let oldProxy = AccountSubscriptionConfirmation(state: .scheduled, date: "2026-09-23",
            checkedAt: now.addingTimeInterval(-7200), source: "proxy-record")
        precondition(store.details(provider: "anthropic", uuid: uuid, fallbackConfirmation: oldProxy).confirmation == nil)
        precondition(store.saveConfirmation(.renewing, date: "2026-10-04", provider: "anthropic", uuid: uuid, source: "billing-page"))
        precondition(store.details(provider: "anthropic", uuid: uuid, fallbackConfirmation: oldProxy).confirmation?.state == .renewing)
        let staleEnded = AccountSubscriptionDetails(plan: "Max", tracksCancellation: true,
            confirmation: AccountSubscriptionConfirmation(state: .ended, date: "2026-09-09",
                checkedAt: now.addingTimeInterval(-48 * 3600), source: "proxy-record"))
        precondition(accountSubscriptionLabel(staleEnded, now: now).contains("종료 재확인"))
        var clearedAt = now
        let clearStore = AccountSubscriptionStore(defaults: defaults, configURL: folder.appendingPathComponent("missing.json"), monitorURL: url, clock: { clearedAt })
        row = ["status": "error", "lastSuccessAt": "2026-09-09T23:59:00Z",
               "event": ["kind": "cancel", "eventAt": "2026-09-08T04:40:00Z", "endsOn": "2026-09-09"]]
        try write()
        precondition(clearStore.saveConfirmation(.scheduled, date: "2026-09-09", provider: "anthropic", uuid: uuid, source: "confirmation-email"))
        precondition(clearStore.details(provider: "anthropic", uuid: uuid).appearance(now: now).isMuted)
        precondition(clearStore.saveConfirmation(nil, date: nil, provider: "anthropic", uuid: uuid))
        let reopened = AccountSubscriptionStore(defaults: defaults, configURL: folder.appendingPathComponent("missing.json"), monitorURL: url, clock: { clearedAt })
        precondition(reopened.details(provider: "anthropic", uuid: uuid).confirmation == nil)
        let clearedButton = AccountSubscriptionButton(provider: "anthropic", accountUuid: uuid, accountName: "기록 삭제 회귀", store: reopened)
        clearedButton.refreshTitle(now: now)
        precondition(!clearedButton.title.contains("종료일 경과"))
        precondition(reopened.details(provider: "anthropic", uuid: uuid).appearance(now: now) == .standard)
        clearedAt = now.addingTimeInterval(3600)
        root["checkedAt"] = "2026-09-10T01:00:00Z"
        row["status"] = "ok"
        row["lastSuccessAt"] = "2026-09-10T01:00:00Z"
        try write()
        precondition(reopened.details(provider: "anthropic", uuid: uuid).confirmation == nil)
        row["event"] = ["kind": "cancel", "eventAt": "2026-09-10T00:30:00Z", "endsOn": "2026-10-09"]
        try write()
        precondition(reopened.details(provider: "anthropic", uuid: uuid).confirmation?.date == "2026-10-09")
        precondition(reopened.saveConfirmation(.ended, date: "2026-09-10", provider: "anthropic", uuid: uuid))
        precondition(reopened.details(provider: "anthropic", uuid: uuid).confirmation?.state == .ended)
        print("MONITOR assertions passed: identity, manual priority, rejoin, stale, failed query and visible labels")
    }
}
