// menubar/Tests/LaneHealthTests.swift
import Foundation

@main
struct LaneHealthTests {
    static func main() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let started = now.addingTimeInterval(-3600)

        // 주기 안에 성공했으면 아무 말도 하지 않는다.
        let fresh = LaneHealth(name: "grok", interval: 60,
                               lastSuccessAt: now.addingTimeInterval(-30), startedAt: started)
        precondition(laneStaleMessages([fresh], now: now).isEmpty, "정상 레인은 조용해야 한다")

        // 한 주기를 넘겨도 3배 전에는 경보하지 않는다(1회 실패로 떠들면 잡음이 된다).
        let oneMiss = LaneHealth(name: "grok", interval: 60,
                                 lastSuccessAt: now.addingTimeInterval(-90), startedAt: started)
        precondition(laneStaleMessages([oneMiss], now: now).isEmpty, "1회 실패로 경보하면 안 된다")

        // 3배를 넘기면 드러낸다.
        let stale = LaneHealth(name: "cli-a", interval: 60,
                               lastSuccessAt: now.addingTimeInterval(-600), startedAt: started)
        let messages = laneStaleMessages([stale], now: now)
        precondition(messages.count == 1, "\(messages.count)")
        precondition(messages[0].name == "cli-a", messages[0].name)
        precondition(messages[0].message.contains("cli-a"), messages[0].message)
        precondition(messages[0].message.contains("10분째"), messages[0].message)
        precondition(messages[0].message.contains("마지막 성공 이후"), messages[0].message)

        // 한 번도 성공하지 못한 레인은 기동 시각으로 잰다 — 데몬 수명 내내 죽어 있던 경우.
        let neverOK = LaneHealth(name: "cli-b", interval: 60, lastSuccessAt: nil, startedAt: started)
        let neverMessages = laneStaleMessages([neverOK], now: now)
        precondition(neverMessages.count == 1, "\(neverMessages.count)")
        precondition(neverMessages[0].message.contains("한 번도 성공 못 함"), neverMessages[0].message)

        // 주기가 0이거나 음수인 레인은 판정하지 않는다(0으로 나누는 대신 건너뛴다).
        precondition(laneStaleMessages([
            LaneHealth(name: "x", interval: 0, lastSuccessAt: nil, startedAt: started),
        ], now: now).isEmpty, "주기 0은 판정 대상이 아니다")

        // 주기가 긴 레인은 같은 경과라도 아직 정상이다.
        let slow = LaneHealth(name: "higgsfield", interval: 600,
                              lastSuccessAt: now.addingTimeInterval(-600), startedAt: started)
        precondition(laneStaleMessages([slow], now: now).isEmpty, "긴 주기 레인을 성급히 판정하면 안 된다")

        // 여러 레인이 동시에 끊기면 전부 보고한다 — 이름이 함께 나와야 레인별로 쿨다운할 수 있다.
        // (한 레인이 떠들면 다른 레인이 묻히던 문제, astra 지적 2026-09-24)
        let both = laneStaleMessages([stale, neverOK], now: now)
        precondition(both.count == 2, "\(both.count)")
        precondition(Set(both.map { $0.name }) == ["cli-a", "cli-b"], "\(both.map { $0.name })")

        print("LaneHealthTests: 통과")
    }
}
