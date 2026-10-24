import Foundation

// 상태바 앱이 TeamClaude 프록시를 다루는 방식의 판정 로직(순수 함수).
//
// supervisor 강제 재시작(launchctl kickstart의 -k 옵션)은 진행 중인 Claude Code 요청을 모두 끊는다.
// 그래서 앱은 다음 원칙을 지킨다.
//  - 계정 설정 변경: CLI가 이미 worker에 SIGHUP으로 무중단 반영한다. 남은 불일치만
//    검증된 worker에 SIGHUP을 한 번 더 보내고, 그래도 남으면 경고만 한다.
//  - 서버 연결 실패: 프로세스가 살아 있으면 응답 지연으로 보고 아무것도 하지 않는다.
//    launchd 프로세스도 없고 포트도 닫혀 있을 때만 `-k` 없는 kickstart로 멈춘 서비스를 시작한다.
//  - `-k` 재시작은 사용자가 확인 대화상자에서 명시적으로 고른 경우뿐이다.

/// `launchctl print gui/<uid>/<label>` 결과.
enum TeamClaudeLaunchdProbe: Equatable {
    case running(pid: Int32)
    case loadedNotRunning
    case notLoaded
    case unknown
}

/// 프록시 포트 TCP 연결 시도 결과.
enum TeamClaudePortProbe: Equatable {
    case listening
    case refused
    /// 타임아웃 등으로 판별하지 못함. 살아 있는 것으로 취급한다(죽이지 않는 쪽).
    case unknown
}

enum TeamClaudeOutageVerdict: Equatable {
    /// 프로세스가 살아 있거나 포트를 누가 잡고 있다. 재시작하지 않는다.
    case responseDelayed(pid: Int32?)
    /// launchd 프로세스도 없고 포트도 닫혔다. `-k` 없는 kickstart로 시작만 한다.
    case startStoppedService
    /// launchd에 서비스가 등록돼 있지 않다. kickstart로는 살릴 수 없으므로 경고만 한다.
    case serviceNotLoaded
    /// launchd 상태를 읽지 못했다. 증거 없이 조치하지 않는다.
    case undetermined
}

enum TeamClaudeSyncPlan: Equatable {
    /// 서버가 응답하고 불일치도 없다(CLI가 이미 라이브 반영함).
    case nothing
    /// 서버는 응답하지만 계정 불일치가 남았다. worker SIGHUP으로 무중단 재로딩.
    case reloadAccounts
    /// 서버가 응답하지 않는다. 프로세스 생존부터 확인한다.
    case checkLiveness
}

struct TeamClaudeProcessIdentity: Equatable {
    let pid: Int32
    let ppid: Int32
    let startedAt: String
    let command: String
}

struct TeamClaudeServerStateSnapshot: Equatable {
    let supervisorPid: Int32?
    let workerPid: Int32?
    let configPath: String?
    let recordedWorker: TeamClaudeProcessIdentity?
}

enum TeamClaudeWorkerSignalDecision: Equatable {
    case signal(pid: Int32)
    case refuse(String)
}

struct TeamClaudeRestartConfirmation: Equatable {
    let title: String
    let message: String
    let confirmTitle: String
    let cancelTitle: String
}

/// `launchctl print`의 최상위(탭 한 개 들여쓰기) `pid = N` 줄만 서비스 pid로 읽는다.
/// 중첩 블록 안의 pid는 무시한다. exit 113은 서비스 미등록이다.
func parseTeamClaudeLaunchdPrint(output: String, exitStatus: Int32) -> TeamClaudeLaunchdProbe {
    if exitStatus == 113 { return .notLoaded }
    guard exitStatus == 0 else { return .unknown }
    var sawTopLevelField = false
    for rawLine in output.split(separator: "\n", omittingEmptySubsequences: false) {
        let line = String(rawLine)
        guard line.hasPrefix("\t"), !line.hasPrefix("\t\t") else { continue }
        let field = line.dropFirst()
        sawTopLevelField = true
        guard field.hasPrefix("pid = ") else { continue }
        let value = field.dropFirst("pid = ".count).trimmingCharacters(in: .whitespaces)
        if let pid = Int32(value), pid > 0 { return .running(pid: pid) }
    }
    return sawTopLevelField ? .loadedNotRunning : .unknown
}

func teamClaudeOutageVerdict(
    launchd: TeamClaudeLaunchdProbe,
    launchdPidAlive: Bool,
    port: TeamClaudePortProbe
) -> TeamClaudeOutageVerdict {
    if case .running(let pid) = launchd, launchdPidAlive {
        return .responseDelayed(pid: pid)
    }
    if port != .refused { return .responseDelayed(pid: nil) }
    switch launchd {
    case .running, .loadedNotRunning: return .startStoppedService
    case .notLoaded: return .serviceNotLoaded
    case .unknown: return .undetermined
    }
}

func teamClaudeSyncPlan(serverReachable: Bool, accountConfigDrift: Int) -> TeamClaudeSyncPlan {
    guard serverReachable else { return .checkLiveness }
    return accountConfigDrift > 0 ? .reloadAccounts : .nothing
}

/// ps의 lstart(`%c`, C 로케일 = `%a %b %e %H:%M:%S %Y`)와 같은 문자열. 프록시가 상태 파일에
/// 기록한 worker 시작 시각과 그대로 비교하려고 서브프로세스 없이 만든다.
func teamClaudeLstartString(epochSeconds: Int, timeZone: TimeZone) -> String {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let date = Date(timeIntervalSince1970: TimeInterval(epochSeconds))
    let parts = calendar.dateComponents([.weekday, .month, .day, .hour, .minute, .second, .year], from: date)
    let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    let weekday = weekdays[((parts.weekday ?? 1) - 1 + 7) % 7]
    let month = months[((parts.month ?? 1) - 1 + 12) % 12]
    return String(
        format: "%@ %@ %2d %02d:%02d:%02d %d",
        weekday, month, parts.day ?? 0, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, parts.year ?? 0
    )
}

/// sysctl KERN_PROCARGS2 버퍼(argc, 실행 경로, NUL 패딩, argv...)에서 argv만 꺼낸다.
func parseTeamClaudeProcArgs(_ buffer: [UInt8]) -> [String]? {
    let intSize = MemoryLayout<Int32>.size
    guard buffer.count > intSize else { return nil }
    let argc = buffer.prefix(intSize).enumerated().reduce(Int32(0)) { value, element in
        value | Int32(element.element) << (8 * Int32(element.offset))
    }
    guard argc > 0, argc < 4_096 else { return nil }
    var index = intSize
    while index < buffer.count, buffer[index] != 0 { index += 1 }
    while index < buffer.count, buffer[index] == 0 { index += 1 }
    var arguments: [String] = []
    while arguments.count < Int(argc) {
        guard index < buffer.count else { return nil }
        let start = index
        while index < buffer.count, buffer[index] != 0 { index += 1 }
        guard index < buffer.count else { return nil }
        arguments.append(String(decoding: buffer[start..<index], as: UTF8.self))
        index += 1
    }
    return arguments
}

private func teamClaudeInt32(_ value: Any?) -> Int32? {
    if let number = value as? NSNumber {
        let double = number.doubleValue
        guard double.isFinite, double == double.rounded(),
              double >= Double(Int32.min), double <= Double(Int32.max) else { return nil }
        return Int32(double)
    }
    if let string = value as? String { return Int32(string) }
    return nil
}

/// `<config>.server.json` 상태 파일에서 worker 검증에 필요한 값만 읽는다.
func parseTeamClaudeServerState(_ json: [String: Any]?) -> TeamClaudeServerStateSnapshot? {
    guard let json else { return nil }
    let lifecycle = json["lifecycle"] as? [String: Any]
    let worker = lifecycle?["worker"] as? [String: Any]
    var recordedWorker: TeamClaudeProcessIdentity?
    if let worker,
       let pid = teamClaudeInt32(worker["pid"]),
       let ppid = teamClaudeInt32(worker["ppid"]),
       let startedAt = worker["startedAt"] as? String,
       let command = worker["command"] as? String {
        recordedWorker = TeamClaudeProcessIdentity(pid: pid, ppid: ppid, startedAt: startedAt, command: command)
    }
    return TeamClaudeServerStateSnapshot(
        supervisorPid: teamClaudeInt32(json["pid"]),
        workerPid: teamClaudeInt32(json["workerPid"]),
        configPath: json["config"] as? String,
        recordedWorker: recordedWorker
    )
}

/// Anthropic 모드 `teamclaude server` 프로세스 명령인가. codex 서버(`... codex server`)는 아니다.
func teamClaudeIsServerCommand(_ command: String) -> Bool {
    let tokens = command.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
    guard let serverIndex = tokens.lastIndex(of: "server"), serverIndex == tokens.count - 1 else { return false }
    guard let entryIndex = tokens.firstIndex(where: { token in
        token.hasSuffix("/src/teamclaude.js")
            || token.hasSuffix("/src/index.js")
            || (token as NSString).lastPathComponent == "teamclaude"
    }) else { return false }
    // 진입점과 server 사이에 다른 인자(codex 등)가 있으면 다른 모드다.
    return entryIndex + 1 == serverIndex
}

/// worker에 SIGHUP을 보내도 되는가. 프록시 CLI의 verifyWorkerIdentity와 같은 기준으로,
/// 상태 파일 기록과 현재 프로세스(부모·시작 시각·명령)가 모두 일치할 때만 허용한다.
func teamClaudeWorkerSignalDecision(
    state: TeamClaudeServerStateSnapshot?,
    expectedConfigPath: String,
    launchd: TeamClaudeLaunchdProbe,
    observedWorker: TeamClaudeProcessIdentity?
) -> TeamClaudeWorkerSignalDecision {
    guard let state else { return .refuse("상태 파일 없음") }
    guard state.configPath == expectedConfigPath else { return .refuse("다른 설정 파일의 서버") }
    guard let supervisorPid = state.supervisorPid, supervisorPid > 1,
          let workerPid = state.workerPid, workerPid > 1, workerPid != supervisorPid else {
        return .refuse("상태 파일 pid 이상")
    }
    guard case .running(let launchdPid) = launchd, launchdPid == supervisorPid else {
        return .refuse("launchd 서비스 pid와 supervisor 불일치")
    }
    guard let recorded = state.recordedWorker, recorded.pid == workerPid, recorded.ppid == supervisorPid else {
        return .refuse("worker 기록 없음")
    }
    guard teamClaudeIsServerCommand(recorded.command) else { return .refuse("teamclaude server 명령 아님") }
    guard let observedWorker else { return .refuse("worker 프로세스 없음") }
    guard observedWorker == recorded else { return .refuse("worker 프로세스가 기록과 다름") }
    return .signal(pid: workerPid)
}

/// 사용자가 "서버 재시작"을 눌렀을 때의 확인 대화상자 문구.
func teamClaudeRestartConfirmation(inflight: Int?, serverReachable: Bool) -> TeamClaudeRestartConfirmation {
    let impact: String
    if serverReachable, let inflight, inflight >= 0 {
        impact = inflight > 0
            ? "진행 중 요청 \(inflight)건이 끊깁니다."
            : "진행 중 요청은 없습니다."
    } else {
        impact = "서버 상태를 읽지 못해 진행 중 요청 수를 확인하지 못했습니다. 진행 중인 요청이 있으면 모두 끊깁니다."
    }
    return TeamClaudeRestartConfirmation(
        title: "TeamClaude 서버를 재시작할까요?",
        message: impact + "\n계정 추가·재인증·켜기/끄기는 재시작 없이 자동 반영되므로 보통은 필요하지 않습니다.",
        confirmTitle: "재시작",
        cancelTitle: "취소"
    )
}

func teamClaudeServerPillLabel(serverReachable: Bool, responseDelayed: Bool) -> String {
    if serverReachable { return "실행중" }
    return responseDelayed ? "응답 지연" : "오프라인"
}

func teamClaudeDriftActionDetail(persistsAfterReload: Bool) -> String {
    persistsAfterReload
        ? "재로딩 후에도 남음 · 재시작하지 않음"
        : "자동 동기화 중 · 서버 반영 확인"
}

// 프록시 `getConfigPath()`/`getServerStatePath()`와 같은 규칙으로 설정·상태 파일 경로를 정한다.
// TEAMCLAUDE_CONFIG → XDG_CONFIG_HOME/teamclaude.json → ~/.config/teamclaude.json.
// 앱의 상태 확인·드리프트 계산·worker 신원 확인이 모두 이 경로를 써야 서로 어긋나지 않는다.
// 상대 경로는 서버 프로세스의 cwd 기준이라 앱이 같은 파일을 가리킨다고 보장할 수 없으므로
// nil(설정 특정 불가)을 돌려주고, 모든 호출 지점이 그 경우 설정을 읽지 않는다.
func teamClaudeConfigPath(environment: [String: String], home: String) -> String? {
    if let explicit = environment["TEAMCLAUDE_CONFIG"], !explicit.isEmpty {
        return explicit.hasPrefix("/") ? explicit : nil
    }
    let configDir = environment["XDG_CONFIG_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? "\(home)/.config"
    return configDir.hasPrefix("/") ? "\(configDir)/teamclaude.json" : nil
}

func teamClaudeServerStatePath(configPath: String) -> String {
    let base = configPath.hasSuffix(".json") ? String(configPath.dropLast(5)) : configPath
    return base + ".server.json"
}

// MARK: - launchd 라벨과 재시작 계획(외부 배포 R3)
//
// 내부 운영은 `com.qjc.teamclaude` 서비스로 프록시를 띄운다. 외부 사용자는 다른 라벨을 쓰거나
// launchd에 등록하지 않고 쓴다. 라벨은 환경변수 > UserDefaults > 기본값 순으로 정한다.
// 라벨이 launchd에 없으면 kickstart로는 살릴 수 없으므로 `teamclaude server`를 분리 실행해 시작만 한다.
// 살아 있는 프록시를 강제로 재시작하지 않는다는 원칙(PR #64)은 그대로다.

let teamClaudeDefaultLaunchdLabel = "com.qjc.teamclaude"
let teamClaudeLaunchdLabelEnvKey = "CC_MENUBAR_TEAMCLAUDE_LABEL"
let teamClaudeLaunchdLabelDefaultsKey = "teamClaudeLaunchdLabel"

/// launchctl 서비스 이름으로 쓸 수 있는 값인가(영문·숫자·`.`·`-`·`_`, 255자 이하).
func teamClaudeLaunchdLabelIsValid(_ label: String) -> Bool {
    guard !label.isEmpty, label.count <= 255 else { return false }
    return label.unicodeScalars.allSatisfy { scalar in
        scalar.isASCII && (CharacterSet.alphanumerics.contains(scalar)
            || scalar == "." || scalar == "-" || scalar == "_")
    }
}

func resolveTeamClaudeLaunchdLabel(environment: [String: String], defaultsValue: String?) -> String {
    for candidate in [environment[teamClaudeLaunchdLabelEnvKey], defaultsValue] {
        if let candidate, teamClaudeLaunchdLabelIsValid(candidate) { return candidate }
    }
    return teamClaudeDefaultLaunchdLabel
}

enum TeamClaudeRestartPlan: Equatable {
    /// launchd 서비스가 등록돼 있다. 기존처럼 확인 대화상자를 거친 뒤에만 `-k` 재시작.
    case forceRestartConfirmed
    /// 라벨이 launchd에 없고 포트도 닫혔다. `teamclaude server`를 분리 실행해 시작만 한다.
    case startDetached
    /// 라벨이 launchd에 없는데 포트를 누가 잡고 있다(또는 판별 불가). 앱이 관리하지 않는 프로세스라 건드리지 않는다.
    case leaveRunning
    /// launchd 상태를 읽지 못했다. 증거 없이 조치하지 않는다.
    case undetermined
}

/// 사용자가 누른 "서버 재시작"이 무엇을 할지. 미등록 라벨에서는 어떤 포트 상태에서도 kickstart로 가지 않는다(A4).
func teamClaudeRestartPlan(launchd: TeamClaudeLaunchdProbe, port: TeamClaudePortProbe) -> TeamClaudeRestartPlan {
    switch launchd {
    case .running, .loadedNotRunning: return .forceRestartConfirmed
    case .notLoaded: return port == .refused ? .startDetached : .leaveRunning
    case .unknown: return .undetermined
    }
}

/// 자동 동기화가 미등록 라벨의 멈춘 서버를 분리 실행해도 되는가. 설정 파일과 절대 경로 실행 파일이 있어야 한다.
/// (설정이 없는 맥은 TeamClaude 미설치다. PATH 이름만 있으면 무엇이 뜰지 모른다.)
func teamClaudeDetachedStartAllowed(configPresent: Bool, executable: String?) -> Bool {
    guard configPresent, let executable else { return false }
    return executable.hasPrefix("/")
}

/// `teamclaude server`를 셸 백그라운드로 띄우고 셸은 바로 끝난다. 서버는 launchd 아래로 넘어가 앱이 꺼져도 남는다.
/// 인자는 `$0`·`$1`로 넘겨 셸 문자열에 경로를 끼워 넣지 않는다.
func teamClaudeDetachedStartArguments(executable: String, logPath: String) -> (executable: String, arguments: [String]) {
    ("/bin/sh", ["-c", "nohup \"$0\" server >>\"$1\" 2>&1 </dev/null &", executable, logPath])
}
