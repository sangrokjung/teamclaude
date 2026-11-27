import Foundation

// 파일 넣기(FileImporters.swift): 설정 해석, 결과 줄 해석, 알림 문구, 넣을 파일 고르기, 실제 명령 실행.
// 명령은 임시 폴더의 /bin/sh 스크립트로 대신한다. 실패를 모두 모아 출력하고 하나라도 있으면 1로 끝낸다.
@main
struct FileImportersTests {
    static var failures: [String] = []

    static func check(_ condition: Bool, _ message: @autoclosure () -> String) {
        if !condition { failures.append(message()) }
    }

    static func main() {
        L10n.language = .ko
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent("file-importers-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temp) }

        configParsing()
        missingConfigIsEmpty(temp)
        resultParsing()
        notificationText()
        candidateFiltering(temp)
        runnerPassesFilesAndReadsResult(temp)
        runnerTimesOut(temp)
        runnerWithoutResultLine(temp)
        runnerLaunchFailure()
        runnerRejectsSecondRun(temp)
        actionsFollowImporters()

        if failures.isEmpty {
            print("FileImportersTests OK")
        } else {
            failures.forEach { print("FAIL: \($0)") }
            exit(1)
        }
    }

    static func json(_ object: Any) -> Data {
        try! JSONSerialization.data(withJSONObject: object)
    }

    static let anyExecutable: (String) -> Bool = { _ in true }

    static func configParsing() {
        let parsed = FileImporters.parse(json(["importers": [
            ["title": "  Import  ", "command": ["/usr/bin/true", "--flag"], "extensions": [".CSV", "xls", "csv"], "timeout_seconds": 5],
            ["title": "relative", "command": ["bin/import"]],
            ["title": "", "command": ["/usr/bin/true"]],
            ["title": "no command", "command": []],
            ["title": "bad ext", "command": ["/usr/bin/true"], "extensions": ["c sv"]],
            ["title": "bool timeout", "command": ["/usr/bin/true"], "timeout_seconds": true],
            ["title": "A title that is far too long to fit", "command": ["/usr/bin/true"], "timeout_seconds": 99999],
            ["title": "third", "command": ["/usr/bin/true"]],
            ["title": "fourth", "command": ["/usr/bin/true"]],
        ]]), isExecutable: anyExecutable)
        check(parsed.count == 3, "max 3 valid importers, got \(parsed.map(\.title))")
        check(parsed.first == FileImporter(title: "Import", command: ["/usr/bin/true", "--flag"], extensions: ["csv", "xls"], timeoutSeconds: 10),
              "title trimmed, extensions normalized and deduped, timeout clamped up: \(String(describing: parsed.first))")
        check(parsed.count > 1 && parsed[1].title.count == FileImporters.maxTitleLength && parsed[1].title.hasSuffix("…"), "long title shortened")
        check(parsed.count > 1 && parsed[1].timeoutSeconds == 3600, "timeout clamped down")
        check(parsed.count > 2 && parsed[2].timeoutSeconds == FileImporters.defaultTimeout && parsed[2].extensions.isEmpty, "defaults")

        let notExecutable = FileImporters.parse(json(["importers": [["title": "x", "command": ["/nonexistent/import"]]]]))
        check(notExecutable.isEmpty, "a command that is not executable is dropped")
        check(FileImporters.parse(Data("not json".utf8)).isEmpty, "broken file is empty")
        check(FileImporters.parse(json(["links": []])).isEmpty, "no importers key is empty")
        check(FileImporters.parse(json(["importers": [["title": "x", "command": ["/usr/bin/true", 3]]]]), isExecutable: anyExecutable).isEmpty,
              "non-string argument drops the entry")
    }

    static func missingConfigIsEmpty(_ temp: URL) {
        check(FileImporters.load(path: temp.appendingPathComponent("missing.json").path).isEmpty, "missing file is empty")
        check(FileImporters.defaultPath(home: "/h").hasSuffix("/h/.config/cc-menubar/importers.json"), "default path")
    }

    static func resultParsing() {
        let out = """
        progress line
        {"added": 9, "duplicates": 9}
        {"added": 3, "duplicates": 1, "from": "2026-11-01", "to": "2026-11-27", "failed": 1, "message": "line one\\nline two"}
        trailing noise
        """
        let result = FileImportResult.parse(stdout: out)
        check(result == FileImportResult(added: 3, duplicates: 1, from: "2026-11-01", to: "2026-11-27", failed: 1, message: "line one line two"),
              "last JSON result line wins, message is one line: \(String(describing: result))")
        check(FileImportResult.parse(stdout: #"{"added": true, "duplicates": 0}"#) == nil, "bool is not a count")
        check(FileImportResult.parse(stdout: #"{"added": -1, "duplicates": 0}"#) == nil, "negative is not a count")
        check(FileImportResult.parse(stdout: #"{"added": 1.5, "duplicates": 0}"#) == nil, "fraction is not a count")
        check(FileImportResult.parse(stdout: #"{"ok": true}"#) == nil, "line without counts is not a result")
        let loose = FileImportResult.parse(stdout: #"{"added": 0, "duplicates": 4, "from": "11/01", "message": "   "}"#)
        check(loose?.from == nil && loose?.message == nil && loose?.failed == 0, "bad day and blank message are dropped")
        let long = FileImportResult.parse(stdout: "{\"added\":0,\"duplicates\":0,\"message\":\"\(String(repeating: "가", count: 400))\"}")
        check(long?.message?.count == FileImportResult.maxMessageLength, "message is capped")
    }

    static func notificationText() {
        let ok = fileImportNotification(title: "넣기", outcome: .finished(
            FileImportResult(added: 12, duplicates: 3, from: "2026-10-01", to: "2026-11-27", failed: 0, message: nil), exitCode: 0))
        check(ok.title == "넣기" && ok.body == "새로 넣음 12건 · 중복 3건 · 2026-10-01 ~ 2026-11-27", "ok body: \(ok.body)")
        let again = fileImportNotification(title: "넣기", outcome: .finished(
            FileImportResult(added: 0, duplicates: 5, from: "2026-11-27", to: "2026-11-27", failed: 0, message: nil), exitCode: 0))
        check(again.body == "새로 넣음 0건 · 중복 5건 · 2026-11-27", "same-day period shown once: \(again.body)")
        let partial = fileImportNotification(title: "넣기", outcome: .finished(
            FileImportResult(added: 1, duplicates: 0, from: nil, to: nil, failed: 2, message: "형식 확인"), exitCode: 1))
        check(partial.body == "새로 넣음 1건 · 중복 0건 · 실패 2개 파일 · 형식 확인", "partial body: \(partial.body)")
        let exitOnly = fileImportNotification(title: "넣기", outcome: .finished(
            FileImportResult(added: 0, duplicates: 0, from: nil, to: nil, failed: 0, message: nil), exitCode: 2))
        check(exitOnly.body.contains("일부 실패"), "non-zero exit is never shown as plain success: \(exitOnly.body)")
        check(fileImportNotification(title: "t", outcome: .finished(nil, exitCode: 7)).body.contains("종료 코드 7"), "no result")
        check(fileImportNotification(title: "t", outcome: .timedOut).body == L10n.importTimedOut, "timeout")
        check(fileImportNotification(title: "t", outcome: .launchFailed).body == L10n.importLaunchFailed, "launch failed")
        L10n.language = .en
        let english = fileImportNotification(title: "t", outcome: .finished(
            FileImportResult(added: 2, duplicates: 1, from: nil, to: nil, failed: 0, message: nil), exitCode: 0)).body
        check(english == "2 added · 1 duplicates" && english.unicodeScalars.allSatisfy { $0.value < 0x1100 || $0.value > 0xD7FF },
              "english body has no Hangul: \(english)")
        L10n.language = .ko
    }

    static func candidateFiltering(_ temp: URL) {
        let csv = temp.appendingPathComponent("a b.CSV")
        let txt = temp.appendingPathComponent("c.txt")
        let folder = temp.appendingPathComponent("folder.csv")
        FileManager.default.createFile(atPath: csv.path, contents: Data("x".utf8))
        FileManager.default.createFile(atPath: txt.path, contents: Data("x".utf8))
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let importer = FileImporter(title: "t", command: ["/usr/bin/true"], extensions: ["csv"], timeoutSeconds: 10)
        let picked = fileImportCandidates([csv, txt, folder, csv, URL(string: "https://example.com/x.csv")!], importer: importer)
        check(picked == [csv], "extension (case-insensitive), regular file, file URL, once: \(picked)")
        let any = FileImporter(title: "t", command: ["/usr/bin/true"], extensions: [], timeoutSeconds: 10)
        check(fileImportCandidates([csv, txt], importer: any) == [csv, txt], "no extensions accepts all files")
    }

    static func script(_ temp: URL, _ name: String, _ body: String) -> String {
        let url = temp.appendingPathComponent(name)
        try! ("#!/bin/sh\n" + body).write(to: url, atomically: true, encoding: .utf8)
        try! FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        return url.path
    }

    static func runnerPassesFilesAndReadsResult(_ temp: URL) {
        let argsFile = temp.appendingPathComponent("args.txt")
        let path = script(temp, "import ok.sh", """
        for a in "$@"; do printf '%s\\n' "$a"; done > '\(argsFile.path)'
        echo "working" >&2
        echo 'not json'
        printf '{"added": %d, "duplicates": 2, "from": "2026-11-01", "to": "2026-11-02"}\\n' "$(($# - 1))"
        """)
        let fileA = temp.appendingPathComponent("first file.csv")
        let fileB = temp.appendingPathComponent("second.csv")
        let importer = FileImporter(title: "t", command: [path, "--mode=x"], extensions: ["csv"], timeoutSeconds: 10)
        let outcome = FileImportRunner.execute(importer, files: [fileA, fileB])
        check(outcome == .finished(FileImportResult(added: 2, duplicates: 2, from: "2026-11-01", to: "2026-11-02", failed: 0, message: nil), exitCode: 0),
              "result read: \(outcome)")
        let args = (try? String(contentsOf: argsFile, encoding: .utf8)) ?? ""
        check(args == "--mode=x\n\(fileA.path)\n\(fileB.path)\n", "fixed args then one argument per file, spaces kept: \(args)")

        let failing = script(temp, "import fail.sh", """
        echo '{"added": 0, "duplicates": 0, "failed": 1, "message": "bad file"}'
        exit 3
        """)
        let failed = FileImportRunner.execute(FileImporter(title: "t", command: [failing], extensions: [], timeoutSeconds: 10), files: [fileA])
        check(failed == .finished(FileImportResult(added: 0, duplicates: 0, from: nil, to: nil, failed: 1, message: "bad file"), exitCode: 3),
              "exit code kept with result: \(failed)")

        let noisy = script(temp, "import noisy.sh", """
        i=0; while [ $i -lt 4000 ]; do echo "stderr noise line $i padding padding padding padding" >&2; i=$((i+1)); done
        echo '{"added": 1, "duplicates": 0}'
        """)
        let loud = FileImportRunner.execute(FileImporter(title: "t", command: [noisy], extensions: [], timeoutSeconds: 10), files: [fileA])
        check(loud == .finished(FileImportResult(added: 1, duplicates: 0, from: nil, to: nil, failed: 0, message: nil), exitCode: 0),
              "large stderr does not block the child: \(loud)")
    }

    static func runnerTimesOut(_ temp: URL) {
        let path = script(temp, "slow.sh", "sleep 30\necho '{\"added\":1,\"duplicates\":0}'\n")
        let started = Date()
        let outcome = FileImportRunner.execute(FileImporter(title: "t", command: [path], extensions: [], timeoutSeconds: 1), files: [])
        check(outcome == .timedOut, "timeout outcome: \(outcome)")
        check(Date().timeIntervalSince(started) < 10, "timeout stops the child promptly")
    }

    static func runnerWithoutResultLine(_ temp: URL) {
        let path = script(temp, "silent.sh", "echo hello\nexit 4\n")
        let outcome = FileImportRunner.execute(FileImporter(title: "t", command: [path], extensions: [], timeoutSeconds: 10), files: [])
        check(outcome == .finished(nil, exitCode: 4), "no result line: \(outcome)")
    }

    static func runnerLaunchFailure() {
        let outcome = FileImportRunner.execute(FileImporter(title: "t", command: ["/nonexistent/importer"], extensions: [], timeoutSeconds: 10), files: [])
        check(outcome == .launchFailed, "launch failure: \(outcome)")
    }

    static func runnerRejectsSecondRun(_ temp: URL) {
        let path = script(temp, "hold.sh", "sleep 1\necho '{\"added\":0,\"duplicates\":0}'\n")
        let importer = FileImporter(title: "t", command: [path], extensions: [], timeoutSeconds: 10)
        let runner = FileImportRunner(callback: DispatchQueue.global())
        let done = DispatchSemaphore(value: 0)
        var outcomes: [FileImportOutcome] = []
        let first = runner.run(importer, files: []) { outcomes.append($0); done.signal() }
        let second = runner.run(importer, files: []) { _ in }
        check(first && !second && runner.isRunning, "second run is refused while the first runs")
        check(done.wait(timeout: .now() + 10) == .success, "first run completes")
        check(outcomes.count == 1, "only the first run reports")
        Thread.sleep(forTimeInterval: 0.1)
        check(!runner.isRunning, "runner is free afterwards")
        let third = runner.run(importer, files: []) { _ in done.signal() }
        check(third && done.wait(timeout: .now() + 10) == .success, "runner accepts a new run after finishing")
    }

    static func actionsFollowImporters() {
        var chosen: [String] = []
        let importers = [FileImporter(title: "A", command: ["/usr/bin/true"], extensions: [], timeoutSeconds: 10),
                         FileImporter(title: "B", command: ["/usr/bin/true"], extensions: [], timeoutSeconds: 10)]
        let actions = fileImportActions(importers) { chosen.append($0.title) }
        check(actions.map(\.id) == ["import-file-0", "import-file-1"] && actions.map(\.title) == ["A", "B"], "one action per importer")
        check(actions.allSatisfy { $0.group == .app && $0.closesMenu }, "app group, closes menu")
        _ = actions.last?.run()
        check(chosen == ["B"], "running an action chooses its importer")
        check(fileImportActions([]) { _ in }.isEmpty, "no importers, no actions")
    }
}
