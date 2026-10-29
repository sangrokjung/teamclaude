import Cocoa

// 구독 상태 기호·색·처리 버튼·기록 대화상자(menubar/DESIGN.md "구독 상태"). Claude 표와 Codex 풀이 같은 것을 쓴다.
// 그리는 뷰는 모두 isFlipped(위가 0)라 기호 좌표를 시안(SVG 12×12)과 같은 방향으로 쓴다.

enum SubscriptionGlyph {
    static let size: CGFloat = 11

    /// 상태 라벨 글자색. 상태색은 짧은 라벨에만 쓴다(시안 SUB_TONE).
    static func tone(_ state: SubscriptionDisplayState) -> NSColor {
        switch state {
        case .active: return TeamClaudePalette.mint
        case .unknown, .ended: return TeamClaudePalette.fg3
        case .scheduled: return TeamClaudePalette.sky
        case .overdue: return TeamClaudePalette.amber
        }
    }

    /// 왼쪽 위가 (x, y)인 11pt 기호. 모양이 뜻을 갖고 색은 거든다.
    /// 구독 중 = 민트 원 + 체크, 확인 안 됨 = 점선 원, 해지 예약 = 종료일로 갈수록 차오르는 하늘 파이,
    /// 종료일 지남 = 호박 원 + 느낌표, 해지 확정 = 회색 원 + ×.
    static func draw(_ state: SubscriptionDisplayState, x: CGFloat, y: CGFloat, progress: Double = 0.5) {
        let unit = size / 12
        func p(_ px: CGFloat, _ py: CGFloat) -> NSPoint { NSPoint(x: x + px * unit, y: y + py * unit) }
        func circle(_ r: CGFloat) -> NSBezierPath {
            NSBezierPath(ovalIn: NSRect(x: x + (6 - r) * unit, y: y + (6 - r) * unit, width: 2 * r * unit, height: 2 * r * unit))
        }
        let sheet = TeamClaudePalette.sheet
        switch state {
        case .active:
            TeamClaudePalette.mint.setFill(); circle(5.5).fill()
            let check = NSBezierPath()
            check.move(to: p(3.6, 6.2)); check.line(to: p(5.2, 7.8)); check.line(to: p(8.4, 4.4))
            check.lineWidth = 1.5 * unit; check.lineCapStyle = .round; check.lineJoinStyle = .round
            sheet.setStroke(); check.stroke()
        case .unknown:
            let ring = circle(4.9)
            ring.lineWidth = 1.3 * unit
            ring.setLineDash([1.9 * unit, 1.8 * unit], count: 2, phase: 0)
            TeamClaudePalette.fg3.setStroke(); ring.stroke()
        case .scheduled:
            let ring = circle(4.9)
            ring.lineWidth = 1.3 * unit
            TeamClaudePalette.sky.setStroke(); ring.stroke()
            let fraction = min(0.92, max(0.12, progress))
            let pie = NSBezierPath()
            let center = p(6, 6)
            pie.move(to: center)
            pie.line(to: p(6, 3))
            // 위(12시)에서 시계 방향. 뒤집힌 좌표에서는 각도가 시계 방향으로 커진다.
            pie.appendArc(withCenter: center, radius: 3 * unit, startAngle: -90, endAngle: -90 + 360 * CGFloat(fraction), clockwise: false)
            pie.close()
            TeamClaudePalette.sky.setFill(); pie.fill()
        case .overdue:
            TeamClaudePalette.amber.setFill(); circle(5.5).fill()
            let bar = NSBezierPath()
            bar.move(to: p(6, 3.2)); bar.line(to: p(6, 6.4))
            bar.lineWidth = 1.5 * unit; bar.lineCapStyle = .round
            sheet.setStroke(); bar.stroke()
            sheet.setFill()
            NSBezierPath(ovalIn: NSRect(x: x + 5.15 * unit, y: y + 7.75 * unit, width: 1.7 * unit, height: 1.7 * unit)).fill()
        case .ended:
            TeamClaudePalette.fg3.setFill(); circle(5.5).fill()
            let cross = NSBezierPath()
            cross.move(to: p(4.2, 4.2)); cross.line(to: p(7.8, 7.8))
            cross.move(to: p(7.8, 4.2)); cross.line(to: p(4.2, 7.8))
            cross.lineWidth = 1.4 * unit; cross.lineCapStyle = .round
            sheet.setStroke(); cross.stroke()
        }
    }
}

/// 누른 시점에 다시 조회한 그 행의 대상·판정. 버튼은 만들 때 잡은 값이 아니라 이 값으로 판정한다.
struct SubscriptionLatest {
    let target: SubscriptionTarget
    let resolution: SubscriptionResolution
    let billingDay: String?
}

/// 처리 버튼 한 줄을 만든다. 종료로 확정·기록 지우기는 한 번 더 눌러야 실행된다(시안의 확인 대화상자 대신).
/// 무장 상태는 계정별로 4초 유지되고, 표가 버튼을 다시 만들어도 이어진다.
enum SubscriptionActionButtons {
    enum Kind: String { case record, confirmEnd, editEnd, clear }

    private static var armed: [String: (kind: Kind, until: Date)] = [:]
    static let armSeconds: TimeInterval = 4

    static func isArmed(_ target: SubscriptionTarget, _ kind: Kind, now: Date = Date()) -> Bool {
        guard let entry = armed[target.key], entry.kind == kind else { return false }
        return entry.until > now
    }

    static func arm(_ target: SubscriptionTarget, _ kind: Kind, now: Date = Date()) {
        armed[target.key] = (kind, now.addingTimeInterval(armSeconds))
    }

    static func disarm(_ target: SubscriptionTarget) { armed.removeValue(forKey: target.key) }

    /// 상태별 버튼 종류(시안 sub-editor 보기 모드). hideConfirm이면 행 오른쪽에 이미 "종료로 확정"이 있다.
    static func kinds(for resolution: SubscriptionResolution) -> [Kind] {
        // 프록시가 계정 상태로 확정한 종료는 이 맥에서 되돌릴 수 없다. 누르면 성공처럼 보이고 아무것도 바뀌지 않으니 주지 않는다.
        if resolution.proxyLocked { return [] }
        switch resolution.state {
        case .unknown, .active: return [.record]
        case .scheduled, .overdue: return [.confirmEnd, .editEnd, .clear]
        case .ended: return [.clear]
        }
    }

    static func title(_ kind: Kind, state: SubscriptionDisplayState, armed: Bool) -> String {
        switch kind {
        case .record: return L10n.subActionRecordCancel
        case .confirmEnd: return armed ? L10n.subActionConfirmAgain : L10n.subActionConfirmEnd
        case .editEnd: return L10n.subActionEditEnd
        case .clear:
            if armed { return L10n.subActionClearAgain }
            return state == .ended ? L10n.subActionClearToActive : L10n.subActionClear
        }
    }

    /// 상세 버튼을 다시 만들지 정하는 키. 신원(uuid)·상태·종료일·프록시 잠금 중 하나라도 바뀌면 버튼을 새로 만든다.
    static func cacheKey(target: SubscriptionTarget, resolution: SubscriptionResolution) -> String {
        "\(target.key)|\(resolution.state.rawValue)|\(resolution.shown.endDate ?? "-")|\(resolution.proxyLocked)"
    }

    /// 누른 시점 검사. 행이 사라졌거나 다른 계정으로 바뀌었으면, 프록시가 종료를 확정했으면, 그 버튼이 더는 맞지 않으면 실행하지 않는다.
    static func verify(_ kind: Kind, captured: SubscriptionTarget, latest: SubscriptionLatest?) -> (latest: SubscriptionLatest?, reason: String?) {
        guard let latest, latest.target.key == captured.key, latest.target.accountUuid == captured.accountUuid else {
            return (nil, L10n.subFailedAccountChanged)
        }
        if latest.resolution.proxyLocked { return (nil, L10n.subFailedProxyLocked) }
        guard kinds(for: latest.resolution).contains(kind) else { return (nil, L10n.subFailedStateChanged) }
        return (latest, nil)
    }

    /// 되돌리기 시점 검사. 같은 계정(uuid)이 아니거나 프록시가 종료를 확정했으면 되돌리지 않는다. 버튼 종류는 보지 않는다.
    static func verifyUndo(captured: SubscriptionTarget, latest: SubscriptionLatest?) -> String? {
        guard let latest, latest.target.key == captured.key, latest.target.accountUuid == captured.accountUuid else {
            return L10n.subFailedAccountChanged
        }
        return latest.resolution.proxyLocked ? L10n.subFailedProxyLocked : nil
    }

    /// 버튼을 만든다. latest는 누른 시점에 그 행의 최신 대상·판정을 다시 조회한다. onChanged는 무장 상태가 바뀌어 제목을 다시 그려야 할 때 부른다.
    static func make(target: SubscriptionTarget, resolution: SubscriptionResolution, billingDay: String?,
                     center: SubscriptionActionCenter = .shared, now: Date = Date(),
                     latest: @escaping () -> SubscriptionLatest?,
                     onChanged: @escaping () -> Void) -> [PanelButton] {
        let state = resolution.state
        let busy = center.isBusy(target)
        return kinds(for: resolution).map { kind in
            let isArmed = isArmed(target, kind, now: now)
            let style: PanelButton.Style = kind == .confirmEnd ? .primary : (kind == .clear ? .quiet : .ghost)
            let button = PanelButton(title: title(kind, state: state, armed: isArmed), style: style) {
                press(kind, target: target, center: center, latest: latest, onChanged: onChanged)
            }
            button.isEnabled = !busy
            button.setAccessibilityLabel("\(button.title): \(target.name)")
            return button
        }
    }

    private static func press(_ kind: Kind, target: SubscriptionTarget, center: SubscriptionActionCenter,
                              latest: @escaping () -> SubscriptionLatest?, onChanged: @escaping () -> Void) {
        guard !center.isBusy(target) else { return }
        func checked() -> SubscriptionLatest? {
            let result = verify(kind, captured: target, latest: latest())
            if let reason = result.reason {
                center.onOutcome?(SubscriptionOutcome(succeeded: false, message: L10n.subFailed(target.name, reason)))
            }
            return result.latest
        }
        // 실행 직전(대화상자를 닫은 뒤에도) 그 계정의 최신 상태를 다시 본다.
        func runChecked(_ command: SubscriptionCommand) {
            guard let current = checked() else { return }
            center.run(command, target: current.target, current: current.resolution,
                       verify: { verify(kind, captured: target, latest: latest()).reason },
                       undoVerify: { verifyUndo(captured: target, latest: latest()) })
        }
        switch kind {
        case .record, .editEnd:
            guard let before = checked(),
                  let command = SubscriptionRecordDialog.run(mode: kind == .record ? .record : .edit, name: target.name,
                                                             billingDay: before.billingDay, current: before.resolution.shown) else { return }
            runChecked(command)
        case .confirmEnd, .clear:
            guard isArmed(target, kind) else {
                arm(target, kind)
                onChanged()
                DispatchQueue.main.asyncAfter(deadline: .now() + armSeconds + 0.05) { onChanged() }
                return
            }
            disarm(target)
            if kind == .clear {
                runChecked(.clear)
            } else {
                runChecked(.confirmEnd(endDate: latest()?.resolution.shown.endDate, source: "user-confirmed"))
            }
        }
    }
}

extension SubscriptionActionCenter {
    /// 화면에서 부르는 진입점. 결과는 onOutcome(하단 막대)으로 간다. verify는 저장·실행 바로 앞에서 다시 부른다.
    func run(_ command: SubscriptionCommand, target: SubscriptionTarget, current: SubscriptionResolution,
             verify: (() -> String?)? = nil, undoVerify: (() -> String?)? = nil) {
        perform(command, target: target, current: current, verify: verify, undoVerify: undoVerify) { [weak self] outcome in self?.onOutcome?(outcome) }
    }
}

/// 해지 기록·종료일 고치기 입력. 메뉴 패널 안에 폼을 펼치는 대신 앱의 기존 구독 기록처럼 대화상자를 쓴다.
/// 종료일: 모름 · 결제일 · 날짜 입력, 근거: 사용자 확인 · 청구 화면 · 확인 메일.
/// "바로 종료로 확정"은 한 번 더 눌러야 실행된다.
enum SubscriptionRecordDialog {
    enum Mode { case record, edit }

    static let sources = ["user-confirmed", "billing-page", "confirmation-email"]

    /// 고른 값을 명령으로 바꾼다. 날짜 입력을 골랐는데 날짜가 틀리면 nil.
    static func command(mode: Mode, endChoice: Int, typedDate: String, billingDay: String?, sourceIndex: Int,
                        confirmNow: Bool) -> SubscriptionCommand? {
        let endDate: String?
        switch endChoice {
        case 0: endDate = nil
        case 1:
            guard let billingDay, accountSubscriptionDate(billingDay) != nil else { return nil }
            endDate = billingDay
        default:
            let trimmed = typedDate.trimmingCharacters(in: .whitespacesAndNewlines)
            guard accountSubscriptionDate(trimmed) != nil else { return nil }
            endDate = trimmed
        }
        let source = sources.indices.contains(sourceIndex) ? sources[sourceIndex] : "user-confirmed"
        switch mode {
        case .edit: return .editEndDate(endDate)
        case .record: return confirmNow ? .confirmEnd(endDate: endDate, source: source) : .recordCancel(endDate: endDate, source: source)
        }
    }

    static func run(mode: Mode, name: String, billingDay: String?, current: SubscriptionRecordView) -> SubscriptionCommand? {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "\(name) · \(mode == .record ? L10n.subFormTitleRecord : L10n.subFormTitleEdit)"
        alert.informativeText = L10n.subFormBody
        alert.addButton(withTitle: mode == .record ? L10n.subFormSaveScheduled : L10n.save)
        alert.addButton(withTitle: L10n.cancel)
        if mode == .record { alert.addButton(withTitle: L10n.subFormConfirmNow) }

        let width: CGFloat = 380
        let accessory = NSView(frame: NSRect(x: 0, y: 0, width: width, height: mode == .record ? 112 : 58))
        let billingValid = billingDay.flatMap(accountSubscriptionDate) != nil
        let end = NSSegmentedControl(labels: [L10n.subFormEndUnknown,
                                              billingValid ? L10n.subFormEndBilling(subscriptionShortDate(billingDay ?? "")) : L10n.subFormEndBillingMissing,
                                              L10n.subFormEndPick],
                                     trackingMode: .selectOne, target: nil, action: nil)
        end.setEnabled(billingValid, forSegment: 1)
        let field = NSTextField(frame: .zero)
        field.placeholderString = "YYYY-MM-DD"
        field.setAccessibilityLabel(L10n.subFormEndLabel)
        let initial = current.endDate
        if let initial, initial == billingDay { end.selectedSegment = 1 }
        else if let initial { end.selectedSegment = 2; field.stringValue = initial }
        else { end.selectedSegment = 0 }
        end.setAccessibilityLabel(L10n.subFormEndLabel)
        let endLabel = NSTextField(labelWithString: L10n.subFormEndLabel)
        endLabel.frame = NSRect(x: 0, y: accessory.frame.height - 18, width: width, height: 16)
        end.frame = NSRect(x: 0, y: accessory.frame.height - 46, width: 250, height: 24)
        field.frame = NSRect(x: 258, y: accessory.frame.height - 45, width: width - 258, height: 22)
        for view in [endLabel, end, field] { accessory.addSubview(view) }
        let evidence = NSSegmentedControl(labels: [L10n.subEvidenceUser, L10n.subEvidenceBilling, L10n.subEvidenceMail],
                                          trackingMode: .selectOne, target: nil, action: nil)
        if mode == .record {
            let evidenceLabel = NSTextField(labelWithString: L10n.subFormEvidenceLabel)
            evidenceLabel.frame = NSRect(x: 0, y: 36, width: width, height: 16)
            evidence.frame = NSRect(x: 0, y: 8, width: width, height: 24)
            evidence.selectedSegment = 0
            evidence.setAccessibilityLabel(L10n.subFormEvidenceLabel)
            accessory.addSubview(evidenceLabel)
            accessory.addSubview(evidence)
        }
        alert.accessoryView = accessory

        var confirmNowArmed = false
        while true {
            let choice = alert.runModal()
            if choice == .alertSecondButtonReturn { return nil }
            let confirmNow = choice == .alertThirdButtonReturn
            if confirmNow && !confirmNowArmed {
                // 바로 확정은 한 번 더 눌러야 한다.
                confirmNowArmed = true
                alert.informativeText = L10n.subFormConfirmNowAgain
                continue
            }
            if let command = command(mode: mode, endChoice: end.selectedSegment, typedDate: field.stringValue,
                                     billingDay: billingDay, sourceIndex: evidence.selectedSegment, confirmNow: confirmNow) {
                return command
            }
            confirmNowArmed = false
            alert.informativeText = L10n.subFormInvalidDate
        }
    }
}
