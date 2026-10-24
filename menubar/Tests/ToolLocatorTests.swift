// menubar/Tests/ToolLocatorTests.swift
import Foundation

// 외부 CLI 탐색 순서(R2) 회귀 검사.
// 환경변수 재정의 → 기존 후보(내부 설치와 같은 결과) → 로그인 셸 → 공통 설치 위치.
@main
struct ToolLocatorTests {
    static func main() {
        let home = "/h"
        func locator(env: [String: String] = [:], executables: Set<String>,
                     shell: [String: String] = [:], shellCalls: Counter = Counter()) -> ToolLocator {
            ToolLocator(environment: env, home: home,
                        isExecutable: { executables.contains($0) },
                        readFile: { path in
                            if path == "/h/.npmrc" { return "registry=x\nprefix=/h/.npm-custom\n" }
                            if path == "/h/.nvm/alias/default" { return "20\n" }
                            return nil
                        },
                        listDirectory: { path in
                            path == "/h/.nvm/versions/node" ? ["v18.20.0", "v20.11.1", "v20.9.0"] : []
                        },
                        shellLookup: { name in shellCalls.value += 1; return shell[name] })
        }
        let spec = ToolSpec(name: "agy", envKey: "CC_MENUBAR_AGY_BIN",
                            preferred: ["/h/bin/agy", "/opt/homebrew/bin/agy"])

        // MARK: 환경변수 재정의가 최우선이다
        let envHit = locator(env: ["CC_MENUBAR_AGY_BIN": "/custom/agy"],
                             executables: ["/custom/agy", "/h/bin/agy"])
        precondition(envHit.resolve(spec) == .found(path: "/custom/agy", source: .environment))
        // 재정의가 틀렸으면 다른 후보로 조용히 넘어가지 않는다(사용자가 고친 경로가 무시되면 안 된다).
        let envBad = locator(env: ["CC_MENUBAR_AGY_BIN": "/missing/agy"], executables: ["/h/bin/agy"])
        precondition(envBad.resolve(spec) == .overrideInvalid(path: "/missing/agy"))
        precondition(envBad.resolve(spec).path == nil)
        // 빈 값은 재정의가 아니다.
        let envEmpty = locator(env: ["CC_MENUBAR_AGY_BIN": ""], executables: ["/h/bin/agy"])
        precondition(envEmpty.resolve(spec) == .found(path: "/h/bin/agy", source: .existingCandidate))

        // MARK: 기존 후보는 순서 그대로, 로그인 셸보다 먼저(내부 설치 결과가 바뀌지 않는다)
        let calls = Counter()
        let both = locator(executables: ["/h/bin/agy", "/opt/homebrew/bin/agy"],
                           shell: ["agy": "/elsewhere/agy"], shellCalls: calls)
        precondition(both.resolve(spec) == .found(path: "/h/bin/agy", source: .existingCandidate))
        precondition(calls.value == 0, "기존 후보가 있으면 로그인 셸을 띄우지 않는다")
        let second = locator(executables: ["/opt/homebrew/bin/agy"])
        precondition(second.resolve(spec) == .found(path: "/opt/homebrew/bin/agy", source: .existingCandidate))

        // MARK: 로그인 셸 → 결과는 프로세스 수명 동안 캐시한다(없음도 캐시)
        let shellCalls = Counter()
        let viaShell = locator(executables: ["/elsewhere/agy"], shell: ["agy": "/elsewhere/agy"], shellCalls: shellCalls)
        precondition(viaShell.resolve(spec) == .found(path: "/elsewhere/agy", source: .loginShell))
        _ = viaShell.resolve(spec)
        precondition(shellCalls.value == 1, "로그인 셸 조회는 한 번만: \(shellCalls.value)")
        let missCalls = Counter()
        let miss = locator(executables: [], shellCalls: missCalls)
        precondition(miss.resolve(spec) == .missing)
        precondition(miss.resolve(spec) == .missing)
        precondition(missCalls.value == 1, "없음도 캐시: \(missCalls.value)")
        // 셸이 실행 파일이 아닌 값(alias·함수 이름)을 주면 버린다.
        let alias = locator(executables: [], shell: ["agy": "agy: aliased to foo"])
        precondition(alias.resolve(spec) == .missing)

        // MARK: 공통 위치 — Homebrew → npm prefix → fnm·nvm·Volta → ~/.local/bin
        let bare = ToolSpec(name: "tool", envKey: "CC_MENUBAR_TOOL_BIN", preferred: [])
        let common = locator(executables: []).commonCandidates(for: "tool")
        let expected = [
            "/opt/homebrew/bin/tool",
            "/usr/local/bin/tool",
            "/h/.npm-custom/bin/tool",
            "/h/.npm-global/bin/tool",
            "/h/.local/share/fnm/aliases/default/bin/tool",
            "/h/Library/Application Support/fnm/aliases/default/bin/tool",
            "/h/.nvm/versions/node/v20.11.1/bin/tool",
            "/h/.volta/bin/tool",
            "/h/.local/bin/tool",
        ]
        precondition(common == expected, "\(common)")
        for (index, path) in expected.enumerated() {
            // 앞 후보가 없을 때 그 위치에서 찾는다.
            let only = locator(executables: [path])
            precondition(only.resolve(bare) == .found(path: path, source: .commonLocation), "\(index) \(path)")
        }
        // nvm 기본 별칭이 정확한 버전이면 그 버전을 쓴다.
        let exact = ToolLocator(environment: [:], home: home, isExecutable: { _ in false },
                                readFile: { $0 == "/h/.nvm/alias/default" ? "v18.20.0" : nil },
                                listDirectory: { _ in ["v18.20.0", "v20.11.1"] },
                                shellLookup: { _ in nil })
        precondition(exact.commonCandidates(for: "tool").contains("/h/.nvm/versions/node/v18.20.0/bin/tool"))
        // 중복 경로는 한 번만 본다.
        let dup = ToolSpec(name: "tool", envKey: "X", preferred: ["/opt/homebrew/bin/tool"])
        let dupLocator = locator(executables: [])
        precondition(dupLocator.searchOrder(for: dup).filter { $0 == "/opt/homebrew/bin/tool" }.count == 1)

        // MARK: 이름 검증 — 셸에 넘기는 값이라 안전한 문자만
        precondition(toolLocatorSafeName("ccusage"))
        precondition(toolLocatorSafeName("team-codex_2.x"))
        precondition(!toolLocatorSafeName("a;rm -rf /"))
        precondition(!toolLocatorSafeName(""))
        precondition(!toolLocatorSafeName("$(x)"))

        // MARK: 시작 로그 한 줄
        precondition(toolLocatorLogLine("agy", .found(path: "/h/bin/agy", source: .existingCandidate))
            == "TOOL agy=/h/bin/agy (기존 후보)")
        precondition(toolLocatorLogLine("grok", .missing) == "TOOL grok=미설치")
        precondition(toolLocatorLogLine("npx", .overrideInvalid(path: "/x")) == "TOOL npx=재정의 경로 없음 /x")

        // MARK: 실제 로그인 셸 조회는 시간 제한 안에 끝난다
        let started = Date()
        _ = loginShellCommandPath("definitely-not-a-real-tool-cc-menubar", timeout: 2)
        precondition(Date().timeIntervalSince(started) < 4.5, "로그인 셸 조회가 시간 제한을 넘겼다")
        precondition(loginShellCommandPath("bad;name", timeout: 2) == nil)
        loginShellProcessGroupChecks()

        // MARK: 기본 포트 재정의
        precondition(menubarDefaultPort(envKey: "P", fallback: 3456, environment: [:]) == 3456)
        precondition(menubarDefaultPort(envKey: "P", fallback: 3456, environment: ["P": "4100"]) == 4100)
        precondition(menubarDefaultPort(envKey: "P", fallback: 3456, environment: ["P": "0"]) == 3456)
        precondition(menubarDefaultPort(envKey: "P", fallback: 3456, environment: ["P": "x"]) == 3456)

        print("ToolLocatorTests: ok")
    }
}

// MARK: - 실제 로그인 셸 경로(loginShellCommandPath)의 프로세스 그룹 정리
// shellLookup 스텁이 아니라 진짜 /bin/zsh -lc를 띄운다. ZDOTDIR을 임시 폴더로 돌려 사용자 셸 설정 대신
// 통제된 .zshenv를 읽힌다. .zshenv가 TERM을 무시하는 자식을 띄우면, 시간 제한 안에 돌아오고 그 자식도 사라져야 한다.
extension ToolLocatorTests {
    static func openFileDescriptorCount() -> Int {
        (try? FileManager.default.contentsOfDirectory(atPath: "/dev/fd").count) ?? -1
    }

    static func processExists(_ pid: pid_t) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }

    /// 자식이 죽은 뒤 launchd가 회수하기까지 잠깐 걸린다. 그 사이만 기다린다.
    static func waitGone(_ pid: pid_t, within seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if !processExists(pid) { return true }
            usleep(20_000)
        }
        return !processExists(pid)
    }

    static func readPid(_ path: String, within seconds: TimeInterval) -> pid_t? {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let text = try? String(contentsOfFile: path, encoding: .utf8),
               let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 {
                return pid
            }
            usleep(20_000)
        }
        return nil
    }

    static func withShellEnvironment(_ zdotdir: String, path: String, _ body: () -> Void) {
        let savedZdotdir = ProcessInfo.processInfo.environment["ZDOTDIR"]
        let savedPath = ProcessInfo.processInfo.environment["PATH"]
        setenv("ZDOTDIR", zdotdir, 1)
        setenv("PATH", path, 1)
        body()
        if let savedZdotdir { setenv("ZDOTDIR", savedZdotdir, 1) } else { unsetenv("ZDOTDIR") }
        if let savedPath { setenv("PATH", savedPath, 1) } else { unsetenv("PATH") }
    }

    static func loginShellProcessGroupChecks() {
        let fm = FileManager.default
        let root = NSTemporaryDirectory() + "cc-menubar-login-shell-\(getpid())-\(UUID().uuidString)"
        try! fm.createDirectory(atPath: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(atPath: root) }
        // TERM을 무시하고 stdout 파이프를 쥔 채 30초 자는 자식. pid를 파일로 남긴다.
        func stubbornChild(_ pidFile: String) -> String {
            "/bin/sh -c 'trap \"\" TERM; echo $$ > \"\(pidFile)\"; exec /bin/sleep 30' &\n"
        }

        // (가) 셸 자체가 TERM을 무시하고 멈춘다 → 시간 제한에 걸린다. 그룹 전체가 KILL로 정리돼야 한다.
        let hung = root + "/hung"
        try! fm.createDirectory(atPath: hung, withIntermediateDirectories: true)
        try! ("trap '' TERM\n" + stubbornChild(hung + "/child.pid") + "/bin/sleep 30\n")
            .write(toFile: hung + "/.zshenv", atomically: true, encoding: .utf8)
        let fdsBefore = openFileDescriptorCount()
        withShellEnvironment(hung, path: "/usr/bin:/bin") {
            let started = Date()
            let result = loginShellCommandPath("cc-menubar-fake-tool", timeout: 0.5)
            let elapsed = Date().timeIntervalSince(started)
            precondition(result == nil, "멈춘 셸은 결과가 없어야 한다: \(result ?? "nil")")
            precondition(elapsed < 1.6, "시간 제한(0.5초) 뒤 정리까지 너무 오래 걸렸다: \(elapsed)")
        }
        guard let hungChild = readPid(hung + "/child.pid", within: 1) else {
            preconditionFailure("셸 설정의 자식 pid 파일이 없다(ZDOTDIR이 안 먹었다)")
        }
        precondition(waitGone(hungChild, within: 1.5), "시간 제한 뒤 TERM을 무시하는 자식이 남았다 pid=\(hungChild)")
        let fdsAfterHung = openFileDescriptorCount()
        precondition(fdsAfterHung == fdsBefore, "파이프 FD가 샜다: \(fdsBefore) → \(fdsAfterHung)")

        // (나) 셸은 정상 종료하지만 뒤에 남은 자식이 stdout 파이프를 쥐고 있다. 답은 돌려주고 자식은 정리한다.
        let held = root + "/held"
        try! fm.createDirectory(atPath: held + "/bin", withIntermediateDirectories: true)
        let tool = held + "/bin/cc-menubar-fake-tool"
        try! "#!/bin/sh\nexit 0\n".write(toFile: tool, atomically: true, encoding: .utf8)
        chmod(tool, 0o755)
        try! stubbornChild(held + "/child.pid").write(toFile: held + "/.zshenv", atomically: true, encoding: .utf8)
        withShellEnvironment(held, path: held + "/bin:/usr/bin:/bin") {
            let started = Date()
            let result = loginShellCommandPath("cc-menubar-fake-tool", timeout: 2)
            let elapsed = Date().timeIntervalSince(started)
            precondition(result == tool, "파이프를 쥔 자식이 있어도 셸의 답은 돌려줘야 한다: \(result ?? "nil")")
            precondition(elapsed < 1.5, "셸이 끝났는데 시간 제한까지 기다렸다: \(elapsed)")
        }
        guard let heldChild = readPid(held + "/child.pid", within: 1) else {
            preconditionFailure("(나) 자식 pid 파일이 없다")
        }
        precondition(waitGone(heldChild, within: 1.5), "파이프를 쥔 자식이 남았다 pid=\(heldChild)")
        let fdsAfterHeld = openFileDescriptorCount()
        precondition(fdsAfterHeld == fdsBefore, "파이프 FD가 샜다: \(fdsBefore) → \(fdsAfterHeld)")
    }
}

final class Counter {
    var value = 0
}
