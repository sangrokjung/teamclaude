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
        /// 도구는 있는데 실행·해석에 실패했다. "데이터 없음"과 섞이면 수집기 장애가 정상처럼 보인다.
        case loadFailed
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

/// ccusage 한 번 실행이 실패한 원인. 화면 문구와 로그가 같은 말을 쓴다.
enum CcusageFailure: Equatable {
    case launch
    case timeout(seconds: Int)
    case exitStatus(Int32)
    case emptyOutput
    case unparsable
    /// stdout이 크기 상한을 넘었다. 끊었으므로 받은 출력은 쓰지 않는다.
    case outputTooLarge

    var label: String {
        switch self {
        case .launch: return "실행하지 못함"
        case .timeout(let seconds): return "\(seconds)초 시간 초과"
        case .exitStatus(let code): return "종료 코드 \(code)"
        case .emptyOutput: return "빈 출력"
        case .unparsable: return "출력 해석 실패"
        case .outputTooLarge: return "출력 크기 상한 초과"
        }
    }
}

/// ccusage daily 한 번의 결과. 성공적으로 해석한 빈 결과만 noData다.
enum CcusageLoadOutcome: Equatable {
    case loaded
    case noData
    case failed(CcusageFailure)

    var succeeded: Bool {
        if case .failed = self { return false }
        return true
    }
}

/// 실행 결과 → 판정. 실패 원인이 여럿이면 앞의 것(실행 → 출력 크기 상한 → 시간 초과 → 종료 코드 → 빈 출력 → 해석)을 쓴다.
/// 상한을 넘기면 자식을 끊으므로 그 뒤의 종료 코드·빈 출력은 결과일 뿐 원인이 아니다.
/// parsedHasToday: 출력을 해석하지 못했으면 nil, 해석했으면 기록이 있는지.
func ccusageLoadOutcome(launched: Bool, timedOut: Bool, timeoutSeconds: Double, exitStatus: Int32,
                        outputBytes: Int, parsedHasToday: Bool?, outputTooLarge: Bool = false) -> CcusageLoadOutcome {
    guard launched else { return .failed(.launch) }
    if outputTooLarge { return .failed(.outputTooLarge) }
    if timedOut { return .failed(.timeout(seconds: max(Int(timeoutSeconds.rounded()), 1))) }
    guard exitStatus == 0 else { return .failed(.exitStatus(exitStatus)) }
    guard outputBytes > 0 else { return .failed(.emptyOutput) }
    guard let parsedHasToday else { return .failed(.unparsable) }
    return parsedHasToday ? .loaded : .noData
}

/// ccusage는 npx로 돈다. npx가 없으면 미설치, 읽었는데 기록이 없으면 데이터 없음, 실행·해석이 실패했는데
/// 보여 줄 이전 값도 없으면 확인 필요. 이전 값이 있으면 본문은 그대로 두고 ccusageStaleNote가 낡았다고 표시한다.
/// 아직 한 번도 끝나지 않았으면(outcome nil) nil(기존 "확인 중" 화면).
func ccusageToolNotice(installed: Bool, outcome: CcusageLoadOutcome?, hasData: Bool) -> ToolNotice? {
    if !installed {
        return ToolNotice(tool: .ccusage, kind: .notInstalled,
                          headline: "사용량 \(StatusVocabulary.notInstalled)",
                          detail: "ccusage를 실행할 npx(Node.js)가 없습니다 · \(envHint("CC_MENUBAR_NPX_BIN"))")
    }
    guard let outcome, !hasData else { return nil }
    switch outcome {
    case .loaded:
        return nil
    case .noData:
        return ToolNotice(tool: .ccusage, kind: .noData,
                          headline: "사용량 \(StatusVocabulary.noData)",
                          detail: "Claude Code 사용 기록이 아직 없습니다")
    case .failed(let failure):
        return ToolNotice(tool: .ccusage, kind: .loadFailed,
                          headline: "사용량 \(StatusVocabulary.needsCheck)",
                          detail: "ccusage \(failure.label) · 다음 갱신 때 다시 시도합니다")
    }
}

/// 전체 갱신에서 daily 뒤에 돌리는 보조 명령. 실패해도 daily 값은 보이므로 부분 실패로 따로 센다.
enum CcusageAuxCommand: Equatable {
    case weekly
    case monthly

    var label: String {
        switch self {
        case .weekly: return "주간"
        case .monthly: return "월간"
        }
    }

    /// ccusage가 내는 기간 형식인가(주간은 주 시작일 YYYY-MM-DD, 월간은 YYYY-MM).
    func periodMatches(_ period: String) -> Bool {
        let pattern: String
        switch self {
        case .weekly: pattern = #"^\d{4}-\d{2}-\d{2}$"#
        case .monthly: pattern = #"^\d{4}-\d{2}$"#
        }
        return period.range(of: pattern, options: .regularExpression) != nil
    }

    /// ccusage JSON에서 이 명령의 기간 배열 키.
    var arrayKey: String {
        switch self {
        case .weekly: return "weekly"
        case .monthly: return "monthly"
        }
    }
}

/// daily는 읽었는데 실패한 보조 명령과 그 원인.
struct CcusageAuxFailure: Equatable {
    let command: CcusageAuxCommand
    let failure: CcusageFailure
}

/// 보조 명령 실패 꼬리말. 같은 원인은 "주간/월간: 원인"으로 묶고, 다르면 쉼표로 나눈다. 실패가 없으면 nil.
func ccusagePartialNote(_ failures: [CcusageAuxFailure]) -> String? {
    guard !failures.isEmpty else { return nil }
    var groups: [(cause: String, commands: [String])] = []
    for item in failures {
        if let index = groups.firstIndex(where: { $0.cause == item.failure.label }) {
            groups[index].commands.append(item.command.label)
        } else {
            groups.append((item.failure.label, [item.command.label]))
        }
    }
    let body = groups.map { "\($0.commands.joined(separator: "/")): \($0.cause)" }.joined(separator: ", ")
    return "일부 갱신 실패(\(body)) · 일별만 최신"
}

/// 사용량 카드·헤더에 붙는 꼬리말. 이전 값을 남긴 채 갱신이 실패했거나, 지난 기록은 읽었는데 오늘 날짜 항목이
/// 없을 때(오늘은 0으로 보인다), daily는 읽었는데 weekly·monthly가 실패했을 때(partial). 그 외에는 nil.
/// daily 자체가 실패했으면 그 꼬리말만 쓴다(보이는 값 전체가 이전 값이다).
func ccusageStaleNote(outcome: CcusageLoadOutcome?, hasData: Bool, partial: [CcusageAuxFailure] = []) -> String? {
    guard hasData, let outcome else { return nil }
    switch outcome {
    case .loaded: return ccusagePartialNote(partial)
    case .noData: return ["오늘 사용 기록 없음", ccusagePartialNote(partial)].compactMap { $0 }.joined(separator: " · ")
    case .failed(let failure): return "갱신 실패(\(failure.label)) · 이전 값"
    }
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
