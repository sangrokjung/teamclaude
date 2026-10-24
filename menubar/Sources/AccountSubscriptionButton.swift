import Cocoa

final class AccountSubscriptionButton: NSButton {
    var onChange: (() -> Void)?
    private let provider: String
    private let accountUuid: String?
    private let accountName: String
    private let fallbackPlan: String?
    private let fallbackConfirmation: AccountSubscriptionConfirmation?
    private let store: AccountSubscriptionStore
    private var rowAppearance: AccountSubscriptionAppearance = .standard

    /// 구독 기록 대화상자를 연다. 버튼을 누른 것과 같다(개요의 "구독 확인", 펼친 행의 "구독 기록"이 쓴다).
    func openRecordDialog() {
        editPaymentDate()
    }

    init(provider: String, accountUuid: String?, accountName: String, plan: String? = nil, confirmation: AccountSubscriptionConfirmation? = nil, store: AccountSubscriptionStore = .shared) {
        let local = accountSubscriptionLocalAccount(provider: provider, uuid: accountUuid, name: accountName)
        self.store = store
        self.provider = provider
        self.accountUuid = local.uuid
        self.accountName = accountName
        self.fallbackPlan = plan ?? local.plan
        self.fallbackConfirmation = confirmation
        super.init(frame: .zero)
        isBordered = false
        alignment = .left
        font = NSFont.systemFont(ofSize: 11)
        contentTintColor = .secondaryLabelColor
        lineBreakMode = .byTruncatingTail
        target = self
        action = #selector(editPaymentDate)
        isEnabled = self.accountUuid?.isEmpty == false
        refreshTitle()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func refreshTitle(now: Date = Date(), appearance: AccountSubscriptionAppearance? = nil) {
        if let appearance { rowAppearance = appearance }
        let details = store.details(provider: provider, uuid: accountUuid, fallbackPlan: fallbackPlan, fallbackConfirmation: fallbackConfirmation)
        let previousTitle = title
        let appearance = rowAppearance == .standard ? details.appearance(now: now) : rowAppearance
        title = accountSubscriptionLabel(details, now: now)
        if rowAppearance == .ended && details.confirmation?.state != .ended {
            title = "\(details.plan ?? L10n.factSubscription) · \(L10n.reasonPlanEnded)"
        } else if rowAppearance == .endDateReached && details.appearance(now: now) != .endDateReached {
            title = "\(details.plan ?? L10n.factSubscription) · \(L10n.subEndPassed)"
        }
        isEnabled = accountUuid?.isEmpty == false
            && !(provider == "codex" && appearance == .ended)
        let state = details.confirmation?.state
        let color: NSColor = appearance.isMuted ? NSColor(calibratedWhite: 0.62, alpha: 1) : provider == "anthropic"
            ? (state == .scheduled ? .systemOrange
                : state == .renewing && !title.contains(L10n.subRecheckMarker) ? .systemGreen
                : state == .renewing ? .systemOrange : NSColor(calibratedWhite: 0.72, alpha: 1))
            : NSColor(calibratedRed: 0.67, green: 0.74, blue: 0.83, alpha: 1)
        let styled = NSMutableAttributedString(string: title, attributes: [
            .font: NSFont.systemFont(ofSize: provider == "anthropic" ? 12 : 11, weight: provider == "anthropic" ? .medium : .regular),
            .foregroundColor: color
        ])
        if provider == "anthropic", let date = details.confirmation?.date {
            let range = (title as NSString).range(of: date)
            if range.location != NSNotFound {
                styled.addAttribute(.font, value: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .bold), range: range)
            }
        }
        attributedTitle = styled
        setAccessibilityLabel("\(accountName): \(title)")
        toolTip = provider == "anthropic"
            ? L10n.subToolTipClaude
            : L10n.subToolTipCodex
        if let confirmation = details.confirmation {
            let source = confirmation.source == "billing-page" ? L10n.subSourceBilling
                : confirmation.source == "confirmation-email" ? L10n.subSourceMail
                : confirmation.source == "proxy-record" ? L10n.subSourceProxy : L10n.subSourceManual
            let mode = details.automaticallyConfirmed ? L10n.subModeAuto
                : confirmation.source == "proxy-record" ? L10n.subModeProxy : L10n.subModeManual
            toolTip = L10n.subSourceLine(source, mode) + (toolTip ?? "")
        }
        if let note = details.monitorNote { toolTip = note + ". " + (toolTip ?? "") }
        if let start = details.startedAt { toolTip = L10n.subStartLine(start) + (toolTip ?? "") }
        if previousTitle != title { onChange?() }
        store.refreshProfile(provider: provider, uuid: accountUuid) { [weak self] in self?.refreshTitle() }
    }

    private func editConfirmation(accountUuid: String) {
        NSApp.activate(ignoringOtherApps: true)
        let details = store.details(provider: provider, uuid: accountUuid, fallbackPlan: fallbackPlan, fallbackConfirmation: fallbackConfirmation)
        let alert = NSAlert()
        alert.messageText = L10n.subDialogTitle(accountName)
        alert.informativeText = L10n.subDialogBody
        alert.addButton(withTitle: L10n.subSaveRecord)
        alert.addButton(withTitle: L10n.cancel)
        alert.addButton(withTitle: L10n.subClearRecord)
        alert.addButton(withTitle: L10n.subEditPayment)
        let accessory = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 64))
        let state = NSPopUpButton(frame: NSRect(x: 0, y: 34, width: 360, height: 26))
        state.addItems(withTitles: [L10n.unconfirmed, L10n.subStateRenewing, L10n.subStateScheduled, L10n.subEndConfirmed])
        let states: [AccountSubscriptionState?] = [nil, .renewing, .scheduled, .ended]
        state.selectItem(at: states.firstIndex { $0 == details.confirmation?.state } ?? 0)
        state.setAccessibilityLabel(L10n.subStateLabel)
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 26))
        field.placeholderString = L10n.subDatePlaceholder
        field.stringValue = details.confirmation?.date ?? ""
        field.setAccessibilityLabel(L10n.subDateLabel)
        accessory.addSubview(state)
        accessory.addSubview(field)
        alert.accessoryView = accessory
        while true {
            let choice = alert.runModal()
            if choice == .alertSecondButtonReturn { return }
            if choice.rawValue == NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + 3 {
                editStoredPaymentDate(accountUuid: accountUuid)
                return
            }
            let selected = choice == .alertThirdButtonReturn ? nil : states[state.indexOfSelectedItem]
            let raw = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            let date = selected == nil || raw.isEmpty ? nil : raw
            if store.saveConfirmation(selected, date: date, provider: provider, uuid: accountUuid) {
                refreshTitle()
                return
            }
            alert.informativeText = L10n.subInvalidDateRecord
        }
    }

    @objc private func editPaymentDate() {
        guard let accountUuid, !accountUuid.isEmpty else { return }
        if provider == "anthropic" {
            editConfirmation(accountUuid: accountUuid)
            return
        }
        editStoredPaymentDate(accountUuid: accountUuid)
    }

    private func editStoredPaymentDate(accountUuid: String) {
        NSApp.activate(ignoringOtherApps: true)
        let details = store.details(provider: provider, uuid: accountUuid, fallbackPlan: fallbackPlan, fallbackConfirmation: fallbackConfirmation)
        let alert = NSAlert()
        alert.messageText = L10n.subPaymentTitle(accountName)
        alert.informativeText = L10n.subPaymentBody
        alert.addButton(withTitle: L10n.save)
        alert.addButton(withTitle: L10n.cancel)
        alert.addButton(withTitle: L10n.subClearDate)
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 26))
        field.placeholderString = "YYYY-MM-DD"
        field.stringValue = details.paymentDate ?? ""
        field.setAccessibilityLabel(L10n.subNextPaymentDate)
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        while true {
            let choice = alert.runModal()
            if choice == .alertSecondButtonReturn { return }
            let value = choice == .alertThirdButtonReturn ? nil : field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if store.savePaymentDate(value, provider: provider, uuid: accountUuid) {
                refreshTitle()
                return
            }
            alert.informativeText = L10n.subInvalidDateSave
        }
    }
}

