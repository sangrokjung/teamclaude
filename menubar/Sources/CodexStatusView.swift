import Cocoa

final class CodexStatusView: NSView {
    static let baseHeight: CGFloat = 406
    static func poolRowCount(for pool: TeamCodexPoolHealth?) -> Int {
        pool?.accounts.count ?? 0
    }
    static func poolSectionHeight(for pool: TeamCodexPoolHealth?) -> CGFloat {
        guard let pool = pool else { return 0 }
        return 112 + CGFloat(max(1, poolRowCount(for: pool))) * 56
    }
    static func preferredHeight(for pool: TeamCodexPoolHealth?) -> CGFloat {
        baseHeight + (pool == nil ? 0 : poolSectionHeight(for: pool) + 10)
    }
    var health: CodexHealth? {
        didSet {
            updateAccessibility()
            setAccessibilityHelp("GPT-5.6 작업 추천: 구현과 설계는 gpt-5.6 medium, 리뷰와 보안은 gpt-5.6-sol high, 탐색과 병렬 작업은 gpt-5.6-terra low, 분류와 반복 작업은 gpt-5.6-luna none 또는 low")
            needsDisplay = true
        }
    }
    var pool: TeamCodexPoolHealth? {
        didSet {
            updateAccessibility()
            needsLayout = true
            needsDisplay = true
        }
    }
    /// 풀에서 빠진 계정을 되돌리는 버튼을 눌렀을 때. 실행 인자는 넘기지 않는다.
    /// 누른 시점의 행이 낡았을 수 있으므로 호출부가 현재 상태에서 다시 판정한다.
    var onRecover: ((String, String?, TeamCodexAccountRecoveryKind) -> Void)?
    private var recoveryButtons: [NSButton] = []
    private var recoveryTargets: [ObjectIdentifier: (name: String, accountUuid: String?, kind: TeamCodexAccountRecoveryKind)] = [:]
    private var recoverySignature = ""
    private var subscriptionButtons: [AccountSubscriptionButton] = []
    private var subscriptionSignature = ""
    var usage: UsageData? {
        didSet { needsDisplay = true }
    }
    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        // 되돌리기 버튼을 자식으로 두는 표라 컨테이너를 접근성 요소로 잡지 않는다.
        // 쌍둥이인 TeamClaudeTableView가 같은 이유로 false를 쓴다. 두 표의
        // VoiceOver 도달성이 갈리지 않도록 낱말뿐 아니라 이 설정도 맞춘다.
        // 컨테이너를 요소로 유지한다. 패널 본문은 전부 draw() 텍스트라 AX 트리에 없고,
        // updateAccessibility()가 여기 붙이는 요약문이 유일한 낭독 대상이다.
        // true여도 NSButton 자식은 그대로 노출된다(2026-09-06 실측).
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Codex 상태")
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func updateAccessibility() {
        let codexSummary = health?.accessibilitySummary ?? "Codex 상태"
        let poolSummary = pool.map { ", \($0.accessibilitySummary), \($0.resetCreditAccessibilitySummary)" } ?? ""
        setAccessibilityLabel(codexSummary + poolSummary)
    }

    /// 행별 되돌리기 제안. 그리기와 배치가 같은 판정을 쓰도록 한 곳에서만 만든다.
    private func recoveryRows() -> [(index: Int, recovery: TeamCodexAccountRecovery, name: String, accountUuid: String?)] {
        guard let pool else { return [] }
        return pool.accounts.enumerated().compactMap { index, account in
            guard let recovery = teamCodexAccountRecovery(account, now: pool.checkedAt) else { return nil }
            return (index, recovery, account.name, account.accountUuid)
        }
    }

    private func ensureRecoveryButtons() {
        let rows = recoveryRows()
        let signature = rows
            .map { "\($0.index):\($0.recovery.kind):\($0.name):\($0.accountUuid ?? "-")" }
            .joined(separator: "|")
        guard signature != recoverySignature else { return }
        recoverySignature = signature
        recoveryButtons.forEach { $0.removeFromSuperview() }
        recoveryButtons.removeAll(keepingCapacity: true)
        recoveryTargets.removeAll(keepingCapacity: true)
        for row in rows {
            let button = NSButton(frame: .zero)
            button.title = row.recovery.title
            button.bezelStyle = .rounded
            button.isBordered = true
            button.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
            button.contentTintColor = row.recovery.kind == .reauth
                ? NSColor(calibratedRed: 0.96, green: 0.26, blue: 0.32, alpha: 1.0)
                : NSColor(calibratedRed: 0.93, green: 0.76, blue: 0.22, alpha: 1.0)
            button.setAccessibilityLabel(row.recovery.accessibilityLabel)
            button.setAccessibilityHelp(row.recovery.toolTip)
            button.toolTip = row.recovery.toolTip
            button.target = self
            button.action = #selector(recoveryButtonClicked(_:))
            recoveryButtons.append(button)
            recoveryTargets[ObjectIdentifier(button)] = (row.name, row.accountUuid, row.recovery.kind)
            addSubview(button)
        }
    }

    private func ensureSubscriptionButtons() {
        let rows = pool?.accounts ?? []
        let signature = rows.map { row in
            let local = accountSubscriptionLocalAccount(provider: "codex", uuid: row.accountUuid, name: row.name)
            return "\(local.uuid ?? "-"):\(row.name):\(row.planType ?? local.plan ?? "-")"
        }.joined(separator: "|")
        guard signature != subscriptionSignature else {
            subscriptionButtons.forEach { $0.refreshTitle() }
            return
        }
        subscriptionSignature = signature
        subscriptionButtons.forEach { $0.removeFromSuperview() }
        subscriptionButtons = rows.map { row in
            let button = AccountSubscriptionButton(provider: "codex", accountUuid: row.accountUuid,
                                                   accountName: row.name, plan: row.planType)
            addSubview(button)
            return button
        }
    }

    @objc private func recoveryButtonClicked(_ sender: NSButton) {
        guard let target = recoveryTargets[ObjectIdentifier(sender)] else { return }
        onRecover?(target.name, target.accountUuid, target.kind)
    }

    /// draw(_:)의 풀 표와 같은 좌표를 쓴다. 두 곳이 어긋나면 버튼이 남의 행에 붙는다.
    private func poolTableRect() -> NSRect? {
        guard let pool else { return nil }
        let card = bounds.insetBy(dx: 8, dy: 4)
        let layout = codexStatusLayout(
            topY: Double(card.minY + 14),
            poolHeight: Double(Self.poolSectionHeight(for: pool)),
            hasPool: true,
            localUsageLoaded: health != nil
        )
        return NSRect(
            x: card.minX + 16,
            y: CGFloat(layout.poolY),
            width: card.width - 32,
            height: Self.poolSectionHeight(for: pool)
        )
    }

    override func layout() {
        super.layout()
        ensureRecoveryButtons()
        ensureSubscriptionButtons()
        if let pool {
            for (button, account) in zip(subscriptionButtons, pool.accounts) {
                button.refreshTitle(now: pool.checkedAt,
                    appearance: account.isSubscriptionRetired(now: pool.checkedAt) ? .ended : .standard)
            }
        }
        guard let poolRect = poolTableRect() else { return }
        // 마지막 칸(토큰, +720)을 버튼이 통째로 쓴다. 같은 행의 토큰 값은 draw에서 건너뛴다.
        let buttonX = poolRect.minX + 720
        let buttonWidth = max(60, poolRect.maxX - 12 - buttonX)
        let headerY = poolRect.minY + 86
        for (button, row) in zip(recoveryButtons, recoveryRows()) {
            button.frame = NSRect(
                x: buttonX,
                y: headerY + 22 + CGFloat(row.index) * 56 + 6,
                width: buttonWidth,
                height: 22
            )
        }
        for (index, button) in subscriptionButtons.enumerated() {
            button.frame = NSRect(x: poolRect.minX + 12, y: headerY + 22 + CGFloat(index) * 56 + 34,
                                  width: poolRect.width - 28, height: 20)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        let bg = NSColor(calibratedRed: 0.06, green: 0.075, blue: 0.10, alpha: 0.97)
        let panel = NSColor(calibratedRed: 0.095, green: 0.115, blue: 0.15, alpha: 1.0)
        let panel2 = NSColor(calibratedRed: 0.12, green: 0.14, blue: 0.18, alpha: 1.0)
        let line = NSColor(calibratedRed: 0.23, green: 0.27, blue: 0.34, alpha: 1.0)
        let text = NSColor(calibratedRed: 0.92, green: 0.95, blue: 0.98, alpha: 1.0)
        let muted = NSColor(calibratedRed: 0.55, green: 0.61, blue: 0.70, alpha: 1.0)
        let dim = NSColor(calibratedRed: 0.40, green: 0.46, blue: 0.55, alpha: 1.0)
        let green = NSColor(calibratedRed: 0.18, green: 0.82, blue: 0.48, alpha: 1.0)
        let yellow = NSColor(calibratedRed: 0.93, green: 0.76, blue: 0.22, alpha: 1.0)
        let red = NSColor(calibratedRed: 0.96, green: 0.26, blue: 0.32, alpha: 1.0)
        let blue = codexColor()
        let titleFont = NSFont.systemFont(ofSize: 18, weight: .bold)
        let subFont = NSFont.systemFont(ofSize: 13, weight: .medium)
        let headFont = NSFont.systemFont(ofSize: 12, weight: .semibold)
        let rowFont = NSFont.monospacedSystemFont(ofSize: 13, weight: .medium)
        let smallFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)

        func attrs(_ font: NSFont, _ color: NSColor) -> [NSAttributedString.Key: Any] {
            [.font: font, .foregroundColor: color]
        }
        func drawText(_ value: String, _ x: CGFloat, _ y: CGFloat, _ font: NSFont, _ color: NSColor) {
            value.draw(at: NSPoint(x: x, y: y), withAttributes: attrs(font, color))
        }
        func drawRight(_ value: String, _ x: CGFloat, _ y: CGFloat, _ font: NSFont, _ color: NSColor) {
            let a = attrs(font, color)
            let s = value.size(withAttributes: a)
            value.draw(at: NSPoint(x: x - s.width, y: y), withAttributes: a)
        }
        func fillRound(_ rect: NSRect, _ color: NSColor, _ radius: CGFloat) {
            color.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
        }
        func strokeRound(_ rect: NSRect, _ color: NSColor, _ radius: CGFloat) {
            color.setStroke()
            let p = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
            p.lineWidth = 1
            p.stroke()
        }
        func pill(_ value: String, x: CGFloat, y: CGFloat, color: NSColor) {
            let size = value.size(withAttributes: attrs(subFont, color))
            let rect = NSRect(x: x, y: y, width: size.width + 16, height: 22)
            fillRound(rect, color.withAlphaComponent(0.14), 11)
            strokeRound(rect, color.withAlphaComponent(0.38), 11)
            drawText(value, x + 8, y + 3.5, subFont, color)
        }
        func metric(_ title: String, _ value: String, _ detail: String, percent: Double? = nil, x: CGFloat, y: CGFloat, width: CGFloat, color: NSColor) {
            let rect = NSRect(x: x, y: y, width: width, height: 54)
            fillRound(rect, panel, 9)
            strokeRound(rect, line.withAlphaComponent(0.8), 9)
            drawText(title.uppercased(), x + 10, y + 8, headFont, muted)
            let font = NSFont.monospacedSystemFont(ofSize: value.count > 12 ? 15 : 18, weight: .bold)
            drawText(value, x + 10, y + 25, font, color)
            drawRight(detail, x + width - 10, y + 31, smallFont, dim)
            if let percent = percent {
                let track = NSRect(x: x + 10, y: y + 45, width: width - 20, height: 4)
                fillRound(track, NSColor.white.withAlphaComponent(0.10), 2)
                let fillWidth = track.width * CGFloat(max(0, min(100, percent)) / 100)
                if fillWidth > 0 {
                    fillRound(NSRect(x: track.minX, y: track.minY, width: max(2, fillWidth), height: track.height), color, 2)
                }
            }
        }
        func limitTone(_ value: Double?) -> NSColor {
            guard let value = value else { return muted }
            if value >= 90 { return red }
            if value >= 70 { return yellow }
            return green
        }

        let card = bounds.insetBy(dx: 8, dy: 4)
        fillRound(card, bg, 14)
        strokeRound(card, line, 14)
        let innerX = card.minX + 16
        let topY = card.minY + 14

        func drawTeamCodexPool(at poolY: CGFloat) {
            guard let pool = pool else { return }
            let poolHeight = Self.poolSectionHeight(for: pool)
            let poolRect = NSRect(x: innerX, y: poolY, width: card.width - 32, height: poolHeight)
            fillRound(poolRect, panel2, 8)
            strokeRound(poolRect, line.withAlphaComponent(0.8), 8)
            let poolTone = !pool.serverReachable ? red : (pool.usableCount == 0 ? yellow : green)
            drawText("TeamCodex 계정 풀", poolRect.minX + 12, poolRect.minY + 9, subFont, text)
            pill(pool.statusLabel, x: poolRect.minX + 145, y: poolRect.minY + 5, color: poolTone)
            // 구독 종료(영구)와 운영자가 끈 계정(되돌릴 수 있음)이 함께 들어가므로 "영구"라고 쓰지 않는다.
            var headerRight = "사용 가능 \(pool.usableCount) · 풀 \(pool.poolCount) · 제외 \(pool.excludedCount) · port \(pool.serverPort)"
            if let runtime = pool.runtimeSummary { headerRight += " · \(runtime)" }
            drawRight(headerRight, poolRect.maxX - 12, poolRect.minY + 10, smallFont, muted)

            drawText(pool.resetCreditPolicyLabel, poolRect.minX + 12, poolRect.minY + 33, smallFont, muted)
            drawRight(pool.resetCreditSummary, poolRect.maxX - 12, poolRect.minY + 33, smallFont, text)
            let rows = pool.accounts
            let readyNames = rows
                .filter { $0.isUsable(switchThresholdPercent: pool.switchThresholdPercent, now: pool.checkedAt) }
                .map(\.name)
            let readySummary = readyNames.isEmpty
                ? "사용 가능 계정: 없음 · 측정 또는 제한 상태 확인"
                : "사용 가능 계정: " + readyNames.joined(separator: " · ")
            let availableStrip = NSRect(x: poolRect.minX + 8, y: poolRect.minY + 53,
                                        width: poolRect.width - 16, height: 22)
            fillRound(availableStrip, (pool.usableCount > 0 ? green : yellow).withAlphaComponent(0.10), 6)
            drawText(readySummary, availableStrip.minX + 10, availableStrip.minY + 4, smallFont,
                     pool.usableCount > 0 ? green : yellow)

            let headerY = poolRect.minY + 86
            drawText("계정", poolRect.minX + 12, headerY, headFont, muted)
            drawText("상태", poolRect.minX + 250, headerY, headFont, muted)
            drawText("5시간 / 초기화", poolRect.minX + 355, headerY, headFont, muted)
            drawText("7일 / 초기화", poolRect.minX + 445, headerY, headFont, muted)
            drawText("동시", poolRect.minX + 530, headerY, headFont, muted)
            drawText("요청", poolRect.minX + 580, headerY, headFont, muted)
            drawText("리셋권", poolRect.minX + 640, headerY, headFont, muted)
            drawText("토큰", poolRect.minX + 720, headerY, headFont, muted)

            if rows.isEmpty {
                drawText("TeamCodex에 등록된 계정이 없습니다", poolRect.minX + 12, headerY + 25, rowFont, dim)
                return
            }
            for (index, account) in rows.enumerated() {
                let rowY = headerY + 22 + CGFloat(index) * 56
                if index % 2 == 1 {
                    fillRound(NSRect(x: poolRect.minX + 4, y: rowY - 2, width: poolRect.width - 8, height: 55), NSColor.white.withAlphaComponent(0.035), 7)
                }
                let accountState = teamCodexAccountState(
                    account,
                    switchThresholdPercent: pool.switchThresholdPercent,
                    now: pool.checkedAt
                )
                let quotaBlocked = accountState == .limited
                // 되돌리기 버튼은 토큰 칸 자리에 앉는다. 그리기와 배치가 같은 판정을 봐야 한다.
                let recovery = teamCodexAccountRecovery(account, now: pool.checkedAt)
                // 영구 제외(구독 종료·수동 제외)는 가장 조용하게, 일시 한도는 노랑, 진짜 오류는 빨강.
                let accountTone: NSColor
                switch accountState {
                case .retired: accountTone = NSColor(calibratedWhite: 0.62, alpha: 1)
                case .excluded: accountTone = dim
                case .failed: accountTone = red
                case .endDateReached, .limited, .paused: accountTone = yellow
                case .serving: accountTone = green
                case .other: accountTone = muted
                }
                let retired = accountState == .retired
                let marker = account.isCurrent && !retired ? "● " : "  "
                // 오류 사유는 두 렌더러(Claude 표·Codex 풀)가 같은 canonical 라벨을 쓴다는 회귀 가드.
                let statusText = accountState == .failed
                    ? teamAccountErrorReasonLabel(account.errorReason)
                    : teamCodexAccountStateLabel(
                        accountState,
                        status: account.status,
                        errorReason: account.errorReason
                    )
                drawText(marker + account.name, poolRect.minX + 12, rowY, rowFont, accountTone)
                drawText(statusText, poolRect.minX + 250, rowY, rowFont, accountTone)
                if let note = teamCodexAccountNote(
                    account,
                    switchThresholdPercent: pool.switchThresholdPercent,
                    now: pool.checkedAt
                ) {
                    drawText(note, poolRect.minX + 12, rowY + 17, smallFont, dim)
                }
                // 다시 켜도 실행 중 서버에 바로 반영된다는 보장이 없다. 그 사실을 행에서 말한다.
                // 이 문자열은 상태 칸(+250)에서 시작해 5시간(+355)·7일(+445) 보조줄 자리를 지난다.
                // 그래서 초기화 카운트다운을 그리지 않는 행에서만 쓴다. 두 텍스트를 한 줄에 겹쳐
                // 그리느니 안내를 접는 편이 낫다(버튼 툴팁과 터미널 마지막 줄이 같은 말을 한다).
                let drawsResetCountdown = !account.isPermanentlyOut(now: pool.checkedAt)
                if let followUp = recovery?.followUpNote, !drawsResetCountdown {
                    drawText(followUp, poolRect.minX + 250, rowY + 17, smallFont, dim)
                }
                let sessionPercent = account.sessionUsagePercent(at: pool.checkedAt)
                let weeklyPercent = account.weeklyUsagePercent(at: pool.checkedAt)
                drawText(retired ? "—" : formatCodexPercent(sessionPercent), poolRect.minX + 355, rowY, rowFont, retired ? accountTone : limitTone(sessionPercent))
                drawText(retired ? "—" : formatCodexPercent(weeklyPercent), poolRect.minX + 445, rowY, rowFont, retired ? accountTone : limitTone(weeklyPercent))
                // 돌아오지 않는 계정에 초기화 카운트다운을 그리면 "곧 복귀"로 오해된다.
                if drawsResetCountdown {
                    drawText(formatTeamCodexResetRemaining(account.sessionResetAt), poolRect.minX + 355, rowY + 17, smallFont, quotaBlocked ? accountTone : dim)
                    drawText(formatTeamCodexResetRemaining(account.weeklyResetAt), poolRect.minX + 445, rowY + 17, smallFont, dim)
                }
                drawText("\(account.inflight)/\(account.maxConcurrent)", poolRect.minX + 530, rowY, rowFont, retired ? accountTone : muted)
                drawText("\(account.totalRequests)", poolRect.minX + 580, rowY, rowFont, retired ? accountTone : muted)
                let credits = account.resetCreditCount(at: pool.checkedAt, online: pool.serverReachable)
                let creditTone = account.isPermanentlyOut(now: pool.checkedAt) ? dim
                    : (credits == nil ? yellow : (credits == 0 ? muted : green))
                drawText(account.resetCreditLabel(at: pool.checkedAt, online: pool.serverReachable),
                         poolRect.minX + 640, rowY, rowFont, creditTone)
                // 마지막 칸은 버튼과 자리를 나눠 쓴다. 고장 난 계정의 누적 토큰보다
                // 되돌리는 방법이 먼저다(Claude 표도 같은 자리를 버튼에 내준다).
                if recovery == nil {
                    drawText(formatCodexTokens(account.totalTokens), poolRect.minX + 720, rowY, rowFont, retired ? accountTone : muted)
                }
            }
        }

        let poolHeight = Self.poolSectionHeight(for: pool)
        let layout = codexStatusLayout(
            topY: Double(topY),
            poolHeight: Double(poolHeight),
            hasPool: pool != nil,
            localUsageLoaded: health != nil
        )

        guard let health = health else {
            drawText("Codex", innerX, topY, titleFont, text)
            drawText("로컬 사용량 집계 중입니다", innerX, topY + 29, subFont, muted)
            drawTeamCodexPool(at: CGFloat(layout.poolY))
            return
        }

        let tone = health.isError ? red : (health.isWarning ? yellow : green)
        let modelLabel = health.model.map(codexShortenModelName) ?? "default"
        let plan = health.planType ?? health.serviceTier ?? "-"
        let effort = health.reasoningEffort ?? "-"
        let effortText = effort == "-" ? "" : " · effort \(effort)"
        let context = health.contextWindow.map { "\($0 / 1000)K ctx" } ?? "ctx -"
        let quotaAccount = pool?.currentQuotaAccount
        let sessionPercent = quotaAccount?.sessionUsagePercent(at: Date())
        let weeklyPercent = quotaAccount?.weeklyUsagePercent(at: Date())
        let primaryColor = limitTone(sessionPercent)
        let secondaryColor = limitTone(weeklyPercent)
        let codexModels = usage?.modelBreakdown.filter { $0.provider == "Codex" } ?? []
        let codexMonthlyCost = codexModels.reduce(0) { $0 + $1.cost }
        let codexMonthlyTokens = codexModels.reduce(0) { $0 + $1.tokens }

        drawText("Codex 사용량", innerX, topY, titleFont, text)
        pill(health.statusLabel, x: innerX + 118, y: topY - 2, color: tone)
        drawRight("최근 \(formatCodexAge(health.lastCallAt))", card.maxX - 16, topY + 2, subFont, muted)
        drawText("인증 \(health.authLabel)  ·  모델 \(modelLabel)  ·  플랜 \(plan)\(effortText)  ·  \(context)", innerX, topY + 29, subFont, muted)

        drawTeamCodexPool(at: CGFloat(layout.poolY))

        let statY = CGFloat(layout.metricsY)
        let gap: CGFloat = 9
        let statW = (card.width - 32 - gap * 3) / 4
        metric("현재 계정 · 5시간", formatCodexPercent(sessionPercent), sessionPercent == nil ? "한도 정보 없음" : "리셋 \(formatCodexReset(quotaAccount?.sessionResetAt))", percent: sessionPercent, x: innerX, y: statY, width: statW, color: primaryColor)
        metric("현재 계정 · 7일", formatCodexPercent(weeklyPercent), weeklyPercent == nil ? "한도 정보 없음" : "리셋 \(formatCodexReset(quotaAccount?.weeklyResetAt))", percent: weeklyPercent, x: innerX + (statW + gap), y: statY, width: statW, color: secondaryColor)
        metric("오늘 토큰", formatCodexTokens(health.todayTokens), "\(health.todayCalls)회", x: innerX + (statW + gap) * 2, y: statY, width: statW, color: blue)
        let monthlyDetail = codexMonthlyCost > 0 ? formatKRWShort(codexMonthlyCost, rate: usage?.usdKrwRate ?? 1450) : formatCodexTokens(codexMonthlyTokens)
        metric("월 환산비용", codexMonthlyCost > 0 ? formatCost(codexMonthlyCost) : "-", monthlyDetail, x: innerX + (statW + gap) * 3, y: statY, width: statW, color: blue)

        let tableY = statY + 70
        fillRound(NSRect(x: innerX, y: tableY, width: card.width - 32, height: 28), panel2, 8)
        drawText("모델", innerX + 12, tableY + 7, headFont, muted)
        drawText("호출", innerX + 250, tableY + 7, headFont, muted)
        drawText("오늘 토큰", innerX + 345, tableY + 7, headFont, muted)
        drawText("7일 토큰", innerX + 465, tableY + 7, headFont, muted)
        drawText("상태", innerX + 585, tableY + 7, headFont, muted)
        drawText("최근", innerX + 730, tableY + 7, headFont, muted)

        let rows = Array(health.profiles.prefix(3))
        if rows.isEmpty {
            drawText("Codex 세션 사용 기록 없음", innerX + 12, tableY + 42, rowFont, dim)
        } else {
            for (i, row) in rows.enumerated() {
                let y = tableY + 34 + CGFloat(i) * 24
                if i % 2 == 1 {
                    fillRound(NSRect(x: innerX, y: y - 1, width: card.width - 32, height: 23), NSColor.white.withAlphaComponent(0.035), 7)
                }
                let eventCount = row.quotaEvents + row.errorEvents
                let eventText = eventCount > 0 ? "Q\(row.quotaEvents)/E\(row.errorEvents)" : formatCodexVerdict(row.lastVerdict)
                let eventColor = row.quotaEvents > 0 ? red : (row.errorEvents > 0 ? yellow : green)
                fillRound(NSRect(x: innerX + 10, y: y + 7, width: 8, height: 8), eventColor, 4)
                drawText(row.profile, innerX + 24, y + 2, rowFont, text)
                drawText("\(row.todayCalls)/\(row.weekCalls)", innerX + 250, y + 2, rowFont, row.todayCalls > 0 ? green : muted)
                drawText(formatCodexTokens(row.todayTokens), innerX + 345, y + 2, rowFont, row.todayTokens > 0 ? green : muted)
                drawText(formatCodexTokens(row.weekTokens), innerX + 465, y + 2, rowFont, row.weekTokens > 0 ? green : muted)
                drawText(eventText, innerX + 585, y + 2, rowFont, eventColor)
                drawText(formatCodexAge(row.lastAt), innerX + 730, y + 2, smallFont, muted)
            }
        }

        let recommendationY = tableY + 112
        let recommendationRect = NSRect(x: innerX, y: recommendationY, width: card.width - 32, height: 96)
        fillRound(recommendationRect, panel2, 8)
        strokeRound(recommendationRect, line.withAlphaComponent(0.8), 8)
        drawText("GPT-5.6 작업 추천", recommendationRect.minX + 12, recommendationRect.minY + 9, subFont, text)
        let currentModel = "현재 \(modelLabel)\(effort == "-" ? "" : " · \(effort)")"
        drawRight(currentModel, recommendationRect.maxX - 12, recommendationRect.minY + 9, smallFont, blue)

        let columnY = recommendationRect.minY + 36
        let columnWidth = recommendationRect.width / CGFloat(codexModelRecommendations.count)
        let recommendationColors = [green, red, blue, yellow]
        for (index, recommendation) in codexModelRecommendations.enumerated() {
            let x = recommendationRect.minX + CGFloat(index) * columnWidth
            if index > 0 {
                line.withAlphaComponent(0.65).setStroke()
                let divider = NSBezierPath()
                divider.move(to: NSPoint(x: x, y: columnY - 4))
                divider.line(to: NSPoint(x: x, y: recommendationRect.maxY - 10))
                divider.lineWidth = 1
                divider.stroke()
            }
            let color = recommendationColors[index]
            drawText(recommendation.task, x + 12, columnY, headFont, muted)
            drawText(recommendation.model, x + 12, columnY + 20, rowFont, color)
            drawText(recommendation.effort, x + 12, columnY + 39, smallFont, dim)
        }

        let footerY = card.maxY - 30
        let hint = health.hints.first ?? "프롬프트: 목표 · 성공 기준 · 권한 · 검증만 명확하게"
        drawText(hint, innerX, footerY, smallFont, health.hints.isEmpty ? dim : tone)
        drawRight("files \(health.scannedLogFiles) · tok \(formatCodexTokens(health.totalTokens)) · 7d reset \(weeklyPercent == nil ? "-" : formatCodexReset(quotaAccount?.weeklyResetAt))", card.maxX - 16, footerY, smallFont, dim)
    }
}
