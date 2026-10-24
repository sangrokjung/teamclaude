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
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-lc", "command -v \(name)"]
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    let done = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in done.signal() }
    do {
        try process.run()
    } catch {
        return nil
    }
    var collected = Data()
    let reader = DispatchGroup()
    reader.enter()
    DispatchQueue.global(qos: .utility).async {
        collected = output.fileHandleForReading.readDataToEndOfFile()
        reader.leave()
    }
    if done.wait(timeout: .now() + timeout) == .timedOut {
        let pid = process.processIdentifier
        process.terminate()
        if done.wait(timeout: .now() + 0.5) == .timedOut { kill(pid, SIGKILL) }
        _ = reader.wait(timeout: .now() + 0.5)
        return nil
    }
    _ = reader.wait(timeout: .now() + 0.5)
    guard process.terminationStatus == 0 else { return nil }
    let line = String(decoding: collected, as: UTF8.self)
        .split(separator: "\n").first.map(String.init)?
        .trimmingCharacters(in: .whitespaces) ?? ""
    return line.hasPrefix("/") ? line : nil
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
