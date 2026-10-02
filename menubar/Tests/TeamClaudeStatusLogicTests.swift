import Foundation

@main
struct TeamClaudeStatusLogicTests {
    static func main() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var redFailures: [String] = []
        func expectRed(_ id: String, _ condition: @autoclosure () -> Bool) {
            if !condition() { redFailures.append(id) }
        }

        let noDrift = teamClaudeAccountDrift(configuredNames: ["a", "b"], serverNames: ["b", "a"])
        precondition(noDrift.isEmpty)
        let drift = teamClaudeAccountDrift(
            configuredNames: ["a", "b"],
            serverNames: ["b", "c"],
            configuredEnabled: ["a": true, "b": false],
            serverEnabled: ["b": true, "c": true]
        )
        precondition(drift.missingFromServer == ["a"])
        precondition(drift.extraOnServer == ["c"])
        precondition(drift.stateMismatch == ["b"])
        precondition(drift.count == 3)
        precondition(teamClaudeRecoveryReason(serverReachable: false, configPresent: true, accountConfigDrift: 0) == .serverOffline)
        precondition(teamClaudeRecoveryReason(serverReachable: true, configPresent: true, accountConfigDrift: 2) == .accountDrift(2))
        precondition(teamClaudeRecoveryReason(serverReachable: false, configPresent: false, accountConfigDrift: 0) == nil)
        precondition(teamClaudeRecoveryReason(serverReachable: true, configPresent: true, accountConfigDrift: 0) == nil)
        precondition(!teamClaudeShouldRetainQuota(candidateReachable: true, hasMeasuredQuota: true))
        precondition(!teamClaudeShouldRetainQuota(candidateReachable: false, hasMeasuredQuota: false))
        precondition(teamClaudeShouldRetainQuota(candidateReachable: false, hasMeasuredQuota: true))
        var refreshCoordinator = TeamClaudeRefreshCoordinator()
        precondition(refreshCoordinator.request())
        precondition(!refreshCoordinator.request())
        expectRed("C3-inflight-request-reruns", refreshCoordinator.finish())
        precondition(!refreshCoordinator.isRunning)
        let previousPair = TeamClaudeQuotaPair(
            weeklyPercent: 20,
            weeklyResetSeconds: 100,
            fablePercent: 30,
            fableResetSeconds: 200
        )
        precondition(teamClaudeQuotaPair(
            weeklyPercent: 21,
            weeklyResetSeconds: 101,
            fablePercent: 31,
            fableResetSeconds: 201
        ) != nil)
        precondition(teamClaudeQuotaPair(
            weeklyPercent: 21,
            weeklyResetSeconds: 101,
            fablePercent: nil,
            fableResetSeconds: nil
        ) == nil)
        expectRed("C4-partial-keeps-previous-pair", teamClaudeMergedQuotaPair(
            candidate: nil,
            previous: previousPair
        ) == previousPair)
        expectRed("C6-fallback-reset-counts-down", teamClaudeAdjustedQuotaPair(
            previousPair,
            elapsedSeconds: 50
        ) == TeamClaudeQuotaPair(
            weeklyPercent: 20,
            weeklyResetSeconds: 50,
            fablePercent: 30,
            fableResetSeconds: 150
        ))
        expectRed("C6-expired-fallback-pair-dropped", teamClaudeAdjustedQuotaPair(
            previousPair,
            elapsedSeconds: 100
        ) == nil)
        precondition(teamClaudeAdjustedResetSeconds(100, elapsedSeconds: 40) == 60)
        precondition(teamClaudeAdjustedResetSeconds(100, elapsedSeconds: 100) == nil)
        precondition(teamClaudeSafeInt64(42) == 42)
        precondition(teamClaudeSafeInt64(.nan) == nil)
        precondition(teamClaudeSafeInt64(.infinity) == nil)
        precondition(teamClaudeSafeInt64(9_223_372_036_854_775_808.0) == nil)
        precondition(teamClaudeBoundedCount(12, maximum: 100) == 12)
        precondition(teamClaudeBoundedCount(-1, maximum: 100) == 0)
        precondition(teamClaudeBoundedCount(101, maximum: 100) == 0)
        precondition(teamClaudeAddingCounts(60, 50, maximum: 100) == 100)
        precondition(teamClaudeAddingCounts(Int.max, 1, maximum: 100) == 100)
        expectRed("C5-stale-candidate-rejected", !teamClaudeCandidateIsCurrent(
            candidateCheckedAt: now.addingTimeInterval(-1),
            currentCheckedAt: now
        ))
        precondition(teamClaudeFableSummary(
            values: [100, 30],
            thresholdPercent: 98
        ) == TeamClaudeFableSummary(known: 2, over: 1, maximum: 100, average: 65))
        precondition(nextTeamClaudeOutageStartedAt(previous: nil, candidateReachable: false, observedAt: 100) == 100)
        precondition(nextTeamClaudeOutageStartedAt(previous: 100, candidateReachable: false, observedAt: 101) == 100)
        precondition(nextTeamClaudeOutageStartedAt(previous: 100, candidateReachable: true, observedAt: 101) == nil)
        precondition(!teamClaudeShouldAutoRecover(
            candidateReachable: false,
            accountConfigDrift: 0,
            outageDurationSeconds: 0
        ))
        precondition(!teamClaudeShouldAutoRecover(
            candidateReachable: false,
            accountConfigDrift: 0,
            outageDurationSeconds: 34.1
        ))
        precondition(!teamClaudeShouldAutoRecover(
            candidateReachable: false,
            accountConfigDrift: 0,
            outageDurationSeconds: 59.9
        ))
        precondition(teamClaudeShouldAutoRecover(
            candidateReachable: false,
            accountConfigDrift: 0,
            outageDurationSeconds: 60
        ))
        precondition(teamClaudeShouldAutoRecover(
            candidateReachable: true,
            accountConfigDrift: 1,
            outageDurationSeconds: 0
        ))
        precondition(teamClaudeShouldAttemptRecoveryForOutage(
            outageStartedAt: 100,
            attemptedOutageStartedAt: nil
        ))
        precondition(!teamClaudeShouldAttemptRecoveryForOutage(
            outageStartedAt: 100,
            attemptedOutageStartedAt: 100
        ))
        precondition(teamClaudeShouldAttemptRecoveryForOutage(
            outageStartedAt: 101,
            attemptedOutageStartedAt: 100
        ))
        precondition(!teamClaudeShouldAttemptRecoveryForOutage(
            outageStartedAt: nil,
            attemptedOutageStartedAt: 100
        ))
        precondition(teamClaudeShouldAttemptRecoveryForDrift(
            topologySignature: 10,
            attemptedTopologySignature: nil
        ))
        precondition(!teamClaudeShouldAttemptRecoveryForDrift(
            topologySignature: 10,
            attemptedTopologySignature: 10
        ))
        precondition(teamClaudeShouldAttemptRecoveryForDrift(
            topologySignature: 11,
            attemptedTopologySignature: 10
        ))

        precondition(teamClaudeSessionState(percent: 42, lastUsed: nil, now: now) == .measured(42))
        precondition(teamClaudeSessionState(percent: nil, lastUsed: now.addingTimeInterval(-5 * 60 * 60), now: now) == .stale)
        precondition(teamClaudeSessionState(percent: nil, lastUsed: now.addingTimeInterval(-60), now: now) == .unknown)
        precondition(teamClaudeSessionState(percent: nil, lastUsed: nil, now: now) == .unknown)

        precondition(!teamClaudeQuotaNeedsRefresh(
            sessionPercent: nil,
            weeklyPercent: 98,
            fablePercent: 100,
            lastUsed: now.addingTimeInterval(-6 * 60 * 60),
            now: now
        ))
        precondition(!teamClaudeQuotaNeedsRefresh(
            sessionPercent: nil,
            weeklyPercent: 98,
            fablePercent: 100,
            lastUsed: now.addingTimeInterval(-60),
            now: now
        ))
        precondition(teamClaudeQuotaNeedsRefresh(
            sessionPercent: 10,
            weeklyPercent: nil,
            fablePercent: 20,
            lastUsed: now,
            now: now
        ))
        precondition(teamClaudeAccountIsUsable(enabled: true, status: "active", sessionPercent: 10, weeklyPercent: 20, fablePercent: 30, thresholdPercent: 98))
        precondition(teamClaudeAccountIsUsable(enabled: true, status: "active", sessionPercent: 10, weeklyPercent: 20, fablePercent: 100, thresholdPercent: 98))
        precondition(teamClaudeAccountIsUsable(enabled: true, status: "active", sessionPercent: 10, weeklyPercent: 20, fablePercent: nil, thresholdPercent: 98))
        precondition(!teamClaudeAccountIsUsable(enabled: true, status: "active", sessionPercent: nil, weeklyPercent: 20, fablePercent: 30, thresholdPercent: 98))
        precondition(!teamClaudeAccountIsUsable(enabled: true, status: "active", sessionPercent: 10, weeklyPercent: 98, fablePercent: 30, thresholdPercent: 98))

        precondition(teamClaudeMeasurementIssue(
            enabled: true, status: "active", sessionPercent: nil, weeklyPercent: 20,
            fablePercent: 30, lastUsed: now.addingTimeInterval(-6 * 60 * 60), now: now
        ) == .staleSession)
        let quotaBlockedIssue = teamClaudeMeasurementIssue(
            enabled: true, status: "active", sessionPercent: nil, weeklyPercent: 98,
            fablePercent: 100, lastUsed: now.addingTimeInterval(-6 * 60 * 60), now: now
        )
        precondition(quotaBlockedIssue == .quotaBlocked)
        precondition(!(quotaBlockedIssue?.displayText.contains("측정") ?? true))
        precondition(quotaBlockedIssue?.isQuotaLimited == true)
        precondition(quotaBlockedIssue?.isMeasurementUnavailable == false)
        precondition(TeamClaudeMeasurementIssue.throttled.isMeasurementUnavailable)
        precondition(TeamClaudeMeasurementIssue.exhausted.isMeasurementUnavailable)
        precondition(teamClaudeMeasurementIssue(
            enabled: true, status: "configured", sessionPercent: nil, weeklyPercent: nil,
            fablePercent: nil, lastUsed: nil, now: now
        ) == .serverNotSynced)
        precondition(teamClaudeMeasurementIssue(
            enabled: false, status: "active", sessionPercent: nil, weeklyPercent: nil,
            fablePercent: nil, lastUsed: nil, now: now
        ) == .disabled)
        precondition(teamClaudeMeasurementIssue(
            enabled: true, status: "active", sessionPercent: 10, weeklyPercent: 20,
            fablePercent: 30, lastUsed: now, now: now
        ) == nil)
        precondition(teamClaudeMeasurementIssue(
            enabled: true, status: "active", sessionPercent: 10, weeklyPercent: 20,
            fablePercent: 100, lastUsed: now, now: now
        ) == nil)
        let accountErrorIssue = teamClaudeMeasurementIssue(
            enabled: true, status: "error", sessionPercent: nil, weeklyPercent: nil,
            fablePercent: nil, lastUsed: nil, now: now
        )
        precondition(accountErrorIssue == .accountError)
        precondition(accountErrorIssue?.canMeasureNow == true)
        let throttledIssue = teamClaudeMeasurementIssue(
            enabled: true, status: "throttled", sessionPercent: nil, weeklyPercent: nil,
            fablePercent: nil, lastUsed: nil, now: now
        )
        precondition(throttledIssue == .throttled)
        precondition(throttledIssue?.isMeasurementUnavailable == true)
        let exhaustedIssue = teamClaudeMeasurementIssue(
            enabled: true, status: "exhausted", sessionPercent: nil, weeklyPercent: nil,
            fablePercent: nil, lastUsed: nil, now: now
        )
        precondition(exhaustedIssue == .exhausted)
        precondition(exhaustedIssue?.isMeasurementUnavailable == true)
        precondition(teamClaudeMeasurementIssue(
            enabled: true, status: "active", sessionPercent: nil, weeklyPercent: nil,
            fablePercent: nil, lastUsed: nil, now: now
        ) == .sessionMissing)
        precondition(teamClaudeMeasurementIssue(
            enabled: false, status: "active", sessionPercent: nil, weeklyPercent: 100,
            fablePercent: 100, lastUsed: nil, now: now
        ) == .disabled)
        precondition(teamClaudeMeasurementIssue(
            enabled: true, status: "active", sessionPercent: 10, weeklyPercent: 20,
            fablePercent: nil, lastUsed: now, now: now
        ) == .fableMissing)

        precondition(teamClaudeCanReauthenticate(
            enabled: true,
            status: "error",
            source: "oauth",
            provider: "anthropic",
            errorReason: "auth-revoked"
        ))
        precondition(!teamClaudeCanReauthenticate(
            enabled: true,
            status: "active",
            source: "oauth",
            provider: "anthropic",
            errorReason: nil
        ))
        precondition(!teamClaudeCanReauthenticate(
            enabled: false,
            status: "error",
            source: "oauth",
            provider: "anthropic",
            errorReason: "auth-revoked"
        ))
        precondition(!teamClaudeCanReauthenticate(
            enabled: true,
            status: "error",
            source: "apikey",
            provider: "anthropic",
            errorReason: "auth-revoked"
        ))
        precondition(!teamClaudeCanReauthenticate(
            enabled: true,
            status: "error",
            source: "oauth",
            provider: "codex",
            errorReason: "auth-revoked"
        ))
        precondition(!teamClaudeCanReauthenticate(
            enabled: true,
            status: "error",
            source: "oauth",
            provider: "anthropic",
            errorReason: "subscription-disabled"
        ))

        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        precondition(teamClaudeCurrentQuotaUtilization(
            0.9, resetAtMs: nowMs - 1, nowMs: nowMs
        ) == nil)
        precondition(teamClaudeCurrentQuotaUtilization(
            0.9, resetAtMs: nowMs + 1, nowMs: nowMs
        ) == 0.9)
        expectRed("C2-missing-reset-invalid", teamClaudeCurrentQuotaUtilization(
            0.9, resetAtMs: nil, nowMs: nowMs
        ) == nil)
        expectRed("C2-nan-invalid", teamClaudeCurrentQuotaUtilization(
            .nan, resetAtMs: nowMs + 1, nowMs: nowMs
        ) == nil)
        expectRed("C2-over-limit-still-valid", teamClaudeCurrentQuotaUtilization(
            1.1, resetAtMs: nowMs + 1, nowMs: nowMs
        ) == 1.1)
        precondition(teamClaudeCurrentQuotaUtilization(
            -0.1, resetAtMs: nowMs + 1, nowMs: nowMs
        ) == nil)
        let retryAccounts = [
            TeamClaudeRetryAccountState(
                enabled: true,
                status: "active",
                rateLimitedUntilMs: nil,
                windows: [TeamClaudeQuotaWindowState(utilization: 0.2, resetAtMs: nowMs + 60_000)]
            ),
            TeamClaudeRetryAccountState(
                enabled: true,
                status: "active",
                rateLimitedUntilMs: nil,
                windows: [
                    TeamClaudeQuotaWindowState(utilization: 1.0, resetAtMs: nowMs + 420_000),
                    TeamClaudeQuotaWindowState(utilization: 0.3, resetAtMs: nowMs + 900_000),
                ]
            ),
        ]
        precondition(teamClaudeRetryAfterSeconds(
            accounts: retryAccounts, threshold: 0.98, nowMs: nowMs
        ) == 420)
        precondition(teamClaudeRetryAfterSeconds(
            accounts: [
                TeamClaudeRetryAccountState(
                    enabled: true,
                    status: "active",
                    rateLimitedUntilMs: nil,
                    windows: [TeamClaudeQuotaWindowState(utilization: 1.0, resetAtMs: nowMs - 1)]
                ),
            ],
            threshold: 0.98,
            nowMs: nowMs
        ) == nil)
        precondition(teamClaudeRetryAfterSeconds(
            accounts: [
                TeamClaudeRetryAccountState(
                    enabled: true,
                    status: "exhausted",
                    rateLimitedUntilMs: nil,
                    windows: []
                ),
            ],
            threshold: 0.98,
            nowMs: nowMs
        ) == 60)

        let sessionOnlyLimit = TeamClaudeOverallStatusInput(
            serverReachable: true,
            configPresent: true,
            allAccountsError: false,
            quotaLimitedCount: 1,
            hasOtherWarning: false
        )
        precondition(teamClaudeOverallStatus(sessionOnlyLimit) == "warning")
        precondition(teamClaudeTitleSlot(TeamClaudeHeadlineInput(
            serverReachable: true,
            accountConfigDrift: 0,
            measurementPendingCount: 0,
            quotaLimitedCount: 1,
            fableKnown: 13,
            fableOver: 0,
            totalAccounts: 13,
            accountUsable: 4,
            accountActive: 13
        )) == "Claude 라우팅 4/13")
        precondition(teamClaudeTitleSlot(TeamClaudeHeadlineInput(
            serverReachable: true,
            accountConfigDrift: 0,
            measurementPendingCount: 0,
            quotaLimitedCount: 13,
            fableKnown: 13,
            fableOver: 13,
            totalAccounts: 13,
            accountUsable: 0,
            accountActive: 13
        )) == "Claude Fable 한도 13/13")

        if !redFailures.isEmpty {
            print("TeamClaudeStatusLogicTests RED failures: \(redFailures.joined(separator: ", "))")
            fflush(stdout)
        }
        precondition(redFailures.isEmpty)
        print("TeamClaudeStatusLogicTests: 73 passed, 0 failed")
    }
}
