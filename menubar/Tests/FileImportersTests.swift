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
        timeoutWaitsForStubbornChild(temp)
        stdoutHeldByGrandchild(temp)
        configReadIsBounded(temp)
        runnerWithoutResultLine(temp)
        runnerLaunchFailure()
        runnerRejectsSecondRun(temp)
        actionsFollowImporters()
        resultIsReadFromTheEndOfLongOutput(temp)
        invalidFailedIsNotASuccess()
        dropCheckStopsAtFirstMatch()
        preparedRunRefusesNoFilesAndTooMany(temp)

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
        // 검토 2차: 시간 초과면 명령이 띄운 하위 프로세스까지 멈춘다.
        let pidFile = temp.appendingPathComponent("child.pid")
        let body = "sleep 30 &\necho $! > '" + pidFile.path + "'\nwait\necho '{\"added\":1,\"duplicates\":0}'\n"
        let path = script(temp, "slow.sh", body)
        let started = Date()
        let outcome = FileImportRunner.execute(FileImporter(title: "t", command: [path], extensions: [], timeoutSeconds: 1), files: [])
        check(outcome == .timedOut, "timeout outcome: \(outcome)")
        check(Date().timeIntervalSince(started) < 15, "timeout stops the child promptly")
        if let raw = try? String(contentsOf: pidFile, encoding: .utf8), let child = pid_t(raw.trimmingCharacters(in: .whitespacesAndNewlines)) {
            check(kill(child, 0) != 0, "the grandchild (sleep) is gone after the timeout")
        } else {
            check(false, "child pid was recorded")
        }
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
        let file = temp.appendingPathComponent("hold-input.csv")
        FileManager.default.createFile(atPath: file.path, contents: Data("x".utf8))
        let first = runner.run(importer, urls: [file]) { outcomes.append($0); done.signal() }
        let second = runner.run(importer, urls: [file]) { _ in }
        check(first && !second && runner.isRunning, "second run is refused while the first runs")
        check(done.wait(timeout: .now() + 10) == .success, "first run completes")
        check(outcomes.count == 1, "only the first run reports")
        Thread.sleep(forTimeInterval: 0.1)
        check(!runner.isRunning, "runner is free afterwards")
        let third = runner.run(importer, urls: [file]) { _ in done.signal() }
        check(third && done.wait(timeout: .now() + 10) == .success, "runner accepts a new run after finishing")
    }

    static func actionsFollowImporters() {
        var chosen: [String] = []
        let importers = [FileImporter(title: "A", command: ["/usr/bin/true"], extensions: [], timeoutSeconds: 10),
                         FileImporter(title: "B", command: ["/usr/bin/true"], extensions: [], timeoutSeconds: 10)]
        let actions = fileImportActions(importers) { chosen.append($0.title) }
        check(actions.map(\.id) == ["import-file-0", "import-file-1"] && actions.map(\.title) == ["A", "B"], "one action per importer")
        check(actions.allSatisfy { $0.group == .app && $0.closesMenu }, "app group, closes menu")
        check(actions.first?.detail == L10n.importActionDetail && actions.last?.detail == L10n.importActionDetailChooseOnly,
              "only the first entry mentions dropping (it is the one that takes drops)")
        _ = actions.last?.run()
        check(chosen == ["B"], "running an action chooses its importer")
        check(fileImportActions([]) { _ in }.isEmpty, "no importers, no actions")
    }

    // 검토 I1: 결과는 마지막 줄이다. 1MiB를 넘는 진행 로그 앞뒤에 결과가 있으면 뒤의 것을 읽는다.
    static func resultIsReadFromTheEndOfLongOutput(_ temp: URL) {
        let path = script(temp, "long-stdout.sh", """
        echo '{"added": 99, "duplicates": 99}'
        i=0; while [ $i -lt 30000 ]; do echo "progress line $i padding padding padding padding padding"; i=$((i+1)); done
        echo '{"added": 7, "duplicates": 1}'
        """)
        let outcome = FileImportRunner.execute(FileImporter(title: "t", command: [path], extensions: [], timeoutSeconds: 30), files: [])
        check(outcome == .finished(FileImportResult(added: 7, duplicates: 1, from: nil, to: nil, failed: 0, message: nil), exitCode: 0),
              "final result after >1MiB of progress output: \(outcome)")
        // 검토 2차 I1: 결과 뒤에 1MiB 넘는 일반 로그가 와도 마지막 결과를 잃지 않는다.
        let trailing = script(temp, "trailing-log.sh", """
        echo '{"added": 5, "duplicates": 2}'
        i=0; while [ $i -lt 30000 ]; do echo "after line $i padding padding padding padding padding"; i=$((i+1)); done
        """)
        let after = FileImportRunner.execute(FileImporter(title: "t", command: [trailing], extensions: [], timeoutSeconds: 30), files: [])
        check(after == .finished(FileImportResult(added: 5, duplicates: 2, from: nil, to: nil, failed: 0, message: nil), exitCode: 0),
              "result followed by >1MiB of log: \(after)")
        // 줄이 조각으로 나뉘어 와도 이어 붙여 읽는다.
        let capture = ResultLineCapture()
        capture.append(Data("noise\n{\"added\": 3, \"dupl".utf8))
        capture.append(Data("icates\": 4}\ntrailing".utf8))
        capture.finish()
        check(capture.result == FileImportResult(added: 3, duplicates: 4, from: nil, to: nil, failed: 0, message: nil),
              "split chunks are joined: \(String(describing: capture.result))")
        let huge = ResultLineCapture()
        huge.append(Data(("{\"added\": 1, \"duplicates\": 1, \"message\": \"" + String(repeating: "x", count: 70_000) + "\"}\n").utf8))
        huge.finish()
        check(huge.result == nil, "a line over 64KiB is not a result")
        // 검토 3차 I1: 정상 중간 결과 뒤에 64KiB를 넘는 최종 결과가 오면 중간 결과로 대신하지 않는다.
        let shadowed = ResultLineCapture()
        shadowed.append(Data("{\"added\": 9, \"duplicates\": 0}\n".utf8))
        shadowed.append(Data(("{\"added\": 1, \"duplicates\": 0, \"failed\": 3, \"message\": \"" + String(repeating: "y", count: 70_000) + "\"}\n").utf8))
        shadowed.finish()
        check(shadowed.result == nil, "an oversized final result is an error, not the earlier result")
        let logAfter = ResultLineCapture()
        logAfter.append(Data(("{\"added\": 9, \"duplicates\": 0}\n" + String(repeating: "z", count: 70_000) + "\n").utf8))
        logAfter.finish()
        check(logAfter.result?.added == 9, "an oversized plain log line after a result keeps the result")
        // 검토 4차: 값 속에 "added"가 든 긴 JSON 로그 줄은 결과가 아니다(성공을 실패로 바꾸지 않는다).
        let jsonLog = ResultLineCapture()
        let rows = (0..<2_500).map { "{\"status\":\"added\",\"id\":\($0)}" }.joined(separator: ",")
        jsonLog.append(Data(("{\"added\": 6, \"duplicates\": 1}\n{\"event\":\"batch.detail\",\"rows\":[" + rows + "]}\n").utf8))
        jsonLog.finish()
        check(jsonLog.result?.added == 6, "a long JSON log whose values mention added keeps the result")
        check(ResultLineCapture.startsWithResultKey(" { \"failed\" : 1") && !ResultLineCapture.startsWithResultKey("{\"event\":\"added\""),
              "only a leading result key marks an oversized line as a result")
        // 줄바꿈 없이 끝난 마지막 결과도 읽는다.
        let noNewline = ResultLineCapture()
        noNewline.append(Data("{\"added\": 2, \"duplicates\": 1}".utf8))
        noNewline.finish()
        noNewline.finish()
        check(noNewline.result?.added == 2, "final result without a newline is read (finish is idempotent)")
    }

    // 검토 Minor: failed가 있는데 정수가 아니면 결과로 보지 않는다(실패를 성공으로 바꾸지 않는다).
    static func invalidFailedIsNotASuccess() {
        check(FileImportResult.parse(stdout: #"{"added": 1, "duplicates": 0, "failed": "2"}"#) == nil, "string failed is not a result")
        check(FileImportResult.parse(stdout: #"{"added": 1, "duplicates": 0, "failed": -1}"#) == nil, "negative failed is not a result")
        check(FileImportResult.parse(stdout: #"{"added": 1, "duplicates": 0}"#)?.failed == 0, "missing failed is 0")
        // 검토 2차 M2: 마지막 결과가 틀리면 앞의 중간 결과로 대신하지 않는다.
        let two = "{\"added\": 9, \"duplicates\": 0}\n{\"added\": 1, \"duplicates\": 0, \"failed\": \"2\"}"
        check(FileImportResult.parse(stdout: two) == nil, "malformed last result is an error, not the earlier one")
        check(FileImportResult.parse(stdout: "{\"added\": 9, \"duplicates\": 0}\n{\"ok\": true}") != nil, "unrelated JSON after a result is ignored")
        // 검토 3차 M2: 키 하나가 빠진 최종 결과도 형식 오류다.
        check(FileImportResult.parse(stdout: "{\"added\": 9, \"duplicates\": 0}\n{\"added\": 1, \"failed\": 2}") == nil,
              "a final result missing duplicates is an error, not the earlier one")
        check(FileImportResult.parse(stdout: "{\"added\": 9, \"duplicates\": 0}\n{\"failed\": 2}") == nil,
              "a final failed-only line is an error, not the earlier success")
    }

    // 검토 I3: 끌어다 놓기 중 판단은 첫 일치에서 멈춘다.
    static func dropCheckStopsAtFirstMatch() {
        let importer = FileImporter(title: "t", command: ["/usr/bin/true"], extensions: ["csv"], timeoutSeconds: 10)
        let urls = (0..<1000).map { URL(fileURLWithPath: "/tmp/f\($0).csv") }
        // 디스크를 보지 않는다: 없는 경로라도 확장자만 맞으면 받는다(일반 파일인지는 놓은 뒤 배경에서 가린다).
        check(fileImportHasCandidate(urls, importer: importer), "extension match accepts without touching the disk")
        check(!fileImportHasCandidate([URL(fileURLWithPath: "/tmp/a.txt"), URL(string: "https://x/a.csv")!], importer: importer),
              "extension mismatch and non-file URLs are refused")
    }

    // 검토 I4: 맞는 파일이 없거나 너무 많으면 명령을 부르지 않는다.
    static func preparedRunRefusesNoFilesAndTooMany(_ temp: URL) {
        let marker = temp.appendingPathComponent("called.txt")
        let path = script(temp, "mark.sh", "touch '\(marker.path)'\necho '{\"added\":0,\"duplicates\":0}'\n")
        let importer = FileImporter(title: "t", command: [path], extensions: ["csv"], timeoutSeconds: 10)
        check(FileImportRunner.prepareAndExecute(importer, urls: [temp.appendingPathComponent("missing.csv")]) == .noFiles, "no files")
        var many: [URL] = []
        for index in 0...FileImportRunner.maxFiles {
            let url = temp.appendingPathComponent("many-\(index).csv")
            FileManager.default.createFile(atPath: url.path, contents: Data())
            many.append(url)
        }
        check(FileImportRunner.prepareAndExecute(importer, urls: many) == .tooMany(limit: FileImportRunner.maxFiles), "too many files")
        // 검토 3차: 상한을 넘는 입력은 디스크를 보기 전에 거절한다(없는 경로 1만 개도 즉시).
        let flood = (0..<10_000).map { URL(fileURLWithPath: "/nonexistent/flood-\($0).csv") }
        let floodStarted = Date()
        check(FileImportRunner.prepareAndExecute(importer, urls: flood) == .tooMany(limit: FileImportRunner.maxFiles)
              && Date().timeIntervalSince(floodStarted) < 1, "flood is refused before any file check")
        check(!FileManager.default.fileExists(atPath: marker.path), "the command was never called")
        check(fileImportNotification(title: "t", outcome: .tooMany(limit: 200)).body.contains("200"), "too-many notice names the limit")
        check(FileImportRunner.prepareAndExecute(importer, urls: Array(many.prefix(2))) ==
              .finished(FileImportResult(added: 0, duplicates: 0, from: nil, to: nil, failed: 0, message: nil), exitCode: 0), "within limits runs")
        // 검토 2차: 제외한 항목 수를 결과에 싣는다(폴더·확장자 불일치, 같은 경로는 한 번).
        let folder = temp.appendingPathComponent("dir.csv")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let mixed = FileImportRunner.prepareAndExecute(importer, urls: [many[0], many[0], folder, temp.appendingPathComponent("x.txt")])
        check(mixed == .finished(FileImportResult(added: 0, duplicates: 0, from: nil, to: nil, failed: 0, message: nil), exitCode: 0, excluded: 2),
              "mixed drop reports excluded items: \(mixed)")
        check(fileImportNotification(title: "t", outcome: mixed).body.hasSuffix("제외 2개(폴더·형식 불일치)"), "excluded shown in the notice")
    }

    // 검토 3차: 래퍼가 먼저 끝나도 SIGTERM을 무시하는 하위 프로세스가 사라진 뒤에 끝난다.
    static func timeoutWaitsForStubbornChild(_ temp: URL) {
        let pidFile = temp.appendingPathComponent("stubborn.pid")
        let body = "/bin/sh -c 'trap \"\" TERM; sleep 30' &\necho $! > '" + pidFile.path + "'\ntrap 'exit 0' TERM\nwait\n"
        let path = script(temp, "stubborn.sh", body)
        let outcome = FileImportRunner.execute(FileImporter(title: "t", command: [path], extensions: [], timeoutSeconds: 1), files: [])
        check(outcome == .timedOut, "stubborn timeout outcome: \(outcome)")
        if let raw = try? String(contentsOf: pidFile, encoding: .utf8), let child = pid_t(raw.trimmingCharacters(in: .whitespacesAndNewlines)) {
            check(kill(child, 0) != 0, "a child that ignores SIGTERM is killed before the runner is free")
        } else {
            check(false, "stubborn child pid was recorded")
        }
    }

    // 검토 3차: 하위 프로세스가 표준 출력을 물려받아 EOF가 늦어도, 줄바꿈 없는 최종 결과를 읽는다.
    static func stdoutHeldByGrandchild(_ temp: URL) {
        let path = script(temp, "held.sh", "sleep 8 &\nprintf '{\"added\": 4, \"duplicates\": 1}'\n")
        let started = Date()
        let outcome = FileImportRunner.execute(FileImporter(title: "t", command: [path], extensions: [], timeoutSeconds: 30), files: [])
        check(outcome == .finished(FileImportResult(added: 4, duplicates: 1, from: nil, to: nil, failed: 0, message: nil), exitCode: 0),
              "result read although a grandchild holds stdout: \(outcome)")
        check(Date().timeIntervalSince(started) < 8, "does not wait for the grandchild to exit")
    }

    // 검토 3차 Minor: 설정은 64KiB까지만 읽고, 유효한 셋째 항목에서 멈춘다.
    static func configReadIsBounded(_ temp: URL) {
        let big = temp.appendingPathComponent("big.json")
        let padding = String(repeating: " ", count: FileImporters.maxConfigBytes)
        try? ("{\"importers\":[{\"title\":\"x\",\"command\":[\"/usr/bin/true\"]}]" + padding + "}").write(to: big, atomically: true, encoding: .utf8)
        check(FileImporters.load(path: big.path).isEmpty, "an oversized config is ignored")
        var calls = 0
        let rows = (0..<50).map { _ in ["title": "x", "command": ["/usr/bin/true"]] as [String: Any] }
        let parsed = FileImporters.parse(json(["importers": rows])) { _ in calls += 1; return true }
        check(parsed.count == 3 && calls == 3, "parsing stops at the third valid entry, executable checks \(calls)")
    }
}
