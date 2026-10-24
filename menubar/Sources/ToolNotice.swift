import Cocoa

// 도구·데이터가 없을 때 카드들이 공통으로 그리는 상태(외부 배포 R1·R4).
// 외부 사용자의 맥에는 TeamClaude·Codex·Higgsfield 같은 도구가 없을 수 있다. 그때 카드가
// 크래시·빈 카드·원시 오류 문자열 대신 "미설치/데이터 없음" 안내 하나를 같은 모양으로 그린다.
// 판정은 순수 함수, 그리기는 ToolNoticeView 한 곳이다. 레인·구독 카드는 같은 문구를 자기 자리에 그린다.

enum MenubarTool: String, CaseIterable {
    case teamclaude, teamcodex, codex, higgsfield, ccusage, grok, agy, subscription

    var displayName: String {
        switch self {
        case .teamclaude: return "TeamClaude"
        case .teamcodex: return "TeamCodex"
        case .codex: return "Codex"
        case .higgsfield: return "Higgsfield"
        case .ccusage: return "사용량"
        case .grok: return "Grok"
        case .agy: return "agy"
        case .subscription: return "구독 수집기"
        }
    }
}

struct ToolNotice: Equatable {
    enum Kind: Equatable {
        case notInstalled
        case noData
    }

    let tool: MenubarTool
    let kind: Kind
    let headline: String
    let detail: String

    var line: String { "\(headline) · \(detail)" }
}

private func notInstalled(_ tool: MenubarTool, detail: String) -> ToolNotice {
    ToolNotice(tool: tool, kind: .notInstalled,
               headline: "\(tool.displayName) \(StatusVocabulary.notInstalled)", detail: detail)
}

private func envHint(_ key: String) -> String {
    "설치돼 있다면 \(key)로 경로를 지정하세요"
}

/// 설정 파일도, 응답하는 서버도, 계정도 없으면 TeamClaude를 쓰지 않는 맥이다.
/// 설정이 있는데 서버만 꺼졌으면 기존 "오프라인" 화면이 맞으므로 nil.
func teamClaudeToolNotice(configPresent: Bool, serverReachable: Bool, accountCount: Int) -> ToolNotice? {
    guard !configPresent, !serverReachable, accountCount == 0 else { return nil }
    return notInstalled(.teamclaude, detail: "설정 파일(~/.config/teamclaude.json)과 실행 중인 서버가 없습니다")
}

func teamCodexToolNotice(configPresent: Bool, serverReachable: Bool, accountCount: Int) -> ToolNotice? {
    guard !configPresent, !serverReachable, accountCount == 0 else { return nil }
    return notInstalled(.teamcodex, detail: "설정 파일(~/.config/teamcodex.json)과 실행 중인 서버가 없습니다")
}

/// Codex CLI의 인증·설정·세션 기록도, 호출 기록(calls.jsonl)도 없으면 미설치다.
func codexToolNotice(authPresent: Bool, configPresent: Bool, scannedLogFiles: Int, totalCalls: Int) -> ToolNotice? {
    guard !authPresent, !configPresent, scannedLogFiles == 0, totalCalls == 0 else { return nil }
    return notInstalled(.codex, detail: "~/.codex의 인증·설정·세션 기록이 없습니다")
}

/// Codex 섹션은 로컬 Codex와 TeamCodex 풀을 함께 그린다. 둘 다 없을 때만 섹션을 안내로 바꾼다.
func codexSectionToolNotice(codex: ToolNotice?, teamCodex: ToolNotice?) -> ToolNotice? {
    guard codex != nil, teamCodex != nil else { return nil }
    return ToolNotice(tool: .codex, kind: .notInstalled,
                      headline: "Codex·TeamCodex \(StatusVocabulary.notInstalled)",
                      detail: "Codex CLI 기록과 TeamCodex 설정이 없습니다")
}

func higgsfieldToolNotice(installed: Bool) -> ToolNotice? {
    installed ? nil : notInstalled(.higgsfield, detail: envHint("CC_MENUBAR_HIGGSFIELD_BIN"))
}

/// ccusage는 npx로 돈다. npx가 없으면 미설치, 다 읽었는데 기록이 없으면 데이터 없음.
/// 아직 읽는 중이면 nil(기존 "확인 중" 화면).
func ccusageToolNotice(installed: Bool, loadFinished: Bool, hasData: Bool) -> ToolNotice? {
    if !installed {
        return ToolNotice(tool: .ccusage, kind: .notInstalled,
                          headline: "사용량 \(StatusVocabulary.notInstalled)",
                          detail: "ccusage를 실행할 npx(Node.js)가 없습니다 · \(envHint("CC_MENUBAR_NPX_BIN"))")
    }
    guard loadFinished, !hasData else { return nil }
    return ToolNotice(tool: .ccusage, kind: .noData,
                      headline: "사용량 \(StatusVocabulary.noData)",
                      detail: "Claude Code 사용 기록이 아직 없습니다")
}

/// grok CLI도 인증 파일도 없을 때만 미설치. CLI가 있으면 기존 "Grok 로그인"이 맞다.
func grokToolNotice(cliInstalled: Bool, authPresent: Bool) -> ToolNotice? {
    guard !cliInstalled, !authPresent else { return nil }
    return notInstalled(.grok, detail: envHint("CC_MENUBAR_GROK_BIN"))
}

func agyToolNotice() -> ToolNotice {
    notInstalled(.agy, detail: envHint("CC_MENUBAR_AGY_BIN"))
}

/// R4: 구독 수집기는 우리 맥에서만 켜는 선택 기능이다. 상태 파일이 없으면 오류가 아니라 안내다.
func subscriptionCollectorToolNotice(stateFileExists: Bool) -> ToolNotice? {
    stateFileExists ? nil : ToolNotice(tool: .subscription, kind: .notInstalled,
                                       headline: "수집기 미설치(선택 기능)",
                                       detail: "구독 확인 수집기가 없어 결제 메일·청구 페이지 확인은 건너뜁니다")
}

func subscriptionCollectorToolNotice(home: String) -> ToolNotice? {
    let path = "\(home)/.local/state/cc-menubar/subscription-monitor.json"
    return subscriptionCollectorToolNotice(stateFileExists: FileManager.default.fileExists(atPath: path))
}

/// CLI 레인은 한 줄짜리라 안내 카드 대신 같은 문구를 레인 모델에 싣는다.
func grokCardModel(for notice: ToolNotice) -> GrokCardModel {
    GrokCardModel(headline: notice.headline, detail: notice.detail, notice: notice)
}

func agyCardModel(for notice: ToolNotice) -> AgyCardModel {
    AgyCardModel(message: notice.line, groups: [], notice: notice)
}

/// 섹션 id("claude"·"codex"·"higgsfield"·"usage"·"burn") → 안내. 대시보드의 높이·배치·요약이 같은 값을 본다.
struct DashboardToolNotices: Equatable {
    var sections: [String: ToolNotice] = [:]
    var isEmpty: Bool { sections.isEmpty }
}

/// 구독 섹션(burn)은 본문을 바꾸지 않고 카드 안에 안내 줄을 더한다. 나머지는 본문을 안내 카드로 바꾼다.
func dashboardNoticeBodyHeight(section: String, natural: CGFloat, notices: DashboardToolNotices) -> CGFloat {
    guard section != "burn", notices.sections[section] != nil else { return natural }
    return ToolNoticeView.preferredHeight
}

func dashboardNoticeSummary(section: String, natural: String?, notices: DashboardToolNotices) -> String {
    if let notice = notices.sections[section] {
        if section == "burn", let natural, !natural.isEmpty { return natural }
        return notice.headline
    }
    return natural ?? ""
}

/// 안내가 실제로 그려졌는지 스냅샷·테스트가 확인하는 기록. 운영 경로에서는 꺼져 있다.
enum ToolNoticeDrawLog {
    static var isEnabled = false
    private(set) static var drawn: [String: String] = [:]

    static func record(_ cardID: String, _ notice: ToolNotice) {
        guard isEnabled else { return }
        drawn[cardID] = notice.headline
    }

    static func reset() { drawn = [:] }
}

/// 공통 안내 카드. 도구가 없는 섹션의 본문 자리에 놓인다.
final class ToolNoticeView: NSView {
    static let preferredHeight: CGFloat = 64

    var cardID = ""
    var notice: ToolNotice? {
        didSet {
            guard notice != oldValue else { return }
            setAccessibilityLabel(notice.map { "\($0.headline), \($0.detail)" } ?? "")
            needsDisplay = true
        }
    }

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let notice, bounds.width > 0 else { return }
        TeamClaudePalette.panel.setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 8, dy: 4), xRadius: 8, yRadius: 8).fill()
        (notice.headline as NSString).draw(at: NSPoint(x: 24, y: 14), withAttributes: [
            .font: NSFont.systemFont(ofSize: 14, weight: .semibold),
            .foregroundColor: TeamClaudePalette.text,
        ])
        (notice.detail as NSString).draw(at: NSPoint(x: 24, y: 36), withAttributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium),
            .foregroundColor: TeamClaudePalette.muted,
        ])
        ToolNoticeDrawLog.record(cardID, notice)
    }
}
