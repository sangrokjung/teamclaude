// menubar/Tests/QuotaHistoryTests.swift
import Foundation

@main
struct QuotaHistoryTests {
    static func main() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func obs(_ reset: Date?, mean: Double = 0.5, blocked: Bool = false,
                 contributing: Int = 7, paid: Int = 17) -> QuotaObservation {
            QuotaObservation(lane: "claude", window: "7d", resetAt: reset,
                             contributing: contributing, paid: paid,
                             meanUtilization: mean, maxUtilization: mean,
                             exhaustedAccounts: 0, blocked: blocked)
        }

        // 리셋 시각이 그대로면 아직 같은 주기다.
        let pending = now.addingTimeInterval(3600)
        precondition(quotaCycleBoundary(previous: obs(pending), current: obs(pending), now: now) == nil)

        // 리셋 시각이 바뀌면 직전 주기를 확정한다. 확정값은 '이전' 관측이다.
        //
        // 직전 리셋은 관측 시점 기준으로 이미 지나 있다. 리셋이 지나야 서버가 새 리셋을 주기
        // 때문이다. 미래 리셋을 그대로 둔 채 새 리셋이 오는 상황은 시계가 되감겼을 때뿐이고,
        // 그건 아래에서 따로 검사한다.
        let reset = now.addingTimeInterval(-60)
        let moved = now.addingTimeInterval(7 * 86_400)
        let closed = quotaCycleBoundary(previous: obs(reset, mean: 0.82), current: obs(moved), now: now)
        precondition(closed?.meanUtilization == 0.82, "확정은 직전 주기의 값이어야 한다")
        precondition(closed?.contributing == 7 && closed?.paid == 17, "분모를 함께 남긴다")
        precondition(closed?.complete == true)

        // 이전 관측이 없으면(기동 직후) 확정할 주기가 없다.
        precondition(quotaCycleBoundary(previous: nil, current: obs(moved), now: now) == nil)

        // 시계 되감김으로 종료 시각이 미래면 기록하지 않는다.
        let future = now.addingTimeInterval(86_400)
        precondition(quotaCycleBoundary(previous: obs(future, mean: 0.5), current: obs(moved), now: now) == nil,
                     "미래 종료 시각을 가진 주기는 기록하지 않는다")

        // 깨진 JSON과 다른 버전은 빈 이력이다.
        precondition(quotaHistoryDecode(Data("not json".utf8)).isEmpty)
        precondition(quotaHistoryDecode(Data(#"{"version":2,"cycles":[]}"#.utf8)).isEmpty)

        // 왕복이 값을 보존한다.
        let cycle = QuotaCycle(lane: "codex", window: "7d", endedAt: now, contributing: 7, paid: 7,
                               meanUtilization: 0.73, maxUtilization: 1.0,
                               exhaustedAccounts: 2, blockedMoments: 0, complete: true)
        let encoded = quotaHistoryEncode([cycle])
        precondition(encoded != nil)
        precondition(quotaHistoryDecode(encoded!) == [cycle])

        // 보관은 레인·창 조합마다 센다. 한 레인이 많다고 다른 레인이 밀리지 않는다.
        let many = (0..<40).map { i in
            QuotaCycle(lane: "claude", window: "7d", endedAt: now.addingTimeInterval(Double(i) * 86_400),
                       contributing: 1, paid: 1, meanUtilization: 0.1, maxUtilization: 0.1,
                       exhaustedAccounts: 0, blockedMoments: 0, complete: true)
        }
        let trimmed = quotaHistoryTrimmed(many + [cycle], keepPerLane: 32)
        precondition(trimmed.filter { $0.lane == "claude" }.count == 32)
        precondition(trimmed.contains(cycle), "다른 레인은 밀려나지 않는다")
        precondition(trimmed.filter { $0.lane == "claude" }.allSatisfy {
            $0.endedAt >= now.addingTimeInterval(8 * 86_400)
        })

        // Grok은 리셋 시각을 주지 않는다. 사용률이 크게 떨어지는 순간을 경계로 본다.
        func grok(_ mean: Double) -> QuotaObservation {
            QuotaObservation(lane: "grok", window: "7d", resetAt: nil, contributing: 1, paid: 1,
                             meanUtilization: mean, maxUtilization: mean,
                             exhaustedAccounts: 0, blocked: false)
        }
        precondition(quotaDropBoundary(previous: grok(0.29), current: grok(0.31), now: now) == nil)
        precondition(quotaDropBoundary(previous: grok(0.29), current: grok(0.20), now: now) == nil)
        let dropped = quotaDropBoundary(previous: grok(0.95), current: grok(0.02), now: now)
        precondition(dropped?.meanUtilization == 0.95, "\(String(describing: dropped))")
        precondition(dropped?.endedAt == now, "경계 시각은 관측 시각이다. 리셋 시각을 모른다")
        precondition(dropped?.complete == true)
        precondition(quotaDropBoundary(previous: nil, current: grok(0.02), now: now) == nil)

        print("QuotaHistoryTests: 통과")
    }
}
