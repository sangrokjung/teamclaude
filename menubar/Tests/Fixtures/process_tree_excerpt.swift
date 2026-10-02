import Darwin
import Foundation

struct IsolatedProcessResult {
    let terminationStatus: Int32
    let timedOut: Bool
}

private func withOwnedCStringArray<Result>(
    _ values: [String],
    _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Result
) -> Result {
    var pointers: [UnsafeMutablePointer<CChar>?] = values.map { strdup($0) }
    pointers.append(nil)
    defer {
        for case let pointer? in pointers {
            free(pointer)
        }
    }
    return pointers.withUnsafeMutableBufferPointer { buffer in
        body(buffer.baseAddress!)
    }
}

private func decodedWaitStatus(_ status: Int32) -> Int32 {
    let terminatingSignal = status & 0x7f
    if terminatingSignal == 0 {
        return (status >> 8) & 0xff
    }
    return 128 + terminatingSignal
}

private func childHasExitedWithoutReaping(_ pid: pid_t) -> Bool? {
    var info = siginfo_t()
    let result = waitid(
        P_PID,
        UInt32(bitPattern: pid),
        &info,
        WEXITED | WNOHANG | WNOWAIT
    )
    if result == 0 {
        return info.si_pid == pid
    }
    return errno == EINTR ? false : nil
}

private func reapChild(_ pid: pid_t) -> Int32? {
    var status: Int32 = 0
    while true {
        let result = waitpid(pid, &status, 0)
        if result == pid { return decodedWaitStatus(status) }
        if result == -1, errno == EINTR { continue }
        return nil
    }
}

/// `setsid`/`setpgid`로 의도적으로 탈출하지 않는 QJC 고정 CLI만 실행합니다.
func runTrustedProcessInIsolatedGroup(
    _ process: Process,
    timeoutSeconds: Double,
    terminationGraceMicroseconds: useconds_t
) -> IsolatedProcessResult? {
    guard let executableURL = process.executableURL,
          executableURL.isFileURL,
          let standardOutput = process.standardOutput as? FileHandle,
          let standardError = process.standardError as? FileHandle else { return nil }

    var fileActions: posix_spawn_file_actions_t?
    guard posix_spawn_file_actions_init(&fileActions) == 0 else { return nil }
    defer { posix_spawn_file_actions_destroy(&fileActions) }
    guard posix_spawn_file_actions_adddup2(
        &fileActions,
        standardOutput.fileDescriptor,
        STDOUT_FILENO
    ) == 0,
    posix_spawn_file_actions_adddup2(
        &fileActions,
        standardError.fileDescriptor,
        STDERR_FILENO
    ) == 0 else { return nil }

    var attributes: posix_spawnattr_t?
    guard posix_spawnattr_init(&attributes) == 0 else { return nil }
    defer { posix_spawnattr_destroy(&attributes) }
    let spawnFlags = Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT)
    guard posix_spawnattr_setflags(&attributes, spawnFlags) == 0,
          posix_spawnattr_setpgroup(&attributes, 0) == 0 else { return nil }

    let executable = executableURL.path
    let arguments = [executable] + (process.arguments ?? [])
    let environment = (process.environment ?? ProcessInfo.processInfo.environment)
        .sorted { $0.key < $1.key }
        .map { "\($0.key)=\($0.value)" }
    var childPid: pid_t = 0
    let spawnResult = executable.withCString { executablePointer in
        withOwnedCStringArray(arguments) { argumentPointers in
            withOwnedCStringArray(environment) { environmentPointers in
                posix_spawn(
                    &childPid,
                    executablePointer,
                    &fileActions,
                    &attributes,
                    argumentPointers,
                    environmentPointers
                )
            }
        }
    }
    guard spawnResult == 0, childPid > 0 else { return nil }

    let timeoutNanoseconds = UInt64(max(timeoutSeconds, 0) * 1_000_000_000)
    let startedAt = DispatchTime.now().uptimeNanoseconds
    while DispatchTime.now().uptimeNanoseconds - startedAt < timeoutNanoseconds {
        guard let hasExited = childHasExitedWithoutReaping(childPid) else {
            _ = Darwin.killpg(childPid, SIGKILL)
            return reapChild(childPid).map {
                IsolatedProcessResult(terminationStatus: $0, timedOut: false)
            }
        }
        if hasExited {
            return reapChild(childPid).map {
                IsolatedProcessResult(terminationStatus: $0, timedOut: false)
            }
        }
        usleep(50_000)
    }

    // childPid는 직접 자식이며 여기까지 waitpid로 회수하지 않았습니다. 따라서
    // process group ID가 재사용되기 전에 TERM/KILL을 같은 그룹에 안전하게 보낼 수 있습니다.
    _ = Darwin.killpg(childPid, SIGTERM)
    if terminationGraceMicroseconds > 0 {
        usleep(terminationGraceMicroseconds)
    }
    _ = Darwin.killpg(childPid, SIGKILL)
    return reapChild(childPid).map {
        IsolatedProcessResult(terminationStatus: $0, timedOut: true)
    }
}

#if PROCESS_TREE_SELFTEST
@main
struct ProcessTreeExcerptTests {
    static func main() {
        let nullOut = FileHandle(forWritingAtPath: "/dev/null")!
        defer { nullOut.closeFile() }

        let quick = Process()
        quick.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        quick.standardOutput = nullOut
        quick.standardError = nullOut
        let quickResult = runTrustedProcessInIsolatedGroup(
            quick,
            timeoutSeconds: 2,
            terminationGraceMicroseconds: 0
        )
        precondition(
            quickResult?.terminationStatus == 0 && quickResult?.timedOut == false,
            "A successful child must be reaped with its exit status"
        )

        let childPidPipe = Pipe()
        let slow = Process()
        slow.executableURL = URL(fileURLWithPath: "/bin/sh")
        slow.arguments = ["-c", "sleep 30 & echo $!; wait"]
        slow.standardOutput = childPidPipe.fileHandleForWriting
        slow.standardError = nullOut
        let startedAt = Date()
        let slowResult = runTrustedProcessInIsolatedGroup(
            slow,
            timeoutSeconds: 0.2,
            terminationGraceMicroseconds: 100_000
        )
        childPidPipe.fileHandleForWriting.closeFile()
        let childPidData = childPidPipe.fileHandleForReading.readDataToEndOfFile()
        let childPid = String(data: childPidData, encoding: .utf8)
            .flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
        precondition(slowResult?.timedOut == true, "A slow process group must time out")
        precondition(
            slowResult?.terminationStatus == 143 || slowResult?.terminationStatus == 137,
            "The group leader must report TERM or KILL termination"
        )
        precondition(
            Date().timeIntervalSince(startedAt) < 2,
            "Timeout cleanup must remain bounded"
        )
        if let childPid {
            let goneDeadline = Date().addingTimeInterval(2)
            while Darwin.kill(childPid, 0) == 0 && Date() < goneDeadline {
                usleep(50_000)
            }
            precondition(
                Darwin.kill(childPid, 0) == -1 && errno == ESRCH,
                "A same-group grandchild must not survive timeout cleanup"
            )
        } else {
            preconditionFailure("The test shell must report its child PID")
        }
        print("ProcessTreeExcerptTests: 5 passed, 0 failed")
    }
}
#endif
