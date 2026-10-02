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
    let poolY = topY + 58
    let metricsY = poolY + (hasPool ? poolHeight + 10 : 0)
    return CodexStatusLayout(poolY: poolY, metricsY: metricsY)
}
