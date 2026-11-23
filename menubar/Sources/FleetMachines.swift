import Foundation

// 본체·워커 머신 활성 상태 한 줄(2026-11-23 대표 요청: 워커 머신까지 모든 머신을 메뉴바에).
// 값은 외부 수집기(1분 주기로 본체와 워커의 load·코어·램·디스크를 모으는 스크립트)가 쓰는
// ~/.claude/cache/fleet-usage.json 하나만 읽는다. 메뉴바가 직접 ssh 하지 않는다.
// 파일 모양: {"collected_at": <unix 초>, "hosts": [{"name", "ok", "load1", "cores", "mem_free_pct", "disk_free_gb"}]}
// 파일이 없는 기계(수집기가 없는 노드)에서는 줄 자체를 그리지 않는다.

struct FleetMachine: Equatable {
    let name: String
    let online: Bool
    let load1: Double?
    let cores: Int?
    let memFreePercent: Double?
    let diskFreeGB: Double?
}

struct FleetMachinesSnapshot: Equatable {
    let collectedAt: Date
    let machines: [FleetMachine]
}

enum FleetMachines {
    /// 수집기는 1분마다 쓴다. 3분 넘게 그대로면 수집이 멈춘 것으로 본다(상태줄 mod와 같은 기준).
    static let staleSeconds: TimeInterval = 180
    static let hotLoadRatio = 1.5
    static let lowDiskGB = 15.0
    static let lowMemFreePercent = 15.0
    static let maxMachines = 17 // 수집기 상한(워커 16 + 본체)

    static func defaultPath(home: String = NSHomeDirectory()) -> String {
        (home as NSString).appendingPathComponent(".claude/cache/fleet-usage.json")
    }

    static func load(path: String = defaultPath()) -> FleetMachinesSnapshot? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return parse(data)
    }

    static func parse(_ data: Data) -> FleetMachinesSnapshot? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let collected = number(object["collected_at"]), collected > 0,
              let hosts = object["hosts"] as? [Any] else { return nil }
        let machines = hosts.prefix(maxMachines).compactMap { machine($0) }
        guard !machines.isEmpty else { return nil }
        return FleetMachinesSnapshot(collectedAt: Date(timeIntervalSince1970: collected), machines: machines)
    }

    private static func machine(_ raw: Any) -> FleetMachine? {
        guard let host = raw as? [String: Any], let name = host["name"] as? String, !name.isEmpty else { return nil }
        return FleetMachine(
            name: name,
            online: host["ok"] as? Bool == true,
            load1: number(host["load1"]).flatMap { $0 >= 0 ? $0 : nil },
            cores: number(host["cores"]).flatMap { $0 >= 1 && $0 < 10_000 ? Int($0) : nil },
            memFreePercent: number(host["mem_free_pct"]),
            diskFreeGB: number(host["disk_free_gb"])
        )
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
        let double = value.doubleValue
        return double.isFinite ? double : nil
    }

    /// 짧은 이름표. 수집기가 본체를 hub로 쓰므로 그것만 번역하고, 나머지는 -worker 꼬리를 떼고 8자로 줄인다.
    static func label(_ name: String) -> String {
        if name == "hub" { return L10n.fleetHubLabel }
        let trimmed = name.hasSuffix("-worker") ? String(name.dropLast("-worker".count)) : name
        let base = trimmed.isEmpty ? name : trimmed
        return base.count > 8 ? String(base.prefix(7)) + "…" : base
    }

    /// 부하율 = 1분 load ÷ 코어 수. 100%면 코어를 꽉 채운 상태다.
    static func loadPercent(_ machine: FleetMachine) -> Int? {
        guard let load = machine.load1, let cores = machine.cores else { return nil }
        return Int((load / Double(cores) * 100).rounded())
    }

    static func isHot(_ machine: FleetMachine) -> Bool {
        guard machine.online else { return true }
        if let load = machine.load1, let cores = machine.cores, load > Double(cores) * hotLoadRatio { return true }
        if let disk = machine.diskFreeGB, disk < lowDiskGB { return true }
        if let mem = machine.memFreePercent, mem <= lowMemFreePercent { return true }
        return false
    }

    static func machineText(_ machine: FleetMachine) -> String {
        let name = label(machine.name)
        guard machine.online else { return "\(name) \(L10n.fleetOffline)" }
        guard let percent = loadPercent(machine) else { return "\(name) \(L10n.fleetNoValue)" }
        return (isHot(machine) ? "!" : "") + "\(name) \(percent)%"
    }

    static func isStale(_ snapshot: FleetMachinesSnapshot, now: Date) -> Bool {
        let age = now.timeIntervalSince(snapshot.collectedAt)
        return age > staleSeconds || age < -60
    }

    /// 표 상단에 그릴 한 줄. 스냅샷이 없으면 nil(줄 생략).
    static func summaryText(_ snapshot: FleetMachinesSnapshot?, now: Date) -> String? {
        guard let snapshot = snapshot else { return nil }
        if isStale(snapshot, now: now) {
            let minutes = max(0, Int(now.timeIntervalSince(snapshot.collectedAt) / 60))
            return L10n.fleetPrefix + L10n.fleetStale(minutes)
        }
        return L10n.fleetPrefix + snapshot.machines.map(machineText).joined(separator: " · ")
    }

    static func isWarning(_ snapshot: FleetMachinesSnapshot?, now: Date) -> Bool {
        guard let snapshot = snapshot else { return false }
        return isStale(snapshot, now: now) || snapshot.machines.contains(where: isHot)
    }
}
