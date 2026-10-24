import Cocoa

/// Codex 탭(A안). 위는 TeamCodex 계정 풀(계정마다 창이 따로 돌아 리셋을 행마다 둔다), 아래는 이 맥의 Codex 사용량.
/// 행 기하는 아래 행 상수(보조 줄·구독 줄 위치와 poolRowHeight)로 정하고 배치(layout)·그리기(draw)·높이(preferredHeight)가 같은 값을 쓴다.
final class CodexStatusView: NSView {
    static let padding: CGFloat = 16
    /// 풀 머리(제목 줄 + 큰 숫자 + 리셋권 줄 + 계정 머리).
    static let poolHeaderHeight: CGFloat = 112
    /// 행 원점 기준 보조 줄(노트 · 동시 · 요청 · 리셋권 · 토큰)의 y. 막대(rowY+42, 높이 14) 바로 아래.
    static let rowFactsY: CGFloat = 60
    /// 보조 줄 글자(micro)가 실제로 차지하는 높이. 한글 대체 글꼴까지 넣어 잰다.
    static let rowMicroLineHeight: CGFloat =
        ceil(("Ag 한글" as NSString).size(withAttributes: [.font: TeamClaudePalette.microFont]).height)
    /// 보조 줄과 구독 줄 사이 틈.
    static let rowSubscriptionGap: CGFloat = 2
    static let rowSubscriptionHeight: CGFloat = 20
    /// 구독 줄은 보조 줄 아래 자기 띠에 앉는다. 같은 띠에 두면 버튼이 보조 줄 글자를 덮는다.
    static let rowSubscriptionY: CGFloat = rowFactsY + rowMicroLineHeight + rowSubscriptionGap
    static let rowBottomInset: CGFloat = 4
    /// 계정 한 행: 이름 줄 · 막대 줄 · 보조 줄 · 구독 줄.
    static let poolRowHeight: CGFloat = rowSubscriptionY + rowSubscriptionHeight + rowBottomInset
    /// 이 맥의 Codex 사용량 블록(제목·정보 줄·지표 4개·모델 표 3행·작업 추천·꼬리말).
    static let baseHeight: CGFloat = 470

    static func poolRowCount(for pool: TeamCodexPoolHealth?) -> Int {
        pool?.accounts.count ?? 0
    }
    static func poolSectionHeight(for pool: TeamCodexPoolHealth?) -> CGFloat {
        guard let pool = pool else { return 0 }
        return poolHeaderHeight + CGFloat(max(1, poolRowCount(for: pool))) * poolRowHeight
    }
    static func preferredHeight(for pool: TeamCodexPoolHealth?) -> CGFloat {
        baseHeight + (pool == nil ? 0 : poolSectionHeight(for: pool) + 16)
    }
    var health: CodexHealth? {
        didSet {
            updateAccessibility()
            setAccessibilityHelp(L10n.codexRecommendationHelp)
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
    private var recoveryButtons: [PanelButton] = []
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
        // 컨테이너를 요소로 유지한다. 패널 본문은 전부 draw() 텍스트라 AX 트리에 없고,
        // updateAccessibility()가 여기 붙이는 요약문이 유일한 낭독 대상이다.
        // true여도 NSButton 자식은 그대로 노출된다(2026-09-06 실측).
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(L10n.codexStatus)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func updateAccessibility() {
        let codexSummary = health?.accessibilitySummary ?? L10n.codexStatus
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
            // 재인증은 그 행에서 가장 급한 일(주 버튼), 다시 켜기는 테두리 버튼.
            let button = PanelButton(title: row.recovery.title, style: row.recovery.kind == .reauth ? .primary : .ghost)
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

    /// 풀 블록의 위치. draw(_:)와 layout()이 같은 값을 쓴다. 두 곳이 어긋나면 버튼이 남의 행에 붙는다.
    private func poolTableRect() -> NSRect? {
        guard let pool else { return nil }
        let layout = codexStatusLayout(
            topY: 4,
            poolHeight: Double(Self.poolSectionHeight(for: pool)),
            hasPool: true,
            localUsageLoaded: health != nil
        )
        return NSRect(x: Self.padding, y: CGFloat(layout.poolY), width: bounds.width - Self.padding * 2,
                      height: Self.poolSectionHeight(for: pool))
    }

    /// 계정 행 원점 y.
    private func poolRowY(_ poolRect: NSRect, _ index: Int) -> CGFloat {
        poolRect.minY + Self.poolHeaderHeight + CGFloat(index) * Self.poolRowHeight
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
        // 되돌리기 버튼은 그 행 이름 줄 오른쪽, 상태 라벨 자리에 앉는다(라벨은 draw가 건너뛴다).
        for (button, row) in zip(recoveryButtons, recoveryRows()) {
            button.frame = NSRect(x: poolRect.maxX - button.fittingWidth, y: poolRowY(poolRect, row.index) + 2,
                                  width: button.fittingWidth, height: PanelButton.height)
        }
        for (index, button) in subscriptionButtons.enumerated() {
            button.frame = NSRect(x: poolRect.minX + 15, y: poolRowY(poolRect, index) + Self.rowSubscriptionY,
                                  width: poolRect.width - 15, height: Self.rowSubscriptionHeight)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let fg = TeamClaudePalette.fg, fg2 = TeamClaudePalette.fg2, fg3 = TeamClaudePalette.fg3
        let mint = TeamClaudePalette.mint, amber = TeamClaudePalette.amber, ember = TeamClaudePalette.ember
        let caption = TeamClaudePalette.captionFont, micro = TeamClaudePalette.microFont
        let tiny = NSFont.systemFont(ofSize: 10)
        let mono = TeamClaudePalette.numberFont
        let x0 = Self.padding
        let width = bounds.width - Self.padding * 2

        func limitTone(_ value: Double?) -> NSColor {
            guard let value = value else { return fg3 }
            return value >= panelRoutingThresholdPercent ? amber : fg
        }

        func drawTeamCodexPool(at poolY: CGFloat) {
            guard let pool = pool else { return }
            let poolRect = NSRect(x: x0, y: poolY, width: width, height: Self.poolSectionHeight(for: pool))
            let poolTone: PanelTone = !pool.serverReachable ? .error : (pool.usableCount == 0 ? .wait : .ready)
            let titleWidth = PanelDraw.text(L10n.teamCodexPool, poolRect.minX, poolRect.minY + 2, TeamClaudePalette.panelTitleFont, fg)
            PanelDraw.dot(poolRect.minX + titleWidth + 10, centerY: poolRect.minY + 11, poolTone.color)
            let labelWidth = PanelDraw.text(pool.statusLabel, poolRect.minX + titleWidth + 22, poolRect.minY + 3.5, caption, poolTone.color)
            var headerRight = "port \(pool.serverPort)"
            if let runtime = pool.runtimeSummary { headerRight += " · \(runtime)" }
            let rightMax = poolRect.maxX - (poolRect.minX + titleWidth + 22 + labelWidth + 16)
            PanelDraw.right(PanelDraw.clipped(headerRight, micro, maxWidth: rightMax), poolRect.maxX, poolRect.minY + 5, micro, fg3)

            // 큰 숫자: 지금 배정 가능 / 풀
            let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 32, weight: .semibold)
            let numberWidth = PanelDraw.text("\(pool.usableCount)", poolRect.minX - 1, poolRect.minY + 26, numberFont, fg)
            PanelDraw.text(L10n.codexPoolUsable(pool: pool.poolCount, excluded: pool.excludedCount), poolRect.minX + numberWidth + 8,
                           poolRect.minY + 42, NSFont.monospacedDigitSystemFont(ofSize: 14, weight: .regular), fg3)
            PanelDraw.right(PanelDraw.clipped(pool.resetCreditSummary, caption, maxWidth: width / 2), poolRect.maxX, poolRect.minY + 34, caption, fg2)
            PanelDraw.right(PanelDraw.clipped(pool.resetCreditPolicyLabel, micro, maxWidth: width / 2), poolRect.maxX, poolRect.minY + 52, micro, fg3)
            // 지금 배정 가능한 계정 이름(Claude 표의 "사용 가능" 묶음과 같은 정보).
            let readyNames = pool.accounts
                .filter { $0.isUsable(switchThresholdPercent: pool.switchThresholdPercent, now: pool.checkedAt) }
                .map(\.name)
            PanelDraw.text(PanelDraw.clipped(L10n.codexUsableNames(readyNames), micro, maxWidth: width / 2 - 8), poolRect.minX, poolRect.minY + 66,
                           micro, readyNames.isEmpty ? TeamClaudePalette.amber : fg3)

            let headY = poolRect.minY + 84
            PanelDraw.meta(L10n.codexAccountsHead, poolRect.minX, headY)
            PanelDraw.right(L10n.codexWindowsPerAccount, poolRect.maxX, headY, TeamClaudePalette.legendFont, fg3)
            PanelDraw.hairline(poolRect.minX, poolRect.maxX, headY + 22)

            let rows = pool.accounts
            if rows.isEmpty {
                PanelDraw.text(L10n.codexNoAccounts, poolRect.minX, poolRowY(poolRect, 0) + 12, caption, fg3)
                return
            }
            let recoveryIndices = Set(recoveryRows().map(\.index))
            for (index, account) in rows.enumerated() {
                let rowY = poolRowY(poolRect, index)
                if index > 0 { PanelDraw.hairline(poolRect.minX, poolRect.maxX, rowY - 1) }
                let accountState = teamCodexAccountState(account, switchThresholdPercent: pool.switchThresholdPercent, now: pool.checkedAt)
                let quotaBlocked = accountState == .limited
                // 영구 제외(구독 종료·수동 제외)는 가장 조용하게, 일시 한도는 호박, 진짜 오류는 빨강.
                let tone: PanelTone
                switch accountState {
                case .retired, .excluded, .other: tone = .off
                case .failed: tone = .error
                case .endDateReached, .limited, .paused: tone = .wait
                case .serving: tone = .ready
                }
                let retired = accountState == .retired
                let muted = retired || accountState == .excluded
                // 오류 사유는 두 렌더러(Claude 표·Codex 풀)가 같은 canonical 라벨을 쓴다는 회귀 가드.
                let statusText = accountState == .failed
                    ? teamAccountErrorReasonLabel(account.errorReason)
                    : teamCodexAccountStateLabel(accountState, status: account.status, errorReason: account.errorReason)
                PanelDraw.dot(poolRect.minX + 2, centerY: rowY + 14, tone.color)
                let nameWidth = PanelDraw.text(PanelDraw.clipped(account.name, TeamClaudePalette.nameFont, maxWidth: width * 0.55),
                                               poolRect.minX + 15, rowY + 6, TeamClaudePalette.nameFont, muted ? fg2 : fg)
                if account.isCurrent && !retired {
                    PanelDraw.text(L10n.codexCurrent, poolRect.minX + 15 + nameWidth + 8, rowY + 7, micro, TeamClaudePalette.sky)
                }
                if !recoveryIndices.contains(index) {
                    PanelDraw.right(statusText, poolRect.maxX, rowY + 6, caption, tone == .off ? fg2 : tone.color)
                }

                // 5시간 · 7일 막대(리셋은 계정마다 따로).
                // 돌아오지 않는 계정에 초기화 카운트다운을 그리면 "곧 복귀"로 오해된다.
                let drawsResetCountdown = !account.isPermanentlyOut(now: pool.checkedAt)
                let sessionPercent = account.sessionUsagePercent(at: pool.checkedAt)
                let weeklyPercent = account.weeklyUsagePercent(at: pool.checkedAt)
                let half = (width - 15 - 16) / 2
                let windows: [(String, Double?, Date?, Double)] = [
                    (L10n.codexFiveHours, sessionPercent, account.sessionResetAt, 5 * 3_600),
                    (L10n.codexSevenDays, weeklyPercent, account.weeklyResetAt, 7 * 86_400),
                ]
                for (column, window) in windows.enumerated() {
                    let x = poolRect.minX + 15 + CGFloat(column) * (half + 16)
                    PanelDraw.text(window.0, x, rowY + 28, micro, fg3)
                    let reset = muted || !drawsResetCountdown ? StatusVocabulary.none
                        : formatTeamCodexResetRemaining(window.2, now: pool.checkedAt)
                    PanelDraw.right(PanelDraw.clipped(reset, micro, maxWidth: half - 50), x + half, rowY + 28, micro,
                                    quotaBlocked && column == 0 ? amber : fg3)
                    let elapsed = drawsResetCountdown
                        ? panelWindowElapsed(remainingSeconds: window.2?.timeIntervalSince(pool.checkedAt), windowSeconds: window.3) : nil
                    PanelDraw.meterWithValue(NSRect(x: x, y: rowY + 42, width: half, height: 14), percent: retired ? nil : window.1,
                                             elapsed: elapsed, muted: muted, thresholdPercent: pool.switchThresholdPercent)
                }
                // 보조 줄: 돌아오는지·안 돌아오는지(노트) · 되돌리기 안내, 오른쪽에 동시 · 요청 · 리셋권 · 토큰.
                var notes: [String] = []
                if let note = teamCodexAccountNote(account, switchThresholdPercent: pool.switchThresholdPercent, now: pool.checkedAt) {
                    notes.append(note)
                }
                // 다시 켜도 실행 중 서버에 바로 반영된다는 보장이 없다. 그 사실을 행에서 말한다.
                if let followUp = teamCodexAccountRecovery(account, now: pool.checkedAt)?.followUpNote, !drawsResetCountdown {
                    notes.append(followUp)
                }
                let credits = account.resetCreditCount(at: pool.checkedAt, online: pool.serverReachable)
                let facts = L10n.codexFacts(inflight: account.inflight, maxConcurrent: account.maxConcurrent,
                                            requests: account.totalRequests,
                                            credits: account.resetCreditLabel(at: pool.checkedAt, online: pool.serverReachable),
                                            tokens: formatCodexTokens(account.totalTokens))
                let factsWidth = PanelDraw.right(facts, poolRect.maxX, rowY + Self.rowFactsY, micro, credits == nil && !muted ? amber : fg3)
                if !notes.isEmpty {
                    PanelDraw.text(PanelDraw.clipped(notes.joined(separator: " · "), micro, maxWidth: factsWidth - poolRect.minX - 15 - 12),
                                   poolRect.minX + 15, rowY + Self.rowFactsY, micro, tone == .error ? ember : fg3)
                }
            }
        }

        let poolHeight = Self.poolSectionHeight(for: pool)
        let layout = codexStatusLayout(topY: 4, poolHeight: Double(poolHeight), hasPool: pool != nil, localUsageLoaded: health != nil)
        drawTeamCodexPool(at: CGFloat(layout.poolY))

        // 이 맥의 Codex 사용량
        let localY = CGFloat(layout.metricsY) + (pool == nil ? 0 : 8)
        if pool != nil { PanelDraw.hairline(x0, x0 + width, localY - 8) }
        guard let health = health else {
            PanelDraw.text(L10n.codexLocalTitle, x0, localY + 4, TeamClaudePalette.panelTitleFont, fg)
            PanelDraw.text(L10n.codexLocalLoading, x0, localY + 28, caption, fg3)
            return
        }
        let tone: PanelTone = health.isError ? .error : (health.isWarning ? .wait : .ready)
        let modelLabel = health.model.map(codexShortenModelName) ?? "default"
        let plan = health.planType ?? health.serviceTier ?? "-"
        let effort = health.reasoningEffort ?? "-"
        let effortText = effort == "-" ? "" : " · effort \(effort)"
        let context = health.contextWindow.map { "\($0 / 1000)K ctx" } ?? "ctx -"
        let quotaAccount = pool?.currentQuotaAccount
        let sessionPercent = quotaAccount?.sessionUsagePercent(at: Date())
        let weeklyPercent = quotaAccount?.weeklyUsagePercent(at: Date())
        let codexModels = usage?.modelBreakdown.filter { $0.provider == "Codex" } ?? []
        let codexMonthlyCost = codexModels.reduce(0) { $0 + $1.cost }
        let codexMonthlyTokens = codexModels.reduce(0) { $0 + $1.tokens }

        let titleWidth = PanelDraw.text(L10n.codexLocalTitle, x0, localY + 4, TeamClaudePalette.panelTitleFont, fg)
        PanelDraw.dot(x0 + titleWidth + 10, centerY: localY + 13, tone.color)
        PanelDraw.text(health.statusLabel, x0 + titleWidth + 22, localY + 5.5, caption, tone.color)
        PanelDraw.right(L10n.codexRecent(formatCodexAge(health.lastCallAt)), x0 + width, localY + 6, micro, fg3)
        let info = L10n.codexInfoLine(auth: health.authLabel, model: modelLabel, plan: plan) + "\(effortText)  ·  \(context)"
        PanelDraw.text(PanelDraw.clipped(info, micro, maxWidth: width), x0, localY + 28, micro, fg3)

        // 지표 4개
        let statY = localY + 52
        let gap: CGFloat = 8
        let statWidth = (width - gap * 3) / 4
        let metrics: [(String, String, String, Double?, NSColor)] = [
            (L10n.codexCurrentFiveHours, formatCodexPercent(sessionPercent),
             sessionPercent == nil ? L10n.codexNoLimitInfo : L10n.resetIn(formatCodexReset(quotaAccount?.sessionResetAt)), sessionPercent, limitTone(sessionPercent)),
            (L10n.codexCurrentSevenDays, formatCodexPercent(weeklyPercent),
             weeklyPercent == nil ? L10n.codexNoLimitInfo : L10n.resetIn(formatCodexReset(quotaAccount?.weeklyResetAt)), weeklyPercent, limitTone(weeklyPercent)),
            (L10n.codexTodayTokens, formatCodexTokens(health.todayTokens), L10n.codexCallCount(health.todayCalls), nil, fg),
            (L10n.codexMonthlyCost, codexMonthlyCost > 0 ? formatCost(codexMonthlyCost) : "-",
             codexMonthlyCost > 0 ? formatKRWShort(codexMonthlyCost, rate: usage?.usdKrwRate ?? 1450) : formatCodexTokens(codexMonthlyTokens), nil, fg),
        ]
        for (index, metric) in metrics.enumerated() {
            let rect = NSRect(x: x0 + CGFloat(index) * (statWidth + gap), y: statY, width: statWidth, height: 62)
            PanelDraw.card(rect)
            PanelDraw.text(PanelDraw.clipped(metric.0, micro, maxWidth: rect.width - 16), rect.minX + 8, rect.minY + 7, micro, fg3)
            let valueFont = NSFont.monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
            PanelDraw.text(PanelDraw.clipped(metric.1, valueFont, maxWidth: rect.width - 16), rect.minX + 8, rect.minY + 22, valueFont, metric.4)
            if let percent = metric.3 {
                PanelDraw.meter(NSRect(x: rect.minX + 8, y: rect.minY + 44, width: rect.width - 16, height: 4), percent: percent, elapsed: nil)
                PanelDraw.text(PanelDraw.clipped(metric.2, tiny, maxWidth: rect.width - 16), rect.minX + 8, rect.minY + 50, tiny, fg3)
            } else {
                PanelDraw.text(PanelDraw.clipped(metric.2, micro, maxWidth: rect.width - 16), rect.minX + 8, rect.minY + 43, micro, fg3)
            }
        }

        // 모델별 호출(최근 3개 프로필)
        let tableY = statY + 76
        let columns: [(String, CGFloat)] = [(L10n.codexColumnModel, x0), (L10n.codexColumnCalls, x0 + 170), (L10n.codexColumnToday, x0 + 230),
                                           (L10n.codexColumnWeek, x0 + 300), (L10n.codexColumnStatus, x0 + 370)]
        for (title, x) in columns { PanelDraw.meta(title, x, tableY) }
        PanelDraw.right(L10n.codexColumnRecent, x0 + width, tableY, TeamClaudePalette.metaFont, fg3, kern: TeamClaudePalette.metaKern)
        PanelDraw.hairline(x0, x0 + width, tableY + 20)
        let rows = Array(health.profiles.prefix(3))
        if rows.isEmpty {
            PanelDraw.text(L10n.codexNoSessions, x0, tableY + 32, caption, fg3)
        } else {
            for (i, row) in rows.enumerated() {
                let y = tableY + 28 + CGFloat(i) * 22
                let eventCount = row.quotaEvents + row.errorEvents
                let eventText = eventCount > 0 ? "Q\(row.quotaEvents)/E\(row.errorEvents)" : formatCodexVerdict(row.lastVerdict)
                let eventColor = row.quotaEvents > 0 ? ember : (row.errorEvents > 0 ? amber : mint)
                PanelDraw.dot(x0 + 2, centerY: y + 8, eventColor)
                PanelDraw.text(PanelDraw.clipped(row.profile, TeamClaudePalette.nameFont, maxWidth: 150), x0 + 14, y, TeamClaudePalette.nameFont, fg)
                PanelDraw.text("\(row.todayCalls)/\(row.weekCalls)", x0 + 170, y, mono, row.todayCalls > 0 ? fg : fg3)
                PanelDraw.text(formatCodexTokens(row.todayTokens), x0 + 230, y, mono, row.todayTokens > 0 ? fg : fg3)
                PanelDraw.text(formatCodexTokens(row.weekTokens), x0 + 300, y, mono, row.weekTokens > 0 ? fg : fg3)
                PanelDraw.text(PanelDraw.clipped(eventText, mono, maxWidth: 70), x0 + 370, y, mono, eventColor)
                PanelDraw.right(formatCodexAge(row.lastAt), x0 + width, y + 1, micro, fg3)
            }
        }

        // 작업별 모델 추천
        let recommendationY = tableY + 104
        let recommendationRect = NSRect(x: x0, y: recommendationY, width: width, height: 92)
        PanelDraw.card(recommendationRect)
        PanelDraw.meta(L10n.codexRecommendationTitle, recommendationRect.minX + 12, recommendationRect.minY + 10)
        let currentModel = L10n.codexCurrentModel(modelLabel + (effort == "-" ? "" : " · \(effort)"))
        PanelDraw.right(PanelDraw.clipped(currentModel, micro, maxWidth: width / 2), recommendationRect.maxX - 12,
                        recommendationRect.minY + 10, micro, TeamClaudePalette.sky)
        let columnY = recommendationRect.minY + 32
        let recommendations = codexModelRecommendations
        let columnWidth = recommendationRect.width / CGFloat(max(1, recommendations.count))
        for (index, recommendation) in recommendations.enumerated() {
            let x = recommendationRect.minX + CGFloat(index) * columnWidth
            if index > 0 {
                TeamClaudePalette.line.setFill()
                NSRect(x: x, y: columnY - 2, width: 1, height: recommendationRect.maxY - 10 - columnY + 2).fill()
            }
            PanelDraw.text(PanelDraw.clipped(recommendation.task, micro, maxWidth: columnWidth - 20), x + 12, columnY, micro, fg3)
            PanelDraw.text(PanelDraw.clipped(recommendation.model, TeamClaudePalette.nameFont, maxWidth: columnWidth - 20), x + 12, columnY + 17,
                           TeamClaudePalette.nameFont, fg)
            PanelDraw.text(PanelDraw.clipped(recommendation.effort, tiny, maxWidth: columnWidth - 20), x + 12, columnY + 36, tiny, fg3)
        }

        let footerY = recommendationRect.maxY + 12
        let hint = health.hints.first ?? L10n.codexPromptHint
        PanelDraw.text(PanelDraw.clipped(hint, micro, maxWidth: width), x0, footerY, micro, health.hints.isEmpty ? fg3 : tone.color)
        let stats = "files \(health.scannedLogFiles) · tok \(formatCodexTokens(health.totalTokens)) · 7d reset \(weeklyPercent == nil ? "-" : formatCodexReset(quotaAccount?.weeklyResetAt))"
        PanelDraw.text(PanelDraw.clipped(stats, micro, maxWidth: width), x0, footerY + 16, micro, fg3)
    }
}
