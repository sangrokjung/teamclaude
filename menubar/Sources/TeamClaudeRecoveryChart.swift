import AppKit

// Claude 풀의 주간 리셋 일정 그래프(2026-11-18 대표가 고른 web-lab A안).
// 가로는 지금부터 7일, 세로는 쓸 수 있는 구독 계정 수다. 주간 리셋마다 한 칸씩 오르는 계단으로 그린다.
// 새 사용이 없다고 가정한 주간 기준이고, 세션(5시간) 한도는 따로라 실제 복귀는 더 늦을 수 있다(범례에 밝힌다).
// main.swift 타입에 기대지 않아 테스트 러너의 라이브러리 묶음에서도 컴파일된다.

enum TeamClaudeRecoveryChartMetrics {
    static let headerHeight: CGFloat = 26
    static let axisHeight: CGFloat = 18
    static let legendHeight: CGFloat = 18
    static let sidePadding: CGFloat = 12
    static let yLabelWidth: CGFloat = 22
    static let window: TimeInterval = 7 * 86_400
}

/// 그래프 x 좌표(0...1). 지금이 0, 7일 뒤가 1. 범위 밖은 끝으로 붙인다.
func teamClaudeRecoveryChartX(_ date: Date, now: Date, window: TimeInterval = TeamClaudeRecoveryChartMetrics.window) -> CGFloat {
    guard window > 0 else { return 0 }
    return CGFloat(min(1, max(0, date.timeIntervalSince(now) / window)))
}

/// 그래프 위 요약: 지금 몇 개 → 7일 안에 몇 개. 7일 밖 리셋은 세지 않는다.
func teamClaudeRecoveryChartSummary(_ steps: [TeamClaudeRecoveryStep], now: Date,
                                    window: TimeInterval = TeamClaudeRecoveryChartMetrics.window) -> (now: Int, inWindow: Int) {
    let first = steps.first?.count ?? 0
    let last = steps.filter { $0.at.timeIntervalSince(now) <= window }.last?.count ?? first
    return (first, last)
}

func drawTeamClaudeRecoveryChart(_ rect: NSRect, steps: [TeamClaudeRecoveryStep], total: Int, now: Date) {
    typealias M = TeamClaudeRecoveryChartMetrics
    let fg2 = TeamClaudePalette.fg2, fg3 = TeamClaudePalette.fg3, amber = TeamClaudePalette.amber
    let micro = TeamClaudePalette.microFont
    PanelDraw.card(rect)

    // 머리: 제목 · 요약
    let summary = teamClaudeRecoveryChartSummary(steps, now: now)
    PanelDraw.text(L10n.recoveryChartTitle, rect.minX + M.sidePadding, rect.minY + 8, TeamClaudePalette.legendMediumFont, fg2)
    PanelDraw.right(L10n.recoveryChartSummary(now: summary.now, inWeek: summary.inWindow, total: total),
                    rect.maxX - M.sidePadding, rect.minY + 8.5, micro, fg3)

    let plot = NSRect(x: rect.minX + M.sidePadding + M.yLabelWidth, y: rect.minY + M.headerHeight + 6,
                      width: rect.width - M.sidePadding * 2 - M.yLabelWidth,
                      height: rect.height - M.headerHeight - 6 - M.axisHeight - M.legendHeight)
    guard plot.width > 20, plot.height > 10 else { return }
    let maxCount = CGFloat(max(1, total))
    func x(_ date: Date) -> CGFloat { plot.minX + teamClaudeRecoveryChartX(date, now: now) * plot.width }
    func y(_ count: Int) -> CGFloat { plot.maxY - CGFloat(min(count, total)) / maxCount * plot.height }   // flipped 뷰: 아래가 큰 y

    // 눈금: 0과 전체 수 가로선, 하루마다 세로선과 날짜
    for (count, label) in [(0, "0"), (total, "\(total)")] {
        PanelDraw.hairline(plot.minX, plot.maxX, y(count), color: TeamClaudePalette.line)
        PanelDraw.right(label, plot.minX - 5, y(count) - 7, micro, fg3)
    }
    var calendar = Calendar.current
    calendar.timeZone = .current
    var day = calendar.startOfDay(for: now)
    for _ in 0..<8 {
        guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { break }
        day = next
        guard day.timeIntervalSince(now) < M.window else { break }
        let dx = x(day)
        TeamClaudePalette.line.setStroke()
        let tick = NSBezierPath()
        tick.move(to: NSPoint(x: dx, y: plot.minY))
        tick.line(to: NSPoint(x: dx, y: plot.maxY))
        tick.lineWidth = 1
        tick.stroke()
        let label = L10n.recoveryChartDay(day)
        let w = PanelDraw.width(label, micro)
        if dx + w / 2 < plot.maxX + 4 { PanelDraw.text(label, dx - w / 2, plot.maxY + 3, micro, fg3) }
    }

    // 지금 선(점선)
    let nowLine = NSBezierPath()
    nowLine.move(to: NSPoint(x: plot.minX, y: plot.minY))
    nowLine.line(to: NSPoint(x: plot.minX, y: plot.maxY))
    nowLine.setLineDash([2, 3], count: 2, phase: 0)
    fg3.setStroke()
    nowLine.stroke()

    // 계단 선 + 아래 채움
    guard let first = steps.first else { return }
    let path = NSBezierPath()
    path.move(to: NSPoint(x: x(first.at), y: y(first.count)))
    var lastY = y(first.count)
    for step in steps.dropFirst() where step.at.timeIntervalSince(now) <= M.window {
        path.line(to: NSPoint(x: x(step.at), y: lastY))
        lastY = y(step.count)
        path.line(to: NSPoint(x: x(step.at), y: lastY))
    }
    path.line(to: NSPoint(x: plot.maxX, y: lastY))
    let fill = path.copy() as! NSBezierPath
    fill.line(to: NSPoint(x: plot.maxX, y: plot.maxY))
    fill.line(to: NSPoint(x: x(first.at), y: plot.maxY))
    fill.close()
    amber.withAlphaComponent(0.10).setFill()
    fill.fill()
    amber.setStroke()
    path.lineWidth = 1.5
    path.stroke()
    for step in steps.dropFirst() where step.at.timeIntervalSince(now) <= M.window {
        PanelDraw.dot(x(step.at), centerY: y(step.count), amber, size: 5)
    }
    // 다음 리셋 표시
    if let next = steps.dropFirst().first, next.at.timeIntervalSince(now) <= M.window {
        let label = L10n.recoveryChartNext(L10n.resetMoment(next.at))
        let w = PanelDraw.width(label, micro)
        let lx = min(max(plot.minX + 4, x(next.at) - w / 2), plot.maxX - w)
        let ly = max(plot.minY, y(next.count) - 20)
        // 계단 선·점과 겹쳐도 읽히게 카드 바탕색을 깐다.
        PanelDraw.fillRound(NSRect(x: lx - 3, y: ly - 1, width: w + 6, height: 15), TeamClaudePalette.sheet, 3)
        PanelDraw.text(label, lx, ly, micro, amber)
    }

    // 범례
    PanelDraw.text(PanelDraw.clipped(L10n.recoveryChartLegend, micro, maxWidth: rect.width - M.sidePadding * 2),
                   rect.minX + M.sidePadding, rect.maxY - M.legendHeight + 1, micro, fg3)
}
