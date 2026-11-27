import Foundation

// 파일 넣기: 메뉴 동작(⌘K)이나 메뉴바 아이콘에 끌어다 놓은 파일을 이 맥의 로컬 명령에 넘기고,
// 명령이 출력한 결과 JSON을 알림으로 보여 준다. 명령과 경로는 공개 저장소에 박지 않고
// ~/.config/cc-menubar/importers.json에서 읽는다:
//   {"importers":[{"title":"파일 넣기","command":["/usr/bin/python3","/path/to/import.py"],"extensions":["csv"]}]}
// 파일이 없거나 깨졌거나 항목이 모두 틀리면 동작과 끌어다 놓기를 숨긴다.
// 명령은 셸 없이 실행한다(command[0]은 실행 가능한 절대 경로, 나머지는 인자, 그 뒤에 파일 경로들).
// 결과는 표준 출력의 마지막 JSON 객체 줄: {"added":3,"duplicates":1,"from":"2026-11-01","to":"2026-11-27","failed":0,"message":"…"}

struct FileImporter: Equatable {
    let title: String
    let command: [String]
    /// 소문자, 점 없음. 비면 모든 파일을 받는다.
    let extensions: [String]
    let timeoutSeconds: Int

    func accepts(_ url: URL) -> Bool {
        extensions.isEmpty || extensions.contains(url.pathExtension.lowercased())
    }
}

enum FileImporters {
    static let maxImporters = 3
    static let maxTitleLength = 24
    static let maxExtensions = 16
    static let defaultTimeout = 900
    static let timeoutRange = 10...3600

    static func defaultPath(home: String = NSHomeDirectory()) -> String {
        (home as NSString).appendingPathComponent(".config/cc-menubar/importers.json")
    }

    static func load(path: String = defaultPath(),
                     isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) -> [FileImporter] {
        guard let data = FileManager.default.contents(atPath: path) else { return [] }
        return parse(data, isExecutable: isExecutable)
    }

    static func parse(_ data: Data,
                      isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) -> [FileImporter] {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let items = root["importers"] as? [Any] else { return [] }
        return Array(items.compactMap { importer($0, isExecutable: isExecutable) }.prefix(maxImporters))
    }

    private static func importer(_ raw: Any, isExecutable: (String) -> Bool) -> FileImporter? {
        guard let row = raw as? [String: Any],
              let rawTitle = row["title"] as? String,
              let command = row["command"] as? [String], !command.isEmpty,
              command.allSatisfy({ !$0.isEmpty && !$0.contains("\u{0}") }),
              command[0].hasPrefix("/"), isExecutable(command[0]) else { return nil }
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return nil }
        var extensions: [String] = []
        if let rawExtensions = row["extensions"] {
            guard let list = rawExtensions as? [String] else { return nil }
            for item in list {
                let ext = item.trimmingCharacters(in: .whitespaces).lowercased()
                    .trimmingCharacters(in: CharacterSet(charactersIn: "."))
                guard !ext.isEmpty, ext.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) }) else { return nil }
                if !extensions.contains(ext) { extensions.append(ext) }
            }
            guard extensions.count <= maxExtensions else { return nil }
        }
        var timeout = defaultTimeout
        if let rawTimeout = row["timeout_seconds"] {
            guard let number = rawTimeout as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  let value = Int(exactly: number.doubleValue) else { return nil }
            timeout = min(max(value, timeoutRange.lowerBound), timeoutRange.upperBound)
        }
        let shown = title.count > maxTitleLength ? String(title.prefix(maxTitleLength - 1)) + "…" : title
        return FileImporter(title: shown, command: command, extensions: extensions, timeoutSeconds: timeout)
    }
}

/// 명령이 낸 결과 한 줄.
struct FileImportResult: Equatable {
    var added: Int
    var duplicates: Int
    var from: String?
    var to: String?
    var failed: Int
    var message: String?

    static let maxMessageLength = 160

    /// 표준 출력에서 added·duplicates가 정수인 마지막 JSON 객체 줄. 없으면 nil.
    static func parse(stdout: String) -> FileImportResult? {
        for line in stdout.split(whereSeparator: \.isNewline).reversed() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let added = count(object["added"]), let duplicates = count(object["duplicates"]) else { continue }
            return FileImportResult(
                added: added, duplicates: duplicates,
                from: day(object["from"]), to: day(object["to"]),
                failed: count(object["failed"]) ?? 0,
                message: text(object["message"]))
        }
        return nil
    }

    private static func count(_ raw: Any?) -> Int? {
        guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              let value = Int(exactly: number.doubleValue), value >= 0 else { return nil }
        return value
    }

    private static func day(_ raw: Any?) -> String? {
        guard let value = raw as? String,
              value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return nil }
        return value
    }

    private static func text(_ raw: Any?) -> String? {
        guard let value = (raw as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        let oneLine = value.components(separatedBy: .newlines).joined(separator: " ")
        return oneLine.count > maxMessageLength ? String(oneLine.prefix(maxMessageLength - 1)) + "…" : oneLine
    }
}

enum FileImportOutcome: Equatable {
    case finished(FileImportResult?, exitCode: Int32)
    case timedOut
    case launchFailed
}

/// 알림 제목·본문. 제목은 설정의 title, 본문은 결과 요약.
func fileImportNotification(title: String, outcome: FileImportOutcome) -> (title: String, body: String) {
    switch outcome {
    case .finished(let result?, let code):
        var parts = [L10n.importAdded(result.added), L10n.importDuplicates(result.duplicates)]
        if let from = result.from, let to = result.to {
            parts.append(from == to ? from : "\(from) ~ \(to)")
        }
        if result.failed > 0 || code != 0 {
            parts.append(L10n.importFailedFiles(result.failed))
        }
        if let message = result.message { parts.append(message) }
        return (title, parts.joined(separator: " · "))
    case .finished(nil, let code):
        return (title, L10n.importNoResult(code))
    case .timedOut:
        return (title, L10n.importTimedOut)
    case .launchFailed:
        return (title, L10n.importLaunchFailed)
    }
}

/// 넣을 파일만 남긴다(일반 파일·확장자 일치). 순서를 지키고 같은 경로는 한 번만.
func fileImportCandidates(_ urls: [URL], importer: FileImporter,
                          isRegularFile: (URL) -> Bool = { url in
                              (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
                          }) -> [URL] {
    var seen = Set<String>()
    return urls.filter { url in
        let path = url.standardizedFileURL.path
        guard url.isFileURL, importer.accepts(url), isRegularFile(url), seen.insert(path).inserted else { return false }
        return true
    }
}

/// 한 번에 하나만 돌린다. 명령은 배경 큐에서 실행하고 결과는 callback 큐(기본 메인)로 돌려준다.
final class FileImportRunner {
    static let maxOutputBytes = 1 << 20

    private let lock = NSLock()
    private var running = false
    private let work: DispatchQueue
    private let callback: DispatchQueue

    init(work: DispatchQueue = .global(qos: .userInitiated), callback: DispatchQueue = .main) {
        self.work = work
        self.callback = callback
    }

    var isRunning: Bool {
        lock.lock(); defer { lock.unlock() }
        return running
    }

    /// 이미 돌고 있으면 false(아무것도 하지 않음).
    @discardableResult
    func run(_ importer: FileImporter, files: [URL], completion: @escaping (FileImportOutcome) -> Void) -> Bool {
        lock.lock()
        guard !running else { lock.unlock(); return false }
        running = true
        lock.unlock()
        work.async { [self] in
            let outcome = Self.execute(importer, files: files)
            lock.lock(); running = false; lock.unlock()
            callback.async { completion(outcome) }
        }
        return true
    }

    static func execute(_ importer: FileImporter, files: [URL]) -> FileImportOutcome {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: importer.command[0])
        process.arguments = Array(importer.command.dropFirst()) + files.map { $0.standardizedFileURL.path }
        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        process.standardInput = FileHandle.nullDevice
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err

        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        do {
            try process.run()
        } catch {
            return .launchFailed
        }
        // 파이프가 차서 자식이 멈추지 않게 두 출력을 따로 끝까지 읽는다(앞 1MiB만 보관).
        let readers = DispatchGroup()
        let captured = CapturedOutput()
        for (pipe, keep) in [(out, true), (err, false)] {
            readers.enter()
            DispatchQueue.global(qos: .utility).async {
                let handle = pipe.fileHandleForReading
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty { break }
                    if keep { captured.append(chunk, limit: maxOutputBytes) }
                }
                readers.leave()
            }
        }
        if done.wait(timeout: .now() + .seconds(importer.timeoutSeconds)) == .timedOut {
            process.terminate()
            if done.wait(timeout: .now() + 5) == .timedOut { kill(process.processIdentifier, SIGKILL); done.wait() }
            _ = readers.wait(timeout: .now() + 5)
            return .timedOut
        }
        // 자식이 남긴 손자 프로세스가 파이프를 쥐고 있어도 오래 기다리지 않는다.
        _ = readers.wait(timeout: .now() + 5)
        let text = String(decoding: captured.data, as: UTF8.self)
        return .finished(FileImportResult.parse(stdout: text), exitCode: process.terminationStatus)
    }
}

/// 읽기 스레드와 결과를 만드는 스레드가 함께 쓰는 출력 버퍼.
private final class CapturedOutput {
    private let lock = NSLock()
    private var buffer = Data()

    func append(_ chunk: Data, limit: Int) {
        lock.lock(); defer { lock.unlock() }
        guard buffer.count < limit else { return }
        buffer.append(chunk.prefix(limit - buffer.count))
    }

    var data: Data {
        lock.lock(); defer { lock.unlock() }
        return buffer
    }
}

/// macOS 알림. 번들 없는 실행 파일이라 UNUserNotificationCenter 대신 osascript를 쓰고, 문구는 argv로 넘겨 따옴표 문제를 피한다.
func postFileImportNotification(title: String, body: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    task.arguments = [
        "-e", "on run argv",
        "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run",
        title, body,
    ]
    task.standardOutput = FileHandle.nullDevice
    task.standardError = FileHandle.nullDevice
    try? task.run()
}

/// 하단 동작 목록(앱 묶음)에 넣을 파일 넣기 항목. choose는 호스트가 메뉴 닫기와 파일 고르기 창을 묶어 넘긴다.
func fileImportActions(_ importers: [FileImporter], choose: @escaping (FileImporter) -> Void) -> [DashboardAction] {
    importers.enumerated().map { index, importer in
        DashboardAction(id: "import-file-\(index)", group: .app, title: importer.title, detail: L10n.importActionDetail) {
            choose(importer)
            return nil
        }
    }
}
