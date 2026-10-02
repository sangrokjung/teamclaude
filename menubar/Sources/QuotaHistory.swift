import Foundation

// 주기 단위 요약만 쌓는다. 60초 폴링 값을 모두 남길 이유가 없다.
// 판정에 필요한 것은 "지난 주기에 실제로 몇 % 썼나" 하나다.
//
// 분모(contributing)를 반드시 함께 남긴다. 계정 7개가 살아 있을 때의 82%와
// 15개일 때의 82%는 소비량이 두 배 차이라, 분모가 없으면 이력끼리 비교할 수 없다.

struct QuotaCycle: Equatable, Codable {
    let lane: String
    let window: String
    let endedAt: Date
    let contributing: Int
    let paid: Int
    let meanUtilization: Double
    let maxUtilization: Double
    let exhaustedAccounts: Int
    let blockedMoments: Int
    let complete: Bool
}

/// 폴링 한 번의 관측. 주기가 넘어갈 때 직전 관측이 그대로 한 주기가 된다.
struct QuotaObservation: Equatable {
    let lane: String
    let window: String
    let resetAt: Date?
    let contributing: Int
    let paid: Int
    let meanUtilization: Double
    let maxUtilization: Double
    let exhaustedAccounts: Int
    let blocked: Bool
}

private func quotaClose(_ previous: QuotaObservation, endedAt: Date) -> QuotaCycle {
    QuotaCycle(
        lane: previous.lane, window: previous.window, endedAt: endedAt,
        contributing: previous.contributing, paid: previous.paid,
        meanUtilization: previous.meanUtilization, maxUtilization: previous.maxUtilization,
        exhaustedAccounts: previous.exhaustedAccounts,
        blockedMoments: previous.blocked ? 1 : 0, complete: true
    )
}

/// 리셋 시각이 바뀌는 순간이 주기가 넘어간 순간이다. 그때 직전 주기를 확정한다.
///
/// 확정값은 **직전 관측**이다. 현재 관측은 이미 새 주기의 것이라 쓰면 안 된다.
func quotaCycleBoundary(previous: QuotaObservation?, current: QuotaObservation,
                        now: Date) -> QuotaCycle? {
    guard let previous,
          previous.lane == current.lane, previous.window == current.window,
          let previousReset = previous.resetAt, let currentReset = current.resetAt,
          previousReset != currentReset else {
        return nil
    }
    // 시계가 되감기면 종료 시각이 미래가 된다. 그런 주기는 기록하지 않는다.
    // 잘못된 시각이 이력에 섞이면 평균이 오염되고 되돌릴 방법이 없다.
    guard previousReset <= now else { return nil }
    return quotaClose(previous, endedAt: previousReset)
}

/// 리셋 시각을 주지 않는 레인(Grok)의 주기 경계.
///
/// 사용률은 주기 안에서 단조 증가하다 리셋에서만 떨어진다. 그래서 큰 하락은 리셋이다.
/// 20%p는 관측 간격(60초) 동안 정상 사용으로 도달하기 어려운 폭이라 잡음과 구분된다.
/// 리셋 시각을 모르므로 종료 시각은 관측 시각으로 둔다. 추정이라는 사실은 화면이 표시한다.
let quotaResetDropThreshold: Double = 0.2

func quotaDropBoundary(previous: QuotaObservation?, current: QuotaObservation,
                       now: Date) -> QuotaCycle? {
    guard let previous,
          previous.lane == current.lane, previous.window == current.window,
          previous.meanUtilization - current.meanUtilization >= quotaResetDropThreshold else {
        return nil
    }
    return quotaClose(previous, endedAt: now)
}

private struct QuotaHistoryFile: Codable {
    let version: Int
    let cycles: [QuotaCycle]
}

var quotaHistoryURL: URL {
    URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".codex/cache/cc-menubar-quota-history-v1.json")
}

/// 읽기는 절대 던지지 않는다. 파일이 깨져도 앱이 죽는 것보다 이력을 잃는 편이 낫다.
func quotaHistoryDecode(_ data: Data) -> [QuotaCycle] {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    guard let file = try? decoder.decode(QuotaHistoryFile.self, from: data),
          file.version == 1 else {
        return []
    }
    return file.cycles
}

func quotaHistoryEncode(_ cycles: [QuotaCycle]) -> Data? {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return try? encoder.encode(QuotaHistoryFile(version: 1, cycles: cycles))
}

/// 보관은 레인·창 조합마다 센다. 한 레인이 오래 돌았다고 다른 레인의 이력이 밀리면
/// 그 레인은 영원히 판정할 수 없다.
func quotaHistoryTrimmed(_ cycles: [QuotaCycle], keepPerLane: Int = 32) -> [QuotaCycle] {
    var kept: [String: [QuotaCycle]] = [:]
    for cycle in cycles.sorted(by: { $0.endedAt < $1.endedAt }) {
        kept["\(cycle.lane)/\(cycle.window)", default: []].append(cycle)
    }
    return kept.values.flatMap { $0.suffix(keepPerLane) }.sorted { $0.endedAt < $1.endedAt }
}
