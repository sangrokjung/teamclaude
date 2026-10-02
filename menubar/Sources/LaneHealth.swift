import Foundation

// CLI 쿼터 레인(grok·agy·힉스필드)이 조용히 죽는 일이 반복됐다.
//   - agy: 데몬 수명 내내 작업 폴더 문제로 한 번도 성공하지 못했다 (2026-09-23)
//   - 힉스필드: 주기 조회 자체가 없어 기동 시 실패가 영구 공백이 됐다 (2026-09-24)
//   - grok: 토큰 만료가 "로그인"으로만 보여 원인을 찾는 데 시간이 들었다 (2026-09-24)
// 셋의 공통점은 화면이 "값 없음"과 "죽었음"을 구분하지 못한 것이다. 여기서는 레인별로
// 마지막 성공 시각을 보고, 제 주기의 몇 배가 지나도록 성공이 없으면 그 사실을 문장으로 만든다.

struct LaneHealth: Equatable {
    /// 로그에 찍힐 이름.
    let name: String
    /// 그 레인의 조회 주기.
    let interval: TimeInterval
    /// 마지막 성공 시각. 한 번도 성공하지 못했으면 nil.
    let lastSuccessAt: Date?
    /// 기동 시각. 한 번도 성공하지 못한 레인은 이 시각을 기준으로 잰다.
    let startedAt: Date
}

/// 죽었다고 보기까지 허용할 주기 배수. 1회 실패로 경보하면 잡음이 되고,
/// 3배면 연속 실패가 확실해진다.
let laneStaleFactor: Double = 3

/// 같은 경보를 반복하지 않을 간격. 레인이 오래 죽어 있어도 로그를 채우지 않는다.
let laneStaleLogCooldown: TimeInterval = 600

struct LaneStaleNotice: Equatable {
    let name: String
    let message: String
    /// 화면에 붙일 짧은 꼬리말. 로그 문장과 같은 수치를 쓴다 — 둘이 갈리면 어느 쪽이 맞는지 알 수 없다.
    let note: String
}

/// 갱신이 끊긴 레인의 설명을 만든다. 정상인 레인은 아무것도 만들지 않는다.
func laneStaleMessages(_ lanes: [LaneHealth], now: Date, factor: Double = laneStaleFactor) -> [LaneStaleNotice] {
    var out: [LaneStaleNotice] = []
    for lane in lanes {
        guard lane.interval > 0 else { continue }
        let since = lane.lastSuccessAt ?? lane.startedAt
        let elapsed = now.timeIntervalSince(since)
        guard elapsed > lane.interval * factor else { continue }
        let minutes = max(Int(elapsed / 60), 1)
        let what = lane.lastSuccessAt == nil ? "기동 후 한 번도 성공 못 함" : "마지막 성공 이후"
        out.append(LaneStaleNotice(
            name: lane.name,
            message: "LANE-STALE: \(lane.name) \(minutes)분째 갱신 없음 (\(what))",
            note: StatusVocabulary.staleSuffix(minutes: minutes)
        ))
    }
    return out
}
