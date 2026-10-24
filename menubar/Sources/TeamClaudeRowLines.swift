import Foundation

// Claude 풀 표의 계정 행은 이름 줄 아래에 보조 줄 두 개(2행 사유, 3행 구독)를 둘 수 있다.
// 어느 줄을 그릴지와 그 결과 행이 몇 pt인지를 이 파일 하나가 정한다.
// 높이 계산(teamContentHeight)·버튼 배치(layout)·그리기(draw)가 서로 다른 판정을 쓰면
// 행이 겹치거나 빈 칸이 생기므로, 세 경로 모두 여기 함수만 부른다. main.swift 밖에 둔 이유는
// 테스트 러너가 main.swift 없이 컴파일하는 라이브러리 묶음에 들어가야 해서다.
// 구독 기록이 없는 행의 입력 진입점은 행을 펼치면 나오는 상세 칸에 있다(A안). 예전처럼 이름 줄에
// 투명한 버튼을 숨겨 두지 않는다 — 행을 누르는 동작이 그 자리를 대신한다.

/// 정보가 없어 행에서 빼도 되는 사유 문구.
/// TeamClaudeAvailability가 같은 상수를 쓰므로 문자열이 두 군데서 따로 바뀌지 않는다.
enum TeamClaudeRowReason {
    static let fableReady = "Fable 사용 가능"
    static let opusReady = "Opus 사용 가능"
    static let offline = "오프라인 · 확인 필요"
    static let thresholdUnknown = "한도 기준 확인 필요"
    static let measurementStale = "최신 한도 측정 필요"

    /// 상태 점(초록)이나 헤더 요약("N개 계정 확인 필요")이 이미 말하는 문구, 또는 계정별 원인이 아니라
    /// 서버 전체 조건(오프라인·한도 기준 없음·측정 지연)이라 모든 행에 똑같이 찍히는 문구.
    /// 오류·인증 거부·비활성·한도 초과·구독 종료 같은 계정별 문제 사유는 여기 넣지 않는다 — 그 문구가 이 표의 핵심이다.
    static let uninformative: Set<String> = [fableReady, opusReady, offline, thresholdUnknown, measurementStale]
}

/// 2행(사유)을 그릴지. 위 목록 밖의 문구는 전부 그린다.
func teamClaudeReasonLineIsInformative(_ reason: String) -> Bool {
    !TeamClaudeRowReason.uninformative.contains(reason)
}

/// 3행(구독)을 그릴지. 플랜·확인 기록·입력 결제일·메일 조회 상태 중 하나라도 있어야 한다.
/// 전부 없으면 "구독 미확인 · 해지 미확인 · 결제일 미확인 · 만료일 미확인"처럼 모든 행에 같은 문구가 반복된다.
/// 행 외형이 회색(종료·종료일 경과)이면 서버 기록만으로 종료를 말하는 중이라 기록이 비어 있어도 그린다.
func accountSubscriptionLineIsInformative(_ details: AccountSubscriptionDetails,
                                          appearance: AccountSubscriptionAppearance = .standard) -> Bool {
    if appearance.isMuted { return true }
    if details.plan != nil || details.confirmation != nil || details.monitorStatus != nil { return true }
    return details.paymentDate.flatMap(accountSubscriptionDate) != nil
}

/// 한 행에 그릴 보조 줄.
struct TeamClaudeRowLines: Equatable {
    var reason: Bool
    var subscription: Bool

    static let full = TeamClaudeRowLines(reason: true, subscription: true)
    static let compact = TeamClaudeRowLines(reason: false, subscription: false)
}

/// 행 기하(A안 520pt 표). 이름 줄 아래에 사유 줄·구독 줄이 붙고, 펼친 행에는 상세 칸이 더 붙는다.
enum TeamClaudeRowMetrics {
    static let nameHeight: CGFloat = 30
    static let reasonHeight: CGFloat = 18
    static let subscriptionHeight: CGFloat = 22
    static let gap: CGFloat = 2
    /// 이름 줄 아래 첫 보조 줄이 시작하는 y.
    static let firstLineY: CGFloat = 26
    /// 펼친 행의 상세(구독·동시 요청·누적 요청·리셋 + 동작 버튼).
    static let detailHeight: CGFloat = 92
    /// 상태 묶음 머리(점·이름·개수·설명).
    static let groupHeadHeight: CGFloat = 28
}

/// 열 기하(표 왼쪽 기준). 이름 · 세션 · 주간 · Fable · 상태. 높이·배치·그리기가 같은 값을 쓴다.
enum TeamClaudeColumns {
    static let padding: CGFloat = 16
    static let nameX: CGFloat = 16
    static let nameWidth: CGFloat = 140
    static let meterWidth: CGFloat = 82
    static let sessionX: CGFloat = 164
    static let weeklyX: CGFloat = 254
    static let fableX: CGFloat = 344
    /// 상태 열 오른쪽 끝은 표 폭 - padding.
    static let statusX: CGFloat = 434
}

/// 행을 묶는 상태(사용 가능 · 한도 대기 · 확인 필요 · 제외). 표는 이 순서로 묶어 그린다.
enum TeamClaudeRowGroup: Int, CaseIterable {
    case ready, limited, check, excluded
}

func teamClaudeRowHeight(_ lines: TeamClaudeRowLines, expanded: Bool = false) -> CGFloat {
    TeamClaudeRowMetrics.nameHeight
        + (lines.reason ? TeamClaudeRowMetrics.reasonHeight : 0)
        + (lines.subscription ? TeamClaudeRowMetrics.subscriptionHeight : 0)
        + (expanded ? TeamClaudeRowMetrics.detailHeight : 0)
}

func teamClaudeRowStride(_ lines: TeamClaudeRowLines, expanded: Bool = false) -> CGFloat {
    teamClaudeRowHeight(lines, expanded: expanded) + TeamClaudeRowMetrics.gap
}

/// 행 원점 기준 사유 텍스트 y. 그리지 않으면 nil.
func teamClaudeReasonLineY(_ lines: TeamClaudeRowLines) -> CGFloat? {
    lines.reason ? TeamClaudeRowMetrics.firstLineY : nil
}

/// 행 원점 기준 구독 버튼 y. 사유 줄이 빠지면 그 자리로 올라온다.
func teamClaudeSubscriptionLineY(_ lines: TeamClaudeRowLines) -> CGFloat? {
    guard lines.subscription else { return nil }
    return TeamClaudeRowMetrics.firstLineY + (lines.reason ? TeamClaudeRowMetrics.reasonHeight : 0)
}

/// 행 원점 기준 펼친 상세 칸 y.
func teamClaudeDetailY(_ lines: TeamClaudeRowLines) -> CGFloat {
    teamClaudeRowHeight(lines)
}

/// 표 첫 행 기준 각 행의 원점 y(묶음 없이 위에서부터). 마지막 원소 뒤에 총 높이가 하나 더 붙는다(count + 1개).
func teamClaudeRowOrigins(_ rows: [TeamClaudeRowLines]) -> [CGFloat] {
    var origins: [CGFloat] = [0]
    for lines in rows { origins.append(origins[origins.count - 1] + teamClaudeRowStride(lines)) }
    return origins
}

func teamClaudeRowsHeight(_ rows: [TeamClaudeRowLines]) -> CGFloat {
    rows.reduce(0) { $0 + teamClaudeRowStride($1) }
}

/// 상태별로 묶은 표 배치. 행 순서는 묶음 순서(사용 가능 → 한도 대기 → 확인 필요 → 제외), 같은 묶음 안에서는 원래 순서다.
struct TeamClaudeGroupedLayout: Equatable {
    struct Heading: Equatable {
        let group: TeamClaudeRowGroup
        let y: CGFloat
        let count: Int
    }
    /// 그리는 순서대로 원래 행 번호.
    let order: [Int]
    /// 원래 행 번호 → 표 첫 줄 기준 행 원점 y.
    let origins: [Int: CGFloat]
    let headings: [Heading]
    let height: CGFloat
}

func teamClaudeGroupedLayout(groups: [TeamClaudeRowGroup], lines: [TeamClaudeRowLines], expanded: Int?) -> TeamClaudeGroupedLayout {
    var order: [Int] = []
    var origins: [Int: CGFloat] = [:]
    var headings: [TeamClaudeGroupedLayout.Heading] = []
    var y: CGFloat = 0
    for group in TeamClaudeRowGroup.allCases {
        let members = groups.indices.filter { groups[$0] == group && lines.indices.contains($0) }
        guard !members.isEmpty else { continue }
        headings.append(.init(group: group, y: y, count: members.count))
        y += TeamClaudeRowMetrics.groupHeadHeight
        for index in members {
            order.append(index)
            origins[index] = y
            y += teamClaudeRowStride(lines[index], expanded: index == expanded)
        }
    }
    return TeamClaudeGroupedLayout(order: order, origins: origins, headings: headings, height: y)
}

/// 표 상단(서버 줄·측정 안내·열 머리)의 기하. 4pt 리듬이다.
/// 높이 계산(teamContentHeight)·버튼 배치(layout)·그리기(draw)가 이 값 하나로 행 시작 y를 잡는다.
enum TeamClaudeCardMetrics {
    static let cardInset: CGFloat = 0
    /// 섹션 머리 아래 → 서버 줄 글자 y.
    static let topInset: CGFloat = 4
    /// 서버 줄 높이.
    static let headerHeight: CGFloat = 24
    /// 호스트 요약 줄이 있을 때 더해지는 높이(구버전 서버·미측정 시 0).
    static let hostLineHeight: CGFloat = 20
    /// 측정·연동 안내 띠.
    static let stripHeight: CGFloat = 44
    static let stripGap: CGFloat = 12
    /// 열 머리(이름 + 리셋 한 번).
    static let tableHeadHeight: CGFloat = 36
    static let tableHeadGap: CGFloat = 0
    /// 마지막 행 아래 범례 한 줄.
    static let footerHeight: CGFloat = 36

    static func titleY(hostLine: Bool) -> CGFloat { cardInset + topInset }
    static func stripY(hostLine: Bool) -> CGFloat {
        titleY(hostLine: hostLine) + headerHeight + (hostLine ? hostLineHeight : 0)
    }
    static func tableHeadY(hostLine: Bool) -> CGFloat { stripY(hostLine: hostLine) + stripHeight + stripGap }
    /// 첫 행(첫 묶음 머리) 원점 y(뷰 bounds 기준).
    static func rowsTop(hostLine: Bool) -> CGFloat { tableHeadY(hostLine: hostLine) + tableHeadHeight + tableHeadGap }
}

/// 행을 뺀 표 높이. 전체 높이 = 이 값 + teamClaudeGroupedLayout(...).height.
func teamClaudeCardBaseHeight(hostLine: Bool) -> CGFloat {
    TeamClaudeCardMetrics.rowsTop(hostLine: hostLine) + TeamClaudeCardMetrics.footerHeight + TeamClaudeCardMetrics.cardInset
}
