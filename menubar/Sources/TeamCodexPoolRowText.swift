import Foundation

// Codex 풀 카드(CodexStatusView.drawTeamCodexPool)가 그리는 문구·값을 정하는 순수 함수.
// 뷰는 여기서 받은 값을 좌표·글꼴·색만 입혀 그대로 그린다. 무엇을 보여 줄지(문구·값)를 여기 한곳에 두어
// 뷰와 테스트(StatusConsumerMapTests: status 필드가 화면에 실리는지)가 같은 함수를 부르게 한다.
// main.swift 밖에 둔 이유는 테스트 러너가 main.swift 없이 컴파일하는 라이브러리 묶음에 들어가야 해서다.

/// 풀 카드 머리(제목 옆 상태·서버 줄·큰 숫자·리셋권 요약·사용 가능 이름).
struct TeamCodexPoolHeaderText: Equatable {
    let tone: PanelTone
    let statusLabel: String
    let serverLine: String
    let usableNumber: String
    let usableDetail: String
    let resetCreditSummary: String
    let resetCreditPolicy: String
    let readyNames: String
    let readyNamesEmpty: Bool
}

func teamCodexPoolHeaderText(_ pool: TeamCodexPoolHealth) -> TeamCodexPoolHeaderText {
    var serverLine = "port \(pool.serverPort)"
    if let runtime = pool.runtimeSummary { serverLine += " · \(runtime)" }
    // 지금 배정 가능한 계정 이름(Claude 표의 "사용 가능" 묶음과 같은 정보).
    let readyNames = pool.accounts
        .filter { $0.isUsable(switchThresholdPercent: pool.switchThresholdPercent, now: pool.checkedAt) }
        .map(\.name)
    return TeamCodexPoolHeaderText(
        tone: !pool.serverReachable ? .error : (pool.usableCount == 0 ? .wait : .ready),
        statusLabel: pool.statusLabel,
        serverLine: serverLine,
        usableNumber: "\(pool.usableCount)",
        usableDetail: L10n.codexPoolUsable(pool: pool.poolCount, excluded: pool.excludedCount),
        resetCreditSummary: pool.resetCreditSummary,
        resetCreditPolicy: pool.resetCreditPolicyLabel,
        readyNames: L10n.codexUsableNames(readyNames),
        readyNamesEmpty: readyNames.isEmpty
    )
}

/// 계정 행의 5시간·7일 칸 하나. percent는 막대(PanelDraw.meterWithValue)에 넘기는 값이다.
struct TeamCodexPoolWindowText: Equatable {
    let label: String
    let reset: String
    let percent: Double?
    let elapsed: Double?
}

/// 계정 행 하나(상태 점·이름·현재 표시·상태 칸·두 창·보조 줄·사실 줄).
struct TeamCodexPoolRowText: Equatable {
    let state: TeamCodexAccountState
    let tone: PanelTone
    let retired: Bool
    let muted: Bool
    let name: String
    let currentLabel: String?
    let statusText: String
    let windows: [TeamCodexPoolWindowText]
    let notes: [String]
    let facts: String
    /// 리셋권 개수를 모를 때 사실 줄을 호박색으로 그린다.
    let factsWarn: Bool

    var quotaBlocked: Bool { state == .limited }
}

func teamCodexPoolRowTone(_ state: TeamCodexAccountState) -> PanelTone {
    // 영구 제외(구독 종료·수동 제외)는 가장 조용하게, 일시 한도는 호박, 진짜 오류는 빨강.
    switch state {
    case .retired, .excluded, .other: return .off
    case .failed: return .error
    case .endDateReached, .limited, .paused: return .wait
    case .serving: return .ready
    }
}

func teamCodexPoolRowText(_ account: TeamCodexPoolAccount, pool: TeamCodexPoolHealth) -> TeamCodexPoolRowText {
    let now = pool.checkedAt
    let state = teamCodexAccountState(account, switchThresholdPercent: pool.switchThresholdPercent, now: now)
    let retired = state == .retired
    let muted = retired || state == .excluded
    // 오류 사유는 두 렌더러(Claude 표·Codex 풀)가 같은 canonical 라벨을 쓴다는 회귀 가드.
    let statusText = state == .failed
        ? teamAccountErrorReasonLabel(account.errorReason)
        : teamCodexAccountStateLabel(state, status: account.status, errorReason: account.errorReason)
    return TeamCodexPoolRowText(
        state: state, tone: teamCodexPoolRowTone(state), retired: retired, muted: muted,
        name: account.name,
        currentLabel: account.isCurrent && !retired ? L10n.codexCurrent : nil,
        statusText: statusText,
        windows: teamCodexPoolWindows(account, now: now, retired: retired, muted: muted),
        notes: teamCodexPoolNotes(account, pool: pool),
        facts: L10n.codexFacts(inflight: account.inflight, maxConcurrent: account.maxConcurrent,
                               requests: account.totalRequests,
                               credits: account.resetCreditLabel(at: now, online: pool.serverReachable),
                               tokens: formatCodexTokens(account.totalTokens)),
        factsWarn: account.resetCreditCount(at: now, online: pool.serverReachable) == nil && !muted
    )
}

/// 5시간 · 7일 칸(리셋은 계정마다 따로). 돌아오지 않는 계정에 초기화 카운트다운을 그리면 "곧 복귀"로 오해된다.
private func teamCodexPoolWindows(_ account: TeamCodexPoolAccount, now: Date, retired: Bool, muted: Bool) -> [TeamCodexPoolWindowText] {
    let drawsResetCountdown = !account.isPermanentlyOut(now: now)
    let windows: [(String, Double?, Date?, Double)] = [
        (L10n.codexFiveHours, account.sessionUsagePercent(at: now), account.sessionResetAt, 5 * 3_600),
        (L10n.codexSevenDays, account.weeklyUsagePercent(at: now), account.weeklyResetAt, 7 * 86_400),
    ]
    return windows.map { window in
        TeamCodexPoolWindowText(
            label: window.0,
            reset: muted || !drawsResetCountdown ? StatusVocabulary.none : formatTeamCodexResetRemaining(window.2, now: now),
            percent: retired ? nil : window.1,
            elapsed: drawsResetCountdown
                ? panelWindowElapsed(remainingSeconds: window.2?.timeIntervalSince(now), windowSeconds: window.3) : nil
        )
    }
}

/// 보조 줄: 돌아오는지·안 돌아오는지(노트) · 되돌리기 안내.
private func teamCodexPoolNotes(_ account: TeamCodexPoolAccount, pool: TeamCodexPoolHealth) -> [String] {
    var notes: [String] = []
    if let note = teamCodexAccountNote(account, switchThresholdPercent: pool.switchThresholdPercent, now: pool.checkedAt) {
        notes.append(note)
    }
    // 다시 켜도 실행 중 서버에 바로 반영된다는 보장이 없다. 그 사실을 행에서 말한다.
    if let followUp = teamCodexAccountRecovery(account, now: pool.checkedAt)?.followUpNote,
       account.isPermanentlyOut(now: pool.checkedAt) {
        notes.append(followUp)
    }
    return notes
}
