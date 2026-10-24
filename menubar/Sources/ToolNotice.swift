import Foundation

// 도구·데이터가 없을 때 카드들이 공통으로 그리는 상태(외부 배포 R1·R4).
// 외부 사용자의 맥에는 TeamClaude·Codex·Higgsfield 같은 도구가 없을 수 있다. 그때 카드가
// 크래시·빈 카드·원시 오류 문자열 대신 "미설치/데이터 없음" 안내 하나를 같은 모양으로 그린다.
// 판정은 이 파일의 순수 함수, 그리기는 ToolNoticeView.swift 한 곳이다. 레인·구독 카드는 같은 문구를 자기 자리에 그린다.

enum MenubarTool: String, CaseIterable {
    case teamclaude, teamcodex, codex, higgsfield, ccusage, grok, agy, subscription

    var displayName: String {
        switch self {
        case .teamclaude: return "TeamClaude"
        case .teamcodex: return "TeamCodex"
        case .codex: return "Codex"
        case .higgsfield: return "Higgsfield"
        case .ccusage: return L10n.sectionUsage
        case .grok: return "Grok"
        case .agy: return "agy"
        case .subscription: return L10n.toolSubscriptionCollector
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
    L10n.envHint(key)
}

/// 설정 파일도, 응답하는 서버도, 계정도 없으면 TeamClaude를 쓰지 않는 맥이다.
/// 설정이 있는데 서버만 꺼졌으면 기존 "오프라인" 화면이 맞으므로 nil.
func teamClaudeToolNotice(configPresent: Bool, serverReachable: Bool, accountCount: Int) -> ToolNotice? {
    guard !configPresent, !serverReachable, accountCount == 0 else { return nil }
    return notInstalled(.teamclaude, detail: L10n.noticeNoConfigOrServer("~/.config/teamclaude.json"))
}

func teamCodexToolNotice(configPresent: Bool, serverReachable: Bool, accountCount: Int) -> ToolNotice? {
    guard !configPresent, !serverReachable, accountCount == 0 else { return nil }
    return notInstalled(.teamcodex, detail: L10n.noticeNoConfigOrServer("~/.config/teamcodex.json"))
}

/// Codex CLI의 인증·설정·세션 기록도, 호출 기록(calls.jsonl)도 없으면 미설치다.
func codexToolNotice(authPresent: Bool, configPresent: Bool, scannedLogFiles: Int, totalCalls: Int) -> ToolNotice? {
    guard !authPresent, !configPresent, scannedLogFiles == 0, totalCalls == 0 else { return nil }
    return notInstalled(.codex, detail: L10n.noticeNoCodex)
}

/// Codex 섹션은 로컬 Codex와 TeamCodex 풀을 함께 그린다. 둘 다 없을 때만 섹션을 안내로 바꾼다.
func codexSectionToolNotice(codex: ToolNotice?, teamCodex: ToolNotice?) -> ToolNotice? {
    guard codex != nil, teamCodex != nil else { return nil }
    return ToolNotice(tool: .codex, kind: .notInstalled,
                      headline: "Codex·TeamCodex \(StatusVocabulary.notInstalled)",
                      detail: L10n.noticeNoCodexSection)
}

func higgsfieldToolNotice(installed: Bool) -> ToolNotice? {
    installed ? nil : notInstalled(.higgsfield, detail: envHint("CC_MENUBAR_HIGGSFIELD_BIN"))
}

/// ccusage는 npx로 돈다. npx가 없으면 미설치, 다 읽었는데 기록이 없으면 데이터 없음.
/// 아직 읽는 중이면 nil(기존 "확인 중" 화면).
func ccusageToolNotice(installed: Bool, loadFinished: Bool, hasData: Bool) -> ToolNotice? {
    if !installed {
        return ToolNotice(tool: .ccusage, kind: .notInstalled,
                          headline: "\(L10n.sectionUsage) \(StatusVocabulary.notInstalled)",
                          detail: L10n.noticeNoNpx(envHint("CC_MENUBAR_NPX_BIN")))
    }
    guard loadFinished, !hasData else { return nil }
    return ToolNotice(tool: .ccusage, kind: .noData,
                      headline: "\(L10n.sectionUsage) \(StatusVocabulary.noData)",
                      detail: L10n.noticeNoClaudeUsage)
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
                                       headline: L10n.noticeCollectorHeadline,
                                       detail: L10n.noticeCollectorDetail)
}

func subscriptionCollectorToolNotice(home: String) -> ToolNotice? {
    let path = "\(home)/.local/state/cc-menubar/subscription-monitor.json"
    return subscriptionCollectorToolNotice(stateFileExists: FileManager.default.fileExists(atPath: path))
}

/// 섹션 id("claude"·"codex"·"higgsfield"·"usage"·"burn") → 안내. 대시보드의 높이·배치·요약이 같은 값을 본다.
struct DashboardToolNotices: Equatable {
    var sections: [String: ToolNotice] = [:]
    var isEmpty: Bool { sections.isEmpty }
}

/// 공통 안내 카드(ToolNoticeView) 높이.
let toolNoticeCardHeight: CGFloat = 64

/// 구독 섹션(burn)은 본문을 바꾸지 않고 카드 안에 안내 줄을 더한다. 나머지는 본문을 안내 카드로 바꾼다.
func dashboardNoticeBodyHeight(section: String, natural: CGFloat, notices: DashboardToolNotices) -> CGFloat {
    guard section != "burn", notices.sections[section] != nil else { return natural }
    return toolNoticeCardHeight
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
