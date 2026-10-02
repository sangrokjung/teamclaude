import Cocoa

/// TeamClaude 표가 쓰는 색·폰트. draw마다 새로 만들지 않고 프로세스 수명 동안 1회 생성한다.
enum TeamClaudePalette {
    static let bg = NSColor(calibratedRed: 0.06, green: 0.075, blue: 0.10, alpha: 0.97)
    static let panel = NSColor(calibratedRed: 0.095, green: 0.115, blue: 0.15, alpha: 1.0)
    static let panel2 = NSColor(calibratedRed: 0.12, green: 0.14, blue: 0.18, alpha: 1.0)
    static let line = NSColor(calibratedRed: 0.23, green: 0.27, blue: 0.34, alpha: 1.0)
    static let text = NSColor(calibratedRed: 0.92, green: 0.95, blue: 0.98, alpha: 1.0)
    static let muted = NSColor(calibratedRed: 0.55, green: 0.61, blue: 0.70, alpha: 1.0)
    static let green = NSColor(calibratedRed: 0.18, green: 0.82, blue: 0.48, alpha: 1.0)
    static let yellow = NSColor(calibratedRed: 0.93, green: 0.76, blue: 0.22, alpha: 1.0)
    static let red = NSColor(calibratedRed: 0.96, green: 0.26, blue: 0.32, alpha: 1.0)
    static let blue = NSColor(calibratedRed: 0.28, green: 0.55, blue: 0.90, alpha: 1.0)
    static let inactive = NSColor(calibratedWhite: 0.62, alpha: 1)
    /// 카드 제목. 장식이 데이터(행 13pt)보다 지나치게 크지 않게 16pt — 위계는 굵기로 낸다.
    static let titleFont = NSFont.systemFont(ofSize: 16, weight: .bold)
    static let subFont = NSFont.systemFont(ofSize: 13, weight: .medium)
    static let headFont = NSFont.systemFont(ofSize: 12, weight: .semibold)
    static let rowFont = NSFont.monospacedSystemFont(ofSize: 13, weight: .medium)
    static let smallFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    // 요약 밴드(ServiceAvailabilitySummaryView) 전용 크기. 한 줄 띠라 표 본문(13pt)과 같은 급으로 맞춘다 —
    // 예전 카드 3장(24/20/32/17pt)이 표보다 커서 위계가 뒤집혔던 것을 바로잡은 값이다.
    static let summaryTitleFont = NSFont.systemFont(ofSize: 12, weight: .semibold)
    static let summaryBodyFont = NSFont.systemFont(ofSize: 13, weight: .medium)
    static let summaryValueFont = NSFont.monospacedDigitSystemFont(ofSize: 15, weight: .bold)
    static let summaryNameFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    static let summaryFootFont = NSFont.systemFont(ofSize: 11)

    /// 정적 멤버 전부를 한 번 건드려 첫 draw 안이 아니라 기동 시점에 팔레트를 만든다.
    static func prewarm() {
        _ = (bg, panel, panel2, line, text, muted, green, yellow, red, blue, inactive, titleFont, subFont, headFont, rowFont, smallFont, summaryTitleFont, summaryBodyFont, summaryValueFont, summaryNameFont, summaryFootFont)
    }
}
