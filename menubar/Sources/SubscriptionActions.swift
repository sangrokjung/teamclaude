import Foundation

// 구독 상태 직접 처리(해지 기록 · 종료로 확정 · 종료일 고치기 · 기록 지우기)와 되돌리기.
// Claude는 로컬 기록(AccountSubscriptionStore)만 바꾼다. Codex는 정본이 프록시 설정이라 teamcodex CLI
// (`codex subscription cancel|clear … --account-uuid`)를 먼저 실행하고, 성공했을 때만 로컬 확인 기록을 남긴다.
// CLI가 실패하면 로컬 기록을 바꾸지 않고 사유를 돌려준다. 처리 중인 계정은 잠가 중복 실행을 막는다.
// 이 파일은 main.swift 없이 컴파일된다. 실제 프로세스 실행기는 main.swift가 주입한다.

enum SubscriptionCommand: Equatable {
    /// 해지했다고 기록(해지 예약). 종료일은 없어도 된다.
    case recordCancel(endDate: String?, source: String)
    /// 종료로 확정. 해지 예약에서 넘어오면 그 종료일을, "바로 종료로 확정"이면 입력한 종료일을 기록에 남긴다.
    case confirmEnd(endDate: String?, source: String)
    case editEndDate(String?)
    /// 기록 지우기 = 구독 중(사용자 확인)으로 되돌린다.
    case clear
}

struct SubscriptionTarget: Equatable {
    let provider: String
    let name: String
    let accountUuid: String?

    var key: String { "\(provider):\(accountUuid ?? "name:" + name)" }
}

struct SubscriptionCLIResult: Equatable {
    let status: Int32
    /// stdout과 stderr를 이어 붙인 출력.
    let output: String
    var timedOut = false
}

typealias SubscriptionCLIRunner = (_ arguments: [String], _ completion: @escaping (SubscriptionCLIResult) -> Void) -> Void

struct SubscriptionUndo {
    let target: SubscriptionTarget
    /// 처리 직전 로컬 기록 원본(nil = 기록 없음).
    let previousRecord: [String: Any]?
    /// Codex만: 직전 설정 상태로 돌리는 CLI 인자.
    let restoreArguments: [String]?
    /// 되돌리기 직전(그리고 Codex CLI 완료 뒤) 그 계정이 아직 같은 계정인지·프록시가 잠그지 않았는지 다시 본다. nil이면 통과.
    /// 버튼(행 뷰)이 아니라 패널이 되돌리기를 부를 때 지금 붙어 있는 데이터로 채운다. 행 뷰는 처리 뒤 다시 만들어질 수 있다.
    var verify: (() -> String?)? = nil
}

struct SubscriptionOutcome {
    let succeeded: Bool
    let message: String
    var restartNeeded = false
    var undo: SubscriptionUndo? = nil
}

private func teamCodexSubscriptionBase(_ action: String, name: String, accountUuid: String?) -> [String]? {
    // 신원이 확인된 행에서만 실행한다. 이름이 플래그처럼 보이면 CLI 인자 해석이 바뀌므로 거부한다.
    guard let accountUuid, !accountUuid.isEmpty, !name.isEmpty, !name.hasPrefix("-"), !accountUuid.hasPrefix("-") else { return nil }
    return ["codex", "subscription", action, name]
}

/// 처리 하나를 teamcodex CLI 인자로 바꾼다. 만들 수 없으면 nil(실행하지 않는다).
/// 종료로 확정은 종료일 없는 cancel이다. 프록시는 다음 인증 실패에서 종료로 확정한다(즉시 확정은 메뉴바 로컬 기록이 보인다).
func teamCodexSubscriptionArguments(_ command: SubscriptionCommand, name: String, accountUuid: String?) -> [String]? {
    func cancel(_ endDate: String?) -> [String]? {
        guard var args = teamCodexSubscriptionBase("cancel", name: name, accountUuid: accountUuid) else { return nil }
        if let endDate {
            guard accountSubscriptionDate(endDate) != nil else { return nil }
            args += ["--ends-on", endDate]
        }
        return args + ["--account-uuid", accountUuid ?? ""]
    }
    switch command {
    case .recordCancel(let endDate, _): return cancel(endDate)
    case .confirmEnd: return cancel(nil)
    case .editEndDate(let endDate): return cancel(endDate)
    case .clear:
        return teamCodexSubscriptionBase("clear", name: name, accountUuid: accountUuid).map { $0 + ["--account-uuid", accountUuid ?? ""] }
    }
}

/// 되돌리기 인자: 직전 설정 상태가 기록 없음·구독 중이면 clear, 해지 계열이면 그 종료일로 cancel.
/// 프록시가 확정한 종료(ended)는 CLI가 직접 만들 수 없어 종료일 없는 cancel로 돌린다(다음 인증 실패에 다시 확정된다).
func teamCodexSubscriptionRestoreArguments(previous: SubscriptionRecordView?, name: String, accountUuid: String?) -> [String]? {
    switch previous?.state {
    case nil, .active?, .unknown?:
        return teamCodexSubscriptionArguments(.clear, name: name, accountUuid: accountUuid)
    case .scheduled?, .overdue?:
        return teamCodexSubscriptionArguments(.editEndDate(previous?.endDate), name: name, accountUuid: accountUuid)
    case .ended?:
        return teamCodexSubscriptionArguments(.confirmEnd(endDate: nil, source: "user-confirmed"), name: name, accountUuid: accountUuid)
    }
}

/// 실행 중 서버가 계정 단위 리로드를 못 했을 때 CLI가 찍는 줄(src/index.js noteRunningServerReload).
func teamCodexSubscriptionNeedsRestart(_ output: String) -> Bool {
    output.contains("Apply the change with: teamcodex restart")
}

/// 실패 사유 한 줄. 마지막 비어 있지 않은 줄을 80자로 자른다(경로·계정 신원을 길게 늘어놓지 않는다).
func teamCodexSubscriptionFailureReason(_ result: SubscriptionCLIResult) -> String {
    if result.timedOut { return L10n.subFailedTimeout }
    let line = result.output.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        .last { !$0.isEmpty && !$0.hasPrefix("Usage:") } ?? ""
    guard !line.isEmpty else { return L10n.subFailedUnknown }
    return line.count > 80 ? String(line.prefix(79)) + "…" : line
}

/// 화면이 읽는 Codex 풀 설정 파일(메뉴바는 기본 경로를 고정해 읽는다: TeamCodexPoolStatus·AccountSubscription).
func teamCodexSubscriptionConfigPath(home: String) -> String {
    (home as NSString).appendingPathComponent(".config/teamcodex.json")
}

/// teamcodex 실행 환경. 셸에서 물려받은 TEAMCLAUDE_CONFIG·XDG_CONFIG_HOME·TEAMCLAUDE_PROVIDER가 다른 설정 파일을 가리키면
/// 화면은 기본 풀을 보여 주는데 클릭은 다른 파일을 고친다. 화면이 읽는 파일로 고정한다.
func teamCodexSubscriptionEnvironment(base: [String: String], home: String, executableBin: String) -> [String: String] {
    var environment = base
    environment.removeValue(forKey: "XDG_CONFIG_HOME")
    environment.removeValue(forKey: "TEAMCLAUDE_PROVIDER")
    environment["TEAMCLAUDE_CONFIG"] = teamCodexSubscriptionConfigPath(home: home)
    environment["HOME"] = home
    environment["PATH"] = "\(executableBin):/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    return environment
}

final class SubscriptionActionCenter {
    static let shared = SubscriptionActionCenter(store: .shared) { _, completion in
        completion(SubscriptionCLIResult(status: -1, output: L10n.subFailedUnknown))
    }

    private let store: AccountSubscriptionStore
    /// 메인 스레드에서 completion을 부르는 실행기. main.swift가 실제 teamcodex 실행기로 바꾼다.
    var runner: SubscriptionCLIRunner
    private var busy: Set<String> = []
    /// 잠금·기록이 바뀌면 부른다(표가 버튼을 다시 그린다).
    var onChange: (() -> Void)?
    /// 화면 처리 결과(하단 막대가 6초 보인다). 대시보드가 단다.
    var onOutcome: ((SubscriptionOutcome) -> Void)?

    init(store: AccountSubscriptionStore, runner: @escaping SubscriptionCLIRunner) {
        self.store = store
        self.runner = runner
    }

    func isBusy(_ target: SubscriptionTarget) -> Bool { busy.contains(target.key) }

    private func localState(_ command: SubscriptionCommand, current: SubscriptionResolution)
        -> (state: AccountSubscriptionState, date: String?, source: String) {
        switch command {
        case .recordCancel(let endDate, let source): return (.scheduled, endDate, source)
        case .confirmEnd(let endDate, let source): return (.ended, endDate, source)
        case .editEndDate(let endDate):
            let source = current.shown.source.flatMap { $0 == "proxy-record" ? nil : $0 } ?? "user-confirmed"
            return (.scheduled, endDate, source)
        case .clear: return (.renewing, nil, "user-confirmed")
        }
    }

    private func message(_ command: SubscriptionCommand, name: String, current: SubscriptionResolution, now: Date) -> String {
        switch command {
        case .recordCancel(let endDate, _):
            let past = endDate.flatMap { subscriptionDayOffset($0, now: now) }.map { $0 < 0 } ?? false
            return past ? L10n.subDoneRecordPast(name) : L10n.subDoneRecordCancel(name)
        case .confirmEnd: return current.isCancelled ? L10n.subDoneConfirmEnd(name) : L10n.subDoneConfirmNow(name)
        case .editEndDate: return L10n.subDoneEditEnd(name)
        case .clear: return L10n.subDoneClear(name)
        }
    }

    private func save(_ local: (state: AccountSubscriptionState, date: String?, source: String), target: SubscriptionTarget) -> Bool {
        guard let uuid = target.accountUuid else { return false }
        return target.provider == "codex"
            ? store.saveCodexConfirmation(local.state, date: local.date, uuid: uuid, source: local.source)
            : store.saveConfirmation(local.state, date: local.date, provider: target.provider, uuid: uuid, source: local.source)
    }

    private func finish(_ target: SubscriptionTarget) {
        busy.remove(target.key)
        onChange?()
    }

    /// 처리를 시작한다. 잠긴 계정이면 아무것도 하지 않고 false. completion은 메인 스레드에서 한 번 불린다.
    @discardableResult
    func perform(_ command: SubscriptionCommand, target: SubscriptionTarget, current: SubscriptionResolution,
                 now: Date = Date(), verify: (() -> String?)? = nil,
                 completion: @escaping (SubscriptionOutcome) -> Void) -> Bool {
        guard !isBusy(target) else { return false }
        // 화면이 주는 마지막 확인(그 계정이 아직 그 계정인지·잠기지 않았는지). 실패하면 아무것도 바꾸지 않는다.
        if let reason = verify?() {
            completion(SubscriptionOutcome(succeeded: false, message: L10n.subFailed(target.name, reason)))
            return true
        }
        guard let uuid = target.accountUuid, !uuid.isEmpty, ["anthropic", "codex"].contains(target.provider) else {
            completion(SubscriptionOutcome(succeeded: false, message: L10n.subFailed(target.name, L10n.subFailedIdentity)))
            return true
        }
        // 프록시가 확정한 종료는 이 맥 기록을 바꿔도 다음 판정에서 프록시 값이 이긴다. 성공으로 보이지 않게 거절한다.
        if current.proxyLocked {
            completion(SubscriptionOutcome(succeeded: false, message: L10n.subFailed(target.name, L10n.subFailedProxyLocked)))
            return true
        }
        let local = localState(command, current: current)
        if let date = local.date, accountSubscriptionDate(date) == nil {
            completion(SubscriptionOutcome(succeeded: false, message: L10n.subFailed(target.name, L10n.subFormInvalidDate)))
            return true
        }
        let previous = store.confirmationRecord(provider: target.provider, uuid: uuid)
        let done = message(command, name: target.name, current: current, now: now)
        guard target.provider == "codex" else {
            let saved = save(local, target: target)
            completion(saved
                ? SubscriptionOutcome(succeeded: true, message: done,
                                      undo: SubscriptionUndo(target: target, previousRecord: previous, restoreArguments: nil))
                : SubscriptionOutcome(succeeded: false, message: L10n.subFailed(target.name, L10n.subFormInvalidDate)))
            onChange?()
            return true
        }
        guard let arguments = teamCodexSubscriptionArguments(command, name: target.name, accountUuid: uuid) else {
            completion(SubscriptionOutcome(succeeded: false, message: L10n.subFailed(target.name, L10n.subFailedIdentity)))
            return true
        }
        // 되돌리기 인자는 직전 설정 상태에서 만든다. 이 맥 기록이 있으면 그것이 마지막으로 실행한 설정이다.
        let previousView = subscriptionRecordView(accountSubscriptionConfirmation(previous, now: now), now: now) ?? current.proxy
        let restore = teamCodexSubscriptionRestoreArguments(previous: previousView, name: target.name, accountUuid: uuid)
        busy.insert(target.key)
        onChange?()
        runner(arguments) { [weak self] result in
            guard let self else { return }
            defer { self.finish(target) }
            guard result.status == 0, !result.timedOut else {
                completion(SubscriptionOutcome(succeeded: false,
                                               message: L10n.subFailed(target.name, teamCodexSubscriptionFailureReason(result))))
                return
            }
            _ = self.save(local, target: target)
            let restart = teamCodexSubscriptionNeedsRestart(result.output)
            completion(SubscriptionOutcome(succeeded: true, message: restart ? "\(done) · \(L10n.subRestartNeeded)" : done,
                                           restartNeeded: restart,
                                           undo: SubscriptionUndo(target: target, previousRecord: previous, restoreArguments: restore)))
        }
        return true
    }

    /// 직전 처리의 반대 동작. 로컬 기록을 처리 전 원본으로 돌리고, Codex면 CLI로 설정도 되돌린다.
    @discardableResult
    func undo(_ undo: SubscriptionUndo, completion: @escaping (SubscriptionOutcome) -> Void) -> Bool {
        let target = undo.target
        guard !isBusy(target), let uuid = target.accountUuid else { return false }
        let done = L10n.subDoneUndo(target.name)
        // 처리 뒤 프록시가 종료를 확정했거나 행이 다른 계정으로 바뀌었으면 아무것도 바꾸지 않고 실패로 알린다.
        if let reason = undo.verify?() {
            completion(SubscriptionOutcome(succeeded: false, message: L10n.subFailed(target.name, reason)))
            return true
        }
        guard let arguments = undo.restoreArguments else {
            store.restoreConfirmationRecord(undo.previousRecord, provider: target.provider, uuid: uuid)
            completion(SubscriptionOutcome(succeeded: true, message: done))
            onChange?()
            return true
        }
        busy.insert(target.key)
        onChange?()
        runner(arguments) { [weak self] result in
            guard let self else { return }
            defer { self.finish(target) }
            guard result.status == 0, !result.timedOut else {
                completion(SubscriptionOutcome(succeeded: false,
                                               message: L10n.subFailed(target.name, teamCodexSubscriptionFailureReason(result))))
                return
            }
            self.store.restoreConfirmationRecord(undo.previousRecord, provider: target.provider, uuid: uuid)
            // CLI가 도는 사이 프록시가 종료를 확정했으면, 설정은 되돌렸지만 화면은 여전히 해지 확정이다. 성공으로 보이지 않게 알린다.
            if let reason = undo.verify?() {
                completion(SubscriptionOutcome(succeeded: false, message: "\(L10n.subUndoConfigOnly(target.name)) · \(reason)"))
                return
            }
            let restart = teamCodexSubscriptionNeedsRestart(result.output)
            completion(SubscriptionOutcome(succeeded: true, message: restart ? "\(done) · \(L10n.subRestartNeeded)" : done,
                                           restartNeeded: restart))
        }
        return true
    }
}
