import Cocoa

// 프록시 상태 응답의 API 키 credit 블록(spec B9)과 Claude 탭 "API 크레딧" 묶음의 문구(B10).
// 남은 금액은 프록시가 토큰 사용량과 단가표로 계산한 추정이다. 실제 잔액은 상류 거절(exhausted)이 진실이다.
// 키 값은 상태 응답에 없고 여기에도 없다. main.swift 밖에 둔 이유는 테스트 러너의 라이브러리 묶음에 들어가야 해서다.

struct TeamClaudeApiCredit: Equatable {
    /// 기록한 충전 금액(USD). 미입력이면 nil.
    var usd: Double?
    /// 추정 지출(USD).
    var spentUsd: Double
    var since: Date?
    var expiresAt: Date?
    /// 상류가 크레딧 부족으로 거절해 프록시가 뺀 키.
    var exhausted: Bool
    var exhaustedReason: String?
    /// 단가를 모르는 모델의 토큰 수(지출 추정에 들어가지 않았다).
    var unpricedTokens: Int
    /// 소진 차단을 프록시가 설정에 쓰지 못했다(재시작하면 풀린다, 프록시가 다시 쓴다).
    var persistFailed = false

    /// 화면에 보일 남은 금액(0 미만은 0). 충전 금액이 없으면 nil.
    var remainingShownUsd: Double? { usd.map { max(0, $0 - spentUsd) } }

    /// 충전 금액 대비 남은 비율(0~1). 충전 금액이 없으면 nil.
    var remainingFraction: Double? {
        guard let usd, usd > 0 else { return nil }
        return max(0, min(1, (usd - spentUsd) / usd))
    }
}

private func creditNumber(_ raw: Any?) -> Double? {
    guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
          value.doubleValue.isFinite else { return nil }
    return value.doubleValue
}

private func creditMillisDate(_ raw: Any?) -> Date? {
    guard let ms = creditNumber(raw), ms > 0 else { return nil }
    return Date(timeIntervalSince1970: ms / 1000)
}

/// credit 블록을 읽는다. 블록이 없거나(구버전 프록시·구독 계정) 객체가 아니면 nil.
func teamClaudeApiCredit(_ raw: Any?) -> TeamClaudeApiCredit? {
    guard let dict = raw as? [String: Any] else { return nil }
    let usd = creditNumber(dict["usd"]).flatMap { $0 > 0 ? $0 : nil }
    let spent = creditNumber(dict["spentUsd"]).map { max(0, $0) } ?? 0
    func flag(_ key: String) -> Bool {
        guard let value = dict[key] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
        return value.boolValue
    }
    let exhausted = flag("exhausted")
    let reason = (dict["exhaustedReason"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    // 범위를 먼저 자른 뒤 정수로 바꾼다. 유한하지만 Int 범위 밖인 값(손상된 응답)에서 앱이 멈추지 않게.
    let unpriced = creditNumber(dict["unpricedTokens"]).map { Int(min(max(0, $0), 1_000_000_000_000_000)) } ?? 0
    return TeamClaudeApiCredit(usd: usd, spentUsd: spent, since: creditMillisDate(dict["since"]),
                               expiresAt: creditMillisDate(dict["expiresAt"]), exhausted: exhausted,
                               exhaustedReason: reason, unpricedTokens: unpriced,
                               persistFailed: exhausted && flag("persistFailed"))
}

private func usdText(_ value: Double) -> String { String(format: "$%.2f", value) }

private func creditDateText(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter.string(from: date)
}

/// "약 $12.30 남음 · $50.00 중 (추정)". 충전 금액이 없으면 추정 지출만 말한다.
func teamClaudeApiCreditAmountText(_ credit: TeamClaudeApiCredit) -> String {
    guard let usd = credit.usd, let left = credit.remainingShownUsd else {
        return L10n.apiCreditNoTopUp(usdText(credit.spentUsd))
    }
    return L10n.apiCreditLeft(usdText(left), usdText(usd))
}

/// "만료 2026-12-31"(지났으면 "만료됨 …"). 만료일이 없으면 nil.
func teamClaudeApiCreditExpiryText(_ credit: TeamClaudeApiCredit, now: Date = Date()) -> String? {
    guard let expiresAt = credit.expiresAt else { return nil }
    let date = creditDateText(expiresAt)
    return expiresAt <= now ? L10n.apiCreditExpired(date) : L10n.apiCreditExpires(date)
}

/// 행 2줄(사유 줄) 문구. 소진이면 다시 켜는 법, 아니면 남은 금액 · 만료 · 단가 없는 토큰.
func teamClaudeApiCreditReason(_ credit: TeamClaudeApiCredit, now: Date = Date()) -> String {
    if credit.exhausted {
        return credit.persistFailed ? "\(L10n.apiCreditExhaustedReason) · \(L10n.apiCreditNotSaved)" : L10n.apiCreditExhaustedReason
    }
    var parts = [teamClaudeApiCreditAmountText(credit)]
    if let expiry = teamClaudeApiCreditExpiryText(credit, now: now) { parts.append(expiry) }
    if credit.unpricedTokens > 0 { parts.append(L10n.apiCreditUnpriced(credit.unpricedTokens)) }
    return parts.joined(separator: " · ")
}

/// 막대 오른쪽 값. 남은 금액(추정) 또는 "-".
func teamClaudeApiCreditBarValue(_ credit: TeamClaudeApiCredit) -> String {
    credit.remainingShownUsd.map(usdText) ?? "-"
}

extension PanelDraw {
    /// API 키 행의 남은 금액 막대(추정). 채움은 남은 비율, 20% 미만이면 호박색, 빠진 키(muted)는 graphite.
    /// 충전 금액이 없으면 트랙만 그리고 값 칸은 "-". credit 블록이 없으면(구버전 프록시) 트랙과 "-".
    static func apiCreditMeter(_ rect: NSRect, credit: TeamClaudeApiCredit?, muted: Bool) {
        let valueWidth: CGFloat = 64
        let barRect = NSRect(x: rect.minX, y: rect.midY - 3, width: max(0, rect.width - valueWidth - 6), height: 6)
        let radius = barRect.height / 2
        fillRound(barRect, TeamClaudePalette.track, radius)
        let fraction = credit?.exhausted == true ? 0 : credit?.remainingFraction
        if let fraction, fraction > 0 {
            let color = muted ? TeamClaudePalette.graphite
                : fraction < 0.2 ? TeamClaudePalette.amber : TeamClaudePalette.mint.withAlphaComponent(0.85)
            fillRound(NSRect(x: barRect.minX, y: barRect.minY, width: max(barRect.width * CGFloat(fraction), barRect.width * 0.03),
                             height: barRect.height), color, radius)
        }
        let value = credit.map(teamClaudeApiCreditBarValue) ?? "-"
        let color = muted || fraction == nil ? TeamClaudePalette.fg3 : (fraction ?? 1) < 0.2 ? TeamClaudePalette.amber : TeamClaudePalette.fg
        right(value, rect.maxX, rect.midY - 7.5, TeamClaudePalette.numberFont, color)
    }
}
