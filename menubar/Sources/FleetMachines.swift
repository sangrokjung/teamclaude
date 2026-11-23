import AppKit

// 본체·워커 머신 활성 상태 한 줄(2026-11-23 대표 요청: 워커 머신까지 모든 머신을 메뉴바에).
// 값은 외부 수집기(1분 주기로 본체와 워커의 load·코어·램·디스크를 모으는 스크립트)가 쓰는
// ~/.claude/cache/fleet-usage.json 하나만 읽는다. 메뉴바가 직접 ssh 하지 않는다.
// 파일 모양: {"collected_at": <unix 초>, "hosts": [{"name", "ok", "load1", "cores", "mem_free_pct", "disk_free_gb"}]}
// 파일이 없는 기계(수집기가 없는 노드)에서는 줄 자체를 그리지 않는다. 파일이 있는데 못 읽으면 숨기지 않고 오류를 말한다.

struct FleetMachine: Equatable {
    let name: String
    let online: Bool
    let load1: Double?
    let cores: Int?
    let memFreePercent: Double?
    let diskFreeGB: Double?
}

struct FleetMachinesSnapshot: Equatable {
    /// nil이면 파일은 있는데 읽거나 해석하지 못했다.
    let collectedAt: Date?
    let machines: [FleetMachine]
    /// 형식이 맞지 않아 뺀 머신 기록 수(조용히 버리지 않고 줄에 센다).
    var invalidHosts: Int = 0

    static let unreadable = FleetMachinesSnapshot(collectedAt: nil, machines: [])
}

enum FleetMachines {
    /// 수집기는 1분마다 쓴다. 3분 넘게 그대로면 수집이 멈춘 것으로 본다(상태줄 mod와 같은 기준).
    static let staleSeconds: TimeInterval = 180
    static let futureSkewSeconds: TimeInterval = 60
    static let hotLoadRatio = 1.5
    static let lowDiskGB = 15.0
    static let lowMemFreePercent = 15.0
    static let maxMachines = 17 // 수집기 상한(워커 16 + 본체)
    /// 이 범위를 벗어난 수는 손상된 값으로 보고 쓰지 않는다(Int 변환 트랩 방지).
    static let maxLoad = 1_000_000.0
    static let maxEpochSeconds = 10_000_000_000.0

    static func defaultPath(home: String = NSHomeDirectory()) -> String {
        (home as NSString).appendingPathComponent(".claude/cache/fleet-usage.json")
    }

    /// 파일이 실제로 없을 때만 nil(줄 생략). 권한 오류·읽기 실패·해석 실패는 `.unreadable`로 드러낸다.
    static func load(path: String = defaultPath()) -> FleetMachinesSnapshot? {
        do {
            return parse(try Data(contentsOf: URL(fileURLWithPath: path))) ?? .unreadable
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return nil
        } catch let error as NSError where error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT) {
            return nil
        } catch {
            return .unreadable
        }
    }

    static func parse(_ data: Data) -> FleetMachinesSnapshot? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let collected = number(object["collected_at"]), collected > 0, collected < maxEpochSeconds,
              let hosts = object["hosts"] as? [Any] else { return nil }
        let considered = Array(hosts.prefix(maxMachines))
        let machines = considered.compactMap { machine($0) }
        return FleetMachinesSnapshot(collectedAt: Date(timeIntervalSince1970: collected), machines: machines,
                                     invalidHosts: considered.count - machines.count)
    }

    /// 대시보드 스냅샷 픽스처(fleetUsage 키)를 같은 파서로 읽는다. ageSeconds는 now 기준 수집 나이다.
    /// 기본 나이(30초)는 키를 생략했을 때만 쓴다. 명시한 값의 타입이 틀리면 nil(스냅샷 실패).
    static func fixture(_ raw: [String: Any], now: Date) -> FleetMachinesSnapshot? {
        var stamped = raw
        let ageSeconds: Double
        if let explicit = raw["ageSeconds"] {
            guard let value = number(explicit) else { return nil }
            ageSeconds = value
        } else {
            ageSeconds = 30
        }
        stamped["collected_at"] = now.timeIntervalSince1970 - ageSeconds
        return (try? JSONSerialization.data(withJSONObject: stamped)).flatMap(parse)
    }

    private static func machine(_ raw: Any) -> FleetMachine? {
        guard let host = raw as? [String: Any], let name = host["name"] as? String, !name.isEmpty else { return nil }
        return FleetMachine(
            name: name,
            online: host["ok"] as? Bool == true,
            load1: number(host["load1"]).flatMap { $0 >= 0 && $0 < maxLoad ? $0 : nil },
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

    enum Problem: Equatable { case offline, noLoad, overload, lowDisk, lowMemory }

    /// 문제 판정 하나로 요약의 !·정렬·경고색과 전체 목록의 사유 표시를 함께 정한다.
    static func problems(_ machine: FleetMachine) -> [Problem] {
        guard machine.online else { return [.offline] }
        var found: [Problem] = []
        if loadPercent(machine) == nil { found.append(.noLoad) }
        if let load = machine.load1, let cores = machine.cores, load > Double(cores) * hotLoadRatio { found.append(.overload) }
        if let disk = machine.diskFreeGB, disk < lowDiskGB { found.append(.lowDisk) }
        if let mem = machine.memFreePercent, mem <= lowMemFreePercent { found.append(.lowMemory) }
        return found
    }

    static func isHot(_ machine: FleetMachine) -> Bool { !problems(machine).isEmpty }

    static func machineText(_ machine: FleetMachine) -> String {
        let name = label(machine.name)
        guard machine.online else { return "\(name) \(L10n.fleetOffline)" }
        guard let percent = loadPercent(machine) else { return "\(name) \(L10n.fleetNoValue)" }
        return (isHot(machine) ? "!" : "") + "\(name) \(percent)%"
    }

    /// 수집 나이(초). 파일을 못 읽었으면 nil.
    private static func age(_ snapshot: FleetMachinesSnapshot, now: Date) -> TimeInterval? {
        snapshot.collectedAt.map { now.timeIntervalSince($0) }
    }

    static func isStale(_ snapshot: FleetMachinesSnapshot, now: Date) -> Bool {
        guard let age = age(snapshot, now: now) else { return false }
        return age > staleSeconds || age < -futureSkewSeconds
    }

    /// 상태 문구(머신 목록이 아닌 경우). nil이면 머신 목록을 보여 줄 상태다.
    private static func condition(_ snapshot: FleetMachinesSnapshot, now: Date) -> String? {
        guard let age = age(snapshot, now: now) else { return L10n.fleetUnreadable }
        if age < -futureSkewSeconds { return L10n.fleetFutureTime }
        if age > staleSeconds { return age < 1e9 ? L10n.fleetStale(Int(age / 60)) : L10n.fleetStaleLong }
        if snapshot.machines.isEmpty { return snapshot.invalidHosts > 0 ? L10n.fleetInvalidHosts(snapshot.invalidHosts) : L10n.fleetEmpty }
        return nil
    }

    /// 한 줄 문구. 스냅샷이 없으면 nil(줄 생략).
    /// fits를 주면 그 폭에 맞춘다: 문제 있는 머신(끊김·과부하·값 없음)을 앞에 두고, 못 넣은 머신은 "외 N대"로 센다.
    static func summaryText(_ snapshot: FleetMachinesSnapshot?, now: Date, fits: ((String) -> Bool)? = nil) -> String? {
        guard let snapshot = snapshot else { return nil }
        if let condition = condition(snapshot, now: now) { return L10n.fleetPrefix + condition }
        let invalid = snapshot.invalidHosts > 0 ? [L10n.fleetInvalidHosts(snapshot.invalidHosts)] : []
        let all = snapshot.machines.map(machineText)
        let full = L10n.fleetPrefix + (all + invalid).joined(separator: " · ")
        guard let fits = fits, !fits(full) else { return full }
        let ordered = snapshot.machines.filter(isHot).map(machineText) + snapshot.machines.filter { !isHot($0) }.map(machineText)
        for shown in stride(from: ordered.count - 1, through: 0, by: -1) {
            let rest = [L10n.fleetMore(ordered.count - shown)]
            let candidate = L10n.fleetPrefix + (invalid + ordered.prefix(shown) + rest).joined(separator: " · ")
            if fits(candidate) { return candidate }
        }
        return L10n.fleetPrefix + L10n.fleetMore(ordered.count)
    }

    /// 머신마다 원래 이름과 상태를 담은 전체 목록(툴팁·접근성용). 화면 폭에 맞춰 줄이지 않는다.
    static func detailLines(_ snapshot: FleetMachinesSnapshot?, now: Date) -> [String]? {
        guard let snapshot = snapshot else { return nil }
        if let condition = condition(snapshot, now: now) { return [condition] }
        let lines = snapshot.machines.map { machine -> String in
            let name = machine.name == "hub" ? "\(L10n.fleetHubLabel) (hub)" : machine.name
            guard machine.online else { return "\(name): \(L10n.fleetOffline)" }
            // 부하·램·디스크를 따로 적는다. 하나가 빠져도 나머지 측정값(예: 디스크 부족)은 남긴다.
            var parts = [loadPercent(machine).map(L10n.fleetLoadDetail) ?? L10n.fleetLoadMissing]
            if let mem = machine.memFreePercent { parts.append(L10n.fleetMemDetail(Int(max(0, min(mem, 100)).rounded()))) }
            if let disk = machine.diskFreeGB, disk >= 0, disk < 1e9 { parts.append(L10n.fleetDiskDetail(Int(disk))) }
            let warnings = problems(machine).compactMap(warningLabel)
            let tail = warnings.isEmpty ? "" : " — " + warnings.joined(separator: ", ")
            return "\(name): " + parts.joined(separator: " · ") + tail
        }
        let invalid = snapshot.invalidHosts > 0 ? [L10n.fleetInvalidHosts(snapshot.invalidHosts)] : []
        return lines + invalid
    }

    private static func warningLabel(_ problem: Problem) -> String? {
        switch problem {
        case .offline, .noLoad: return nil // 줄 본문(끊김·부하 값 없음)이 이미 말한다
        case .overload: return L10n.fleetWarnOverload
        case .lowDisk: return L10n.fleetWarnDisk
        case .lowMemory: return L10n.fleetWarnMemory
        }
    }

    static func isWarning(_ snapshot: FleetMachinesSnapshot?, now: Date) -> Bool {
        guard let snapshot = snapshot else { return false }
        return condition(snapshot, now: now) != nil || snapshot.invalidHosts > 0 || snapshot.machines.contains(where: isHot)
    }
}

/// 머신 줄 위에 겹쳐 놓는 투명한 영역. 마우스를 올리면 원래 이름과 상태 전체를 툴팁으로 보여 준다
/// ('외 N대'로 줄어든 머신도 여기서 확인한다). 그리기는 표가 하고, 클릭은 표로 넘긴다.
final class FleetMachinesHintView: NSView {
    override func mouseDown(with event: NSEvent) { superview?.mouseDown(with: event) }
    override func mouseUp(with event: NSEvent) { superview?.mouseUp(with: event) }
}
