import Cocoa
import CryptoKit

@main
struct TeamClaudeAvailabilityTests {
    static func main() throws {
        let app = NSApplication.shared
        let now = accountSubscriptionDate("2026-09-09")!.addingTimeInterval(12 * 3600)
        func row(_ name: String = "검증 계정", session: Double? = 12, weekly: Double? = 23,
                 fable: Double? = 34, reset: Int? = 3600, status: String = "active",
                 enabled: Bool = true, proxy: Bool? = true, current: Bool = true,
                 inflight: Int = 0, capacity: Int = 3, reason: String? = nil) -> TeamClaudeAccountHealth {
            TeamClaudeAccountHealth(name: name, isCurrent: false, enabled: enabled, isUsable: true,
                status: status, errorReason: reason, provider: "anthropic", accountUuid: "ui-fixture-\(name)",
                source: "oauth", totalTokens: 0, totalRequests: 1, sessionPercent: session,
                sessionResetSeconds: reset, weeklyPercent: weekly, weeklyResetSeconds: reset,
                fablePercent: fable, fableResetSeconds: reset, probedAt: now, measurementIssue: nil,
                usableFromProxy: proxy, fableMeasurementCurrent: current, inflightCount: inflight,
                concurrentCapacity: capacity)
        }
        func health(_ rows: [TeamClaudeAccountHealth], online: Bool = true, threshold: Double = 98, checkedAt: Date? = nil) -> TeamClaudeHealth {
            TeamClaudeHealth(checkedAt: checkedAt ?? now, overallStatus: "warning", configPresent: true,
                serverReachable: online, serverPort: 3456, serverPid: nil, accountTotal: rows.count,
                accountConfigured: rows.count, accountActive: rows.count, accountUsable: rows.count,
                accountThrottled: 0, accountExhausted: 0, accountError: 0, accountDisabled: 0,
                accountConfigDrift: 0, inflight: 0, capacity: 48, fableKnown: rows.count, fableOver: 0,
                fableMaxPercent: 99, fableAvgPercent: 34, quotaThresholdPercent: threshold,
                retryAfterSeconds: 3600, accounts: rows, hints: [], host: nil)
        }
        func subscription(_ state: AccountSubscriptionState?, date: String? = nil) -> AccountSubscriptionDetails {
            AccountSubscriptionDetails(plan: "Max 20×", tracksCancellation: true,
                confirmation: state.map { AccountSubscriptionConfirmation(state: $0, date: date, checkedAt: now, source: "user-confirmed") })
        }
        var checks = 0
        func expect(_ item: TeamClaudeAccountHealth, _ expected: TeamClaudeFableState,
                    online: Bool = true, threshold: Double = 98, details: AccountSubscriptionDetails? = nil) {
            let result = teamClaudeFableAvailability(item, health: health([item], online: online, threshold: threshold),
                subscription: details ?? subscription(nil), now: now)
            precondition(result.state == expected, "\(item.name): \(result.reason)")
            checks += 1
        }
        expect(row(), .ready)
        expect(row(weekly: 100, fable: 5), .limited)
        expect(row(session: 98, weekly: 10, fable: 10), .limited)
        expect(row(fable: 98), .limited)
        expect(row(fable: 97.99), .ready)
        expect(row(fable: 90), .limited, threshold: 90)
        for item in [row(session: nil), row(weekly: nil), row(fable: nil), row(reset: 0),
                     row(reset: -1), row(reset: nil), row(fable: .nan), row(fable: -.infinity), row(fable: -1)] {
            expect(item, .unconfirmed)
        }
        expect(row(), .unconfirmed, online: false)
        expect(row(current: false), .unconfirmed)
        expect(row(weekly: 100, current: false), .unconfirmed)
        var fractionalReset = row(reset: 1)
        fractionalReset.weeklyResetAt = now.addingTimeInterval(0.2)
        precondition(teamClaudeFableAvailability(fractionalReset, health: health([fractionalReset], checkedAt: now.addingTimeInterval(0.1)), subscription: subscription(nil), now: now.addingTimeInterval(0.5)).state == .unconfirmed)
        precondition(teamClaudeResetLabel(1, checkedAt: now.addingTimeInterval(0.1), now: now.addingTimeInterval(0.5), resetAt: fractionalReset.weeklyResetAt) == "재측정")
        let expires = row(reset: 1)
        precondition(teamClaudeFableAvailability(expires, health: health([expires]), subscription: subscription(nil), now: now.addingTimeInterval(2)).state == .unconfirmed)
        precondition(teamClaudeFableAvailability(row(), health: health([row()]), subscription: subscription(nil), now: now.addingTimeInterval(61)).state == .unconfirmed)
        let tomorrow = now.addingTimeInterval(86400)
        precondition(teamClaudeFableAvailability(row(), health: health([row()]), subscription: subscription(.scheduled, date: "2026-09-09"), now: tomorrow).state == .unconfirmed)
        var unknownCapacity = row()
        unknownCapacity.concurrentCapacity = nil
        expect(unknownCapacity, .unconfirmed)
        unknownCapacity.concurrentCapacity = 3
        unknownCapacity.inflightCount = nil
        expect(unknownCapacity, .unconfirmed)
        for value: Any? in [nil, "3", true, -1, 1.5, Double.nan] {
            precondition(teamClaudeConcurrencyValue(value) == nil)
        }
        precondition(teamClaudeConcurrencyValue(0) == 0)
        precondition(teamClaudeConcurrencyValue(0, positive: true) == nil)
        precondition(teamClaudeConcurrencyValue(3, positive: true) == 3)
        expect(row(proxy: false), .excluded)
        expect(row(proxy: nil), .unconfirmed)
        expect(row(enabled: false), .excluded)
        expect(row(status: "error"), .excluded)
        expect(row(reason: "auth-expired"), .unconfirmed)
        expect(row(reason: "auth-rejected"), .unconfirmed)
        expect(row(reason: "unknown-error"), .unconfirmed)
        expect(row(status: "configured"), .unconfirmed)
        expect(row(status: "throttled"), .limited)
        expect(row(status: "exhausted"), .limited)
        for status in ["throttled", "exhausted"] {
            expect(row(status: status, current: false), .unconfirmed)
            for (reset, elapsed) in [(1, 2.0), (3600, 60.0)] {
                let item = row(reset: reset, status: status)
                precondition(teamClaudeFableAvailability(item, health: health([item]), subscription: subscription(nil),
                    now: now.addingTimeInterval(elapsed)).state == .unconfirmed)
                checks += 1
            }
        }
        precondition(teamClaudeResetLabel(30, checkedAt: now, now: now.addingTimeInterval(20)) == "10s")
        precondition(teamClaudeResetLabel(30, checkedAt: now, now: now.addingTimeInterval(30)) == "재측정")
        expect(row(inflight: 3), .limited)
        expect(row(inflight: 2), .ready)
        expect(row(), .excluded, details: subscription(.ended, date: "2026-09-01"))
        expect(row(reason: "subscription-ended"), .excluded)
        expect(row(), .ready, details: subscription(.scheduled, date: "2026-10-01"))
        expect(row(), .ready, details: subscription(.scheduled, date: "2026-09-09"))
        expect(row(), .unconfirmed, details: subscription(.scheduled, date: "2026-09-08"))
        expect(row(), .ready, details: subscription(.renewing, date: "2026-10-01"))
        expect(row(), .unconfirmed, threshold: .nan)
        let proxyRecord: [String: Any] = ["state": "cancellation-scheduled", "endsAt": "2026-10-02T00:00:00+09:00", "recordedAt": "2026-09-09T10:00:00+09:00"]
        let proxyConfirmation = teamClaudeSubscriptionConfirmation(proxyRecord, now: now)!
        precondition(proxyConfirmation.state == .scheduled && proxyConfirmation.date == "2026-10-01")
        precondition(teamClaudeSubscriptionConfirmation(["state": "active"], now: now) == nil)
        var due = row()
        due.subscriptionEndReached = true
        expect(due, .unconfirmed)
        var timedEnd = row()
        timedEnd.subscriptionEndsAt = now.addingTimeInterval(20)
        precondition(teamClaudeFableAvailability(timedEnd, health: health([timedEnd]), subscription: subscription(nil), now: now.addingTimeInterval(19)).state == .ready)
        precondition(teamClaudeFableAvailability(timedEnd, health: health([timedEnd]), subscription: subscription(nil), now: now.addingTimeInterval(20)).state == .unconfirmed)
        var endedByProxy = row()
        endedByProxy.subscriptionConfirmation = teamClaudeSubscriptionConfirmation(["state": "ended"], now: now)
        precondition(health([endedByProxy]).fableAvailability(now: now).first?.state == .excluded)
        let proxyButton = AccountSubscriptionButton(provider: "anthropic", accountUuid: "proxy-fixture", accountName: "서버 기록", confirmation: proxyConfirmation)
        precondition(proxyButton.title.contains("2026-10-01"))
        precondition(proxyButton.toolTip?.contains("서버 구독 기록") == true)
        precondition(!proxyButton.isEnabled)
        UserDefaults.standard.removeObject(forKey: "cc.account-subscription.v1.anthropic.proxy-fixture")
        let missing = accountSubscriptionLabel(subscription(nil), now: now)
        precondition(missing.contains("만료일 미확인") && !missing.contains("정상"))
        let ended = accountSubscriptionLabel(subscription(.ended, date: "2026-09-01"), now: now)
        precondition(ended.contains("구독 종료 확인") && ended.contains("만료일 2026-09-01"))
        let scheduled = accountSubscriptionLabel(subscription(.scheduled, date: "2026-10-01"), now: now)
        precondition(scheduled.contains("해지 예약") && scheduled.contains("2026-10-01"))
        let previous = row()
        let partial = row(weekly: nil, fable: nil)
        let merged = teamClaudeAccountMergingQuota(candidate: partial, previous: previous,
            elapsedSeconds: 10, thresholdPercent: 98, observedAt: now)
        precondition(merged.fablePercent == 34)
        expect(merged, .unconfirmed)
        let denied = teamClaudeAccountMergingQuota(candidate: row(proxy: false), previous: previous,
            elapsedSeconds: 10, thresholdPercent: 98, observedAt: now)
        expect(denied, .excluded)
        let conflicting = teamClaudeAccountMergingQuota(candidate: row(reason: "auth-expired"), previous: previous,
            elapsedSeconds: 10, thresholdPercent: 98, observedAt: now)
        precondition(conflicting.errorReason == "auth-expired")
        expect(conflicting, .unconfirmed)
        for raw in ["{\"errorReason\":{\"code\":\"auth-expired\"}}", "{\"errorReason\":[\"auth-expired\"]}", "{\"errorReason\":false}"] {
            let parsed = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [String: Any]
            let invalid = row(reason: teamClaudeErrorReason(parsed["errorReason"]))
            expect(invalid, .unconfirmed)
            let retained = teamClaudeAccountMergingQuota(candidate: invalid, previous: previous,
                elapsedSeconds: 10, thresholdPercent: 98, observedAt: now)
            expect(retained, .unconfirmed)
        }
        precondition(teamClaudeErrorReason(nil) == nil)
        precondition(teamClaudeErrorReason(NSNull()) == nil)
        precondition(teamClaudeErrorReason("auth-expired") == "auth-expired")
        let rawJSON = try JSONSerialization.jsonObject(with: Data("{\"numeric\":0,\"no\":false,\"yes\":true,\"one\":1}".utf8)) as! [String: Any]
        precondition(teamClaudeQuotaNumber(rawJSON["numeric"]) == 0)
        precondition(teamClaudeStatusBool(rawJSON["no"]) == false)
        precondition(teamClaudeStatusBool(rawJSON["yes"]) == true)
        precondition(teamClaudeStatusBool(rawJSON["one"]) == nil)
        for key in ["no", "yes"] {
            precondition(teamClaudeQuotaNumber(rawJSON[key]) == nil)
            for window in 0..<3 {
                let parsed = teamClaudeQuotaNumber(rawJSON[key])
                let invalid = row(session: window == 0 ? parsed : 12,
                                  weekly: window == 1 ? parsed : 23,
                                  fable: window == 2 ? parsed : 34)
                expect(invalid, .unconfirmed)
                let mergedInvalid = teamClaudeAccountMergingQuota(candidate: invalid, previous: previous,
                    elapsedSeconds: 10, thresholdPercent: 98, observedAt: now)
                expect(mergedInvalid, .unconfirmed)
            }
        }
        expect(row(session: teamClaudeQuotaNumber(rawJSON["numeric"]), weekly: 0, fable: 0), .ready)
        expect(row(proxy: teamClaudeStatusBool(rawJSON["one"])), .unconfirmed)
        expect(row(), .unconfirmed, threshold: teamClaudeQuotaNumber(rawJSON["no"]) ?? .nan)
        let resetMs = now.addingTimeInterval(3600).timeIntervalSince1970 * 1000
        let thresholdAccount: [String: Any] = ["name": "threshold-fixture", "provider": "anthropic",
            "enabled": true, "status": "active", "usable": true, "inflight": 0, "maxConcurrent": 3,
            "quota": ["unified5h": 0.1, "unified7d": 0.2, "unified5hReset": resetMs,
                      "unified7dReset": resetMs, "modelWeekly": ["7d_oi": ["utilization": 0.97, "reset": resetMs]]]]
        for (serverThreshold, expected): (Any?, TeamClaudeFableState) in [
            (nil, .unconfirmed), (NSNull(), .unconfirmed), (true, .unconfirmed),
            (0.98, .ready), (0.95, .limited)
        ] {
            var rawStatus: [String: Any] = ["accounts": [thresholdAccount]]
            rawStatus["switchThreshold"] = serverThreshold
            let data = try JSONSerialization.data(withJSONObject: rawStatus)
            let parsedStatus = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            for localThreshold in [0.5, 0.99] {
                let parsed = parseTeamClaudeHealth(config: ["switchThreshold": localThreshold], server: nil,
                    status: parsedStatus, port: 3456, now: now)
                precondition(parsed.accounts.count == 1)
                precondition(teamClaudeFableAvailability(parsed.accounts[0], health: parsed,
                    subscription: subscription(nil), now: now).state == expected)
                checks += 1
            }
        }
        print("FABLE-AVAILABILITY: \(checks) boundary cases, expiry labels and retained-quota exclusion passed")

        let suite = "ui-fixture-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = AccountSubscriptionStore(defaults: defaults,
            configURL: URL(fileURLWithPath: "/nonexistent-ui-fixture-config"), clock: { now })
        let one = row("기록 변경")
        let before = health([one]).fableAvailability(store: store, now: now)
        precondition(before.filter { $0.state == .ready }.count == 1)
        precondition(store.saveConfirmation(.ended, date: "2026-09-01", provider: "anthropic", uuid: one.accountUuid!))
        precondition(health([one]).fableAvailability(store: store, now: now).filter { $0.state == .ready }.isEmpty)
        let button = AccountSubscriptionButton(provider: "anthropic", accountUuid: one.accountUuid,
            accountName: one.name, store: store)
        var changes = 0
        button.onChange = { changes += 1 }
        precondition(store.saveConfirmation(.scheduled, date: "2026-10-01", provider: "anthropic", uuid: one.accountUuid!))
        button.refreshTitle()
        precondition(changes == 1)
        let monitorURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("fable-monitor-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: monitorURL) }
        let key = SHA256.hash(data: Data(("anthropic:" + one.accountUuid!).utf8)).map { String(format: "%02x", $0) }.joined()
        let monitor = ["version": 1, "checkedAt": "2026-09-09T11:00:00+09:00", "accounts": [key: [
            "status": "ok", "lastSuccessAt": "2026-09-09T11:00:00+09:00", "event": ["kind": "cancel",
            "eventAt": "2026-09-09T10:00:00+09:00", "endsOn": "2026-10-01"]]]] as [String: Any]
        try JSONSerialization.data(withJSONObject: monitor).write(to: monitorURL)
        defaults.removePersistentDomain(forName: suite)
        let monitoredStore = AccountSubscriptionStore(defaults: defaults, configURL: URL(fileURLWithPath: "/nonexistent-ui-fixture-config"), monitorURL: monitorURL, clock: { now })
        let monitored = monitoredStore.details(provider: "anthropic", uuid: one.accountUuid)
        precondition(monitored.automaticallyConfirmed && monitored.confirmation?.state == .scheduled)
        precondition(accountSubscriptionLabel(monitored, now: now).contains("자동확인"))
        let serverEnded = teamClaudeSubscriptionConfirmation(["state": "ended"], now: now)!
        let prioritized = monitoredStore.details(provider: "anthropic", uuid: one.accountUuid, fallbackConfirmation: serverEnded)
        precondition(prioritized.confirmation?.state == .ended && !prioritized.automaticallyConfirmed)
        print("FABLE-MONITOR: concurrent mail-monitor overlay preserved; server ended record takes priority passed")
        print("FABLE-RECORD: confirmation changes update count and callback passed")

        let runId = UUID().uuidString
        let cases = [row("사용 가능"), row("주간 소진", weekly: 100, fable: 5), row("세션 소진", session: 99),
                     row("Fable 소진", fable: 99), row("재측정 필요", current: false), row("구독 종료"),
                     row("해지 예약"), row("인증 오류", status: "error", reason: "auth-expired")]
        var rows = (0..<16).map { index -> TeamClaudeAccountHealth in
            var item = cases[index % cases.count]
            item.accountUuid = "fable-layout-\(runId)-\(index)"
            return item
        }
        rows[0].concurrentCapacity = 3
        defer {
            for item in rows {
                UserDefaults.standard.removeObject(forKey: "cc.account-subscription.v1.anthropic.\(item.accountUuid!)")
            }
        }
        for (index, item) in rows.enumerated() {
            let state: AccountSubscriptionState? = index % 8 == 5 ? .ended : index % 8 == 6 ? .scheduled : nil
            let date = state == .ended ? "2026-09-01" : "2099-10-01"
            precondition(AccountSubscriptionStore.shared.saveConfirmation(state, date: date,
                provider: "anthropic", uuid: item.accountUuid!))
        }
        let model = health(rows, checkedAt: Date())
        precondition(model.fableAvailability().filter { $0.state == .ready }.count == 4)
        let view = TeamClaudeTableView(frame: NSRect(x: 0, y: 0, width: 880,
            height: StatusMenuDashboardView.teamContentHeight(model)))
        view.health = model
        view.layoutSubtreeIfNeeded()
        precondition(view.accessibilityLabel()?.contains("Fable 사용 가능 4/16") == true)
        let buttons = view.subviews.compactMap { $0 as? AccountSubscriptionButton }
        precondition(buttons.count == 16)
        for button in buttons {
            precondition(view.bounds.contains(button.frame))
            precondition(button.attributedTitle.size().width < button.frame.width)
            for other in view.subviews.compactMap({ $0 as? NSButton }) where other !== button {
                precondition(!button.frame.intersects(other.frame))
            }
        }
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 880, height: 730))
        scroll.hasVerticalScroller = true
        scroll.documentView = view
        scroll.contentView.scroll(to: NSPoint(x: 0, y: view.bounds.height - scroll.contentView.bounds.height))
        precondition(scroll.contentView.bounds.contains(buttons.last!.frame))
        scroll.contentView.scroll(to: .zero)
        app.setActivationPolicy(.regular)
        let window = NSWindow(contentRect: scroll.bounds, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "TeamClaude Fable UI 검증"
        window.contentView = scroll
        window.center()
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        window.displayIfNeeded()
        if let index = CommandLine.arguments.firstIndex(of: "--screenshot"), CommandLine.arguments.count > index + 1 {
            let bitmap = scroll.bitmapImageRepForCachingDisplay(in: scroll.bounds)!
            scroll.cacheDisplay(in: scroll.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[index + 1]))
        }
        print("FABLE-LAYOUT: 16 production rows, count 4/16, button width, non-overlap and scroll end passed")
        let automatedModal = CommandLine.arguments.contains("--automated-modal")
        if let index = CommandLine.arguments.firstIndex(of: "--interactive-verify")
            ?? CommandLine.arguments.firstIndex(of: "--automated-modal") {
            let nonce = CommandLine.arguments[index + 1]
            let executableData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[0]))
            let executableHash = SHA256.hash(data: executableData).map { String(format: "%02x", $0) }.joined()
            var invalidDateSeen = false
            var savedSeen = false
            var inputStage = 0
            let timer = Timer(timeInterval: 0.2, repeats: true) { _ in
                func texts(_ node: NSView) -> [String] {
                    ((node as? NSTextField).map { [$0.stringValue] } ?? []) + node.subviews.flatMap(texts)
                }
                if app.windows.contains(where: { $0.contentView.map { texts($0).contains(where: { $0.contains("날짜를 확인하세요. 실제 존재하는") }) } ?? false }) {
                    invalidDateSeen = true
                }
                let details = AccountSubscriptionStore.shared.details(provider: "anthropic", uuid: rows[0].accountUuid)
                if details.confirmation?.state == .ended && details.confirmation?.date == "2026-09-01" {
                    precondition(view.accessibilityLabel()?.contains("Fable 사용 가능 3/16") == true)
                    savedSeen = true
                }
                if automatedModal {
                    func descendants(_ node: NSView) -> [NSView] {
                        [node] + node.subviews.flatMap(descendants)
                    }
                    if let modal = app.modalWindow?.contentView {
                        let controls = descendants(modal)
                        if let popup = controls.compactMap({ $0 as? NSPopUpButton }).first,
                           let field = controls.compactMap({ $0 as? NSTextField }).first(where: { $0.placeholderString != nil }),
                           let save = controls.compactMap({ $0 as? NSButton }).first(where: { $0.title == "기록 저장" }) {
                            if inputStage == 0 {
                                popup.selectItem(at: 3)
                                field.stringValue = "2026-02-30"
                                inputStage = 1
                                save.performClick(nil)
                            } else if inputStage == 1 && invalidDateSeen {
                                field.stringValue = "2026-09-01"
                                inputStage = 2
                                save.performClick(nil)
                            }
                        }
                    } else if savedSeen {
                        scroll.contentView.scroll(to: NSPoint(x: 0, y: view.bounds.height - scroll.contentView.bounds.height))
                    }
                }
                if invalidDateSeen && savedSeen && scroll.contentView.bounds.contains(buttons.last!.frame) {
                    let result: [String: Any] = ["nonce": nonce, "executable_sha256": executableHash,
                        "invalid_date_blocked": invalidDateSeen, "saved": savedSeen,
                        "ready_before": 4, "ready_after": 3, "last_row_visible": true]
                    let payload = try! JSONSerialization.data(withJSONObject: result, options: .sortedKeys)
                    FileHandle.standardOutput.write(Data("INTERACTIVE-RESULT:".utf8) + payload + Data("\n".utf8))
                    exit(0)
                }
            }
            RunLoop.main.add(timer, forMode: .common)
            RunLoop.main.add(timer, forMode: .modalPanel)
            let statusTimer = Timer(timeInterval: 10, repeats: true) { _ in view.health = health(rows, checkedAt: Date()) }
            RunLoop.main.add(statusTimer, forMode: .common)
            if automatedModal { DispatchQueue.main.async { buttons[0].performClick(nil) } }
            app.run()
            timer.invalidate()
            statusTimer.invalidate()
            return
        }
        if CommandLine.arguments.contains("--show-window") {
            // Interactive QA mirrors production's 10-second status polling.
            // The automated expiry tests below deliberately receive no updates.
            let timer = Timer(timeInterval: 10, repeats: true) { _ in
                view.health = health(rows, checkedAt: Date())
            }
            RunLoop.main.add(timer, forMode: .common)
            app.run()
            timer.invalidate()
        }
        for (reset, age) in [(3600, 59.2), (1, 0.0)] {
            let snapshot = health([row("시간 갱신", reset: reset)], checkedAt: Date().addingTimeInterval(-age))
            view.health = snapshot
            precondition(view.accessibilityLabel()?.contains("Fable 사용 가능 1/1") == true)
            RunLoop.main.run(until: Date().addingTimeInterval(2.2))
            precondition(view.accessibilityLabel()?.contains("Fable 사용 가능 0/1") == true)
            precondition(snapshot.fableAvailability(now: view.evaluatedAt).first?.state == .unconfirmed)
        }
        var soonEnding = row("구독 종료 시각")
        soonEnding.subscriptionEndsAt = Date().addingTimeInterval(0.8)
        view.health = health([soonEnding], checkedAt: Date())
        precondition(view.accessibilityLabel()?.contains("Fable 사용 가능 1/1") == true)
        RunLoop.main.run(until: Date().addingTimeInterval(2.2))
        precondition(view.accessibilityLabel()?.contains("Fable 사용 가능 0/1") == true)
        window.orderOut(nil)
        print("FABLE-SUBSCRIPTION-TIME: exact endsAt expires within 60s without a new server response passed")
        print("FABLE-TIMER: open window updates count and accessibility across 60s and reset boundaries without new status; countdown 30s to 10s to remeasure passed")
    }
}
