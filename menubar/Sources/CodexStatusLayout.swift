import Foundation

struct CodexStatusLayout {
    let poolY: Double
    let metricsY: Double
}

func codexStatusLayout(
    topY: Double,
    poolHeight: Double,
    hasPool: Bool,
    localUsageLoaded: Bool
) -> CodexStatusLayout {
    _ = localUsageLoaded
    // 풀이 맨 위, 이 맥의 사용량이 그 아래(A안). 예전에는 사용량 제목 줄(58pt) 아래에 풀이 왔다.
    let poolY = topY
    let metricsY = poolY + (hasPool ? poolHeight + 16 : 0)
    return CodexStatusLayout(poolY: poolY, metricsY: metricsY)
}
