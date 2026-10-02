import Cocoa

@main
struct AccountSubscriptionLayoutTests {
    static func main() throws {
        let app = NSApplication.shared
        let runId = UUID().uuidString
        let ids = (0..<16).map { "cancellation-layout-\(runId)-\($0)" }
        let states: [AccountSubscriptionState?] = [nil, .renewing, .scheduled, .ended, .renewing, .scheduled]
        let expected = ["해지 미확인", "자동갱신 확인", "해지 예약", "구독 종료 확인", "갱신 재확인", "종료일 경과 · 확인 필요"]
        func cleanUp() {
            ids.forEach { UserDefaults.standard.removeObject(forKey: "cc.account-subscription.v1.anthropic.\($0)") }
        }
        defer { cleanUp() }
        let termination = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification,
            object: nil, queue: .main) { _ in cleanUp() }
        defer { NotificationCenter.default.removeObserver(termination) }
        for (index, uuid) in ids.enumerated() {
            let state = states[index % states.count]
            precondition(AccountSubscriptionStore.shared.saveConfirmation(state, date: index % states.count == 5 ? "2000-01-01" : "2099-10-05", provider: "anthropic", uuid: uuid))
            let key = "cc.account-subscription.v1.anthropic.\(uuid)"
            var saved = UserDefaults.standard.dictionary(forKey: key) ?? [:]
            saved["plan"] = "Max 20×"
            if index % states.count == 4, var confirmation = saved["confirmation"] as? [String: Any] {
                confirmation["checkedAt"] = Date().addingTimeInterval(-90000)
                saved["confirmation"] = confirmation
            }
            UserDefaults.standard.set(saved, forKey: key)
        }
        let rows = (0..<16).map { index in
            TeamClaudeAccountHealth(name: "검증 계정 \(index + 1)", isCurrent: index % states.count == 3 || index % states.count == 5, enabled: true, isUsable: false,
                status: index % states.count == 5 ? "active" : "error", errorReason: index % states.count == 5 ? nil : "auth-expired", provider: "anthropic", accountUuid: ids[index],
                source: "oauth", totalTokens: 0, totalRequests: 0, sessionPercent: 12, sessionResetSeconds: 3600,
                weeklyPercent: 23, weeklyResetSeconds: 86400, fablePercent: 34, fableResetSeconds: 86400, probedAt: Date(), measurementIssue: nil)
        }
        let health = TeamClaudeHealth(checkedAt: Date(), overallStatus: "warning", configPresent: true,
            serverReachable: true, serverPort: 3456, serverPid: nil, accountTotal: 16, accountConfigured: 16,
            accountActive: 0, accountUsable: 0, accountThrottled: 0, accountExhausted: 0, accountError: 16,
            accountDisabled: 0, accountConfigDrift: 0, inflight: 0, capacity: 48, fableKnown: 0, fableOver: 0,
            fableMaxPercent: nil, fableAvgPercent: nil, quotaThresholdPercent: 98, retryAfterSeconds: nil,
            accounts: rows, hints: [], host: nil)
        let view = TeamClaudeTableView(frame: NSRect(x: 0, y: 0, width: 880, height: StatusMenuDashboardView.teamContentHeight(health)))
        view.health = health
        view.layoutSubtreeIfNeeded()
        let buttons = view.subviews.compactMap { $0 as? AccountSubscriptionButton }
        let recovery = view.subviews.compactMap { $0 as? NSButton }.filter { !($0 is AccountSubscriptionButton) }
        precondition(buttons.count == 16 && recovery.count == 11)
        for (index, row) in rows.enumerated() {
            let hasRecovery = recovery.contains { $0.accessibilityLabel() == "재인증 필요: \(row.name)" }
            precondition(hasRecovery == (index % states.count != 3 && index % states.count != 5))
        }
        func isGray(_ color: NSColor) -> Bool {
            let rgb = color.usingColorSpace(.deviceRGB)!
            return abs(rgb.redComponent - rgb.greenComponent) < 0.02
                && abs(rgb.greenComponent - rgb.blueComponent) < 0.02
        }
        for (index, button) in buttons.enumerated() {
            precondition(button.title.contains(expected[index % expected.count]))
            let color = button.attributedTitle.attribute(.foregroundColor, at: 0, effectiveRange: nil) as! NSColor
            if index % states.count == 3 || index % states.count == 5 { precondition(isGray(color)) }
            if index % states.count == 2 { precondition(!isGray(color)) }
            precondition(view.bounds.contains(button.frame))
            precondition(button.attributedTitle.size().width < button.frame.width)
            precondition(button.accessibilityLabel()?.contains(button.title) == true)
            for other in view.subviews.compactMap({ $0 as? NSButton }) where other !== button {
                precondition(!button.frame.intersects(other.frame))
            }
        }
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 880, height: 420))
        scroll.hasVerticalScroller = true
        scroll.documentView = view
        scroll.contentView.scroll(to: NSPoint(x: 0, y: view.bounds.height - scroll.contentView.bounds.height))
        precondition(scroll.contentView.bounds.contains(buttons.last!.frame))
        let now = Date()
        let today = Calendar.current.startOfDay(for: now)
        let format = DateFormatter()
        format.dateFormat = "yyyy-MM-dd"
        let lastDay = format.string(from: today)
        let details = AccountSubscriptionDetails(tracksCancellation: true,
            confirmation: AccountSubscriptionConfirmation(state: .scheduled, date: lastDay, checkedAt: today, source: "user-confirmed"))
        precondition(details.appearance(now: today) == .standard)
        precondition(details.appearance(now: today.addingTimeInterval(86399)) == .standard)
        precondition(details.appearance(now: Calendar.current.date(byAdding: .day, value: 1, to: today)!) == .endDateReached)
        let availability = health.fableAvailability(now: now)
        precondition(availability[3].state == .excluded && availability[3].subscriptionAppearance == .ended)
        precondition(availability[5].state == .unconfirmed && availability[5].subscriptionAppearance == .endDateReached)
        var sameDayEnd = rows[0]
        sameDayEnd.subscriptionEndsAt = now.addingTimeInterval(-3600)
        // 서버 시각이 오늘이어도 현지 날짜가 지나지 않았으면 예약 상태를 유지한다.
        precondition(teamClaudeFableAvailability(sameDayEnd, health: health, subscription: AccountSubscriptionDetails(), now: now).subscriptionAppearance == .standard)
        precondition(availability[0].state == .excluded && !availability[0].subscriptionAppearance.isMuted)
        var proxyEnded = rows[0]
        proxyEnded.errorReason = "subscription-ended"
        precondition(teamClaudeFableAvailability(proxyEnded, health: health,
            subscription: AccountSubscriptionDetails(), now: now).subscriptionAppearance == .ended)
        let screenshots = CommandLine.arguments.firstIndex(of: "--screenshot-dir").map {
            URL(fileURLWithPath: CommandLine.arguments[$0 + 1], isDirectory: true)
        }
        func capture(_ view: NSView, _ filename: String) throws {
            guard let screenshots else { return }
            view.appearance = NSAppearance(named: .darkAqua)
            view.layoutSubtreeIfNeeded()
            let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])!.write(to: screenshots.appendingPathComponent(filename))
        }
        try capture(view, "claude-gray.png")
        // 같은 뷰에서 재가입 기록이 들어오면 종료 색과 숨겼던 복구 버튼도 갱신된다.
        precondition(AccountSubscriptionStore.shared.saveConfirmation(.renewing, date: "2099-10-05", provider: "anthropic", uuid: ids[3]))
        buttons[3].refreshTitle()
        view.layoutSubtreeIfNeeded()
        precondition(view.subviews.compactMap { $0 as? NSButton }.filter { !($0 is AccountSubscriptionButton) }.count == 12)
        precondition(buttons[3].title.contains("자동갱신 확인"))
        precondition(buttons[3].isEnabled)
        precondition(!isGray(buttons[3].attributedTitle.attribute(.foregroundColor, at: 0, effectiveRange: nil) as! NSColor))
        // 자동 감시/서버 fallback이 있는 계정도 로컬 확인 기록을 수정할 수 있어야 한다.
        let fallbackButton = AccountSubscriptionButton(provider: "anthropic", accountUuid: ids[1],
            accountName: "자동확인 계정", confirmation: AccountSubscriptionConfirmation(
                state: .scheduled, date: "2099-10-05", checkedAt: now, source: "proxy-record"))
        precondition(fallbackButton.isEnabled)

        let codexRows = (0..<3).map { index in
            TeamCodexPoolAccount(name: ["구독 종료", "종료일 경과", "사용 가능"][index],
                accountUuid: "codex-gray-\(runId)-\(index)", isCurrent: index == 0, enabled: true,
                status: "active", errorReason: nil, usableFromProxy: index != 0,
                sessionPercent: 23, sessionResetAt: now.addingTimeInterval(3600), weeklyPercent: 45,
                weeklyResetAt: now.addingTimeInterval(86400), inflight: 0, maxConcurrent: 3,
                totalRequests: 7, totalTokens: 12345, subscriptionState: ["ended", "end-date-reached", "active"][index],
                planType: "plus", accountType: "oauth", providerName: "codex")
        }
        let pool = TeamCodexPoolHealth(checkedAt: now, serverReachable: true, serverPort: 3457,
            serverPid: nil, currentAccount: nil, currentAccountUuid: nil, switchThresholdPercent: 98, accounts: codexRows)
        let codexView = CodexStatusView(frame: NSRect(x: 0, y: 0, width: 880, height: CodexStatusView.preferredHeight(for: pool)))
        codexView.pool = pool
        codexView.layoutSubtreeIfNeeded()
        let codexButtons = codexView.subviews.compactMap { $0 as? AccountSubscriptionButton }
        precondition(codexButtons.count == 3)
        precondition(codexButtons[0].title.contains("구독 종료") && !codexButtons[0].title.contains("다음 결제"))
        precondition(isGray(codexButtons[0].attributedTitle.attribute(.foregroundColor, at: 0, effectiveRange: nil) as! NSColor))
        precondition(!codexButtons[0].isEnabled && codexButtons[1].isEnabled)
        precondition(teamCodexAccountState(codexRows[1], switchThresholdPercent: pool.switchThresholdPercent, now: pool.checkedAt) == .endDateReached)
        try capture(codexView, "codex-gray.png")
        var revived = codexRows
        revived[0].subscriptionState = "active"
        codexView.pool = TeamCodexPoolHealth(checkedAt: now, serverReachable: true, serverPort: 3457,
            serverPid: nil, currentAccount: nil, currentAccountUuid: nil, switchThresholdPercent: 98, accounts: revived)
        codexView.layoutSubtreeIfNeeded()
        precondition(!codexButtons[0].title.contains("구독 종료") && codexButtons[0].isEnabled)
        func makeHealth(_ rows: [TeamClaudeAccountHealth], online: Bool = true) -> TeamClaudeHealth {
            TeamClaudeHealth(checkedAt: now, overallStatus: "warning", configPresent: true,
                serverReachable: online, serverPort: 3456, serverPid: nil, accountTotal: rows.count,
                accountConfigured: rows.count, accountActive: rows.count, accountUsable: 0,
                accountThrottled: 0, accountExhausted: 0, accountError: 0, accountDisabled: 0,
                accountConfigDrift: 0, inflight: 0, capacity: 3, fableKnown: 0, fableOver: 0,
                fableMaxPercent: nil, fableAvgPercent: nil, quotaThresholdPercent: 98,
                retryAfterSeconds: nil, accounts: rows, hints: [], host: nil)
        }
        func pending(_ uuid: String, enabled: Bool = true) -> TeamClaudeAccountHealth {
            TeamClaudeAccountHealth(name: "측정 대상", isCurrent: true, enabled: enabled, isUsable: true,
                status: "active", provider: "anthropic", accountUuid: uuid, source: "oauth",
                totalTokens: 0, totalRequests: 0, sessionPercent: nil, sessionResetSeconds: nil,
                weeklyPercent: nil, weeklyResetSeconds: nil, fablePercent: nil, fableResetSeconds: nil,
                probedAt: nil, measurementIssue: .sessionMissing)
        }
        // 종료일 경과 × 오프라인/비활성에서도 같은 회색 표시를 유지한다.
        for (enabled, online) in [(true, false), (false, true), (false, false)] {
            let matrix = makeHealth([pending(ids[5], enabled: enabled)], online: online)
            let state = matrix.fableAvailability(now: now)[0]
            precondition(state.subscriptionAppearance == .endDateReached)
            precondition(state.state == (enabled ? .unconfirmed : .excluded))
            let matrixView = TeamClaudeTableView(frame: NSRect(x: 0, y: 0, width: 880,
                height: StatusMenuDashboardView.teamContentHeight(matrix)))
            matrixView.health = matrix
            matrixView.layoutSubtreeIfNeeded()
            let button = matrixView.subviews.compactMap { $0 as? AccountSubscriptionButton }[0]
            precondition(button.title.contains("종료일 경과"))
            precondition(isGray(button.attributedTitle.attribute(.foregroundColor, at: 0, effectiveRange: nil) as! NSColor))
            try capture(matrixView, "claude-due-\(enabled)-\(online).png")
        }
        let endedPending = pending(ids[9])
        let onlyEnded = makeHealth([endedPending])
        precondition(onlyEnded.measurementPendingCount == 0)
        let pendingView = TeamClaudeTableView(frame: NSRect(x: 0, y: 0, width: 880,
            height: StatusMenuDashboardView.teamContentHeight(onlyEnded)))
        pendingView.health = onlyEnded
        pendingView.layoutSubtreeIfNeeded()
        precondition(pendingView.accessibilityHelp() == nil)
        precondition(pendingView.accessibilityLabel()?.contains("측정 필요 0") == true)
        var measurements = 0
        pendingView.onMeasure = { measurements += 1 }
        let enter = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)!
        pendingView.keyDown(with: enter)
        precondition(measurements == 0)
        try capture(pendingView, "claude-ended-no-measure.png")
        let mixed = makeHealth([endedPending, pending(ids[0])])
        precondition(mixed.measurementPendingCount == 1)
        pendingView.health = mixed
        pendingView.layoutSubtreeIfNeeded()
        precondition(pendingView.accessibilityHelp()?.contains("Return") == true)
        pendingView.keyDown(with: enter)
        precondition(measurements == 1)
        print("SUBSCRIPTION-EDGE: offline/disabled due appearance and retired-only/mixed measurement actions passed")
        print("CANCELLATION-LAYOUT: actual Claude16 rows, six states, recovery buttons and scroll end passed")
        print("SUBSCRIPTION-GRAY: boundary, error precedence, neutral colors, live renewal and Codex retired rows passed")
        if CommandLine.arguments.contains("--show-window") {
            app.setActivationPolicy(.regular)
            let window = NSWindow(contentRect: scroll.bounds, styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Claude 계정 행 해지 표시 검증"
            window.contentView = scroll
            window.center()
            window.makeKeyAndOrderFront(nil)
            app.activate(ignoringOtherApps: true)
            app.run()
        }
    }
}
