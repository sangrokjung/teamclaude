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
    /// 기록이 없어 구독 줄을 그리지 않는 행에서 이름 줄 안에 놓이는 조용한 진입점.
    /// 화면 제목만 짧게 바꾸고 접근성 라벨·툴팁은 전체 문구를 유지한다 — 보조기기에는 여전히 무엇이 미확인인지 읽힌다.
    private(set) var isQuietEntry = false
    static let quietTitle = "구독 기록"

    func setQuietEntry(_ quiet: Bool) {
        guard quiet != isQuietEntry else { return }
        isQuietEntry = quiet
        refreshTitle()
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
            title = "\(details.plan ?? "구독") · 구독 종료 · 이용 불가"
        } else if rowAppearance == .endDateReached && details.appearance(now: now) != .endDateReached {
            title = "\(details.plan ?? "구독") · 종료일 경과 · 확인 필요"
        }
        isEnabled = accountUuid?.isEmpty == false
            && !(provider == "codex" && appearance == .ended)
        let state = details.confirmation?.state
        let color: NSColor = appearance.isMuted ? NSColor(calibratedWhite: 0.62, alpha: 1) : provider == "anthropic"
            ? (state == .scheduled ? .systemOrange
                : state == .renewing && !title.contains("재확인") ? .systemGreen
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
        attributedTitle = isQuietEntry
            ? NSAttributedString(string: Self.quietTitle, attributes: [
                .font: NSFont.systemFont(ofSize: 11, weight: .medium),
                .foregroundColor: NSColor(calibratedWhite: 0.72, alpha: 1)
            ])
            : styled
        setAccessibilityLabel("\(accountName): \(title)")
        toolTip = provider == "anthropic"
            ? "구독 관리 화면이나 해지 확인 메일의 내용을 기록합니다. 실제 구독은 변경하지 않습니다. Max/active만으로 해지 여부를 확인할 수 없습니다."
            : "결제일을 입력하거나 수정합니다. 자동 조회된 결제일이 아닙니다."
        if let confirmation = details.confirmation {
            let source = confirmation.source == "billing-page" ? "구독 관리 화면"
                : confirmation.source == "confirmation-email" ? "확인 메일"
                : confirmation.source == "proxy-record" ? "TeamClaude 서버 구독 기록" : "직접 입력"
            let mode = details.automaticallyConfirmed ? "로그인된 메일에서 자동 확인했습니다."
                : confirmation.source == "proxy-record" ? "서버에 기록된 구독 상태입니다." : "이 기록은 직접 확인한 내용입니다."
            toolTip = "출처: \(source). \(mode) " + (toolTip ?? "")
        }
        if let note = details.monitorNote { toolTip = note + ". " + (toolTip ?? "") }
        if let start = details.startedAt { toolTip = "구독 시작일 \(start). " + (toolTip ?? "") }
        if previousTitle != title { onChange?() }
        store.refreshProfile(provider: provider, uuid: accountUuid) { [weak self] in self?.refreshTitle() }
    }

    private func editConfirmation(accountUuid: String) {
        NSApp.activate(ignoringOtherApps: true)
        let details = store.details(provider: provider, uuid: accountUuid, fallbackPlan: fallbackPlan, fallbackConfirmation: fallbackConfirmation)
        let alert = NSAlert()
        alert.messageText = "\(accountName) 구독 확인 기록"
        alert.informativeText = "구독 관리 화면이나 확인 메일에서 확인한 상태만 기록하세요. 실제 구독 변경·해지가 아닙니다. 자동갱신은 다음 결제일, 해지 예약은 마지막 이용일을 입력하세요. 날짜를 모르면 비워 두세요."
        alert.addButton(withTitle: "기록 저장")
        alert.addButton(withTitle: "취소")
        alert.addButton(withTitle: "확인 기록 지우기")
        alert.addButton(withTitle: "입력 결제일 편집")
        let accessory = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 64))
        let state = NSPopUpButton(frame: NSRect(x: 0, y: 34, width: 360, height: 26))
        state.addItems(withTitles: ["미확인", "자동갱신 확인", "해지 예약", "구독 종료 확인"])
        let states: [AccountSubscriptionState?] = [nil, .renewing, .scheduled, .ended]
        state.selectItem(at: states.firstIndex { $0 == details.confirmation?.state } ?? 0)
        state.setAccessibilityLabel("확인한 구독 상태")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 26))
        field.placeholderString = "YYYY-MM-DD (미확인 시 비워 둠)"
        field.stringValue = details.confirmation?.date ?? ""
        field.setAccessibilityLabel("다음 결제일 또는 마지막 이용일")
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
            alert.informativeText = "날짜를 확인하세요. 실제 존재하는 YYYY-MM-DD 날짜만 기록할 수 있습니다. 실제 구독은 변경하지 않습니다."
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
        alert.messageText = "\(accountName) 결제일"
        alert.informativeText = "청구서 또는 구독 관리 화면에서 확인한 다음 결제일을 입력하세요. YYYY-MM-DD 형식입니다."
        alert.addButton(withTitle: "저장")
        alert.addButton(withTitle: "취소")
        alert.addButton(withTitle: "날짜 지우기")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 26))
        field.placeholderString = "YYYY-MM-DD"
        field.stringValue = details.paymentDate ?? ""
        field.setAccessibilityLabel("다음 결제일")
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
            alert.informativeText = "날짜를 확인하세요. 실제 존재하는 YYYY-MM-DD 날짜만 저장할 수 있습니다."
        }
    }
}

