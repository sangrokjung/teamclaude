import Foundation

// 전망은 두 근거 중 하나로 낸다. 완료 주기가 둘 이상이면 과거 평균이고,
// 그 전까지는 현재 주기를 선형 외삽한다. 외삽임을 화면이 숨기지 않는다.

enum BurnConfidence: Equatable { case low, normal }

enum BurnBasis: Equatable {
    case history(cycles: Int)
    case extrapolation(confidence: BurnConfidence)
    /// 주기 경계를 아직 모른다(리셋 시각을 주지 않는 레인).
    case collecting
    /// 잴 수 없다(리셋이 이미 지났거나 값이 없다).
    case unmeasured
}

struct BurnProjection: Equatable {
    let current: Double?
    let projected: Double?
    /// 과거 주기들의 최소~최대. 평균만 보면 "매주 딱 맞다"로 읽힌다.
    let range: ClosedRange<Double>?
    let basis: BurnBasis
}

/// 경과율이 이보다 낮으면 외삽을 믿기 어렵다.
let burnLowConfidenceRatio: Double = 0.3

/// 주기가 얼마나 지났는가. 0으로 나누지 않도록 경계를 모두 막는다.
func burnElapsedRatio(windowSeconds: Double, resetAt: Date?, now: Date) -> Double? {
    guard windowSeconds > 0, let resetAt else { return nil }
    let remaining = resetAt.timeIntervalSince(now)
    // 이미 지난 리셋과, 창 길이보다 먼 리셋은 둘 다 신뢰할 수 없는 입력이다.
    guard remaining > 0, remaining <= windowSeconds else { return nil }
    let elapsed = (windowSeconds - remaining) / windowSeconds
    return elapsed > 0 ? elapsed : nil
}

func burnProject(current: Double?, windowSeconds: Double, resetAt: Date?,
                 history: [QuotaCycle], now: Date) -> BurnProjection {
    let complete = history.filter { $0.complete }
    if complete.count >= 2 {
        let means = complete.map { $0.meanUtilization }
        let mean = means.reduce(0, +) / Double(means.count)
        return BurnProjection(current: current, projected: mean,
                              range: (means.min() ?? mean)...(means.max() ?? mean),
                              basis: .history(cycles: complete.count))
    }
    guard let current else {
        return BurnProjection(current: nil, projected: nil, range: nil, basis: .collecting)
    }
    guard let elapsed = burnElapsedRatio(windowSeconds: windowSeconds, resetAt: resetAt, now: now) else {
        return BurnProjection(current: current, projected: nil, range: nil, basis: .unmeasured)
    }
    return BurnProjection(
        current: current, projected: current / elapsed, range: nil,
        basis: .extrapolation(confidence: elapsed < burnLowConfidenceRatio ? .low : .normal)
    )
}
