import Foundation

// 외부 CLI(agy·higgsfield·npx·teamclaude·teamcodex·claude·grok) 공용 탐색기.
// 메뉴바 앱은 launchd·Finder에서 떠서 셸 PATH를 상속하지 않는다. 그래서 위치를 직접 찾는다.
//
// 순서:
//  1. 환경변수 재정의(CC_MENUBAR_<TOOL>_BIN). 값이 틀려도 다른 후보로 넘어가지 않는다.
//  2. 기존 탐색 함수가 쓰던 후보(순서 그대로). 내부 설치가 이 단계에서 끝나므로 결과가 바뀌지 않는다.
//  3. 로그인 셸 `command -v`(2초 제한, 프로세스 수명 동안 캐시). 기존 후보가 하나도 없을 때만 띄운다.
//     launchd 환경에서 셸 초기화가 멈춘 적이 있어(resolveNpx 주석 참고) 앞 단계로 올리지 않는다.
//  4. 공통 설치 위치: Homebrew → npm 전역 prefix → fnm·nvm·Volta 기본 별칭 → ~/.local/bin.

struct ToolSpec {
    /// 실행 파일 이름. 로그인 셸에 넘기므로 toolLocatorSafeName을 통과해야 한다.
    let name: String
    /// 사용자가 경로를 직접 지정하는 환경변수.
    let envKey: String
    /// 기존 탐색 함수가 쓰던 후보. 순서가 곧 우선순위다.
    let preferred: [String]
}

enum ToolSource: String, Equatable {
    case environment
    case existingCandidate
    case loginShell
    case commonLocation

    var label: String {
        switch self {
        case .environment: return "환경변수"
        case .existingCandidate: return "기존 후보"
        case .loginShell: return "로그인 셸"
        case .commonLocation: return "공통 위치"
        }
    }
}

enum ToolResolution: Equatable {
    case found(path: String, source: ToolSource)
    /// 환경변수로 지정한 경로가 실행 파일이 아니다.
    case overrideInvalid(path: String)
    case missing

    var path: String? {
        if case .found(let path, _) = self { return path }
        return nil
    }
}

/// 셸 명령줄에 넣어도 되는 이름인가(영문·숫자·`-`·`_`·`.`).
func toolLocatorSafeName(_ name: String) -> Bool {
    guard !name.isEmpty, name.count <= 64 else { return false }
    return name.unicodeScalars.allSatisfy { scalar in
        CharacterSet.alphanumerics.contains(scalar) && scalar.isASCII
            || scalar == "-" || scalar == "_" || scalar == "."
    }
}

func toolLocatorLogLine(_ name: String, _ resolution: ToolResolution) -> String {
    switch resolution {
    case .found(let path, let source): return "TOOL \(name)=\(path) (\(source.label))"
    case .overrideInvalid(let path): return "TOOL \(name)=재정의 경로 없음 \(path)"
    case .missing: return "TOOL \(name)=\(StatusVocabulary.notInstalled)"
    }
}

/// `/bin/zsh -lc 'command -v <name>'`. 시간 제한을 넘기면 셸을 끝내고 nil.
/// 절대 경로가 아닌 답(alias·함수)은 버린다.
func loginShellCommandPath(_ name: String, timeout: TimeInterval) -> String? {
    guard toolLocatorSafeName(name), FileManager.default.isExecutableFile(atPath: "/bin/zsh") else { return nil }
    guard let run = runInOwnProcessGroup(["/bin/zsh", "-lc", "command -v \(name)"], timeout: timeout,
                                         drainGrace: 0.2, killGrace: 0.3),
          run.exitStatus == 0 else { return nil }
    let line = String(decoding: run.output, as: UTF8.self)
        .split(separator: "\n").first.map(String.init)?
        .trimmingCharacters(in: .whitespaces) ?? ""
    return line.hasPrefix("/") ? line : nil
}

struct ProcessGroupRun {
    /// 셸의 종료 코드. 신호로 죽었으면(시간 초과 포함) 128+신호 번호.
    let exitStatus: Int32
    let output: Data
}

/// 명령을 자기 프로세스 그룹(그룹 id = 자식 pid)에서 띄우고 stdout을 모은다.
/// 셸 설정(.zprofile 등)이 띄운 자식은 같은 그룹에 든다. 시간 제한을 넘기거나, 셸은 끝났는데
/// 남은 자식이 stdout 파이프를 drainGrace 넘게 쥐고 있으면 그룹 전체에 TERM, killGrace 뒤 KILL을 보낸다.
/// 셸 pid는 그룹 신호를 다 보낼 때까지 회수하지 않는다 — 그동안 그룹 id가 재사용될 수 없다.
/// 읽기와 대기를 이 스레드 한 곳에서 하고 파이프는 직접 닫는다(떠도는 읽기 스레드·FD가 남지 않는다).
func runInOwnProcessGroup(_ argv: [String], timeout: TimeInterval,
                          drainGrace: TimeInterval, killGrace: TimeInterval) -> ProcessGroupRun? {
    guard let executable = argv.first else { return nil }
    var fds: [Int32] = [-1, -1]
    guard pipe(&fds) == 0 else { return nil }
    let readFD = fds[0], writeFD = fds[1]
    defer { close(readFD) }

    var actions: posix_spawn_file_actions_t?
    guard posix_spawn_file_actions_init(&actions) == 0 else { close(writeFD); return nil }
    defer { posix_spawn_file_actions_destroy(&actions) }
    var attributes: posix_spawnattr_t?
    guard posix_spawnattr_init(&attributes) == 0 else { close(writeFD); return nil }
    defer { posix_spawnattr_destroy(&attributes) }
    guard posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) == 0,
          posix_spawn_file_actions_adddup2(&actions, writeFD, STDOUT_FILENO) == 0,
          posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) == 0,
          posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT)) == 0,
          posix_spawnattr_setpgroup(&attributes, 0) == 0 else {
        close(writeFD)
        return nil
    }

    var pid: pid_t = 0
    let environment = ProcessInfo.processInfo.environment.map { "\($0.key)=\($0.value)" }
    let cArgs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) } + [nil]
    let cEnv: [UnsafeMutablePointer<CChar>?] = environment.map { strdup($0) } + [nil]
    defer {
        cArgs.forEach { free($0) }
        cEnv.forEach { free($0) }
    }
    let spawned = posix_spawn(&pid, executable, &actions, &attributes, cArgs, cEnv)
    close(writeFD)
    guard spawned == 0, pid > 0 else { return nil }

    _ = fcntl(readFD, F_SETFL, fcntl(readFD, F_GETFL) | O_NONBLOCK)
    let outputLimit = 64 * 1024
    var output = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    var reachedEOF = false
    /// 읽을 수 있는 만큼 읽는다. EOF면 true.
    func drain() -> Bool {
        while true {
            let count = read(readFD, &buffer, buffer.count)
            if count > 0 {
                if output.count < outputLimit { output.append(contentsOf: buffer[0..<min(count, outputLimit - output.count)]) }
                continue
            }
            if count == 0 { return true }
            return errno != EAGAIN && errno != EINTR
        }
    }
    func leaderExited() -> Bool {
        var info = siginfo_t()
        let result = waitid(P_PID, id_t(pid), &info, WEXITED | WNOHANG | WNOWAIT)
        return result == 0 && info.si_pid == pid
    }

    let deadline = Date().addingTimeInterval(max(timeout, 0))
    var exitedAt: Date?
    while Date() < deadline {
        if !reachedEOF {
            var poller = pollfd(fd: readFD, events: Int16(POLLIN), revents: 0)
            _ = poll(&poller, 1, 20)
            reachedEOF = drain()
        } else {
            usleep(10_000)
        }
        if exitedAt == nil, leaderExited() { exitedAt = Date() }
        if let exitedAt {
            if reachedEOF { break }
            if Date().timeIntervalSince(exitedAt) >= drainGrace { break }
        }
    }

    // 셸이 끝나고 파이프도 닫혔으면 그룹을 건드리지 않는다. 아니면 그룹 전체를 끝낸다.
    if !(exitedAt != nil && reachedEOF) {
        _ = killpg(pid, SIGTERM)
        let graceEnd = Date().addingTimeInterval(max(killGrace, 0))
        while Date() < graceEnd {
            if !reachedEOF { reachedEOF = drain() }
            usleep(20_000)
        }
        _ = killpg(pid, SIGKILL)
    }
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1, errno == EINTR {}
    let signal = status & 0x7f
    let exitStatus = signal == 0 ? (status >> 8) & 0xff : 128 + signal
    return ProcessGroupRun(exitStatus: exitStatus, output: output)
}

final class ToolLocator {
    static let shared = ToolLocator()

    private let environment: [String: String]
    private let home: String
    private let isExecutable: (String) -> Bool
    private let readFile: (String) -> String?
    private let listDirectory: (String) -> [String]
    private let shellLookup: (String) -> String?
    private let lock = NSLock()
    private var shellCache: [String: String?] = [:]

    init(environment: [String: String] = ProcessInfo.processInfo.environment,
         home: String = NSHomeDirectory(),
         isExecutable: @escaping (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
         readFile: @escaping (String) -> String? = { try? String(contentsOfFile: $0, encoding: .utf8) },
         listDirectory: @escaping (String) -> [String] = {
             (try? FileManager.default.contentsOfDirectory(atPath: $0)) ?? []
         },
         shellLookup: @escaping (String) -> String? = { loginShellCommandPath($0, timeout: 2) }) {
        self.environment = environment
        self.home = home
        self.isExecutable = isExecutable
        self.readFile = readFile
        self.listDirectory = listDirectory
        self.shellLookup = shellLookup
    }

    func resolve(_ spec: ToolSpec) -> ToolResolution {
        if let override = environment[spec.envKey], !override.isEmpty {
            return isExecutable(override) ? .found(path: override, source: .environment) : .overrideInvalid(path: override)
        }
        for path in dedupe(spec.preferred) where isExecutable(path) {
            return .found(path: path, source: .existingCandidate)
        }
        if let path = cachedShellLookup(spec.name), isExecutable(path) {
            return .found(path: path, source: .loginShell)
        }
        let preferred = Set(spec.preferred)
        for path in commonCandidates(for: spec.name) where !preferred.contains(path) && isExecutable(path) {
            return .found(path: path, source: .commonLocation)
        }
        return .missing
    }

    /// 기존 후보 + 공통 위치(로그인 셸 제외). 중복 없이 탐색 순서대로.
    func searchOrder(for spec: ToolSpec) -> [String] {
        dedupe(spec.preferred + commonCandidates(for: spec.name))
    }

    func commonCandidates(for name: String) -> [String] {
        var dirs = ["/opt/homebrew/bin", "/usr/local/bin"]
        dirs.append(contentsOf: npmPrefixBins())
        dirs.append("\(home)/.local/share/fnm/aliases/default/bin")
        dirs.append("\(home)/Library/Application Support/fnm/aliases/default/bin")
        if let nvm = nvmDefaultBin() { dirs.append(nvm) }
        dirs.append("\(home)/.volta/bin")
        dirs.append("\(home)/.local/bin")
        return dedupe(dirs.map { "\($0)/\(name)" })
    }

    private func cachedShellLookup(_ name: String) -> String? {
        lock.lock()
        if let cached = shellCache[name] {
            lock.unlock()
            return cached
        }
        lock.unlock()
        let found = toolLocatorSafeName(name) ? shellLookup(name) : nil
        lock.lock()
        shellCache[name] = .some(found)
        lock.unlock()
        return found
    }

    /// npm 전역 설치 위치. NPM_CONFIG_PREFIX → ~/.npmrc의 prefix= → 흔한 사용자 prefix(~/.npm-global).
    private func npmPrefixBins() -> [String] {
        var prefixes: [String] = []
        if let env = environment["NPM_CONFIG_PREFIX"] ?? environment["npm_config_prefix"], !env.isEmpty {
            prefixes.append(env)
        }
        if let npmrc = readFile("\(home)/.npmrc") {
            for raw in npmrc.split(separator: "\n") {
                let line = raw.trimmingCharacters(in: .whitespaces)
                guard line.hasPrefix("prefix") else { continue }
                let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                guard parts.count == 2, parts[0] == "prefix", !parts[1].isEmpty else { continue }
                let value = parts[1].hasPrefix("~/") ? home + String(parts[1].dropFirst()) : parts[1]
                prefixes.append(value)
            }
        }
        prefixes.append("\(home)/.npm-global")
        return prefixes.filter { $0.hasPrefix("/") }.map { "\($0)/bin" }
    }

    /// nvm 기본 별칭(~/.nvm/alias/default)이 가리키는 버전의 bin. "20"처럼 앞자리만 적혀 있으면
    /// 그 앞자리로 시작하는 설치본 중 가장 높은 버전을 쓴다.
    private func nvmDefaultBin() -> String? {
        guard let raw = readFile("\(home)/.nvm/alias/default")?
            .trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        let wanted = raw.hasPrefix("v") ? raw : "v" + raw
        let root = "\(home)/.nvm/versions/node"
        let installed = listDirectory(root)
        if installed.contains(wanted) { return "\(root)/\(wanted)/bin" }
        let matching = installed.filter { $0 == wanted || $0.hasPrefix(wanted + ".") }
        guard let best = matching.max(by: { toolLocatorVersionLess($0, $1) }) else { return nil }
        return "\(root)/\(best)/bin"
    }

    private func dedupe(_ paths: [String]) -> [String] {
        var seen = Set<String>()
        return paths.filter { seen.insert($0).inserted }
    }
}

/// 설정·상태 파일에 포트가 없을 때 쓰는 기본 포트. 환경변수로 바꿀 수 있다(다른 포트로 띄운 프록시, 격리 테스트).
func menubarDefaultPort(envKey: String, fallback: Int,
                        environment: [String: String] = ProcessInfo.processInfo.environment) -> Int {
    guard let raw = environment[envKey], let port = Int(raw), port > 0, port < 65_536 else { return fallback }
    return port
}

/// "v20.9.0" < "v20.11.1" 같은 숫자 단위 비교.
func toolLocatorVersionLess(_ lhs: String, _ rhs: String) -> Bool {
    func parts(_ value: String) -> [Int] {
        value.trimmingCharacters(in: CharacterSet(charactersIn: "v"))
            .split(separator: ".").map { Int($0) ?? 0 }
    }
    let a = parts(lhs), b = parts(rhs)
    for index in 0..<max(a.count, b.count) {
        let x = index < a.count ? a[index] : 0
        let y = index < b.count ? b[index] : 0
        if x != y { return x < y }
    }
    return false
}
