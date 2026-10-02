import Cocoa

final class SubscriptionMockProtocol: URLProtocol {
    static var requestCount = 0
    static var responseStatus = 200
    static var responseBody = Data()
    static var responseDelay: TimeInterval = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requestCount += 1
        precondition(request.url?.absoluteString == "https://api.anthropic.com/api/oauth/profile")
        precondition(request.value(forHTTPHeaderField: "Authorization")?.hasPrefix("Bearer ") == true)
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.responseStatus, httpVersion: nil, headerFields: nil)!
        let body = Self.responseBody
        let finish = {
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: body)
            self.client?.urlProtocolDidFinishLoading(self)
        }
        if Self.responseDelay > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.responseDelay, execute: finish)
        } else { finish() }
    }
    override func stopLoading() {}
}

@main
struct AccountSubscriptionTests {
    static func profileLifecycle(defaults: UserDefaults, payload: [String: Any]) {
        let configURL = FileManager.default.temporaryDirectory.appendingPathComponent("subscription-config-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: configURL) }
        let row: [String: Any] = ["accountUuid": "account-a", "type": "oauth", "accessToken": UUID().uuidString]
        func writeRows(_ rows: [[String: Any]]) {
            try! JSONSerialization.data(withJSONObject: ["accounts": rows], options: .sortedKeys).write(to: configURL)
        }
        writeRows([row])
        let original = try! Data(contentsOf: configURL)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SubscriptionMockProtocol.self]
        var now = accountSubscriptionDate("2026-09-09")!.addingTimeInterval(3600)
        func makeStore() -> AccountSubscriptionStore {
            AccountSubscriptionStore(defaults: defaults, configURL: configURL, sessionConfiguration: config, clock: { now })
        }
        func wait(_ condition: () -> Bool) {
            let deadline = Date().addingTimeInterval(3)
            while !condition(), Date() < deadline {
                RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            }
            precondition(condition(), "profile callback timed out")
        }
        SubscriptionMockProtocol.requestCount = 0
        SubscriptionMockProtocol.responseStatus = 200
        SubscriptionMockProtocol.responseBody = try! JSONSerialization.data(withJSONObject: payload)
        let store = makeStore()
        var completions = 0
        store.refreshProfile(provider: "anthropic", uuid: "account-a") { completions += 1 }
        store.refreshProfile(provider: "anthropic", uuid: "account-a") { completions += 1 }
        wait { completions == 2 }
        precondition(SubscriptionMockProtocol.requestCount == 1)
        precondition(store.details(provider: "anthropic", uuid: "account-a").plan == "Max 5×")
        precondition(store.saveConfirmation(.scheduled, date: "2026-10-01", provider: "anthropic", uuid: "account-a"))
        let reopened = makeStore()
        reopened.refreshProfile(provider: "anthropic", uuid: "account-a") { completions += 1 }
        precondition(SubscriptionMockProtocol.requestCount == 1)
        now = now.addingTimeInterval(6 * 3600 + 1)
        reopened.refreshProfile(provider: "anthropic", uuid: "account-a") { completions += 1 }
        wait { completions == 3 }
        precondition(SubscriptionMockProtocol.requestCount == 2)
        precondition(reopened.details(provider: "anthropic", uuid: "account-a").confirmation?.state == .scheduled)
        precondition(reopened.details(provider: "anthropic", uuid: "account-a").confirmation?.date == "2026-10-01")
        SubscriptionMockProtocol.responseBody = try! JSONSerialization.data(withJSONObject: [
            "account": ["uuid": "account-a"], "organization": ["rate_limit_tier": "default_claude_pro"]
        ])
        now = now.addingTimeInterval(6 * 3600 + 1)
        reopened.refreshProfile(provider: "anthropic", uuid: "account-a") { completions += 1 }
        wait { completions == 4 }
        precondition(reopened.details(provider: "anthropic", uuid: "account-a", fallbackPlan: "max_20x").plan == "Pro")
        _ = NSApplication.shared
        let refreshedButton = AccountSubscriptionButton(provider: "anthropic", accountUuid: "account-a",
            accountName: "플랜 변경 검증", plan: "max_20x", store: reopened)
        refreshedButton.refreshTitle(now: now)
        precondition(refreshedButton.title.hasPrefix("Pro ·"))
        precondition(refreshedButton.title.contains("해지 재확인") || refreshedButton.title.contains("해지 예약"))
        precondition(try! Data(contentsOf: configURL) == original)

        let key = "cc.account-subscription.v1.anthropic.account-a"
        defaults.removeObject(forKey: key)
        SubscriptionMockProtocol.responseStatus = 500
        let failed = makeStore()
        failed.refreshProfile(provider: "anthropic", uuid: "account-a") { completions += 1 }
        wait { completions == 5 }
        let afterFailure = makeStore()
        afterFailure.refreshProfile(provider: "anthropic", uuid: "account-a") { completions += 1 }
        precondition(SubscriptionMockProtocol.requestCount == 4)
        now = now.addingTimeInterval(301)
        afterFailure.refreshProfile(provider: "anthropic", uuid: "account-a") { completions += 1 }
        wait { completions == 6 }
        precondition(SubscriptionMockProtocol.requestCount == 5)
        precondition(afterFailure.details(provider: "anthropic", uuid: "account-a").plan == nil)

        let invalidProviders: [Any] = ["codex", 7, NSNull(), ["name": "anthropic"]]
        let invalidProviderRows = invalidProviders.map { value in [row.merging(["provider": value]) { _, new in new }] }
        for invalidRows in [[row, row], [row.merging(["type": "api-key"]) { _, new in new }]] + invalidProviderRows {
            defaults.removeObject(forKey: key)
            writeRows(invalidRows)
            let invalid = makeStore()
            invalid.refreshProfile(provider: "anthropic", uuid: "account-a") { completions += 1 }
            RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            precondition(SubscriptionMockProtocol.requestCount == 5)
        }
        writeRows([row])
        precondition(try! Data(contentsOf: configURL) == original)

        let delegate = AccountSubscriptionRedirectDelegate()
        let url = URL(string: "https://api.anthropic.com/api/oauth/profile")!
        let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: nil, headerFields: nil)!
        let task = URLSession.shared.dataTask(with: url)
        var redirectDenied = false
        delegate.urlSession(URLSession.shared, task: task, willPerformHTTPRedirection: response,
                            newRequest: URLRequest(url: URL(string: "https://example.invalid")!)) {
            redirectDenied = $0 == nil
        }
        precondition(redirectDenied)
        task.cancel()
        defaults.removeObject(forKey: key)
        SubscriptionMockProtocol.responseStatus = 200
        SubscriptionMockProtocol.responseDelay = 0.15
        let beforeReplacement = SubscriptionMockProtocol.requestCount
        let replacementStore = makeStore()
        var oldButton: AccountSubscriptionButton? = AccountSubscriptionButton(provider: "anthropic",
            accountUuid: "account-a", accountName: "교체 전", plan: "max_20x", store: replacementStore)
        precondition(oldButton!.title.hasPrefix("Max 20×"))
        let newButton = AccountSubscriptionButton(provider: "anthropic", accountUuid: "account-a",
            accountName: "교체 후", plan: "max_20x", store: replacementStore)
        oldButton = nil
        wait { newButton.title.hasPrefix("Pro ·") }
        precondition(SubscriptionMockProtocol.requestCount == beforeReplacement + 1)
        SubscriptionMockProtocol.responseDelay = 0
        print("Profile lifecycle: success/failure TTL across stores, coalescing, provider/UUID rejection, config preservation, redirect rejection passed")
    }

    static func cancellationLifecycle(defaults: UserDefaults) {
        var now = accountSubscriptionDate("2026-09-09")!.addingTimeInterval(3600)
        let store = AccountSubscriptionStore(defaults: defaults, clock: { now })
        let provider = "anthropic"
        let uuid = "cancellation-test"
        func details() -> AccountSubscriptionDetails { store.details(provider: provider, uuid: uuid, fallbackPlan: "max") }
        func label() -> String { accountSubscriptionLabel(details(), now: now) }
        precondition(label().contains("해지 미확인"))
        precondition(store.savePaymentDate("2026-10-04", provider: provider, uuid: uuid))
        precondition(label().contains("입력 결제일 2026-10-04"))
        precondition(!label().contains("자동갱신"))
        precondition(store.savePaymentDate("2026-08-01", provider: provider, uuid: uuid))
        precondition(label().contains("입력 결제일 지남 2026-08-01"))
        precondition(store.savePaymentDate("2026-10-04", provider: provider, uuid: uuid))
        precondition(store.saveConfirmation(.scheduled, date: "2026-09-10", provider: provider, uuid: uuid))
        precondition(label().contains("해지 예약"))
        precondition(!label().contains("결제일"))
        let saved = defaults.dictionary(forKey: "cc.account-subscription.v1.anthropic.cancellation-test")!
        precondition(!store.saveConfirmation(.renewing, date: "2026-02-30", provider: provider, uuid: uuid))
        precondition(details().confirmation?.state == .scheduled)
        precondition(!store.saveConfirmation(.renewing, date: nil, provider: "codex", uuid: uuid))
        precondition(!store.saveConfirmation(.renewing, date: nil, provider: provider, uuid: ""))
        precondition(!store.saveConfirmation(.renewing, date: nil, provider: provider, uuid: uuid, source: "profile"))
        precondition(store.details(provider: provider, uuid: "different-account").confirmation == nil)
        precondition(store.details(provider: "codex", uuid: uuid).confirmation == nil)
        defaults.set(["plan": "Pro"], forKey: "cc.account-subscription.v1.codex.plan-priority")
        precondition(store.details(provider: "codex", uuid: "plan-priority", fallbackPlan: "plus").plan == "Plus")
        let reopened = AccountSubscriptionStore(defaults: defaults, clock: { now })
        precondition(reopened.details(provider: provider, uuid: uuid).confirmation?.state == .scheduled)
        now = now.addingTimeInterval(2 * 86400)
        precondition(label().contains("종료일 경과"))
        precondition(!label().contains("구독 종료 확인"))
        precondition(store.saveConfirmation(.renewing, date: "2026-10-04", provider: provider, uuid: uuid, source: "billing-page"))
        precondition(label().contains("자동갱신 확인"))
        precondition(label().contains("2026-10-04"))
        now = now.addingTimeInterval(86400)
        precondition(label().contains("갱신 재확인"))
        precondition(label().contains("기록 결제일 2026-10-04"))
        precondition(!label().contains("이전 결제일"))
        precondition(!label().contains("다음 결제"))
        precondition(store.saveConfirmation(.ended, date: nil, provider: provider, uuid: uuid))
        precondition(label().contains("구독 종료 확인"))
        precondition(!label().contains("다음 결제"))
        precondition(store.saveConfirmation(nil, date: nil, provider: provider, uuid: uuid))
        precondition(label().contains("해지 미확인"))
        precondition(details().paymentDate == "2026-10-04")
        let raw = saved["confirmation"] as! [String: Any]
        precondition(accountSubscriptionConfirmation(raw.merging(["source": "profile"]) { _, b in b }, now: now) == nil)
        precondition(accountSubscriptionConfirmation(raw.merging(["state": "active"]) { _, b in b }, now: now) == nil)
        precondition(accountSubscriptionConfirmation(raw.merging(["checkedAt": now.addingTimeInterval(60)]) { _, b in b }, now: now) == nil)
        precondition(accountSubscriptionConfirmation(raw.merging(["date": "2026-02-30"]) { _, b in b }, now: now) == nil)
        print("Cancellation lifecycle: unknown/renewing/scheduled/ended/stale/identity/profile-independent persistence passed")
    }

    static func main() {
        precondition(accountSubscriptionPlan("default_claude_max_20x") == "Max 20×")
        precondition(accountSubscriptionPlan("plus") == "Plus")
        precondition(accountSubscriptionPlan("arbitrary-plan") == nil)
        precondition(accountSubscriptionDate("2026-02-29") == nil)
        precondition(accountSubscriptionDate("2028-02-29") != nil)
        precondition(accountSubscriptionDate("2026-09-31") == nil)
        precondition(accountSubscriptionDate("2026-9-7") == nil)
        let payload: [String: Any] = [
            "account": ["uuid": "account-a", "has_claude_max": true],
            "organization": ["rate_limit_tier": "default_claude_max_5x", "subscription_created_at": "2026-08-05T09:00:00Z"]
        ]
        let parsed = accountSubscriptionProfile(payload, expectedUuid: "account-a")!
        precondition(parsed.plan == "Max 5×")
        precondition(parsed.startedAt == "2026-08-05")
        precondition(parsed.paymentDate == nil)
        precondition(accountSubscriptionProfile(payload, expectedUuid: "account-b") == nil)
        let rows: [[String: Any]] = [["name": "row", "accountUuid": "a"]]
        precondition(accountSubscriptionConfiguredAccount(provider: "anthropic", uuid: nil, name: "row", rows: rows)?["accountUuid"] as? String == "a")
        precondition(accountSubscriptionConfiguredAccount(provider: "anthropic", uuid: "b", name: "row", rows: rows) == nil)
        precondition(accountSubscriptionConfiguredAccount(provider: "anthropic", uuid: nil, name: "row", rows: rows + rows) == nil)
        let suite = "cc-subscription-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = AccountSubscriptionStore(defaults: defaults)
        profileLifecycle(defaults: defaults, payload: payload)
        cancellationLifecycle(defaults: defaults)
        precondition(!store.savePaymentDate("2026-02-30", provider: "anthropic", uuid: "a"))
        precondition(store.savePaymentDate("2026-10-05", provider: "anthropic", uuid: "a"))
        precondition(store.details(provider: "anthropic", uuid: "a").paymentDate == "2026-10-05")
        precondition(store.details(provider: "codex", uuid: "a").paymentDate == nil)
        precondition(store.details(provider: "anthropic", uuid: "b").paymentDate == nil)
        precondition(store.savePaymentDate(nil, provider: "anthropic", uuid: "a"))
        precondition(store.details(provider: "anthropic", uuid: "a").paymentDate == nil)
        precondition(!store.savePaymentDate("2026-10-05", provider: "anthropic", uuid: ""))
        let unknown = accountSubscriptionLabel(AccountSubscriptionDetails(plan: "Pro"))
        precondition(unknown.contains("결제일 미확인"))
        let past = accountSubscriptionLabel(AccountSubscriptionDetails(plan: "Pro", paymentDate: "2020-01-01"))
        precondition(past.contains("결제일 지남"))
        _ = NSApplication.shared
        let button = AccountSubscriptionButton(provider: "codex", accountUuid: "ui-test-account", accountName: "구독 테스트 계정", plan: "pro", store: store)
        precondition(button.title.contains("Pro"))
        var visited = 0
        func respond(_ value: String?, code: NSApplication.ModalResponse) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                guard let window = NSApp.modalWindow else { preconditionFailure("날짜 입력 창이 열리지 않음") }
                func fill(_ view: NSView) {
                    if let field = view as? NSTextField, field.isEditable, let value { field.stringValue = value }
                    view.subviews.forEach(fill)
                }
                if let content = window.contentView { fill(content) }
                visited += 1
                NSApp.stopModal(withCode: code)
            }
        }
        respond("2026-10-05", code: .alertFirstButtonReturn)
        button.performClick(nil)
        precondition(store.details(provider: "codex", uuid: "ui-test-account").paymentDate == "2026-10-05")
        precondition(button.title.contains("2026-10-05"))
        respond("2026-10-06", code: .alertSecondButtonReturn)
        button.performClick(nil)
        precondition(store.details(provider: "codex", uuid: "ui-test-account").paymentDate == "2026-10-05")
        respond(nil, code: .alertThirdButtonReturn)
        button.performClick(nil)
        precondition(store.details(provider: "codex", uuid: "ui-test-account").paymentDate == nil)
        precondition(visited == 3)
        let claudeButton = AccountSubscriptionButton(provider: "anthropic", accountUuid: "native-cancel-test", accountName: "구독 해지 테스트", plan: "max", store: store)
        func respondConfirmation(state: Int, value: String?, code: NSApplication.ModalResponse) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                guard let window = NSApp.modalWindow else { preconditionFailure("구독 확인 기록 창이 열리지 않음") }
                func fill(_ view: NSView) {
                    if let popup = view as? NSPopUpButton { popup.selectItem(at: state) }
                    if let field = view as? NSTextField, field.isEditable, let value { field.stringValue = value }
                    view.subviews.forEach(fill)
                }
                if let content = window.contentView { fill(content) }
                NSApp.stopModal(withCode: code)
            }
        }
        respondConfirmation(state: 2, value: "2099-10-05", code: .alertFirstButtonReturn)
        claudeButton.performClick(nil)
        precondition(claudeButton.title.contains("해지 예약"))
        precondition(claudeButton.title.contains("2099-10-05"))
        precondition(!claudeButton.title.contains("다음 결제"))
        respondConfirmation(state: 1, value: "2099-10-06", code: .alertSecondButtonReturn)
        claudeButton.performClick(nil)
        precondition(store.details(provider: "anthropic", uuid: "native-cancel-test").confirmation?.state == .scheduled)
        respondConfirmation(state: 1, value: "2026-02-30", code: .alertFirstButtonReturn)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.stopModal(withCode: .alertSecondButtonReturn) }
        claudeButton.performClick(nil)
        precondition(store.details(provider: "anthropic", uuid: "native-cancel-test").confirmation?.state == .scheduled)
        respondConfirmation(state: 3, value: "2026-02-30", code: .alertFirstButtonReturn)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.stopModal(withCode: .alertSecondButtonReturn) }
        claudeButton.performClick(nil)
        precondition(store.details(provider: "anthropic", uuid: "native-cancel-test").confirmation?.state == .scheduled)
        respondConfirmation(state: 3, value: "2026-09-01", code: .alertFirstButtonReturn)
        claudeButton.performClick(nil)
        precondition(store.details(provider: "anthropic", uuid: "native-cancel-test").confirmation?.state == .ended)
        precondition(store.details(provider: "anthropic", uuid: "native-cancel-test").confirmation?.date == "2026-09-01")
        respondConfirmation(state: 0, value: nil, code: .alertThirdButtonReturn)
        claudeButton.performClick(nil)
        precondition(claudeButton.title.contains("해지 미확인"))
        let editDate = NSApplication.ModalResponse(rawValue: NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + 3)
        respondConfirmation(state: 0, value: nil, code: editDate)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            respond("2020-08-01", code: .alertFirstButtonReturn)
        }
        claudeButton.performClick(nil)
        precondition(claudeButton.title.contains("입력 결제일 지남 2020-08-01"))
        precondition(store.details(provider: "anthropic", uuid: "native-cancel-test").confirmation == nil)
        respondConfirmation(state: 0, value: nil, code: editDate)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            respond(nil, code: .alertThirdButtonReturn)
        }
        claudeButton.performClick(nil)
        precondition(store.details(provider: "anthropic", uuid: "native-cancel-test").paymentDate == nil)
        precondition(claudeButton.title.contains("결제일 미확인"))
        let preview = NSView(frame: NSRect(x: 0, y: 0, width: 880, height: 180))
        preview.wantsLayer = true
        preview.layer?.backgroundColor = NSColor(calibratedRed: 0.07, green: 0.09, blue: 0.12, alpha: 1).cgColor
        let previewStates: [AccountSubscriptionState?] = [nil, .renewing, .scheduled, .ended]
        for (index, state) in previewStates.enumerated() {
            let uuid = "preview-\(index)"
            precondition(store.saveConfirmation(state, date: state == .ended ? nil : "2099-10-05", provider: "anthropic", uuid: uuid))
            let row = AccountSubscriptionButton(provider: "anthropic", accountUuid: uuid, accountName: "검증 계정 \(index + 1)", plan: "max_20x", store: store)
            row.frame = NSRect(x: 20, y: 140 - CGFloat(index) * 36, width: 840, height: 24)
            let textWidth = row.attributedTitle.size().width
            precondition(textWidth < row.bounds.width, "구독 상태 텍스트 잘림")
            preview.addSubview(row)
        }
        if let image = preview.bitmapImageRepForCachingDisplay(in: preview.bounds) {
            preview.cacheDisplay(in: preview.bounds, to: image)
            let path = FileManager.default.temporaryDirectory.appendingPathComponent("cc-subscription-cancellation-test.png")
            try! image.representation(using: .png, properties: [:])!.write(to: path)
            print("Cancellation native preview rendered: \(path.path)")
        } else { preconditionFailure("구독 상태 미리보기 렌더 실패") }
        print("AccountSubscriptionTests: validation, isolation, native save/cancel/clear assertions passed")
    }
}
