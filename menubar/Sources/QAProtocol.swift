import Foundation
import Darwin

struct QARequest: Codable, Equatable {
    let id: String
    let steps: [QAStep]
}

enum QAStep: Equatable {
    case open
    case key(String)
    case wait(Double)
    case capture(String)
    case close
    case state(String)

    var kind: String {
        switch self {
        case .open: return "open"
        case .key: return "key"
        case .wait: return "wait"
        case .capture: return "capture"
        case .close: return "close"
        case .state: return "state"
        }
    }
}

enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        if let value = try? container.decode(Bool.self) { self = .bool(value); return }
        if let value = try? container.decode(Double.self) { self = .number(value); return }
        if let value = try? container.decode(String.self) { self = .string(value); return }
        if let value = try? container.decode([String: JSONValue].self) { self = .object(value); return }
        if let value = try? container.decode([JSONValue].self) { self = .array(value); return }
        throw QAValidationError.invalidJSON
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

extension QAStep: Codable {
    init(from decoder: Decoder) throws {
        let object = try decoder.singleValueContainer().decode([String: JSONValue].self)
        guard object.count == 1 else { throw QAValidationError.invalidStep }
        if object["open"] == .bool(true) { self = .open; return }
        if object["close"] == .bool(true) { self = .close; return }
        if case let .string(value)? = object["key"] { self = .key(value); return }
        if case let .number(value)? = object["wait"] { self = .wait(value); return }
        if case let .string(value)? = object["capture"] { self = .capture(value); return }
        if case let .string(value)? = object["state"] { self = .state(value); return }
        throw QAValidationError.invalidStep
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .open: try container.encode(["open": JSONValue.bool(true)])
        case .key(let value): try container.encode(["key": JSONValue.string(value)])
        case .wait(let value): try container.encode(["wait": JSONValue.number(value)])
        case .capture(let value): try container.encode(["capture": JSONValue.string(value)])
        case .close: try container.encode(["close": JSONValue.bool(true)])
        case .state(let value): try container.encode(["state": JSONValue.string(value)])
        }
    }
}

enum QAValidationError: Error, Equatable, CustomStringConvertible {
    case invalidJSON, invalidRequest, invalidID, invalidStep
    case invalidKey(String), invalidName(String), duplicateName(String), tooManySteps, waitOutOfRange
    case requestTooLarge, notRegularFile(String), notEnabled, outputAlreadyExists, requestAlreadyClaimed

    var description: String {
        switch self {
        case .invalidJSON: return "invalid JSON"
        case .invalidRequest: return "request must contain id and steps"
        case .invalidID: return "id must contain 1-64 ASCII letters, digits, '-' or '_'"
        case .invalidStep: return "step must contain exactly one supported operation"
        case .invalidKey(let key): return "unsupported key: \(key)"
        case .invalidName(let name): return "invalid output name: \(name)"
        case .duplicateName(let name): return "output name used twice or reserved: \(name)"
        case .tooManySteps: return "steps must contain at most 50 items"
        case .waitOutOfRange: return "wait must be between 0 and 10 seconds"
        case .requestTooLarge: return "request.json exceeds 64 KiB"
        case .notRegularFile(let path): return "not a regular file: \(path)"
        case .notEnabled: return "QA hook is not enabled"
        case .outputAlreadyExists: return "output id already exists"
        case .requestAlreadyClaimed: return "request could not be claimed"
        }
    }
}

struct QARequestValidator {
    static let maxRequestBytes = 64 * 1024
    static let maxSteps = 50
    static let supportedKeys = Set(["1", "2", "3", "4", "5", "r", "cmd+k", "escape"])
    static let nameCharacterSet = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

    static func decode(_ data: Data) throws -> QARequest {
        guard data.count <= maxRequestBytes else { throw QAValidationError.requestTooLarge }
        let request: QARequest
        do { request = try JSONDecoder().decode(QARequest.self, from: data) }
        catch let error as QAValidationError { throw error }
        catch { throw QAValidationError.invalidJSON }
        try validate(request)
        return request
    }

    static func validate(_ request: QARequest) throws {
        guard validName(request.id, maxLength: 64) else { throw QAValidationError.invalidID }
        guard request.steps.count <= maxSteps else { throw QAValidationError.tooManySteps }
        // 산출물 이름은 요청 안에서 한 번만 쓴다. 같은 이름이 두 번 오면 앞 파일이 조용히 덮인다.
        var usedNames: Set<String> = ["result"]
        for step in request.steps {
            switch step {
            case .key(let key):
                guard supportedKeys.contains(key) else { throw QAValidationError.invalidKey(key) }
            case .wait(let seconds): guard seconds.isFinite, seconds >= 0, seconds <= 10 else { throw QAValidationError.waitOutOfRange }
            case .capture(let name), .state(let name):
                guard validName(name, maxLength: 40) else { throw QAValidationError.invalidName(name) }
                guard usedNames.insert(name).inserted else { throw QAValidationError.duplicateName(name) }
            case .open, .close: break
            }
        }
    }

    /// 잘렸거나 깨진 요청에서도 결과를 돌려줄 id를 찾는다(qa.sh는 id를 맨 앞에 쓴다).
    static func salvageID(from data: Data) -> String? {
        let prefix = String(decoding: data.prefix(256), as: UTF8.self)
        guard let range = prefix.range(of: #"\"id\"\s*:\s*\"([A-Za-z0-9_-]{1,64})\""#, options: .regularExpression) else { return nil }
        let match = String(prefix[range])
        guard let open = match.dropLast().lastIndex(of: "\"") else { return nil }
        let id = String(match[match.index(after: open)..<match.index(before: match.endIndex)])
        return validName(id, maxLength: 64) ? id : nil
    }

    static func validName(_ value: String, maxLength: Int) -> Bool {
        guard !value.isEmpty, value.count <= maxLength else { return false }
        return value.unicodeScalars.allSatisfy { nameCharacterSet.contains($0) }
    }
}

struct QAStateSnapshot: Codable, Equatable {
    let statusTitle: String
    let selectedTab: String
    let claudeRoutable: Int
    let claudeTotal: Int
    let teamCodexUsable: Int
    let teamCodexTotal: Int
    let menuOpen: Bool
    let panelWidth: Double
    let panelHeight: Double
}

struct QAStepResult: Codable, Equatable {
    let index: Int
    let kind: String
    let ok: Bool
    let error: String?
}

struct QAResult: Codable, Equatable {
    let id: String
    let startedAt: String
    let endedAt: String
    let completed: Bool
    let timeout: Bool
    let steps: [QAStepResult]
}

struct QAPaths {
    let root: URL
    var enabledFile: URL { root.appendingPathComponent("ENABLED") }
    var requestFile: URL { root.appendingPathComponent("request.json") }
    var outputRoot: URL { root.appendingPathComponent("out", isDirectory: true) }

    static func current() -> QAPaths {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return QAPaths(root: support.appendingPathComponent("cc-menubar/qa", isDirectory: true))
    }
}

struct QAFileSafety {
    static func pathExists(_ url: URL) -> Bool {
        var info = stat()
        return lstat(url.path, &info) == 0
    }

    static func isOwnedDirectory(_ url: URL, uid: uid_t = getuid(), mode: mode_t = 0o700) -> Bool {
        var info = stat()
        guard lstat(url.path, &info) == 0 else { return false }
        return (info.st_mode & S_IFMT) == S_IFDIR && info.st_uid == uid && (info.st_mode & 0o7777) == mode
    }

    static func isOwnedRegularFile(_ url: URL, uid: uid_t = getuid()) -> Bool {
        var info = stat()
        guard lstat(url.path, &info) == 0 else { return false }
        return (info.st_mode & S_IFMT) == S_IFREG && info.st_uid == uid
    }

    static func regularFileSize(_ url: URL) -> off_t? {
        var info = stat()
        guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return nil }
        return info.st_size
    }

    static func isEnabled(_ paths: QAPaths = .current()) -> Bool {
        isOwnedDirectory(paths.root) && isOwnedRegularFile(paths.enabledFile)
    }

    static func atomicWrite(_ data: Data, to url: URL, permissions: Int = 0o600) throws {
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).tmp-\(UUID().uuidString)")
        do {
            try data.write(to: temporary)
            try FileManager.default.setAttributes([.posixPermissions: permissions], ofItemAtPath: temporary.path)
            guard Darwin.rename(temporary.path, url.path) == 0 else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
            }
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }
}
