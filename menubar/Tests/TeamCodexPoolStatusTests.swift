import Foundation

private final class RedirectProbeURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var localRequests = 0
    private static var externalRequests = 0
    private static var externalAPIKeys: [String] = []

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        localRequests = 0
        externalRequests = 0
        externalAPIKeys = []
    }

    static func counts() -> (local: Int, external: Int, externalAPIKeys: [String]) {
        lock.lock()
        defer { lock.unlock() }
        return (localRequests, externalRequests, externalAPIKeys)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let isLocal = request.url?.host == "127.0.0.1"
        Self.lock.lock()
        if isLocal {
            Self.localRequests += 1
        } else {
            Self.externalRequests += 1
            if let key = request.value(forHTTPHeaderField: "x-api-key") {
                Self.externalAPIKeys.append(key)
            }
        }
        Self.lock.unlock()

        let response: HTTPURLResponse
        if isLocal {
            response = HTTPURLResponse(
                url: request.url!,
                statusCode: 302,
                httpVersion: nil,
                headerFields: ["Location": "https://external.invalid/steal"]
            )!
        } else {
            response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
        }
        if isLocal {
            client?.urlProtocol(
                self,
                wasRedirectedTo: URLRequest(url: URL(string: "https://external.invalid/steal")!),
                redirectResponse: response
            )
        } else {
            client?.urlProtocol(
                self,
                didReceive: response,
                cacheStoragePolicy: .notAllowed
            )
            client?.urlProtocol(self, didLoad: Data("redirect-followed".utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

@main
struct TeamCodexPoolStatusTests {
    static func main() throws {
        let statusRequest = teamCodexStatusRequest(port: 3457, apiKey: "test-proxy-key")
        precondition(statusRequest?.value(forHTTPHeaderField: "x-api-key") == "test-proxy-key")
        precondition(statusRequest?.value(forHTTPHeaderField: "x-teamcodex-status-identity") == "1")
        let unauthenticatedStatusRequest = teamCodexStatusRequest(port: 3457, apiKey: nil)
        precondition(unauthenticatedStatusRequest?.value(forHTTPHeaderField: "x-api-key") == nil)
        precondition(unauthenticatedStatusRequest?.value(forHTTPHeaderField: "x-teamcodex-status-identity") == nil)

        RedirectProbeURLProtocol.reset()
        let redirectConfiguration = URLSessionConfiguration.ephemeral
        redirectConfiguration.protocolClasses = [RedirectProbeURLProtocol.self]
        let redirectedData = teamCodexFetchStatus(
            port: 3457,
            apiKey: "test-proxy-key",
            sessionConfiguration: redirectConfiguration
        )
        let redirectCounts = RedirectProbeURLProtocol.counts()
        precondition(redirectedData == nil)
        precondition(redirectCounts.local == 1)
        precondition(redirectCounts.external == 0)
        precondition(redirectCounts.externalAPIKeys.isEmpty)

        let checkedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let sessionResetMs = Int64((checkedAt.timeIntervalSince1970 + 16_200) * 1_000)
        let weeklyResetMs = Int64((checkedAt.timeIntervalSince1970 + 176_400) * 1_000)

        var refreshCoordinator = TeamCodexConfigRefreshCoordinator()
        precondition(refreshCoordinator.request(generation: 1))
        precondition(refreshCoordinator.shouldContinue(generation: 1))
        precondition(!refreshCoordinator.request(generation: 2))
        precondition(!refreshCoordinator.request(generation: 3))
        precondition(refreshCoordinator.pendingGeneration == 3)
        precondition(!refreshCoordinator.shouldContinue(generation: 1))
        precondition(refreshCoordinator.finish(generation: 1))
        precondition(refreshCoordinator.request(generation: 3))
        precondition(refreshCoordinator.shouldContinue(generation: 3))
        precondition(!refreshCoordinator.finish(generation: 3))

        // Given: TeamCodex 프록시가 반환하는 실제 status 형태
        let fixture: [String: Any] = [
            "currentAccount": "codex-main",
            "currentAccountUuid": "uuid-main",
            "switchThreshold": 0.98,
            "accounts": [
                [
                    "name": "codex-main",
                    "accountUuid": "uuid-main",
                    "status": "active",
                    "enabled": true,
                    "inflight": 1,
                    "maxConcurrent": 3,
                    "quota": [
                        "unified5h": 0.42,
                        "unified5hReset": sessionResetMs,
                        "unified7d": 0.67,
                        "unified7dReset": weeklyResetMs,
                    ],
                    "usage": [
                        "totalRequests": 12,
                        "totalInputTokens": 1_200,
                        "totalOutputTokens": 300,
                    ],
                ],
                [
                    "name": "codex-backup",
                    "status": "disabled",
                    "enabled": false,
                    "inflight": 0,
                    "maxConcurrent": 2,
                    "quota": [:],
                    "usage": [:],
                ],
                [
                    "name": "codex-limited",
                    "status": "active",
                    "enabled": true,
                    "inflight": 0,
                    "maxConcurrent": 3,
                    "quota": [
                        "unified5h": 1.0,
                        "unified5hReset": sessionResetMs,
                    ],
                    "usage": [:],
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: fixture)

        // When: 앱 표시 모델로 파싱
        let health = try teamCodexPoolHealth(
            from: data,
            port: 3457,
            serverPid: 1234,
            checkedAt: checkedAt
        )

        // Then: 현재 계정·쿼터·동시 요청·사용량이 보존됨
        precondition(health.serverReachable)
        precondition(health.serverPort == 3457)
        precondition(health.serverPid == 1234)
        precondition(health.currentAccount == "codex-main")
        precondition(health.currentAccountUuid == "uuid-main")
        precondition(health.accounts.count == 3)
        precondition(health.currentQuotaAccount?.name == "codex-main")
        precondition(health.currentQuotaAccount?.sessionUsagePercent(at: checkedAt) == 42)
        precondition(health.currentQuotaAccount?.weeklyUsagePercent(at: checkedAt) == 67)
        precondition(health.accounts[0].sessionUsagePercent(at: Date(timeIntervalSince1970: Double(sessionResetMs) / 1_000)) == nil)

        let missingWindowFixture: [String: Any] = [
            "currentAccount": "weekly-only",
            "accounts": [[
                "name": "weekly-only", "status": "active",
                "quota": ["unified5h": 0, "unified7d": 0, "unified7dReset": weeklyResetMs],
            ]],
        ]
        let weeklyOnly = try teamCodexPoolHealth(
            from: JSONSerialization.data(withJSONObject: missingWindowFixture),
            port: 3457, serverPid: 1234, checkedAt: checkedAt
        )
        precondition(weeklyOnly.currentQuotaAccount?.sessionUsagePercent(at: checkedAt) == nil)
        precondition(weeklyOnly.currentQuotaAccount?.weeklyUsagePercent(at: checkedAt) == 0)
        var noCurrentFixture = missingWindowFixture
        noCurrentFixture["currentAccount"] = "not-in-pool"
        let noCurrent = try teamCodexPoolHealth(
            from: JSONSerialization.data(withJSONObject: noCurrentFixture),
            port: 3457, serverPid: 1234, checkedAt: checkedAt
        )
        precondition(noCurrent.currentQuotaAccount == nil)
        let resetWithoutUsage = TeamCodexPoolAccount(
            name: "partial", accountUuid: nil, isCurrent: true, enabled: true,
            status: "active", errorReason: nil, usableFromProxy: true,
            sessionPercent: nil, sessionResetAt: nil, weeklyPercent: nil,
            weeklyResetAt: checkedAt.addingTimeInterval(3_600),
            inflight: 0, maxConcurrent: 3, totalRequests: 1, totalTokens: 1
        )
        precondition(resetWithoutUsage.weeklyUsagePercent(at: checkedAt) == nil)
        precondition(health.activeCount == 2)
        precondition(health.usableCount == 1)
        precondition(health.accounts[0].isCurrent)
        precondition(health.accounts[0].accountUuid == "uuid-main")
        precondition(health.accounts[0].sessionPercent == 42)
        precondition(health.accounts[0].sessionResetAt == Date(timeIntervalSince1970: Double(sessionResetMs) / 1_000))
        precondition(health.accounts[0].weeklyPercent == 67)
        precondition(health.accounts[0].weeklyResetAt == Date(timeIntervalSince1970: Double(weeklyResetMs) / 1_000))
        precondition(formatTeamCodexResetRemaining(health.accounts[0].sessionResetAt, now: checkedAt) == "4시간 30분 후")
        precondition(formatTeamCodexResetRemaining(health.accounts[0].weeklyResetAt, now: checkedAt) == "2일 1시간 후")
        precondition(health.accounts[0].inflight == 1)
        precondition(health.accounts[0].maxConcurrent == 3)
        precondition(health.accounts[0].totalRequests == 12)
        precondition(health.accounts[0].totalTokens == 1_500)
        precondition(!health.accounts[1].enabled)
        precondition(health.accounts[2].isQuotaBlocked(switchThresholdPercent: health.switchThresholdPercent))
        precondition(!health.accounts[2].isUsable(switchThresholdPercent: health.switchThresholdPercent))
        precondition(formatTeamCodexResetRemaining(nil, now: checkedAt) == "시각 미측정")
        precondition(formatTeamCodexResetRemaining(checkedAt.addingTimeInterval(-1), now: checkedAt) == "갱신 확인 중")

        let duplicateUuidData = try JSONSerialization.data(withJSONObject: [
            "currentAccount": "first",
            "currentAccountUuid": "duplicate-uuid",
            "accounts": [
                ["name": "first", "accountUuid": "duplicate-uuid"],
                ["name": "second", "accountUuid": "duplicate-uuid"],
            ],
        ])
        let duplicateUuid = try teamCodexPoolHealth(
            from: duplicateUuidData,
            port: 3457,
            serverPid: nil
        )
        precondition(duplicateUuid.currentAccount == nil)
        precondition(duplicateUuid.currentAccountUuid == nil)
        precondition(duplicateUuid.accounts.count == 2)
        precondition(duplicateUuid.accounts.allSatisfy { !$0.isCurrent })

        let duplicateNameData = try JSONSerialization.data(withJSONObject: [
            "currentAccount": "duplicate-name",
            "accounts": [
                ["name": "duplicate-name"],
                ["name": "duplicate-name"],
            ],
        ])
        let duplicateName = try teamCodexPoolHealth(
            from: duplicateNameData,
            port: 3457,
            serverPid: nil
        )
        precondition(duplicateName.currentAccount == nil)
        precondition(duplicateName.currentAccountUuid == nil)
        precondition(duplicateName.accounts.allSatisfy { !$0.isCurrent })

        // Given: 서버가 꺼져도 설정에는 계정이 남아 있음
        let config: [String: Any] = [
            "accounts": [
                ["name": "configured-only", "accountUuid": "uuid-configured", "type": "oauth"],
                ["name": "configured-off", "enabled": false, "type": "oauth"],
            ],
        ]
        let configData = try JSONSerialization.data(withJSONObject: config)

        // When/Then: 앱은 계정 자체를 숨기지 않고 오프라인 상태로 표시
        let offline = try teamCodexPoolOfflineHealth(
            configData: configData,
            port: 3457,
            serverPid: nil
        )
        precondition(offline.currentQuotaAccount == nil)
        precondition(!offline.serverReachable)
        precondition(offline.statusLabel == "오프라인")
        precondition(offline.accounts.count == 2)
        precondition(offline.accounts[0].name == "configured-only")
        precondition(offline.accounts[0].accountUuid == "uuid-configured")
        // 프록시가 안 떠 있으면 지금 응답할 수 있는 계정은 0이다.
        // 설정 파일에만 있는 행을 "사용 가능"으로 세면 요약줄이 행 라벨("설정됨")과 어긋난다.
        precondition(offline.accounts[0].usableFromProxy == nil)
        precondition(!offline.accounts[0].isUsable(
            switchThresholdPercent: offline.switchThresholdPercent
        ))
        precondition(offline.usableCount == 0)
        precondition(offline.poolCount == 1)
        precondition(offline.excludedCount == 1)
        precondition(teamCodexAccountStatusLabel(
            offline.accounts[0],
            switchThresholdPercent: offline.switchThresholdPercent
        ) == "설정됨")
        precondition(teamCodexAccountStatusLabel(
            offline.accounts[1],
            switchThresholdPercent: offline.switchThresholdPercent
        ) == "비활성")
        precondition(offline.accessibilitySummary
            == "TeamCodex 오프라인, 지금 쓸 수 있는 계정 0개, 풀에 남은 계정 1개, 풀에서 빠진 계정 1개")

        // Given: 새 프록시 필드(errorReason·usable)가 포함된 상태 (2026-08 프록시)
        let reasonFixture: [String: Any] = [
            "accounts": [
                [
                    "name": "codex-lapsed",
                    "status": "error",
                    "enabled": true,
                    "errorReason": "subscription-disabled",
                    "usable": false,
                ],
                [
                    "name": "codex-forced-usable",
                    "status": "active",
                    "enabled": true,
                    "usable": true,
                    "quota": ["unified5h": 1.0, "unified5hReset": sessionResetMs],
                ],
                [
                    "name": "codex-legacy",
                    "status": "active",
                    "enabled": true,
                    "quota": ["unified5h": 1.0, "unified5hReset": sessionResetMs],
                ],
            ],
        ]
        let reasonData = try JSONSerialization.data(withJSONObject: reasonFixture)
        let reasonHealth = try teamCodexPoolHealth(from: reasonData, port: 3457, serverPid: nil)
        let reasonThreshold = reasonHealth.switchThresholdPercent

        // Then: errorReason 보존 + usable:false → 사용 불가
        let lapsedAccount = reasonHealth.accounts[0]
        precondition(lapsedAccount.errorReason == "subscription-disabled")
        precondition(lapsedAccount.usableFromProxy == false)
        precondition(!lapsedAccount.isUsable(switchThresholdPercent: reasonThreshold))
        precondition(teamAccountErrorReasonLabel("subscription-disabled") == "조직차단")
        precondition(teamAccountErrorReasonLabel("auth-revoked") == "인증만료")
        precondition(teamAccountErrorReasonLabel(nil) == "오류")

        // usable:true → 쿼터가 꽉 차도 프록시 판정을 신뢰
        let forcedUsable = reasonHealth.accounts[1]
        precondition(forcedUsable.usableFromProxy == true)
        precondition(forcedUsable.isQuotaBlocked(switchThresholdPercent: reasonThreshold))
        precondition(forcedUsable.isUsable(switchThresholdPercent: reasonThreshold))

        // 구 프록시(필드 없음) → nil + 기존 computed 폴백 유지
        let legacyAccount = reasonHealth.accounts[2]
        precondition(legacyAccount.errorReason == nil)
        precondition(legacyAccount.usableFromProxy == nil)
        precondition(!legacyAccount.isUsable(switchThresholdPercent: reasonThreshold))

        // 기존 fixture의 old-style row도 errorReason nil
        precondition(health.accounts[0].errorReason == nil)

        // Given: 구독 상태·플랜까지 담긴 2026-09 프록시 payload
        // (enabled와 status는 독립이다 — 꺼 둔 계정도 status는 계속 "active"로 온다)
        let subscriptionFixture: [String: Any] = [
            "switchThreshold": 1.0,
            "accounts": [
                [
                    "name": "healthy",
                    "status": "active",
                    "enabled": true,
                    "usable": true,
                    "planType": "pro",
                    "subscription": ["state": "active"],
                    "quota": ["unified7d": 0.12, "unified7dReset": weeklyResetMs],
                ],
                [
                    "name": "weekly-full",
                    "status": "active",
                    "enabled": true,
                    "usable": false,
                    "planType": "pro",
                    "subscription": ["state": "active"],
                    "quota": ["unified7d": 1.0, "unified7dReset": weeklyResetMs],
                ],
                [
                    "name": "ending-but-serving",
                    "status": "active",
                    "enabled": true,
                    "usable": true,
                    "planType": "pro",
                    "subscription": [
                        "state": "cancellation-scheduled",
                        "endsAt": "2023-11-17T22:13:20.000Z",
                    ],
                    "quota": ["unified7d": 0.4, "unified7dReset": weeklyResetMs],
                ],
                [
                    "name": "ended",
                    "status": "error",
                    "enabled": false,
                    "errorReason": "subscription-ended",
                    "usable": false,
                    "planType": "free",
                    "subscription": ["state": "ended"],
                    "quota": [:],
                ],
                [
                    "name": "end-date-reached",
                    "status": "active",
                    "enabled": true,
                    "usable": false,
                    "planType": "free",
                    "subscription": [
                        "state": "end-date-reached",
                        "endsAt": "2023-11-13T22:13:20.000Z",
                    ],
                    "quota": ["unified7d": 1.0, "unified7dReset": weeklyResetMs],
                ],
                [
                    "name": "switched-off",
                    "status": "active",
                    "enabled": false,
                    "usable": false,
                    "planType": "free",
                    "subscription": ["state": "cancellation-scheduled"],
                    "quota": ["unified7d": 1.0, "unified7dReset": weeklyResetMs],
                ],
                [
                    "name": "paused",
                    "status": "active",
                    "enabled": true,
                    "usable": false,
                    "planType": "pro",
                    "subscription": ["state": "active"],
                    "quota": ["unified7d": 0.3, "unified7dReset": weeklyResetMs],
                ],
                [
                    // 해지 예약인데 종료 시각이 이미 지났다. 프록시 state가 아직 안 넘어가도 종료다.
                    "name": "scheduled-past",
                    "status": "active",
                    "enabled": true,
                    "usable": false,
                    "planType": "pro",
                    "subscription": [
                        "state": "cancellation-scheduled",
                        "endsAt": "2023-11-13T22:13:20.000Z",
                    ],
                    "quota": ["unified7d": 1.0, "unified7dReset": weeklyResetMs],
                ],
                [
                    // 꺼 두었는데 인증도 깨진 계정. 다시 켜면 그대로 실패하므로 오류를 삼키면 안 된다.
                    "name": "off-and-broken",
                    "status": "error",
                    "enabled": false,
                    "errorReason": "auth-revoked",
                    "usable": false,
                    "planType": "pro",
                    "subscription": ["state": "active"],
                    "quota": [:],
                ],
                [
                    // 병합 경로(main.swift)가 status를 "disabled"로 덮은 같은 계정.
                    "name": "off-and-broken-merged",
                    "status": "disabled",
                    "enabled": false,
                    "errorReason": "auth-revoked",
                    "usable": false,
                    "planType": "pro",
                    "subscription": ["state": "active"],
                    "quota": [:],
                ],
            ],
        ]
        let subscriptionData = try JSONSerialization.data(withJSONObject: subscriptionFixture)
        let subscriptionHealth = try teamCodexPoolHealth(
            from: subscriptionData,
            port: 3457,
            serverPid: nil,
            checkedAt: checkedAt
        )
        let subscriptionThreshold = subscriptionHealth.switchThresholdPercent
        func labelled(_ name: String) -> (String, String?, TeamCodexAccountState) {
            guard let account = subscriptionHealth.accounts.first(where: { $0.name == name }) else {
                fatalError("fixture 계정 없음: \(name)")
            }
            return (
                teamCodexAccountStatusLabel(
                    account,
                    switchThresholdPercent: subscriptionThreshold,
                    now: checkedAt
                ),
                teamCodexAccountNote(
                    account,
                    switchThresholdPercent: subscriptionThreshold,
                    now: checkedAt
                ),
                teamCodexAccountState(
                    account,
                    switchThresholdPercent: subscriptionThreshold,
                    now: checkedAt
                )
            )
        }
        func account(_ name: String) -> TeamCodexPoolAccount {
            guard let account = subscriptionHealth.accounts.first(where: { $0.name == name }) else {
                fatalError("fixture 계정 없음: \(name)")
            }
            return account
        }

        // Then: subscription·planType이 디코드된다
        precondition(account("healthy").subscriptionState == "active")
        precondition(account("healthy").planType == "pro")
        precondition(account("ending-but-serving").subscriptionEndsAt
            == Date(timeIntervalSince1970: 1_700_259_200))
        precondition(account("healthy").subscriptionEndsAt == nil)

        // 정상 계정: 사용 중
        precondition(labelled("healthy") == ("사용 중", nil, .serving))

        // 주간 한도만 찬 계정: 일시적 한도 소진 — 초기화되면 돌아온다
        precondition(labelled("weekly-full") == ("한도소진", nil, .limited))
        precondition(!account("weekly-full").isPermanentlyOut(now: checkedAt))
        precondition(!account("weekly-full").isSubscriptionRetired(now: checkedAt))

        // 해지 예약: 아직 서비스 중이므로 실패가 아니라 "사용 중" + 보조줄로 예고
        precondition(labelled("ending-but-serving")
            == ("사용 중", "구독 종료 예정 · 3일 후", .serving))
        precondition(!account("ending-but-serving").isPermanentlyOut(now: checkedAt))
        precondition(account("ending-but-serving").isSubscriptionEnding(now: checkedAt))

        // 구독 종료: 오류가 아니라 종료 — 그리고 돌아오지 않는다
        precondition(labelled("ended") == ("구독종료", "돌아오지 않음", .retired))
        precondition(account("ended").isPermanentlyOut(now: checkedAt))
        precondition(!account("ended").isUsable(
            switchThresholdPercent: subscriptionThreshold,
            now: checkedAt
        ))

        // 종료일 도달: enabled가 아직 true여도 한도 소진처럼 보이면 안 된다
        // 프록시는 end-date-reached에도 계속 요청을 보낸다(tui.js 노랑 sub due).
        // 종료로 접으면 서빙 중인 계정을 화면에서 지운다.
        precondition(labelled("end-date-reached")
            == ("종료확인중", "종료일 지남 · 연결 확인 중", .endDateReached))
        precondition(account("end-date-reached").enabled)
        // 풀에서 빼지 않는다 — 프록시가 아직 이 계정에 요청을 보낸다.
        precondition(!account("end-date-reached").isPermanentlyOut(now: checkedAt))
        precondition(!account("end-date-reached").isSubscriptionRetired(now: checkedAt))
        precondition(account("end-date-reached").isSubscriptionEndDateReached(now: checkedAt))
        // usable은 프록시 판정을 그대로 따른다(이 픽스처는 usable:false).
        precondition(!account("end-date-reached").isUsable(
            switchThresholdPercent: subscriptionThreshold,
            now: checkedAt
        ))

        // 해지 예약인데 종료 시각이 지났다: 프록시 state가 아직 안 넘어가도 종료로 본다
        precondition(labelled("scheduled-past")
            == ("종료확인중", "종료일 지남 · 연결 확인 중", .endDateReached))
        precondition(account("scheduled-past").enabled)
        precondition(account("scheduled-past").subscriptionState == "cancellation-scheduled")
        // 종료 시각이 지났어도 확정 종료가 아니다. 프록시가 state를 옮길 때까지 풀에 남는다.
        precondition(!account("scheduled-past").isSubscriptionRetired(now: checkedAt))
        precondition(account("scheduled-past").isSubscriptionEndDateReached(now: checkedAt))
        precondition(!account("scheduled-past").isSubscriptionEnding(now: checkedAt))
        precondition(!account("scheduled-past").isPermanentlyOut(now: checkedAt))
        // 종료 시각 이전이었다면 아직 서비스 중이다 (경계 판정이 now에 달려 있다는 회귀 가드)
        let beforeEnd = Date(timeIntervalSince1970: 1_699_000_000)
        precondition(!account("scheduled-past").isSubscriptionRetired(now: beforeEnd))
        precondition(account("scheduled-past").isSubscriptionEnding(now: beforeEnd))

        // 꺼 둔 계정: status가 active여도 "사용 중"·"한도소진"으로 보이면 안 된다
        precondition(labelled("switched-off") == ("비활성", "직접 꺼 둔 계정", .excluded))
        precondition(account("switched-off").status == "active")
        precondition(account("switched-off").isPermanentlyOut(now: checkedAt))

        // 꺼 두었는데 인증까지 깨진 계정: "비활성"이 오류를 삼키면 다시 켤 때 처음 알게 된다
        precondition(labelled("off-and-broken") == ("인증만료", "직접 꺼 둔 계정", .failed))
        precondition(account("off-and-broken").isPermanentlyOut(now: checkedAt))
        // 병합 경로가 status를 "disabled"로 덮어도 errorReason으로 같은 판정이 나온다
        precondition(labelled("off-and-broken-merged") == ("인증만료", "직접 꺼 둔 계정", .failed))

        // 살아 있지만 프록시가 배정하지 않는 계정
        precondition(labelled("paused") == ("일시대기", nil, .paused))
        precondition(!account("paused").isPermanentlyOut(now: checkedAt))

        // Then: 요약 수치가 꺼 둔 계정·확정 종료 계정을 빼고 센다.
        // 종료일만 지난 계정(end-date-reached / scheduled-past)은 프록시가 아직 라우팅하므로 풀에 남는다.
        precondition(subscriptionHealth.accounts.count == 10)
        precondition(subscriptionHealth.excludedCount == 4)
        precondition(subscriptionHealth.poolCount == 6)
        precondition(subscriptionHealth.activeCount == 6)
        precondition(subscriptionHealth.usableCount == 2)
        precondition(subscriptionHealth.accessibilitySummary
            == "TeamCodex 온라인, 지금 쓸 수 있는 계정 2개, 풀에 남은 계정 6개, 풀에서 빠진 계정 4개")

        // 회귀 가드: 종료일만 지난 계정이 실제로 서빙 중일 때(usable:true) 화면에서 지워지면 안 된다.
        // 이 계정이 유일한 서버였다면 요약이 "사용 가능 0"이라 말하는데 Codex는 잘 돌고 있게 된다.
        let stillServing = TeamCodexPoolAccount(
            name: "end-date-reached-but-serving",
            accountUuid: nil,
            isCurrent: false,
            enabled: true,
            status: "active",
            errorReason: nil,
            usableFromProxy: true,
            sessionPercent: 0.0,
            sessionResetAt: nil,
            weeklyPercent: 10.0,
            weeklyResetAt: nil,
            inflight: 0,
            maxConcurrent: 3,
            totalRequests: 0,
            totalTokens: 0,
            subscriptionState: "end-date-reached",
            subscriptionEndsAt: Date(timeIntervalSince1970: 1_700_000_000),
            planType: "pro"
        )
        precondition(stillServing.isUsable(switchThresholdPercent: 100, now: checkedAt))
        precondition(!stillServing.isPermanentlyOut(now: checkedAt))
        precondition(teamCodexAccountState(stillServing, switchThresholdPercent: 100, now: checkedAt)
            == .endDateReached)
        let servingPool = TeamCodexPoolHealth(
            checkedAt: checkedAt,
            serverReachable: true,
            serverPort: 3457,
            serverPid: nil,
            currentAccount: nil,
            currentAccountUuid: nil,
            switchThresholdPercent: 100,
            accounts: [stillServing]
        )
        precondition(servingPool.usableCount == 1)
        precondition(servingPool.poolCount == 1)
        precondition(servingPool.excludedCount == 0)

        // 회귀 가드(2026-09-06 리뷰): 조직이 막은 계정을 운영자가 추가로 꺼 둔 조합.
        // 다시 켜기는 주되, 켠 뒤에도 재인증 버튼은 영영 안 나오므로 "켠 뒤 재인증" 약속을 하지 않는다.
        func recovery(enabled: Bool, status: String, errorReason: String?) -> TeamCodexAccountRecovery? {
            let a = TeamCodexPoolAccount(
                name: "acct", accountUuid: "uuid-acct", isCurrent: false,
                enabled: enabled, status: status, errorReason: errorReason,
                usableFromProxy: nil, sessionPercent: 0, sessionResetAt: nil,
                weeklyPercent: 0, weeklyResetAt: nil, inflight: 0, maxConcurrent: 3,
                totalRequests: 0, totalTokens: 0,
                accountType: "oauth", providerName: "codex"
            )
            return teamCodexAccountRecovery(a, now: checkedAt)
        }
        let blockedAndOff = recovery(enabled: false, status: "error", errorReason: "subscription-disabled")
        precondition(blockedAndOff?.kind == .enable)
        precondition(blockedAndOff?.followUpNote == teamCodexEnableFollowUpNote)
        precondition(!(blockedAndOff?.toolTip.contains("재인증") ?? true))
        // 켠 뒤에는 재인증 버튼이 아예 없다 — 위 안내가 지킬 수 없는 약속이 아니어야 한다
        precondition(recovery(enabled: true, status: "error", errorReason: "subscription-disabled") == nil)
        // 송신 실패는 자격증명 문제가 아니다: 재인증을 처방하지 않는다
        precondition(recovery(enabled: true, status: "error", errorReason: "send-failed") == nil)
        let offWithAuthError = recovery(enabled: false, status: "error", errorReason: "auth-revoked")
        precondition(offWithAuthError?.kind == .enable)
        precondition(offWithAuthError?.followUpNote == teamCodexEnableThenReauthFollowUpNote)

        // errorReason 라벨: 구독 종료는 결함이 아니다
        precondition(teamAccountErrorReasonLabel("subscription-ended") == "구독종료")

        // 구 프록시(subscription 필드 없음)는 기존 동작 유지
        precondition(health.accounts[0].subscriptionState == nil)
        precondition(health.accounts[0].planType == nil)
        precondition(!health.accounts[0].isPermanentlyOut())
        precondition(health.accounts[1].isPermanentlyOut())
        precondition(
            teamCodexAccountStatusLabel(
                health.accounts[2],
                switchThresholdPercent: health.switchThresholdPercent
            ) == "한도소진"
        )
        precondition(
            teamCodexAccountStatusLabel(
                offline.accounts[0],
                switchThresholdPercent: offline.switchThresholdPercent
            ) == "설정됨"
        )

        let loadingLayout = codexStatusLayout(
            topY: 14,
            poolHeight: 86,
            hasPool: true,
            localUsageLoaded: false
        )
        let loadedLayout = codexStatusLayout(
            topY: 14,
            poolHeight: 86,
            hasPool: true,
            localUsageLoaded: true
        )
        precondition(loadingLayout.poolY == 72)
        precondition(loadedLayout.poolY == loadingLayout.poolY)
        precondition(loadedLayout.metricsY == 168)

        // ── 되돌리기 버튼 자격 판정 ───────────────────────────────────────────
        // 실제 CLI(운영 아티팩트 6b538222)가 거부하는 조합에는 버튼을 붙이지 않는다.
        func recoveryAccount(
            name: String = "codex-account",
            accountUuid: String? = "11111111-2222-3333-4444-555555555555",
            enabled: Bool = true,
            status: String = "active",
            errorReason: String? = nil,
            usableFromProxy: Bool? = nil,
            sessionPercent: Double? = nil,
            weeklyPercent: Double? = nil,
            subscriptionState: String? = "active",
            subscriptionEndsAt: Date? = nil,
            accountType: String? = "oauth",
            providerName: String? = "codex"
        ) -> TeamCodexPoolAccount {
            TeamCodexPoolAccount(
                name: name,
                accountUuid: accountUuid,
                isCurrent: false,
                enabled: enabled,
                status: status,
                errorReason: errorReason,
                usableFromProxy: usableFromProxy,
                sessionPercent: sessionPercent,
                sessionResetAt: nil,
                weeklyPercent: weeklyPercent,
                weeklyResetAt: nil,
                inflight: 0,
                maxConcurrent: 3,
                totalRequests: 0,
                totalTokens: 0,
                subscriptionState: subscriptionState,
                subscriptionEndsAt: subscriptionEndsAt,
                planType: "pro",
                accountType: accountType,
                providerName: providerName
            )
        }

        let recoveryNow = Date(timeIntervalSince1970: 1_788_700_000)

        // 운영자가 끈 계정 → 다시 켜기 (CLI enable은 이름만 받는다)
        let offAccount = recoveryAccount(name: "off@example.com", enabled: false, status: "disabled")
        let offRecovery = teamCodexAccountRecovery(offAccount, now: recoveryNow)
        precondition(offRecovery?.kind == .enable)
        precondition(offRecovery?.title == "다시 켜기")
        precondition(offRecovery?.arguments == ["codex", "enable", "off@example.com"])
        precondition(offRecovery?.followUpNote == teamCodexEnableFollowUpNote)
        precondition(offRecovery?.accessibilityLabel == "다시 켜기: off@example.com")

        // 꺼져 있으면서 인증까지 깨진 계정도 "다시 켜기"가 먼저다.
        // CLI reauth는 disabled 계정을 거부하므로 순서를 바꾸면 실패할 명령을 띄우게 된다.
        let offBrokenRecovery = teamCodexAccountRecovery(
            recoveryAccount(enabled: false, status: "disabled", errorReason: "auth-revoked"),
            now: recoveryNow
        )
        precondition(offBrokenRecovery?.kind == .enable)
        // 상태 칸은 빨간 "인증만료"인데 버튼은 노란 "다시 켜기" 하나뿐인 조합.
        // 보조줄이 "켜도 인증 문제가 남는다"를 먼저 말해야 한다.
        precondition(offBrokenRecovery?.followUpNote == teamCodexEnableThenReauthFollowUpNote)
        precondition(offBrokenRecovery?.toolTip.contains("재인증이 필요합니다") == true)
        precondition(teamCodexEnableThenReauthFollowUpNote != teamCodexEnableFollowUpNote)

        // 인증 오류 → 재인증. uuid를 붙여 신원을 고정한다.
        let brokenRecovery = teamCodexAccountRecovery(
            recoveryAccount(name: "broken@example.com", status: "error", errorReason: "auth-revoked"),
            now: recoveryNow
        )
        precondition(brokenRecovery?.kind == .reauth)
        // 낱말은 Claude 풀 표의 같은 버튼과 맞춘다("재인증 필요").
        precondition(brokenRecovery?.title == "재인증 필요")
        precondition(brokenRecovery?.accessibilityLabel == "재인증 필요: broken@example.com")
        precondition(brokenRecovery?.arguments == [
            "codex",
            "reauth",
            "broken@example.com",
            "--account-uuid",
            "11111111-2222-3333-4444-555555555555",
        ])
        precondition(brokenRecovery?.followUpNote == nil)
        precondition(teamCodexAccountRecovery(
            recoveryAccount(status: "error", errorReason: "refresh-failed"),
            now: recoveryNow
        )?.kind == .reauth)

        // uuid 없는 행: 자격증명 덮어쓰기는 신원이 확인될 때만
        precondition(teamCodexAccountRecovery(
            recoveryAccount(accountUuid: nil, status: "error", errorReason: "auth-revoked"),
            now: recoveryNow
        ) == nil)
        // 같은 행이라도 끄기/켜기는 되돌릴 수 있어 uuid 없이도 제안한다.
        precondition(teamCodexAccountRecovery(
            recoveryAccount(accountUuid: nil, enabled: false, status: "disabled"),
            now: recoveryNow
        )?.kind == .enable)

        // 조직 차단 → 재인증으로 풀리지 않는다 (Claude 표와 같은 판단)
        precondition(teamCodexAccountRecovery(
            recoveryAccount(status: "error", errorReason: "subscription-disabled"),
            now: recoveryNow
        ) == nil)

        // 구독 종료 → 다시 로그인해도 돌아오지 않는다.
        // 프록시 자체 TUI 게이트(canReauthenticateTuiAccount)도 subscription-ended를 뺀다.
        precondition(teamCodexAccountRecovery(
            recoveryAccount(status: "error", errorReason: "subscription-ended", subscriptionState: "ended"),
            now: recoveryNow
        ) == nil)
        precondition(teamCodexAccountRecovery(
            recoveryAccount(
                enabled: false,
                status: "error",
                errorReason: "subscription-ended",
                subscriptionState: "ended"
            ),
            now: recoveryNow
        ) == nil)

        // 정상·한도소진·종료확인중: 고칠 것이 없으므로 버튼도 없다
        precondition(teamCodexAccountRecovery(
            recoveryAccount(usableFromProxy: true),
            now: recoveryNow
        ) == nil)
        precondition(teamCodexAccountRecovery(
            recoveryAccount(status: "exhausted", sessionPercent: 100),
            now: recoveryNow
        ) == nil)
        precondition(teamCodexAccountRecovery(
            recoveryAccount(status: "throttled"),
            now: recoveryNow
        ) == nil)
        precondition(teamCodexAccountRecovery(
            recoveryAccount(
                subscriptionState: "end-date-reached",
                subscriptionEndsAt: recoveryNow.addingTimeInterval(-3600)
            ),
            now: recoveryNow
        ) == nil)

        // oauth가 아니거나 다른 풀의 계정이면 codex 명령을 쏘지 않는다
        precondition(teamCodexAccountRecovery(
            recoveryAccount(status: "error", errorReason: "auth-revoked", accountType: "api-key"),
            now: recoveryNow
        ) == nil)
        precondition(teamCodexAccountRecovery(
            recoveryAccount(enabled: false, status: "disabled", accountType: nil),
            now: recoveryNow
        ) == nil)
        precondition(teamCodexAccountRecovery(
            recoveryAccount(status: "error", errorReason: "auth-revoked", providerName: "anthropic"),
            now: recoveryNow
        ) == nil)
        // provider가 비어 있는 구 status는 codex 풀로 본다(이 패널은 codex 풀만 그린다)
        precondition(teamCodexAccountRecovery(
            recoveryAccount(status: "error", errorReason: "auth-revoked", providerName: nil),
            now: recoveryNow
        )?.kind == .reauth)

        // 실제 payload에서 type/provider가 실려 온다 (프록시 status는 두 필드를 함께 준다)
        let typedFixture: [String: Any] = [
            "switchThreshold": 1.0,
            "accounts": [
                [
                    "name": "typed@example.com",
                    "accountUuid": "typed-uuid",
                    "type": "oauth",
                    "provider": "codex",
                    "status": "active",
                    "enabled": false,
                    "inflight": 0,
                    "maxConcurrent": 3,
                    "quota": [:],
                    "usage": [:],
                ],
            ],
        ]
        let typedHealth = try teamCodexPoolHealth(
            from: try JSONSerialization.data(withJSONObject: typedFixture),
            port: 3457,
            serverPid: nil,
            checkedAt: recoveryNow
        )
        precondition(health.accounts[0].accountType == nil)
        precondition(typedHealth.accounts[0].accountType == "oauth")
        precondition(typedHealth.accounts[0].providerName == "codex")
        precondition(teamCodexAccountRecovery(typedHealth.accounts[0], now: recoveryNow)?.kind == .enable)

        print("TeamCodexPoolStatusTests: all assertions passed")
    }
}
