import Darwin
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

    /// 결과 후보: added·duplicates 키가 모두 있는 JSON 객체 줄(값의 형식은 아직 보지 않는다).
    static func isCandidate(_ line: Substring) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("{"), trimmed.contains("\"added\""), trimmed.contains("\"duplicates\""),
              let data = trimmed.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        return object["added"] != nil && object["duplicates"] != nil
    }

    /// 표준 출력의 마지막 결과 후보 줄을 읽는다. 후보가 없거나, 마지막 후보의 값 형식이 틀리면 nil
    /// (앞의 중간 결과로 대신하지 않는다).
    static func parse(stdout: String) -> FileImportResult? {
        guard let line = stdout.split(whereSeparator: \.isNewline).last(where: isCandidate) else { return nil }
        return parse(line: line)
    }

    static func parse(line: Substring) -> FileImportResult? {
        guard let data = line.trimmingCharacters(in: .whitespaces).data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let added = count(object["added"]), let duplicates = count(object["duplicates"]) else { return nil }
        // failed는 없으면 0이지만, 있는데 정수가 아니면 형식 오류다(실패를 성공으로 바꾸지 않는다).
        var failed = 0
        if let raw = object["failed"] {
            guard let value = count(raw) else { return nil }
            failed = value
        }
        return FileImportResult(added: added, duplicates: duplicates,
                                from: day(object["from"]), to: day(object["to"]),
                                failed: failed, message: text(object["message"]))
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
    /// excluded: 넘긴 것 가운데 일반 파일·확장자 조건에 맞지 않아 명령에 주지 않은 항목 수.
    case finished(FileImportResult?, exitCode: Int32, excluded: Int = 0)
    case timedOut
    case launchFailed
    /// 확장자·일반 파일 조건에 맞는 파일이 없다(명령을 부르지 않음).
    case noFiles
    /// 한 번에 넘기기에 파일이 너무 많거나 경로가 너무 길다(명령을 부르지 않음).
    case tooMany(limit: Int)
}

/// 알림 제목·본문. 제목은 설정의 title, 본문은 결과 요약.
func fileImportNotification(title: String, outcome: FileImportOutcome) -> (title: String, body: String) {
    switch outcome {
    case .finished(let result?, let code, let excluded):
        var parts = [L10n.importAdded(result.added), L10n.importDuplicates(result.duplicates)]
        if let from = result.from, let to = result.to {
            parts.append(from == to ? from : "\(from) ~ \(to)")
        }
        if result.failed > 0 || code != 0 {
            parts.append(L10n.importFailedFiles(result.failed))
        }
        if excluded > 0 { parts.append(L10n.importExcluded(excluded)) }
        if let message = result.message { parts.append(message) }
        return (title, parts.joined(separator: " · "))
    case .finished(nil, let code, let excluded):
        return (title, L10n.importNoResult(code) + (excluded > 0 ? " · " + L10n.importExcluded(excluded) : ""))
    case .timedOut:
        return (title, L10n.importTimedOut)
    case .launchFailed:
        return (title, L10n.importLaunchFailed)
    case .noFiles:
        return (title, L10n.importNoFiles)
    case .tooMany(let limit):
        return (title, L10n.importTooMany(limit))
    }
}

/// 끌어다 놓기 중 수락 여부: 파일 URL이고 확장자가 맞는 항목이 하나라도 있는지. 디스크는 보지 않는다
/// (일반 파일인지는 놓은 뒤 배경에서 fileImportCandidates가 가린다).
func fileImportHasCandidate(_ urls: [URL], importer: FileImporter) -> Bool {
    urls.contains { $0.isFileURL && importer.accepts($0) }
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
    /// 한 번에 넘기는 파일 수와 경로 바이트 합의 상한. 시스템 실행 한도(ARG_MAX)보다 훨씬 낮게 둔다.
    static let maxFiles = 200
    static let maxArgumentBytes = 200_000

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

    /// 이미 돌고 있으면 false(아무것도 하지 않음). 파일 고르기·상한 검사도 배경 큐에서 한다.
    @discardableResult
    func run(_ importer: FileImporter, urls: [URL], completion: @escaping (FileImportOutcome) -> Void) -> Bool {
        lock.lock()
        guard !running else { lock.unlock(); return false }
        running = true
        lock.unlock()
        work.async { [self] in
            let outcome = Self.prepareAndExecute(importer, urls: urls)
            lock.lock(); running = false; lock.unlock()
            callback.async { completion(outcome) }
        }
        return true
    }

    static func prepareAndExecute(_ importer: FileImporter, urls: [URL]) -> FileImportOutcome {
        let files = fileImportCandidates(urls, importer: importer)
        guard !files.isEmpty else { return .noFiles }
        let excluded = Set(urls.map { $0.standardizedFileURL.path }).count - files.count
        let argumentBytes = (importer.command + files.map { $0.standardizedFileURL.path }).reduce(0) { $0 + $1.utf8.count + 1 }
        guard files.count <= maxFiles, argumentBytes <= maxArgumentBytes else { return .tooMany(limit: maxFiles) }
        let outcome = execute(importer, files: files)
        if case .finished(let result, let code, _) = outcome {
            return .finished(result, exitCode: code, excluded: max(0, excluded))
        }
        return outcome
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
        // 파이프가 차서 자식이 멈추지 않게 두 출력을 따로 끝까지 읽는다. 표준 출력은 줄 단위로 보며 마지막 결과 후보 줄만 남긴다.
        let readers = DispatchGroup()
        let captured = ResultLineCapture()
        for (pipe, keep) in [(out, true), (err, false)] {
            readers.enter()
            DispatchQueue.global(qos: .utility).async {
                let handle = pipe.fileHandleForReading
                while true {
                    let chunk = handle.availableData
                    if chunk.isEmpty { break }
                    if keep { captured.append(chunk) }
                }
                if keep { captured.finish() }
                readers.leave()
            }
        }
        if done.wait(timeout: .now() + .seconds(importer.timeoutSeconds)) == .timedOut {
            // 명령이 띄운 하위 프로세스까지 멈추고, 모두 사라진 뒤에야 다음 넣기를 받는다.
            terminateTree(process.processIdentifier, signal: SIGTERM)
            if done.wait(timeout: .now() + 5) == .timedOut { terminateTree(process.processIdentifier, signal: SIGKILL); done.wait() }
            _ = readers.wait(timeout: .now() + 5)
            return .timedOut
        }
        // 자식이 남긴 손자 프로세스가 파이프를 쥐고 있어도 오래 기다리지 않는다.
        _ = readers.wait(timeout: .now() + 5)
        return .finished(captured.result, exitCode: process.terminationStatus)
    }

    /// pid와 그 하위 프로세스 전부에 신호를 보낸다(자식부터 모은 뒤 위에서 아래로). SIGKILL이면 하위가 사라질 때까지 잠깐 기다린다.
    static func terminateTree(_ pid: pid_t, signal: Int32) {
        let tree = [pid] + descendants(of: pid)
        for member in tree { kill(member, signal) }
        guard signal == SIGKILL else { return }
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline, tree.dropFirst().contains(where: { kill($0, 0) == 0 }) {
            Thread.sleep(forTimeInterval: 0.05)
        }
    }

    static func descendants(of pid: pid_t) -> [pid_t] {
        var result: [pid_t] = []
        var queue = [pid]
        while let current = queue.popLast(), result.count < 512 {
            var buffer = [pid_t](repeating: 0, count: 256)
            // 돌려주는 값은 바이트가 아니라 자식 PID 개수다(macOS 27에서 확인).
            let found = proc_listchildpids(current, &buffer, Int32(buffer.count * MemoryLayout<pid_t>.size))
            guard found > 0 else { continue }
            let children = buffer.prefix(min(Int(found), buffer.count)).filter { $0 > 0 }
            result += children
            queue += children
        }
        return result
    }
}

/// 표준 출력을 줄 단위로 보며 마지막 결과 후보 줄만 남긴다(긴 진행 로그가 앞뒤에 있어도 메모리는 한 줄 상한).
/// 64KiB를 넘는 한 줄은 결과가 아니므로 버린다.
final class ResultLineCapture {
    static let maxLineBytes = 64 * 1024
    private let lock = NSLock()
    private var pending = Data()
    private var overflow = false
    private var lastCandidate: String?

    func append(_ chunk: Data) {
        lock.lock(); defer { lock.unlock() }
        var rest = chunk[...]
        while let newline = rest.firstIndex(of: 0x0A) {
            take(rest[rest.startIndex..<newline])
            rest = rest[rest.index(after: newline)...]
        }
        if !overflow { pending.append(contentsOf: rest) }
        if pending.count > Self.maxLineBytes { pending.removeAll(); overflow = true }
    }

    func finish() {
        lock.lock(); defer { lock.unlock() }
        take(Data()[...])
    }

    var result: FileImportResult? {
        lock.lock(); defer { lock.unlock() }
        return lastCandidate.flatMap { FileImportResult.parse(line: Substring($0)) }
    }

    private func take(_ tail: Data.SubSequence) {
        defer { pending.removeAll(keepingCapacity: true); overflow = false }
        guard !overflow, pending.count + tail.count <= Self.maxLineBytes else { return }
        let line = Substring(String(decoding: pending + tail, as: UTF8.self))
        if FileImportResult.isCandidate(line) { lastCandidate = String(line) }
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
    // 알림을 못 띄워도 결과는 로그(FILE-IMPORT 줄)에 남는다. 전송 실패만 따로 적는다.
    task.terminationHandler = { finished in
        if finished.terminationStatus != 0 {
            print("FILE-IMPORT: 알림 전송 실패(osascript 종료 코드 \(finished.terminationStatus))")
            fflush(stdout)
        }
    }
    do {
        try task.run()
    } catch {
        print("FILE-IMPORT: 알림 전송 실패(osascript 실행 불가)")
        fflush(stdout)
    }
}

/// 하단 동작 목록(앱 묶음)에 넣을 파일 넣기 항목. choose는 호스트가 메뉴 닫기와 파일 고르기 창을 묶어 넘긴다.
func fileImportActions(_ importers: [FileImporter], choose: @escaping (FileImporter) -> Void) -> [DashboardAction] {
    importers.enumerated().map { index, importer in
        // 끌어다 놓기는 첫 항목만 받으므로 그 안내도 첫 항목에만 붙인다.
        DashboardAction(id: "import-file-\(index)", group: .app, title: importer.title,
                        detail: index == 0 ? L10n.importActionDetail : L10n.importActionDetailChooseOnly) {
            choose(importer)
            return nil
        }
    }
}

// 화면 문구(R5 표의 이 기능 몫). 한국어·영어 한 쌍으로 쓴다.
extension L10n {
    static var importActionDetail: String { t("파일 고르기 · 아이콘에 끌어다 놓기도 됨", "Choose files · or drop them on the icon") }
    static func importAdded(_ count: Int) -> String { t("새로 넣음 \(count)건", "\(count) added") }
    static func importDuplicates(_ count: Int) -> String { t("중복 \(count)건", "\(count) duplicates") }
    static func importFailedFiles(_ count: Int) -> String {
        count > 0 ? t("실패 \(count)개 파일", "\(count) files failed") : t("일부 실패", "partly failed")
    }
    static var importActionDetailChooseOnly: String { t("파일 고르기", "Choose files") }
    static var importStarted: String { t("넣는 중…", "Importing…") }
    static func importExcluded(_ count: Int) -> String { t("제외 \(count)개(폴더·형식 불일치)", "\(count) skipped (folders or other types)") }
    static var importBusy: String { t("이미 넣는 중입니다. 끝난 뒤 다시 하세요.", "An import is already running. Try again after it ends.") }
    static var importNoFiles: String { t("넣을 수 있는 파일이 없습니다(확장자 확인).", "No file this import accepts (check the extension).") }
    static func importNoResult(_ code: Int32) -> String {
        t("넣기 실패: 결과를 읽지 못했습니다(종료 코드 \(code)).", "Import failed: no result (exit code \(code)).")
    }
    static var importTimedOut: String { t("넣기 실패: 시간이 초과돼 중단했습니다.", "Import failed: timed out and stopped.") }
    static var importLaunchFailed: String { t("넣기 실패: 명령을 실행하지 못했습니다.", "Import failed: could not run the command.") }
    static func importTooMany(_ limit: Int) -> String {
        t("한 번에 넣을 파일이 너무 많습니다(\(limit)개까지, 경로가 길면 더 적게).", "Too many files at once (up to \(limit); fewer with long paths).")
    }
    static var importPanelPrompt: String { t("넣기", "Import") }
}
