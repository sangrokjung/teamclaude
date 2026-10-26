import Foundation

struct CodexModelRecommendation: Equatable {
    let task: String
    let model: String
    let effort: String
}

var codexModelRecommendations: [CodexModelRecommendation] { [
    CodexModelRecommendation(task: L10n.codexTaskBuild, model: "gpt-5.6", effort: L10n.codexEffortBuild),
    CodexModelRecommendation(task: L10n.codexTaskReview, model: "gpt-5.6-sol", effort: "high / xhigh"),
    CodexModelRecommendation(task: L10n.codexTaskExplore, model: "gpt-5.6-terra", effort: "low / medium"),
    CodexModelRecommendation(task: L10n.codexTaskTriage, model: "gpt-5.6-luna", effort: "none / low"),
] }

struct CodexProfileHealth {
    let profile: String
    let todayCalls: Int
    let weekCalls: Int
    let totalCalls: Int
    let todayTokens: Int
    let weekTokens: Int
    let totalTokens: Int
    let quotaEvents: Int
    let errorEvents: Int
    let lastVerdict: String
    let lastAt: Date?
}

struct CodexCallStats {
    let todayCalls: Int
    let weekCalls: Int
    let totalCalls: Int
    let todayTokens: Int
    let weekTokens: Int
    let totalTokens: Int
    let quotaEvents: Int
    let errorEvents: Int
    let lastCallAt: Date?
    let latestModel: String?
    let planType: String?
    let contextWindow: Int?
    let primaryUsedPercent: Double?
    let secondaryUsedPercent: Double?
    let primaryResetAt: Date?
    let secondaryResetAt: Date?
    let scannedLogFiles: Int
    let scannedLogBytes: Int64
    let profiles: [CodexProfileHealth]
}

/// 한 번의 세션 코퍼스 스캔이 실제로 만진 양. 진단 로그(`CODEX-REFRESH … scan=`)용.
struct CodexScanReport: Equatable {
    let files: Int
    let changed: Int
    let bytesRead: Int64
}

struct CodexHealth {
    let checkedAt: Date
    let overallStatus: String
    let configPresent: Bool
    let authPresent: Bool
    let authMode: String?
    let authLabel: String
    let hasApiKey: Bool
    let hasTokens: Bool
    let lastRefresh: Date?
    let model: String?
    let reasoningEffort: String?
    let serviceTier: String?
    let contextWindow: Int?
    let todayCalls: Int
    let weekCalls: Int
    let totalCalls: Int
    let todayTokens: Int
    let weekTokens: Int
    let totalTokens: Int
    let quotaEvents: Int
    let errorEvents: Int
    let lastCallAt: Date?
    let planType: String?
    let scannedLogFiles: Int
    let scannedLogBytes: Int64
    let profiles: [CodexProfileHealth]
    let hints: [String]
    var scan: CodexScanReport? = nil

    var isWarning: Bool { overallStatus == "warning" }
    var isError: Bool { overallStatus == "error" }

    var titleSlot: String {
        if isError { return L10n.titleCodexReauth }
        if !authPresent || (!hasApiKey && !hasTokens) { return L10n.titleCodexLogin }
        if errorEvents > 0 { return L10n.titleCodexWarningCount(errorEvents) }
        if isWarning && todayTokens == 0 { return L10n.titleCodexWarning }
        // "Codex 3/6"(계정 풀)과 같은 꼴이면 계정 수로 읽힌다 — 이 맥에서 오늘 쓴 토큰이라고 말한다(실사용 QA 2026-10-26).
        return L10n.titleCodexTodayTokens(formatCodexTokens(todayTokens))
    }

    var statusLabel: String {
        if isError { return L10n.reauthenticate }
        if isWarning { return L10n.statusWarning }
        return L10n.statusOK
    }

    var accessibilitySummary: String {
        let modelText = model ?? "default"
        return "Codex \(statusLabel), auth \(authLabel), model \(modelText), today calls \(todayCalls), week calls \(weekCalls), today tokens \(todayTokens), week tokens \(weekTokens), quota events \(quotaEvents), error events \(errorEvents)"
    }
}

struct CodexConfigSummary {
    let present: Bool
    let model: String?
    let reasoningEffort: String?
    let serviceTier: String?
    let contextWindow: Int?
}

struct CodexMutableProfile: Codable {
    var todayCalls = 0
    var weekCalls = 0
    var totalCalls = 0
    var todayTokens = 0
    var weekTokens = 0
    var totalTokens = 0
    var quotaEvents = 0
    var errorEvents = 0
    var lastVerdict = "-"
    var lastAt: Date?
}
