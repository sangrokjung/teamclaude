import Cocoa
import Foundation

let codexISOFormatter = ISO8601DateFormatter()
let codexISOFormatterFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

let codexLabelWords: [String: String] = [
    "codex": "Codex", "max": "Max", "mini": "Mini", "pro": "Pro",
    "flash": "Flash", "high": "High", "preview": "Preview", "image": "Image", "free": "Free",
]

func codexString(_ value: Any?) -> String? {
    if let s = value as? String { return s }
    if let n = value as? NSNumber { return n.stringValue }
    return nil
}

func codexISODate(_ value: String) -> Date? {
    codexISOFormatterFractional.date(from: value) ?? codexISOFormatter.date(from: value)
}

func codexTitleWord(_ value: String) -> String {
    codexLabelWords[value.lowercased()] ?? value
}

func codexShortenModelName(_ name: String) -> String {
    var base = name
    if let r = base.range(of: "-[0-9]{8}$", options: .regularExpression) {
        base.removeSubrange(r)
    }
    let lower = base.lowercased()
    let parts = base.split(separator: "-").map(String.init)
    let tiers = ["opus", "sonnet", "haiku", "fable"]
    if lower.hasPrefix("claude"), parts.count >= 3, tiers.contains(parts[1].lowercased()) {
        let tier = parts[1].prefix(1).uppercased() + parts[1].dropFirst().lowercased()
        let nums = parts.dropFirst(2).filter { $0.allSatisfy { $0.isNumber } }
        return nums.isEmpty ? tier : "\(tier) \(nums.joined(separator: "."))"
    }
    if lower.hasPrefix("gpt") {
        let ver = parts.count > 1 ? parts[1] : ""
        let rest = parts.dropFirst(2).map { codexTitleWord($0) }
        return (["GPT-" + ver] + rest).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    }
    if lower.contains("gemini") {
        let cleaned = base.replacingOccurrences(of: "antigravity-", with: "")
        let rparts = cleaned.split(separator: "-").map(String.init).filter { $0.lowercased() != "gemini" }
        return ("Gemini " + rparts.map { codexTitleWord($0) }.joined(separator: " ")).trimmingCharacters(in: .whitespaces)
    }
    return base
}

func codexColor() -> NSColor {
    NSColor(calibratedRed: 0.00, green: 0.64, blue: 0.59, alpha: 1.0)
}

func codexHomePath() -> String {
    ProcessInfo.processInfo.environment["CC_MENUBAR_CODEX_HOME"]
        ?? "\(NSHomeDirectory())/.codex"
}

func codexCallLogPath() -> String {
    ProcessInfo.processInfo.environment["CC_MENUBAR_CODEX_CALL_LOG"]
        ?? "\(NSHomeDirectory())/.claude/cache/codex-call/calls.jsonl"
}

func codexSessionsPath() -> String {
    ProcessInfo.processInfo.environment["CC_MENUBAR_CODEX_SESSIONS"]
        ?? "\(codexHomePath())/sessions"
}

func readCodexJSON(_ path: String) -> [String: Any]? {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return nil
    }
    return obj
}

func codexInt(_ value: Any?) -> Int? {
    if let n = value as? NSNumber { return n.intValue }
    if let i = value as? Int { return i }
    if let d = value as? Double { return Int(d) }
    if let s = value as? String { return Int(s) }
    return nil
}

func codexDouble(_ value: Any?) -> Double? {
    if let n = value as? NSNumber { return n.doubleValue }
    if let d = value as? Double { return d }
    if let i = value as? Int { return Double(i) }
    if let s = value as? String { return Double(s) }
    return nil
}

func parseCodexDate(_ value: Any?) -> Date? {
    if let n = value as? NSNumber {
        let seconds = n.doubleValue > 10_000_000_000 ? n.doubleValue / 1000.0 : n.doubleValue
        return Date(timeIntervalSince1970: seconds)
    }
    if let d = value as? Double {
        let seconds = d > 10_000_000_000 ? d / 1000.0 : d
        return Date(timeIntervalSince1970: seconds)
    }
    if let s = value as? String {
        if let d = Double(s) {
            let seconds = d > 10_000_000_000 ? d / 1000.0 : d
            return Date(timeIntervalSince1970: seconds)
        }
        return codexISODate(s)
    }
    return nil
}

func safeCodexLabel(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "default" }
    if let at = trimmed.firstIndex(of: "@") {
        let head = trimmed[..<at]
        let domain = trimmed[trimmed.index(after: at)...]
        let shortHead = String(head.prefix(3))
        let shortDomain = String(domain.prefix(8))
        return "\(shortHead)…@\(shortDomain)…"
    }
    return trimmed.count > 22 ? String(trimmed.prefix(21)) + "…" : trimmed
}

func codexTomlValue(_ raw: String) -> String? {
    var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.hasPrefix("\"") {
        let rest = value.dropFirst()
        if let end = rest.firstIndex(of: "\"") {
            return String(rest[..<end])
        }
    }
    if let hash = value.firstIndex(of: "#") {
        value = String(value[..<hash]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    return value.isEmpty ? nil : value
}

func formatCodexTokens(_ value: Int) -> String {
    let n = Double(value)
    if value >= 1_000_000_000 {
        return String(format: "%.1fB", n / 1_000_000_000)
    }
    if value >= 1_000_000 {
        return String(format: "%.1fM", n / 1_000_000)
    }
    if value >= 1_000 {
        return String(format: "%.1fK", n / 1_000)
    }
    return "\(value)"
}

func formatCodexPercent(_ value: Double?) -> String {
    guard let value = value else { return "-" }
    return "\(Int(value.rounded()))%"
}

func formatCodexLimitPair(_ primary: Double?, _ secondary: Double?) -> String? {
    guard primary != nil || secondary != nil else { return nil }
    return "\(formatCodexPercent(primary))/\(formatCodexPercent(secondary))"
}

func formatCodexAge(_ date: Date?) -> String {
    guard let date = date else { return "-" }
    let seconds = max(0, Int(Date().timeIntervalSince(date)))
    if seconds < 60 { return "방금" }
    if seconds < 3_600 { return "\(seconds / 60)m 전" }
    if seconds < 86_400 { return "\(seconds / 3_600)h 전" }
    return "\(seconds / 86_400)d 전"
}

func formatCodexReset(_ date: Date?) -> String {
    guard let date = date else { return "-" }
    let seconds = Int(date.timeIntervalSince(Date()))
    if seconds <= 0 { return "reset" }
    if seconds < 60 { return "\(seconds)s" }
    if seconds < 3_600 { return "\(seconds / 60)m" }
    if seconds < 86_400 { return "\(seconds / 3_600)h" }
    return "\(seconds / 86_400)d"
}

func formatCodexVerdict(_ value: String) -> String {
    switch value.lowercased() {
    case "ok": return "OK"
    case "pass_quota": return "QUOTA"
    case "pass_empty": return "EMPTY"
    case "pass_error": return "ERROR"
    case "config_broken": return "CONFIG"
    case "pass_old_cli": return "OLD CLI"
    default: return value.isEmpty ? "-" : value.uppercased()
    }
}
