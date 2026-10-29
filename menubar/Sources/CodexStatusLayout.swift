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

/// Codex 풀 행 배치(구독 상태 반영). 해지 확정 계정은 목록 아래 "해지 확정" 묶음에 짧은 행으로 모으고,
/// 펼친 행은 그 아래에 구독 기록 칸이 붙는다. 해지 확정·펼침이 없으면 예전과 같다(행 수 × 행 높이).
struct CodexPoolRowPlan: Equatable {
    /// 그리는 순서대로 원래 행 번호.
    var order: [Int] = []
    /// 원래 행 번호 → 행 묶음 첫 줄 기준 원점 y.
    var origins: [Int: Double] = [:]
    /// 해지 확정 묶음의 행 번호.
    var ended: Set<Int> = []
    /// 해지 확정 묶음 머리의 y(없으면 nil).
    var endedHeaderY: Double?
    var height: Double = 0
}

func codexPoolRowPlan(ended: [Bool], expanded: Int?, rowHeight: Double, endedRowHeight: Double,
                      detailHeight: Double, endedHeaderHeight: Double) -> CodexPoolRowPlan {
    var plan = CodexPoolRowPlan()
    guard !ended.isEmpty else {
        // 계정이 없으면 안내 한 줄 자리.
        plan.height = rowHeight
        return plan
    }
    var y = 0.0
    for index in ended.indices where !ended[index] {
        plan.order.append(index)
        plan.origins[index] = y
        y += rowHeight + (index == expanded ? detailHeight : 0)
    }
    let endedRows = ended.indices.filter { ended[$0] }
    if !endedRows.isEmpty {
        plan.endedHeaderY = y
        y += endedHeaderHeight
        for index in endedRows {
            plan.order.append(index)
            plan.origins[index] = y
            plan.ended.insert(index)
            y += endedRowHeight + (index == expanded ? detailHeight : 0)
        }
    }
    plan.height = y
    return plan
}
