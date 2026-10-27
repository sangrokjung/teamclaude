import Cocoa

/// 패널이 쓰는 색·폰트(A안 토큰, menubar/DESIGN.md). draw마다 새로 만들지 않고 프로세스 수명 동안 1회 생성한다.
/// 상태색(mint·amber·ember·sky)은 점·짧은 라벨·막대 상태에만 쓴다. 면을 상태색으로 칠하지 않는다.
enum TeamClaudePalette {
    private static func hex(_ value: UInt32, alpha: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255, alpha: alpha)
    }

    // MARK: A안 토큰
    static let void = hex(0x040506)
    static let sheet = hex(0x0F1012)
    static let raised = hex(0x111214)
    static let overlay = hex(0x1B1C1E)
    static let graphite = hex(0x363739)
    static let lineStrong = NSColor(white: 1, alpha: 0.12)
    static let fg = hex(0xFFFFFF)
    static let fg2 = hex(0x9C9C9D)
    /// 3차 글자. Raycast 원값(#6A6B6C)은 대비 3.5:1이라 5.2:1로 올렸다.
    static let fg3 = hex(0x85868A)
    static let ash = hex(0xE6E6E6)
    static let ashInk = hex(0x2F3031)
    static let mint = hex(0x59D499)
    static let amber = hex(0xF5B94A)
    static let ember = hex(0xFF6363)
    static let sky = hex(0x56C2FF)
    /// 막대 트랙.
    static let track = NSColor(white: 1, alpha: 0.08)

    // MARK: 예전 이름(카드들이 쓰는 별칭). 값은 위 토큰에서 온다.
    /// 카드 면. 패널 바탕(sheet) 위에 흰색 2.5%를 얹은 층.
    static let bg = NSColor(white: 1, alpha: 0.025)
    static let panel = NSColor(white: 1, alpha: 0.03)
    static let panel2 = NSColor(white: 1, alpha: 0.05)
    static let line = NSColor(white: 1, alpha: 0.07)
    static let text = fg
    static let muted = fg3
    static let green = mint
    static let yellow = amber
    static let red = ember
    static let blue = sky
    static let inactive = fg3

    // MARK: 글자
    static let panelTitleFont = NSFont.systemFont(ofSize: 13.5, weight: .semibold)
    /// 개요의 "지금 라우팅 가능" 큰 숫자.
    static let heroFont = NSFont.monospacedDigitSystemFont(ofSize: 52, weight: .semibold)
    static let heroUnitFont = NSFont.monospacedDigitSystemFont(ofSize: 17, weight: .medium)
    static let laneValueFont = NSFont.monospacedDigitSystemFont(ofSize: 20, weight: .semibold)
    /// 개요 "지금 받는 계정" 칸의 세션 퍼센트(15pt medium).
    static let sessionValueFont = NSFont.monospacedDigitSystemFont(ofSize: 15, weight: .medium)
    static let bodyFont = NSFont.systemFont(ofSize: 13)
    static let bodyMediumFont = NSFont.systemFont(ofSize: 13, weight: .medium)
    static let captionFont = NSFont.systemFont(ofSize: 12)
    static let microFont = NSFont.systemFont(ofSize: 11)
    /// 범례·보조 설명(11.5pt).
    static let legendFont = NSFont.systemFont(ofSize: 11.5)
    static let legendMediumFont = NSFont.systemFont(ofSize: 11.5, weight: .medium)
    /// 벌린 자간(0.04em)으로 그리는 메타 라벨.
    static let metaFont = NSFont.systemFont(ofSize: 11, weight: .medium)
    static let metaKern: CGFloat = 0.44
    static let buttonFont = NSFont.systemFont(ofSize: 12, weight: .medium)
    static let keycapFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .medium)
    /// 계정 이름(고정폭).
    static let nameFont = NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
    /// 숫자 값(고정폭 숫자).
    static let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)

    // 예전 이름. 카드 제목은 데이터보다 크지 않게 13.5pt — 위계는 굵기로 낸다.
    static let titleFont = panelTitleFont
    static let subFont = bodyFont
    static let headFont = metaFont
    static let rowFont = NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .regular)
    static let smallFont = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)

    /// 정적 멤버 전부를 한 번 건드려 첫 draw 안이 아니라 기동 시점에 팔레트를 만든다.
    static func prewarm() {
        _ = (void, sheet, raised, overlay, graphite, lineStrong, fg, fg2, fg3, ash, ashInk, mint, amber, ember, sky, track)
        _ = (bg, panel, panel2, line, text, muted, green, yellow, red, blue, inactive)
        _ = (panelTitleFont, heroFont, heroUnitFont, laneValueFont, sessionValueFont, bodyFont, bodyMediumFont, captionFont, microFont,
             metaFont, legendFont, legendMediumFont, buttonFont, keycapFont, nameFont, numberFont, titleFont, subFont, headFont, rowFont, smallFont)
    }
}
