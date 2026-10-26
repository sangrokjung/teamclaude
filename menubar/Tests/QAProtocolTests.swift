import Foundation

final class QAProtocolFakeRuntime: QAExecutionRuntime {
    var menuIsOpen = false
    var calls: [String] = []
    var failKeys = Set<String>()

    func requestOpenMenu(_ completion: @escaping (Result<Void, Error>) -> Void) {
        calls.append("open")
        menuIsOpen = true
        completion(.success(()))
    }

    func sendKey(_ key: String) -> Result<Void, Error> {
        calls.append("key:\(key)")
        if failKeys.contains(key) { return .failure(QAExecutionError(description: "fake key failure")) }
        return .success(())
    }

    func captureView() -> Result<Data, Error> {
        calls.append("capture")
        return .success(Data([1, 2, 3]))
    }

    func closeMenu() -> Result<Void, Error> {
        calls.append("close")
        menuIsOpen = false
        return .success(())
    }

    func stateSnapshot() -> Result<QAStateSnapshot, Error> {
        calls.append("state")
        return .success(QAStateSnapshot(statusTitle: "test", selectedTab: "overview", claudeRoutable: 1, claudeTotal: 2,
                                        teamCodexUsable: 3, teamCodexTotal: 4, menuOpen: menuIsOpen, panelWidth: 520, panelHeight: 600))
    }
}

@main
struct QAProtocolTests {
    static func main() {
        testRequestValidation()
        testFileSafety()
        testExecutionOrderAndFailures()
    }

    static func testRequestValidation() {
        let data = Data("{\"id\":\"qa-1\",\"steps\":[{\"open\":true},{\"key\":\"2\"},{\"wait\":10},{\"capture\":\"shot_1\"},{\"state\":\"state\"},{\"close\":true}]}".utf8)
        let request = try! QARequestValidator.decode(data)
        precondition(request.id == "qa-1")
        precondition(request.steps.count == 6)
        precondition((try? QARequestValidator.decode(Data("{\"id\":\"bad/\",\"steps\":[]}".utf8))) == nil)
        precondition((try? QARequestValidator.decode(Data("{\"id\":\"ok\",\"steps\":[{\"key\":\"x\"}]}".utf8))) == nil)
        precondition((try? QARequestValidator.decode(Data("{\"id\":\"ok\",\"steps\":[{\"wait\":10.1}]}".utf8))) == nil)
        let oversized = Data(repeating: 65, count: QARequestValidator.maxRequestBytes + 1)
        precondition((try? QARequestValidator.decode(oversized)) == nil)
    }

    static func testFileSafety() {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("qa-test-\(UUID().uuidString)")
        let enabled = root.appendingPathComponent("ENABLED")
        try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        FileManager.default.createFile(atPath: enabled.path, contents: Data(), attributes: [.posixPermissions: 0o600])
        let paths = QAPaths(root: root)
        precondition(QAFileSafety.isEnabled(paths))
        try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
        precondition(!QAFileSafety.isEnabled(paths))
        try! FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        try! FileManager.default.removeItem(at: enabled)
        precondition(!QAFileSafety.isEnabled(paths))
        let target = root.appendingPathComponent("target")
        FileManager.default.createFile(atPath: target.path, contents: Data())
        try! FileManager.default.createSymbolicLink(at: enabled, withDestinationURL: target)
        precondition(!QAFileSafety.isEnabled(paths))
        try? FileManager.default.removeItem(at: root)
    }

    static func testExecutionOrderAndFailures() {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("qa-out-\(UUID().uuidString)")
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let runtime = QAProtocolFakeRuntime()
        runtime.failKeys = ["r"]
        let request = QARequest(id: "run-1", steps: [.open, .key("2"), .capture("shot"), .key("r"), .state("state"), .close])
        let execution = QAExecution(request: request, outputDirectory: directory, runtime: runtime, delay: { _, action in action() })
        var result: QAResult?
        execution.start { result = $0 }
        let completed = result!
        precondition(completed.completed && !completed.timeout)
        precondition(completed.steps.count == 6)
        precondition(completed.steps[3].ok == false)
        precondition(runtime.calls == ["open", "key:2", "capture", "key:r", "state", "close"])
        precondition(FileManager.default.fileExists(atPath: directory.appendingPathComponent("shot.png").path))
        precondition(FileManager.default.fileExists(atPath: directory.appendingPathComponent("state.json").path))
        precondition(FileManager.default.fileExists(atPath: directory.appendingPathComponent("result.json").path))
        try? FileManager.default.removeItem(at: directory)
    }
}
