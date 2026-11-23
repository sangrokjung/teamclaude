import Foundation

// 머신 활성 상태 줄(FleetMachines.swift). 수집기 JSON 해석과 한 줄 문구를 고정한다.
@main
struct FleetMachinesTests {
    static func json(_ text: String) -> Data { Data(text.utf8) }

    static func main() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let fresh = Int(now.timeIntervalSince1970) - 30
        let sample = json("""
        {"collected_at": \(fresh), "hosts": [
          {"name": "hub", "ok": true, "load1": 15.0, "cores": 30, "mem_free_pct": 84.0, "disk_free_gb": 170.1},
          {"name": "alpha", "ok": true, "load1": 6.6, "cores": 16, "mem_free_pct": 67.0, "disk_free_gb": 17.4},
          {"name": "beta", "ok": false, "error": "ssh timeout"},
          {"name": "gamma", "ok": true, "load1": 15.9, "cores": 10, "mem_free_pct": 62.0, "disk_free_gb": 18.5},
          {"name": "delta-worker", "ok": true, "load1": 4.0, "cores": 16, "mem_free_pct": 10.0, "disk_free_gb": 31.5}
        ], "config_error": null, "failed_hosts": ["beta"]}
        """)

        // 1. 해석 — 다섯 대가 순서대로 들어온다.
        guard let snapshot = FleetMachines.parse(sample) else { preconditionFailure("valid collector output must parse") }
        precondition(snapshot.machines.map(\.name) == ["hub", "alpha", "beta", "gamma", "delta-worker"])
        precondition(snapshot.machines[2].online == false)

        // 2. 한 줄 — 본체·워커 모두, 끊긴 워커는 끊김, 과부하·램 부족은 ! 표시.
        let line = FleetMachines.summaryText(snapshot, now: now)
        precondition(line == "머신  본체 50% · alpha 41% · beta 끊김 · !gamma 159% · !delta 25%", line ?? "nil")
        precondition(FleetMachines.isWarning(snapshot, now: now), "an offline or overloaded machine warns")

        // 3. 모두 정상이면 경고 아님.
        let calm = FleetMachines.parse(json("""
        {"collected_at": \(fresh), "hosts": [{"name": "hub", "ok": true, "load1": 3, "cores": 30, "disk_free_gb": 100}]}
        """))
        precondition(FleetMachines.summaryText(calm, now: now) == "머신  본체 10%")
        precondition(!FleetMachines.isWarning(calm, now: now))

        // 4. 수집이 3분 넘게 멈추면 숫자 대신 멈춤을 말한다(옛 숫자를 지금 값처럼 보이지 않는다).
        let old = FleetMachines.parse(json("""
        {"collected_at": \(Int(now.timeIntervalSince1970) - 600), "hosts": [{"name": "hub", "ok": true, "load1": 3, "cores": 30}]}
        """))
        precondition(FleetMachines.summaryText(old, now: now) == "머신  수집 멈춤 (10분 전)")
        precondition(FleetMachines.isWarning(old, now: now))

        // 5. 파일이 없거나 깨지면 줄을 그리지 않는다.
        precondition(FleetMachines.summaryText(nil, now: now) == nil)
        for broken in ["", "[]", "{\"hosts\": []}", "{\"collected_at\": 1, \"hosts\": []}",
                       "{\"collected_at\": true, \"hosts\": [{\"name\": \"hub\", \"ok\": true}]}",
                       "{\"collected_at\": 1, \"hosts\": [{\"ok\": true}]}"] {
            precondition(FleetMachines.parse(json(broken)) == nil, broken)
        }
        precondition(FleetMachines.load(path: "/nonexistent/fleet-usage.json") == nil)

        // 6. 값이 빠진 머신은 값 없음(0%로 꾸며 내지 않는다).
        let partial = FleetMachines.parse(json("""
        {"collected_at": \(fresh), "hosts": [{"name": "node9-worker", "ok": true, "load1": -1, "cores": 0}]}
        """))
        precondition(FleetMachines.summaryText(partial, now: now) == "머신  node9 값 없음")

        // 7. 이름표 — 본체만 번역, -worker 꼬리는 떼고, 긴 이름은 줄인다.
        precondition(FleetMachines.label("hub") == "본체")
        precondition(FleetMachines.label("-worker") == "-worker", "a name that is only the suffix stays as is")
        precondition(FleetMachines.label("averyverylongname") == "averyve…")

        // 8. 기본 경로는 홈의 하네스 캐시.
        precondition(FleetMachines.defaultPath(home: "/Users/x") == "/Users/x/.claude/cache/fleet-usage.json")
        print("FleetMachinesTests OK")
    }
}
