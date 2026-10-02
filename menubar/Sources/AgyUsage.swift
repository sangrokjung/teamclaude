import Foundation

// agy(Antigravity CLI) 할당량. 인쇄 모드 `/usage`만 읽는다.
// 이 명령은 모델 턴을 시작하지 않는다. 응답 원문과 계정 식별자는 로그에 남기지 않는다.

let agyUsageFetchInterval: TimeInterval = 60
// 호출은 보통 5~7초. 호스트가 포화되면 더 걸리므로 폴링 주기보다 짧게, 넉넉히 잡는다.
let agyFetchTimeout: TimeInterval = 40
let agyKillGrace: TimeInterval = 3

struct AgyQuotaBucket: Equatable {
    var remaining: Double
    var resetAt: Date?
}

struct AgyQuotaGroup: Equatable {
    var name: String
    var weekly: AgyQuotaBucket?
    var fiveHour: AgyQuotaBucket?
}

struct AgyCardModel: Equatable {
    var message: String?
    var groups: [AgyQuotaGroup]
}

enum AgyFetchOutcome: Equatable {
    case missing
    case ready([AgyQuotaGroup])
    case failed
}

func agyExecutableURL() -> URL? {
    if let override = ProcessInfo.processInfo.environment["CC_MENUBAR_AGY_BIN"], !override.isEmpty {
        return FileManager.default.isExecutableFile(atPath: override) ? URL(fileURLWithPath: override) : nil
    }
    let home = NSHomeDirectory()
    let candidates = [
        "\(home)/bin/agy",
        "/opt/homebrew/bin/agy",
        "/usr/local/bin/agy",
    ]
    for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
        return URL(fileURLWithPath: path)
    }
    return nil
}

func agyFiniteFraction(_ value: Any?) -> Double? {
    let number: Double?
    if let parsed = value as? Double {
        number = parsed
    } else if let parsed = value as? Int {
        number = Double(parsed)
    } else if let parsed = value as? NSNumber {
        number = parsed.doubleValue
    } else {
        number = nil
    }
    guard let number, number.isFinite, number >= 0, number <= 1 else { return nil }
    return number
}

func agyRemainingLabel(_ fraction: Double) -> String? {
    guard let fraction = agyFiniteFraction(fraction) else { return nil }
    let tenth = (fraction * 1000).rounded() / 10
    if abs(tenth - tenth.rounded()) < 0.001 {
        return "\(Int(tenth.rounded()))% 남음"
    }
    let formatted = String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), tenth)
    return "\(formatted)% 남음"
}

func agyDisplayName(_ name: String) -> String {
    let folded = name.lowercased()
    if folded.contains("gemini") { return "Gemini 모델" }
    if folded.contains("claude") || folded.contains("gpt") { return "Claude·GPT" }
    return name
}

func agyResetHint(_ date: Date?, now: Date) -> String? {
    guard let date else { return nil }
    let seconds = date.timeIntervalSince(now)
    if seconds <= 0 { return "곧 리셋" }
    let minutes = Int(seconds / 60)
    if minutes < 60 { return "\(max(minutes, 1))분 뒤" }
    let hours = minutes / 60
    if hours < 48 { return "\(hours)시간 뒤" }
    return "\(hours / 24)일 뒤"
}

/// 화면에 올릴 레인만 남긴다.
///
/// agy는 Antigravity를 거치므로 응답에 Claude·GPT 버킷도 실려 오지만, 우리 레인은 Gemini 하나다
/// (memory-policy: 타 벤더 모델 선택 금지). 쓰지 않는 쿼터를 띄우면 남은 양을 오독하게 된다.
func agyVisibleGroups(_ groups: [AgyQuotaGroup]) -> [AgyQuotaGroup] {
    return groups.filter { $0.name.lowercased().contains("gemini") }
}

func agyLogLine(_ card: AgyCardModel) -> String {
    if card.groups.isEmpty {
        return card.message ?? "agy 확인 중"
    }
    return card.groups.prefix(2).map { group in
        let weekly = group.weekly.flatMap { agyRemainingLabel($0.remaining) } ?? "주간 확인 필요"
        let fiveHour = group.fiveHour.flatMap { agyRemainingLabel($0.remaining) } ?? "5시간 확인 필요"
        return "\(agyDisplayName(group.name)) \(weekly) / \(fiveHour)"
    }.joined(separator: " · ")
}

func agyQuotaGroups(from data: Data) -> [AgyQuotaGroup]? {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    if let turns = root["num_turns"] as? Int, turns != 0 { return nil }
    if let turns = root["num_turns"] as? NSNumber, turns.intValue != 0 { return nil }
    guard let command = root["command"] as? [String: Any],
          (command["name"] as? String) == "usage",
          let payload = command["data"] as? [String: Any],
          let rawGroups = payload["groups"] as? [Any] else {
        return nil
    }

    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]

    var groups: [AgyQuotaGroup] = []
    for item in rawGroups {
        guard let row = item as? [String: Any],
              let name = row["name"] as? String,
              !name.isEmpty,
              let buckets = row["buckets"] as? [Any] else {
            return nil
        }
        var weekly: AgyQuotaBucket?
        var fiveHour: AgyQuotaBucket?
        for bucket in buckets {
            guard let bucket = bucket as? [String: Any],
                  let window = bucket["window"] as? String,
                  window == "weekly" || window == "5h" else {
                continue
            }
            guard let remaining = agyFiniteFraction(bucket["remaining_fraction"]) else {
                return nil
            }
            var resetAt: Date?
            if let raw = bucket["reset_time"] as? String {
                resetAt = fractional.date(from: raw) ?? plain.date(from: raw)
            }
            let parsed = AgyQuotaBucket(remaining: remaining, resetAt: resetAt)
            if window == "weekly" {
                weekly = parsed
            } else {
                fiveHour = parsed
            }
        }
        if weekly == nil && fiveHour == nil { return nil }
        groups.append(AgyQuotaGroup(name: name, weekly: weekly, fiveHour: fiveHour))
    }
    return groups.isEmpty ? nil : groups
}

/// agy는 실행 디렉터리를 워크스페이스로 삼는다. 데몬의 cwd는 launchd 기본값인 루트라서 그대로 두면
/// 루트를 워크스페이스로 열고 응답 없이 멈춘다(2026-09-23 실측: 자식이 6시간 20분 생존, SIGTERM 무시,
/// 완료 콜백이 오지 않아 폴링이 통째로 정지). 전용 빈 폴더에서만 실행한다 — agy 레인 규칙도 루트·홈 워크스페이스를 금지한다.
func agyWorkspaceURL() -> URL? {
    let url = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".claude/cache/cc-menubar-agy", isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    } catch {
        return nil
    }
    return url
}

func fetchAgyUsage(completion: @escaping (AgyFetchOutcome) -> Void) {
    guard let executable = agyExecutableURL() else {
        completion(.missing)
        return
    }
    guard let workspace = agyWorkspaceURL() else {
        // 실행 파일은 있는데 전용 작업 폴더를 못 만든 경우다. "설치 안 됨"과 구분해 알린다.
        print("AGY-WORKSPACE: 전용 작업 폴더를 만들지 못해 호출을 건너뛴다")
        fflush(stdout)
        completion(.failed)
        return
    }
    DispatchQueue.global(qos: .utility).async {
        let process = Process()
        process.executableURL = executable
        process.arguments = ["-p", "/usage", "--output-format", "json"]
        process.currentDirectoryURL = workspace
        let output = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = output
        process.standardError = errorPipe
        process.standardInput = FileHandle.nullDevice

        // 완료는 정확히 한 번 — 타임아웃·정상종료·실행실패가 경쟁해도 호출부의 진행 플래그가 영구히 박히지 않는다.
        let completionLock = NSLock()
        var completed = false
        func finish(_ outcome: AgyFetchOutcome) {
            completionLock.lock()
            let isFirst = !completed
            completed = true
            completionLock.unlock()
            guard isFirst else { return }
            completion(outcome)
        }

        // 자식이 끝나기 전에 읽는다(파이프가 차서 서로 기다리는 교착 방지).
        // stdout 읽기는 이 핸들러 하나뿐이다 — 한 파일 핸들에 reader가 둘이면 마지막 청크가
        // 어느 쪽에 떨어질지 정해져 있지 않아 모아 둔 바이트가 뒤섞인다.
        let stateLock = NSLock()
        var collected = Data()
        var sawEOF = false
        var exitStatus: Int32?
        func stopReading() {
            output.fileHandleForReading.readabilityHandler = nil
            errorPipe.fileHandleForReading.readabilityHandler = nil
        }
        // EOF와 프로세스 종료가 둘 다 와야 판정한다(둘의 순서는 보장되지 않는다).
        func completeIfReady() {
            stateLock.lock()
            let ready = sawEOF && exitStatus != nil
            let status = exitStatus ?? -1
            let data = collected
            stateLock.unlock()
            guard ready else { return }
            guard status == 0, let groups = agyQuotaGroups(from: data) else {
                finish(.failed)
                return
            }
            finish(.ready(groups))
        }

        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                stateLock.lock()
                sawEOF = true
                stateLock.unlock()
                completeIfReady()
                return
            }
            stateLock.lock()
            collected.append(chunk)
            stateLock.unlock()
        }
        errorPipe.fileHandleForReading.readabilityHandler = { handle in
            if handle.availableData.isEmpty { handle.readabilityHandler = nil }
        }

        process.terminationHandler = { finishedProcess in
            stateLock.lock()
            exitStatus = finishedProcess.terminationStatus
            stateLock.unlock()
            completeIfReady()
        }

        do {
            try process.run()
        } catch {
            stopReading()
            finish(.missing)
            return
        }

        // 워치독: SIGTERM으로 죽지 않는 상태가 실재하므로 유예 뒤 SIGKILL까지 간다.
        let pid = process.processIdentifier
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + agyFetchTimeout) {
            guard process.isRunning else { return }
            kill(pid, SIGTERM)
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + agyKillGrace) {
                if process.isRunning { kill(pid, SIGKILL) }
            }
        }
        // 마지막 안전망: 무슨 일이 있어도 이 시각까지는 완료가 돌아간다.
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + agyFetchTimeout + agyKillGrace + 2) {
            stopReading()
            finish(.failed)
        }
    }
}

/// 메뉴바 제목용 짧은 표기 — 우리가 쓰는 레인인 Gemini의 주간 잔량만 보여준다("Agy 99%").
/// 같은 계정의 Claude·GPT 그룹은 규칙상 쓰지 않으므로 제목에 올리지 않는다(대시보드 카드에는 그대로 둔다).
/// Gemini 그룹이나 주간 버킷이 없으면 nil이라 아무것도 그리지 않는다.
func agyTitleSlot(_ card: AgyCardModel) -> String? {
    guard let gemini = card.groups.first(where: { $0.name.lowercased().contains("gemini") }),
          let weekly = gemini.weekly,
          let fraction = agyFiniteFraction(weekly.remaining) else { return nil }
    // 반올림하면 99.5%가 100%로 보인다. 남은 양은 낮춰 말하는 쪽이 안전하다.
    // 범위(0~1)는 agyFiniteFraction이 이미 보장한다.
    return "Agy \(Int(fraction * 100))%"
}
