import Foundation

// Claude 풀 표의 계정 행은 이름 줄 아래에 보조 줄 두 개(2행 사유, 3행 구독)를 둘 수 있다.
// 어느 줄을 그릴지와 그 결과 행이 몇 pt인지를 이 파일 하나가 정한다.
// 높이 계산(teamContentHeight)·버튼 배치(layout)·그리기(draw)가 서로 다른 판정을 쓰면
// 행이 겹치거나 빈 칸이 생기므로, 세 경로 모두 여기 함수만 부른다. main.swift 밖에 둔 이유는
// 테스트 러너가 main.swift 없이 컴파일하는 라이브러리 묶음에 들어가야 해서다.

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

/// 구독 기록이 비어 있어도 진입점은 남긴다 — 정보가 없을 때가 바로 입력이 필요한 때다.
/// 3행을 다시 세우면 1단계가 걷어낸 반복 줄이 돌아오므로, 이름 줄 오른쪽 빈자리에 조용한(흐린) 버튼으로 둔다.
/// 이름이 그 자리를 덮을 만큼 길면 3행으로 내려간다. 이름을 더 잘라 자리를 만드는 쪽은 정보를 줄이는 것이라 택하지 않았다.
enum TeamClaudeSubscriptionEntry {
    /// 이름 줄에서 이름이 차지할 수 있는 폭(글자 단위). rowFont는 고정폭 13pt라 ASCII 한 글자 약 8pt, 한글은 두 배로 센다.
    /// 이름은 innerX+24에서 시작하고 버튼은 innerX+inlineX에서 시작하므로 20단위(약 160pt)면 8pt 이상 여백이 남는다.
    static let inlineNameMaxUnits = 20
    /// 행 원점 기준 조용한 버튼의 x 오프셋(innerX 기준)·폭. 세션 열(innerX+270) 앞에서 끝난다.
    static let inlineX: CGFloat = 196
    static let inlineWidth: CGFloat = 70
    static let inlineHeight: CGFloat = 22
    /// 마우스가 행 위에 없을 때의 투명도.
    ///
    /// 0이다. 기록이 없는 계정이 대다수라 옅게라도 남기면 같은 문구가 행마다 반복되고,
    /// 그건 이번 정리에서 걷어낸 그 노이즈와 같다. 행을 가리키는 순간 드러나므로
    /// 발견은 그 동작에 맡긴다. alpha 0이어도 접근성 트리에는 남아 보조기기는 읽는다.
    static let restingAlpha: CGFloat = 0
}

/// 이름 폭을 글자 단위로 센다. 비ASCII(한글 등)는 고정폭 글꼴에서 두 칸을 차지한다.
func teamClaudeNameWidthUnits(_ name: String) -> Int {
    name.unicodeScalars.reduce(0) { $0 + ($1.isASCII ? 1 : 2) }
}

/// 구독 진입점을 이름 줄 안에 둘 수 있는지. 아니면 3행(구독 줄)으로 내려간다.
func teamClaudeSubscriptionEntryFitsInline(name: String) -> Bool {
    teamClaudeNameWidthUnits(name) <= TeamClaudeSubscriptionEntry.inlineNameMaxUnits
}

/// 한 행에 그릴 보조 줄.
struct TeamClaudeRowLines: Equatable {
    var reason: Bool
    var subscription: Bool

    static let full = TeamClaudeRowLines(reason: true, subscription: true)
    static let compact = TeamClaudeRowLines(reason: false, subscription: false)
}

/// 행 기하. 세 줄 다 있을 때 70pt + 간격 2pt = 72pt로, 보조 줄이 생기기 전 고정 행 높이와 같다.
enum TeamClaudeRowMetrics {
    static let nameHeight: CGFloat = 28
    static let reasonHeight: CGFloat = 20
    static let subscriptionHeight: CGFloat = 22
    static let gap: CGFloat = 2
    /// 이름 줄 아래 첫 보조 줄이 시작하는 y.
    static let firstLineY: CGFloat = 27
}

func teamClaudeRowHeight(_ lines: TeamClaudeRowLines) -> CGFloat {
    TeamClaudeRowMetrics.nameHeight
        + (lines.reason ? TeamClaudeRowMetrics.reasonHeight : 0)
        + (lines.subscription ? TeamClaudeRowMetrics.subscriptionHeight : 0)
}

func teamClaudeRowStride(_ lines: TeamClaudeRowLines) -> CGFloat {
    teamClaudeRowHeight(lines) + TeamClaudeRowMetrics.gap
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

/// 표 첫 행 기준 각 행의 원점 y. 마지막 원소 뒤에 총 높이가 하나 더 붙는다(count + 1개).
func teamClaudeRowOrigins(_ rows: [TeamClaudeRowLines]) -> [CGFloat] {
    var origins: [CGFloat] = [0]
    for lines in rows { origins.append(origins[origins.count - 1] + teamClaudeRowStride(lines)) }
    return origins
}

func teamClaudeRowsHeight(_ rows: [TeamClaudeRowLines]) -> CGFloat {
    rows.reduce(0) { $0 + teamClaudeRowStride($1) }
}

/// 카드 상단(제목·서버 줄·요약 띠·표 머리)의 기하. 4pt 배수 리듬이다.
/// 높이 계산(teamContentHeight)·버튼 배치(layout)·그리기(draw)가 이 값 하나로 행 시작 y를 잡는다 —
/// 행 기하와 같은 이유로 한 곳에 둔다.
enum TeamClaudeCardMetrics {
    /// 대시보드가 카드를 8/4pt 안쪽으로 그리는 인셋(bounds.insetBy(dx: 8, dy: 4)).
    static let cardInset: CGFloat = 4
    /// 카드 위 모서리 → 제목 글자 y.
    static let topInset: CGFloat = 16
    /// 제목 + 서버 줄이 차지하는 높이.
    static let headerHeight: CGFloat = 56
    /// 호스트 요약 줄이 있을 때 더해지는 높이(구버전 서버·미측정 시 0).
    static let hostLineHeight: CGFloat = 20
    /// "사용 가능 계정 · 대기/제외/확인" 한 줄 띠.
    static let stripHeight: CGFloat = 24
    static let stripGap: CGFloat = 8
    /// 표 머리 띠와 첫 행 사이.
    static let tableHeadHeight: CGFloat = 32
    static let tableHeadGap: CGFloat = 4
    /// 마지막 행 아래 → 카드 아래 모서리(구분선 + 각주).
    static let footerHeight: CGFloat = 44

    static func titleY(hostLine: Bool) -> CGFloat { cardInset + topInset }
    static func stripY(hostLine: Bool) -> CGFloat {
        titleY(hostLine: hostLine) + headerHeight + (hostLine ? hostLineHeight : 0)
    }
    static func tableHeadY(hostLine: Bool) -> CGFloat { stripY(hostLine: hostLine) + stripHeight + stripGap }
    /// 첫 행 원점 y(뷰 bounds 기준).
    static func rowsTop(hostLine: Bool) -> CGFloat { tableHeadY(hostLine: hostLine) + tableHeadHeight + tableHeadGap }
}

/// 행을 뺀 카드 높이. 전체 높이 = 이 값 + teamClaudeRowsHeight(rows).
func teamClaudeCardBaseHeight(hostLine: Bool) -> CGFloat {
    TeamClaudeCardMetrics.rowsTop(hostLine: hostLine) + TeamClaudeCardMetrics.footerHeight + TeamClaudeCardMetrics.cardInset
}
