import Foundation

protocol QAExecutionRuntime: AnyObject {
    var menuIsOpen: Bool { get }
    func requestOpenMenu(_ completion: @escaping (Result<Void, Error>) -> Void)
    func sendKey(_ key: String) -> Result<Void, Error>
    func captureView() -> Result<Data, Error>
    func closeMenu() -> Result<Void, Error>
    func stateSnapshot() -> Result<QAStateSnapshot, Error>
}

struct QAExecutionError: Error, CustomStringConvertible {
    let description: String
}

final class QAExecution {
    private let request: QARequest
    private let outputDirectory: URL
    private let runtime: QAExecutionRuntime
    private let now: () -> Date
    private let delay: (TimeInterval, @escaping () -> Void) -> Void
    private var stepResults: [QAStepResult] = []
    private var nextIndex = 0
    private var finished = false
    private var timeoutTimer: Timer?
    private let startedDate: Date

    init(request: QARequest, outputDirectory: URL, runtime: QAExecutionRuntime,
         now: @escaping () -> Date = { Date() },
         delay: @escaping (TimeInterval, @escaping () -> Void) -> Void = { seconds, action in
             let timer = Timer(timeInterval: seconds, repeats: false) { _ in action() }
             RunLoop.main.add(timer, forMode: .common)
         }) {
        self.request = request
        self.outputDirectory = outputDirectory
        self.runtime = runtime
        self.now = now
        self.delay = delay
        self.startedDate = now()
    }

    func start(completion: @escaping (QAResult) -> Void) {
        let deadline = Timer(timeInterval: 120, repeats: false) { [weak self] _ in
            self?.finish(timeout: true, completion: completion)
        }
        timeoutTimer = deadline
        RunLoop.main.add(deadline, forMode: .common)
        advance(completion: completion)
    }

    private func advance(completion: @escaping (QAResult) -> Void) {
        guard !finished else { return }
        if now().timeIntervalSince(startedDate) >= 120 {
            finish(timeout: true, completion: completion)
            return
        }
        guard nextIndex < request.steps.count else {
            finish(timeout: false, completion: completion)
            return
        }
        let index = nextIndex
        nextIndex += 1
        let step = request.steps[index]
        switch step {
        case .open:
            runtime.requestOpenMenu { [weak self] result in
                guard let self else { return }
                self.record(index: index, step: step, result: result)
                self.advance(completion: completion)
            }
        case .key(let key):
            record(index: index, step: step, result: runtime.sendKey(key))
            advance(completion: completion)
        case .wait(let seconds):
            delay(seconds) { [weak self] in
                guard let self else { return }
                self.record(index: index, step: step, result: .success(()))
                self.advance(completion: completion)
            }
        case .capture(let name):
            let result = runtime.captureView().flatMap { data in
                do {
                    try QAFileSafety.atomicWrite(data, to: outputDirectory.appendingPathComponent("\(name).png"))
                    return .success(())
                } catch { return .failure(error) }
            }
            record(index: index, step: step, result: result)
            advance(completion: completion)
        case .state(let name):
            let result = runtime.stateSnapshot().flatMap { snapshot in
                do {
                    try QAFileSafety.atomicWrite(try JSONEncoder.qaEncoder.encode(snapshot), to: outputDirectory.appendingPathComponent("\(name).json"))
                    return .success(())
                } catch { return .failure(error) }
            }
            record(index: index, step: step, result: result)
            advance(completion: completion)
        case .close:
            record(index: index, step: step, result: runtime.closeMenu())
            advance(completion: completion)
        }
    }

    private func record(index: Int, step: QAStep, result: Result<Void, Error>) {
        switch result {
        case .success:
            stepResults.append(QAStepResult(index: index, kind: step.kind, ok: true, error: nil))
        case .failure(let error):
            stepResults.append(QAStepResult(index: index, kind: step.kind, ok: false, error: error.localizedDescription))
        }
    }

    private func finish(timeout: Bool, completion: @escaping (QAResult) -> Void) {
        guard !finished else { return }
        finished = true
        timeoutTimer?.invalidate()
        if timeout { _ = runtime.closeMenu() }
        if timeout {
            stepResults.append(QAStepResult(index: nextIndex, kind: "timeout", ok: false, error: "execution exceeded 120 seconds"))
        }
        let ended = now()
        let result = QAResult(id: request.id, startedAt: QAExecution.iso8601(startedDate), endedAt: QAExecution.iso8601(ended), completed: !timeout, timeout: timeout, steps: stepResults)
        do {
            try QAFileSafety.atomicWrite(try JSONEncoder.qaEncoder.encode(result), to: outputDirectory.appendingPathComponent("result.json"))
        } catch {
            let failed = QAResult(id: request.id, startedAt: result.startedAt, endedAt: result.endedAt, completed: false, timeout: timeout,
                                  steps: result.steps + [QAStepResult(index: nextIndex, kind: "result", ok: false, error: error.localizedDescription)])
            try? QAFileSafety.atomicWrite(try JSONEncoder.qaEncoder.encode(failed), to: outputDirectory.appendingPathComponent("result.json"))
            completion(failed)
            return
        }
        completion(result)
    }

    private static func iso8601(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
}

extension JSONEncoder {
    static var qaEncoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}
