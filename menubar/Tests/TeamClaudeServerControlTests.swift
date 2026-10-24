import Foundation

// 상태바 앱이 살아 있는 프록시를 죽이지 않게 하는 판정 로직 회귀 검사.
// 재시작(kickstart -k)은 진행 중 요청을 모두 끊는다. 계정 변경은 worker SIGHUP으로,
// 응답 지연은 아무 조치 없이, 실제로 멈춘 서비스만 -k 없는 kickstart로 다룬다.
@main
struct TeamClaudeServerControlTests {
    static func main() {
        // MARK: launchctl print 파싱
        let printed = """
        gui/501/com.qjc.teamclaude = {
        \tactive count = 1
        \tstate = running

        \targuments = {
        \t\t/opt/node
        \t\tserver
        \t}

        \tspawn type = daemon
        \tpid = 30821
        \timmediate reason = inefficient
        \tendpoints = {
        \t\tpid = 999
        \t}
        }
        """
        precondition(parseTeamClaudeLaunchdPrint(output: printed, exitStatus: 0) == .running(pid: 30821))
        let notRunning = """
        gui/501/com.qjc.teamclaude = {
        \tactive count = 0
        \tstate = not running
        \tlast exit code = 1
        }
        """
        precondition(parseTeamClaudeLaunchdPrint(output: notRunning, exitStatus: 0) == .loadedNotRunning)
        // 중첩 블록의 pid는 서비스 pid가 아니다.
        let nestedOnly = "gui/501/com.qjc.teamclaude = {\n\tstate = not running\n\tx = {\n\t\tpid = 77\n\t}\n}\n"
        precondition(parseTeamClaudeLaunchdPrint(output: nestedOnly, exitStatus: 0) == .loadedNotRunning)
        precondition(parseTeamClaudeLaunchdPrint(output: "Could not find service", exitStatus: 113) == .notLoaded)
        precondition(parseTeamClaudeLaunchdPrint(output: "", exitStatus: 1) == .unknown)
        precondition(parseTeamClaudeLaunchdPrint(output: "garbage", exitStatus: 0) == .unknown)
        precondition(parseTeamClaudeLaunchdPrint(output: "x = {\n\tpid = 0\n\tstate = running\n}", exitStatus: 0) == .loadedNotRunning)

        // MARK: 서버 연결 실패 판정 — 프로세스가 살아 있으면 절대 재시작하지 않는다
        // 10/10 23:47 사고: 부하(load 40~50)로 status 응답만 늦었고 프로세스는 살아 있었다.
        precondition(teamClaudeOutageVerdict(launchd: .running(pid: 30821), launchdPidAlive: true, port: .refused)
            == .responseDelayed(pid: 30821))
        precondition(teamClaudeOutageVerdict(launchd: .running(pid: 30821), launchdPidAlive: true, port: .unknown)
            == .responseDelayed(pid: 30821))
        precondition(teamClaudeOutageVerdict(launchd: .running(pid: 30821), launchdPidAlive: true, port: .listening)
            == .responseDelayed(pid: 30821))
        // launchd가 모른다 해도 포트를 누가 잡고 있거나 판별 불가면 건드리지 않는다.
        precondition(teamClaudeOutageVerdict(launchd: .loadedNotRunning, launchdPidAlive: false, port: .listening)
            == .responseDelayed(pid: nil))
        precondition(teamClaudeOutageVerdict(launchd: .loadedNotRunning, launchdPidAlive: false, port: .unknown)
            == .responseDelayed(pid: nil))
        precondition(teamClaudeOutageVerdict(launchd: .unknown, launchdPidAlive: false, port: .listening)
            == .responseDelayed(pid: nil))
        // 프로세스도 없고 포트도 닫혀 있을 때만 멈춘 서비스를 시작한다.
        precondition(teamClaudeOutageVerdict(launchd: .loadedNotRunning, launchdPidAlive: false, port: .refused)
            == .startStoppedService)
        precondition(teamClaudeOutageVerdict(launchd: .running(pid: 30821), launchdPidAlive: false, port: .refused)
            == .startStoppedService)
        precondition(teamClaudeOutageVerdict(launchd: .notLoaded, launchdPidAlive: false, port: .refused)
            == .serviceNotLoaded)
        precondition(teamClaudeOutageVerdict(launchd: .unknown, launchdPidAlive: false, port: .refused)
            == .undetermined)

        // MARK: 동기화 계획 — 재시작 계획은 존재하지 않는다
        precondition(teamClaudeSyncPlan(serverReachable: true, accountConfigDrift: 0) == .nothing)
        precondition(teamClaudeSyncPlan(serverReachable: true, accountConfigDrift: 3) == .reloadAccounts)
        precondition(teamClaudeSyncPlan(serverReachable: false, accountConfigDrift: 0) == .checkLiveness)
        precondition(teamClaudeSyncPlan(serverReachable: false, accountConfigDrift: 2) == .checkLiveness)

        // MARK: sysctl 기반 프로세스 식별(ps 서브프로세스 없이 프록시 기록과 같은 형식으로)
        let seoul = TimeZone(identifier: "Asia/Seoul")!
        // 2026-10-10T20:00:46Z = 서울 2026-10-11 05:00:46 (일요일)
        precondition(teamClaudeLstartString(epochSeconds: 1_791_662_446, timeZone: seoul) == "Sun Oct 11 05:00:46 2026")
        // 한 자리 날짜는 ps lstart(%c, %e)처럼 공백으로 채운다.
        precondition(teamClaudeLstartString(epochSeconds: 1_791_158_400, timeZone: TimeZone(identifier: "UTC")!)
            == "Mon Oct  5 00:00:00 2026")
        var procArgs: [UInt8] = []
        var argc = Int32(3).littleEndian
        withUnsafeBytes(of: &argc) { procArgs.append(contentsOf: $0) }
        procArgs.append(contentsOf: Array("/opt/node".utf8) + [0, 0, 0, 0])
        for arg in ["/opt/node", "/opt/pkg/src/teamclaude.js", "server"] {
            procArgs.append(contentsOf: Array(arg.utf8) + [0])
        }
        procArgs.append(contentsOf: Array("PATH=/usr/bin".utf8) + [0])
        precondition(parseTeamClaudeProcArgs(procArgs) == ["/opt/node", "/opt/pkg/src/teamclaude.js", "server"])
        precondition(parseTeamClaudeProcArgs([1, 0]) == nil)
        var tooMany = Int32(5).littleEndian
        var truncated: [UInt8] = []
        withUnsafeBytes(of: &tooMany) { truncated.append(contentsOf: $0) }
        truncated.append(contentsOf: Array("/opt/node".utf8) + [0] + Array("a".utf8) + [0])
        precondition(parseTeamClaudeProcArgs(truncated) == nil)

        // MARK: 상태 파일 파싱
        let command = "/opt/node /opt/pkg/src/teamclaude.js server"
        let stateJSON: [String: Any] = [
            "pid": 30821,
            "workerPid": 30823,
            "port": 3456,
            "config": "/home/u/.config/teamclaude.json",
            "lifecycle": [
                "version": 1,
                "worker": [
                    "pid": 30823,
                    "ppid": 30821,
                    "startedAt": "Sun Oct 11 05:00:46 2026",
                    "command": command,
                ],
            ],
        ]
        guard let state = parseTeamClaudeServerState(stateJSON) else {
            preconditionFailure("state parse")
        }
        precondition(state.supervisorPid == 30821)
        precondition(state.workerPid == 30823)
        precondition(state.configPath == "/home/u/.config/teamclaude.json")
        precondition(state.recordedWorker?.startedAt == "Sun Oct 11 05:00:46 2026")
        precondition(parseTeamClaudeServerState(nil) == nil)

        // MARK: worker SIGHUP 대상 검증 — 실제 teamclaude worker일 때만
        let expectedConfig = "/home/u/.config/teamclaude.json"
        let liveWorker = TeamClaudeProcessIdentity(
            pid: 30823, ppid: 30821, startedAt: "Sun Oct 11 05:00:46 2026", command: command
        )
        precondition(teamClaudeWorkerSignalDecision(
            state: state, expectedConfigPath: expectedConfig,
            launchd: .running(pid: 30821), observedWorker: liveWorker
        ) == .signal(pid: 30823))
        // 상태 파일 없음
        if case .signal = teamClaudeWorkerSignalDecision(
            state: nil, expectedConfigPath: expectedConfig,
            launchd: .running(pid: 30821), observedWorker: liveWorker
        ) { preconditionFailure("no state must refuse") }
        // 다른 설정(TeamCodex 3457 등)의 서버에는 보내지 않는다
        if case .signal = teamClaudeWorkerSignalDecision(
            state: state, expectedConfigPath: "/home/u/.config/teamcodex.json",
            launchd: .running(pid: 30821), observedWorker: liveWorker
        ) { preconditionFailure("config mismatch must refuse") }
        // launchd 서비스 pid와 상태 파일 supervisor가 다르면 거부
        if case .signal = teamClaudeWorkerSignalDecision(
            state: state, expectedConfigPath: expectedConfig,
            launchd: .running(pid: 4444), observedWorker: liveWorker
        ) { preconditionFailure("launchd pid mismatch must refuse") }
        if case .signal = teamClaudeWorkerSignalDecision(
            state: state, expectedConfigPath: expectedConfig,
            launchd: .unknown, observedWorker: liveWorker
        ) { preconditionFailure("unknown launchd must refuse") }
        // pid 재사용: 시작 시각이나 명령이 기록과 다르면 거부
        if case .signal = teamClaudeWorkerSignalDecision(
            state: state, expectedConfigPath: expectedConfig,
            launchd: .running(pid: 30821),
            observedWorker: TeamClaudeProcessIdentity(pid: 30823, ppid: 30821, startedAt: "Mon Oct 12 01:00:00 2026", command: command)
        ) { preconditionFailure("restarted pid must refuse") }
        if case .signal = teamClaudeWorkerSignalDecision(
            state: state, expectedConfigPath: expectedConfig,
            launchd: .running(pid: 30821),
            observedWorker: TeamClaudeProcessIdentity(pid: 30823, ppid: 30821, startedAt: "Sun Oct 11 05:00:46 2026", command: "/usr/bin/vim notes")
        ) { preconditionFailure("foreign command must refuse") }
        // 부모가 supervisor가 아니면 거부
        if case .signal = teamClaudeWorkerSignalDecision(
            state: state, expectedConfigPath: expectedConfig,
            launchd: .running(pid: 30821),
            observedWorker: TeamClaudeProcessIdentity(pid: 30823, ppid: 1, startedAt: "Sun Oct 11 05:00:46 2026", command: command)
        ) { preconditionFailure("orphan worker must refuse") }
        if case .signal = teamClaudeWorkerSignalDecision(
            state: state, expectedConfigPath: expectedConfig,
            launchd: .running(pid: 30821), observedWorker: nil
        ) { preconditionFailure("dead worker must refuse") }
        // 기록 명령이 teamclaude server가 아니면(예: codex server) 거부
        let codexCommand = "/opt/node /opt/pkg/src/teamclaude.js codex server"
        var codexJSON = stateJSON
        codexJSON["lifecycle"] = [
            "version": 1,
            "worker": ["pid": 30823, "ppid": 30821, "startedAt": "Sun Oct 11 05:00:46 2026", "command": codexCommand],
        ]
        if case .signal = teamClaudeWorkerSignalDecision(
            state: parseTeamClaudeServerState(codexJSON), expectedConfigPath: expectedConfig,
            launchd: .running(pid: 30821),
            observedWorker: TeamClaudeProcessIdentity(pid: 30823, ppid: 30821, startedAt: "Sun Oct 11 05:00:46 2026", command: codexCommand)
        ) { preconditionFailure("codex server must refuse") }
        // worker pid가 supervisor pid와 같거나 1 이하이면 거부
        var samePidJSON = stateJSON
        samePidJSON["workerPid"] = 30821
        if case .signal = teamClaudeWorkerSignalDecision(
            state: parseTeamClaudeServerState(samePidJSON), expectedConfigPath: expectedConfig,
            launchd: .running(pid: 30821), observedWorker: liveWorker
        ) { preconditionFailure("supervisor pid must refuse") }
        precondition(teamClaudeIsServerCommand("/opt/node /opt/pkg/src/teamclaude.js server"))
        precondition(teamClaudeIsServerCommand("/opt/node /opt/pkg/src/index.js server"))
        precondition(teamClaudeIsServerCommand("/opt/bin/teamclaude server"))
        precondition(!teamClaudeIsServerCommand("/opt/node /opt/pkg/src/teamclaude.js codex server"))
        precondition(!teamClaudeIsServerCommand("/opt/node /opt/pkg/src/teamclaude.js status"))
        precondition(!teamClaudeIsServerCommand("/opt/node /other/app.js server"))

        // MARK: 수동 재시작 확인 문구 — 끊길 진행 중 요청 수를 보여 준다
        let busy = teamClaudeRestartConfirmation(inflight: 14, serverReachable: true)
        precondition(busy.message.contains("진행 중 요청 14건이 끊깁니다"))
        precondition(busy.confirmTitle == "재시작")
        let idle = teamClaudeRestartConfirmation(inflight: 0, serverReachable: true)
        precondition(idle.message.contains("진행 중 요청은 없습니다"))
        let blind = teamClaudeRestartConfirmation(inflight: 5, serverReachable: false)
        precondition(blind.message.contains("확인하지 못했습니다"))
        precondition(!blind.message.contains("5건"))
        let none = teamClaudeRestartConfirmation(inflight: nil, serverReachable: true)
        precondition(none.message.contains("확인하지 못했습니다"))

        // MARK: 표시 문구
        precondition(teamClaudeServerPillLabel(serverReachable: true, responseDelayed: false) == "실행중")
        precondition(teamClaudeServerPillLabel(serverReachable: true, responseDelayed: true) == "실행중")
        precondition(teamClaudeServerPillLabel(serverReachable: false, responseDelayed: true) == "응답 지연")
        precondition(teamClaudeServerPillLabel(serverReachable: false, responseDelayed: false) == "오프라인")
        precondition(teamClaudeDriftActionDetail(persistsAfterReload: false) == "자동 동기화 중 · 서버 반영 확인")
        precondition(teamClaudeDriftActionDetail(persistsAfterReload: true).contains("재시작하지 않음"))

        // MARK: 설정·상태 파일 경로 (프록시 getConfigPath/getServerStatePath와 같은 규칙)
        precondition(teamClaudeConfigPath(environment: [:], home: "/h") == "/h/.config/teamclaude.json")
        precondition(teamClaudeConfigPath(environment: ["XDG_CONFIG_HOME": "/x"], home: "/h") == "/x/teamclaude.json")
        precondition(teamClaudeConfigPath(environment: ["XDG_CONFIG_HOME": ""], home: "/h") == "/h/.config/teamclaude.json")
        precondition(teamClaudeConfigPath(environment: ["TEAMCLAUDE_CONFIG": "/alt/c.json", "XDG_CONFIG_HOME": "/x"], home: "/h") == "/alt/c.json")
        precondition(teamClaudeServerStatePath(configPath: "/alt/c.json") == "/alt/c.server.json")
        precondition(teamClaudeServerStatePath(configPath: "/h/.config/teamclaude.json") == "/h/.config/teamclaude.server.json")

        precondition(teamClaudeConfigPath(environment: ["TEAMCLAUDE_CONFIG": "./config.json"], home: "/h") == nil)
        precondition(teamClaudeConfigPath(environment: ["TEAMCLAUDE_CONFIG": "config.json"], home: "/h") == nil)
        precondition(teamClaudeConfigPath(environment: ["XDG_CONFIG_HOME": "rel"], home: "/h") == nil)

        // MARK: launchd 라벨 — 환경변수 > UserDefaults > 기본값(R3)
        precondition(teamClaudeDefaultLaunchdLabel == "com.qjc.teamclaude")
        precondition(resolveTeamClaudeLaunchdLabel(environment: [:], defaultsValue: nil) == "com.qjc.teamclaude")
        precondition(resolveTeamClaudeLaunchdLabel(environment: [:], defaultsValue: "dev.me.proxy") == "dev.me.proxy")
        precondition(resolveTeamClaudeLaunchdLabel(
            environment: ["CC_MENUBAR_TEAMCLAUDE_LABEL": "org.x.teamclaude"], defaultsValue: "dev.me.proxy")
            == "org.x.teamclaude")
        // 빈 값·셸·경로 문자가 섞인 값은 무시하고 다음 단계로 넘어간다.
        precondition(resolveTeamClaudeLaunchdLabel(
            environment: ["CC_MENUBAR_TEAMCLAUDE_LABEL": ""], defaultsValue: "dev.me.proxy") == "dev.me.proxy")
        precondition(resolveTeamClaudeLaunchdLabel(
            environment: ["CC_MENUBAR_TEAMCLAUDE_LABEL": "a b;rm"], defaultsValue: nil) == "com.qjc.teamclaude")
        precondition(resolveTeamClaudeLaunchdLabel(environment: [:], defaultsValue: "gui/501/x") == "com.qjc.teamclaude")
        precondition(teamClaudeLaunchdLabelIsValid("com.example.teamclaude-2"))
        precondition(!teamClaudeLaunchdLabelIsValid(String(repeating: "a", count: 300)))

        // MARK: 재시작 버튼 계획(A4) — 라벨이 launchd에 없으면 절대 kickstart(-k)로 가지 않는다
        for port in [TeamClaudePortProbe.listening, .refused, .unknown] {
            precondition(teamClaudeRestartPlan(launchd: .notLoaded, port: port) != .forceRestartConfirmed,
                         "미등록 라벨에서 kickstart 금지: \(port)")
        }
        // 미등록 + 포트 닫힘: 서버를 분리 실행해 시작만 한다.
        precondition(teamClaudeRestartPlan(launchd: .notLoaded, port: .refused) == .startDetached)
        // 미등록인데 포트를 누가 잡고 있거나 판별 불가: 앱이 관리하지 않는 프로세스다. 건드리지 않는다.
        precondition(teamClaudeRestartPlan(launchd: .notLoaded, port: .listening) == .leaveRunning)
        precondition(teamClaudeRestartPlan(launchd: .notLoaded, port: .unknown) == .leaveRunning)
        // 등록된 서비스는 기존처럼 확인 대화상자를 거친 -k 재시작.
        precondition(teamClaudeRestartPlan(launchd: .running(pid: 30821), port: .listening) == .forceRestartConfirmed)
        precondition(teamClaudeRestartPlan(launchd: .loadedNotRunning, port: .refused) == .forceRestartConfirmed)
        // launchd 상태를 못 읽으면 아무것도 하지 않는다.
        for port in [TeamClaudePortProbe.listening, .refused, .unknown] {
            precondition(teamClaudeRestartPlan(launchd: .unknown, port: port) == .undetermined)
        }

        // MARK: 자동 동기화의 분리 실행 — 설정과 실행 파일이 있을 때만(미설치 맥에서 아무것도 띄우지 않는다)
        precondition(teamClaudeDetachedStartAllowed(configPresent: true, executable: "/opt/bin/teamclaude"))
        precondition(!teamClaudeDetachedStartAllowed(configPresent: false, executable: "/opt/bin/teamclaude"))
        precondition(!teamClaudeDetachedStartAllowed(configPresent: true, executable: nil))
        precondition(!teamClaudeDetachedStartAllowed(configPresent: true, executable: "teamclaude"),
                     "PATH 의존 이름만 있으면 띄우지 않는다")

        // 분리 실행 명령은 `server` 하나만 넘기고 재시작 인자를 쓰지 않는다.
        let detached = teamClaudeDetachedStartArguments(executable: "/opt/bin/teamclaude", logPath: "/tmp/l.log")
        precondition(detached.executable == "/bin/sh")
        precondition(detached.arguments.contains("/opt/bin/teamclaude"))
        precondition(detached.arguments[1].contains("server"))
        precondition(!detached.arguments.joined(separator: " ").contains("restart"))
        precondition(!detached.arguments.joined(separator: " ").contains("kickstart"))
        precondition(detached.arguments[1].contains("nohup"))

        print("TeamClaudeServerControlTests: ok")
    }
}
