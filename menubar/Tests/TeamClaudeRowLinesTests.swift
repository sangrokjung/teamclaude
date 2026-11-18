import Foundation

// 계정 행 보조 줄 판정과 행 기하. 높이 계산·그리기·버튼 배치가 전부 이 함수들에 기대므로
// 여기서 고정하는 값이 바뀌면 세 경로가 함께 움직여야 한다.
@main
struct TeamClaudeRowLinesTests {
    static func main() {
        // 1. 사유 줄 — 정상·서버 전체 조건 문구만 빠지고, 계정별 문제 사유는 전부 남는다.
        for reason in [TeamClaudeRowReason.fableReady, TeamClaudeRowReason.opusReady, TeamClaudeRowReason.offline,
                       TeamClaudeRowReason.thresholdUnknown, TeamClaudeRowReason.measurementStale] {
            precondition(!teamClaudeReasonLineIsInformative(reason), "\(reason) repeats on every row and says nothing per account")
        }
        for reason in ["인증 거부 · 상태 확인 필요", "구독 접근 차단", "비활성 · 직접 꺼 둔 계정", "세션·전체 주간 한도 대기",
                       "구독 종료 · 이용 불가", "구독 종료일 경과 · 확인 필요", "한도 리셋 경과 · 재측정 필요",
                       "프록시 라우팅 제외", "일시 제한 해제 대기", "사용 한도 리셋 대기", "서버 상태 확인 필요"] {
            precondition(teamClaudeReasonLineIsInformative(reason), "problem reason must never be dropped: \(reason)")
        }
        precondition(teamClaudeReasonLineIsInformative(""), "an unknown reason is kept rather than silently hidden")

        // 2. 구독 줄 — 전부 미확인이면 빠지고, 정보가 하나라도 있으면 남는다.
        let blank = AccountSubscriptionDetails(tracksCancellation: true)
        precondition(!accountSubscriptionLineIsInformative(blank), "all-unknown subscription line is noise")
        precondition(accountSubscriptionLabel(blank, now: Date()).contains("구독 미확인"), "fixture really is the all-unknown label")
        precondition(accountSubscriptionLineIsInformative(AccountSubscriptionDetails(plan: "Max 20×", tracksCancellation: true)))
        let confirmed = AccountSubscriptionConfirmation(state: .scheduled, date: "2099-10-05", checkedAt: Date(), source: "user-confirmed")
        precondition(accountSubscriptionLineIsInformative(AccountSubscriptionDetails(tracksCancellation: true, confirmation: confirmed)))
        precondition(accountSubscriptionLineIsInformative(AccountSubscriptionDetails(paymentDate: "2099-10-05", tracksCancellation: true)))
        precondition(!accountSubscriptionLineIsInformative(AccountSubscriptionDetails(paymentDate: "not-a-date", tracksCancellation: true)),
                     "an unparsable payment date renders as 미확인 and adds nothing")
        var monitored = blank
        monitored.monitorStatus = "로그인 필요"
        precondition(accountSubscriptionLineIsInformative(monitored), "mail monitor status is actionable")
        precondition(accountSubscriptionLineIsInformative(blank, appearance: .ended), "server-recorded end shows even with no local record")
        precondition(accountSubscriptionLineIsInformative(blank, appearance: .endDateReached))

        // 3. 행 기하(A안 520pt) — 세 줄 다 있으면 예전 고정 행(70 + 2)과 같고, 빠진 줄만큼 줄어든다.
        precondition(teamClaudeRowHeight(.full) == 70)
        precondition(teamClaudeRowStride(.full) == 72)
        precondition(teamClaudeRowHeight(.compact) == 30)
        precondition(teamClaudeRowHeight(TeamClaudeRowLines(reason: true, subscription: false)) == 48)
        precondition(teamClaudeRowHeight(TeamClaudeRowLines(reason: false, subscription: true)) == 52)
        precondition(teamClaudeReasonLineY(.full) == 26)
        precondition(teamClaudeSubscriptionLineY(.full) == 44)
        precondition(teamClaudeReasonLineY(.compact) == nil && teamClaudeSubscriptionLineY(.compact) == nil)
        precondition(teamClaudeSubscriptionLineY(TeamClaudeRowLines(reason: false, subscription: true)) == 26,
                     "without a reason line the subscription line moves up into its slot")
        let rows: [TeamClaudeRowLines] = [.full, .compact, TeamClaudeRowLines(reason: true, subscription: false)]
        precondition(teamClaudeRowOrigins(rows) == [0, 72, 104, 154])
        precondition(teamClaudeRowsHeight(rows) == 154)
        precondition(teamClaudeRowOrigins([]) == [0] && teamClaudeRowsHeight([]) == 0)
        precondition(teamClaudeRowsHeight(Array(repeating: .full, count: 17)) == 17 * 72, "all-full rows reproduce the legacy table height")

        // 4. 펼친 행 — 상세 칸만큼 길어지고, 상세 칸은 보조 줄 바로 아래에서 시작한다.
        //    기록 없는 계정의 구독 입력 진입점은 이 상세 칸에 있다(이름 줄의 투명 버튼은 없앴다).
        precondition(teamClaudeRowHeight(.compact, expanded: true) == 30 + TeamClaudeRowMetrics.detailHeight)
        precondition(teamClaudeDetailY(.full) == 70 && teamClaudeDetailY(.compact) == 30)
        // 열은 겹치지 않고 표 폭(520 - 16) 안에 든다.
        precondition(TeamClaudeColumns.nameX + TeamClaudeColumns.nameWidth <= TeamClaudeColumns.sessionX)
        precondition(TeamClaudeColumns.sessionX + TeamClaudeColumns.meterWidth < TeamClaudeColumns.weeklyX)
        precondition(TeamClaudeColumns.weeklyX + TeamClaudeColumns.meterWidth < TeamClaudeColumns.fableX)
        precondition(TeamClaudeColumns.fableX + TeamClaudeColumns.meterWidth < TeamClaudeColumns.statusX)
        precondition(TeamClaudeColumns.statusX + 60 <= 520 - TeamClaudeColumns.padding, "status column keeps room for a label")

        // 5. 표 상단 기하 — 4pt 리듬. 행 시작 y와 행 없는 높이가 한 함수에서 나온다.
        for value in [TeamClaudeCardMetrics.topInset, TeamClaudeCardMetrics.headerHeight, TeamClaudeCardMetrics.hostLineHeight,
                      TeamClaudeCardMetrics.stripHeight, TeamClaudeCardMetrics.stripGap, TeamClaudeCardMetrics.tableHeadHeight,
                      TeamClaudeCardMetrics.tableHeadGap, TeamClaudeCardMetrics.footerHeight, TeamClaudeCardMetrics.cardInset] {
            precondition(value.truncatingRemainder(dividingBy: 4) == 0, "card spacing follows a 4pt scale: \(value)")
        }
        precondition(TeamClaudeCardMetrics.rowsTop(hostLine: false) == 120)
        precondition(TeamClaudeCardMetrics.rowsTop(hostLine: true) == 140)
        precondition(teamClaudeCardBaseHeight(hostLine: false) == 156)
        precondition(teamClaudeCardBaseHeight(hostLine: true) == 176, "the host line adds exactly its own height")
        precondition(teamClaudeCardBaseHeight(hostLine: false) < 256, "stage 2 removed the four stat tiles, so the base must shrink")

        // 6. 5시간 창이 없는 계정의 세션 칸: 측정 문제 어휘 대신 "없음", 리셋 줄도 "세션 없음".
        L10n.language = .ko
        precondition(teamClaudeSessionEmptyLabel(sessionWindowAbsent: true, stale: true, quotaBlocked: false, attempted: true) == "없음")
        precondition(teamClaudeSessionEmptyLabel(sessionWindowAbsent: true, stale: false, quotaBlocked: false, attempted: false) == L10n.sessionNoneShort)
        precondition(teamClaudeSessionEmptyLabel(sessionWindowAbsent: false, stale: false, quotaBlocked: false, attempted: false) == StatusVocabulary.notMeasured)
        precondition(teamClaudeSessionEmptyLabel(sessionWindowAbsent: false, stale: false, quotaBlocked: false, attempted: true) == StatusVocabulary.needsCheck)
        precondition(teamClaudeSessionEmptyLabel(sessionWindowAbsent: false, stale: true, quotaBlocked: false, attempted: true) == L10n.remeasure)
        precondition(teamClaudeSessionEmptyLabel(sessionWindowAbsent: false, stale: true, quotaBlocked: true, attempted: true) == L10n.quotaReset)
        precondition(teamClaudeSessionResetPart(sessionWindowAbsent: true, resetLabel: "3시간 뒤") == "세션 없음")
        precondition(teamClaudeSessionResetPart(sessionWindowAbsent: false, resetLabel: "3시간 뒤") == "세션 3시간 뒤")
        L10n.language = .en
        precondition(teamClaudeSessionEmptyLabel(sessionWindowAbsent: true, stale: false, quotaBlocked: false, attempted: true) == "None")
        precondition(teamClaudeSessionResetPart(sessionWindowAbsent: true, resetLabel: "3h") == "No session")
        L10n.language = .ko

        // 7. 주간 리셋을 행에 바로 보인다(2026-11-18). 구독 계정·미래 리셋만, API 키·종료·지난 리셋은 아니다.
        let seoul = TimeZone(identifier: "Asia/Seoul")!
        var cal = Calendar(identifier: .gregorian); cal.timeZone = seoul
        let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 17, hour: 23, minute: 10))!
        let reset = cal.date(from: DateComponents(year: 2026, month: 11, day: 18, hour: 10, minute: 0))!
        precondition(teamClaudeShowsWeeklyReset(isApiKey: false, ended: false, weeklyResetAt: reset, now: now))
        precondition(!teamClaudeShowsWeeklyReset(isApiKey: true, ended: false, weeklyResetAt: reset, now: now), "API keys have no weekly window")
        precondition(!teamClaudeShowsWeeklyReset(isApiKey: false, ended: true, weeklyResetAt: reset, now: now), "an ended plan never comes back")
        precondition(!teamClaudeShowsWeeklyReset(isApiKey: false, ended: false, weeklyResetAt: now.addingTimeInterval(-1), now: now))
        precondition(!teamClaudeShowsWeeklyReset(isApiKey: false, ended: false, weeklyResetAt: nil, now: now))
        precondition(L10n.resetMoment(reset, timeZone: seoul) == "11/18(수) 10:00", L10n.resetMoment(reset, timeZone: seoul))
        // 시각 문자열은 시스템 시간대를 따른다. 문구 조립만 비교하려고 같은 함수로 기대값을 만든다.
        let moment = L10n.resetMoment(reset)
        let readyLine = teamClaudeReasonLineText(reason: TeamClaudeRowReason.opusReady, showsWeeklyReset: true, weeklyResetAt: reset, now: now)
        precondition(readyLine == "주간 리셋 \(moment) · 10시간 50분 뒤", readyLine)
        let limitedLine = teamClaudeReasonLineText(reason: "전체 주간 한도 대기", showsWeeklyReset: true, weeklyResetAt: reset, now: now)
        precondition(limitedLine == "전체 주간 한도 대기 · 리셋 \(moment) (10시간 50분 뒤)", limitedLine)
        precondition(teamClaudeReasonLineText(reason: "인증 거부", showsWeeklyReset: false, weeklyResetAt: reset, now: now) == "인증 거부",
                     "without a reset the reason is untouched")

        // 8. 한도 대기 묶음은 리셋이 빠른 순, 다른 묶음은 원래 순서. 값이 없으면 뒤로.
        let mixed: [TeamClaudeRowGroup] = [.limited, .ready, .limited, .limited, .ready]
        let plain = Array(repeating: TeamClaudeRowLines.compact, count: mixed.count)
        let sorted = teamClaudeGroupedLayout(groups: mixed, lines: plain, expanded: nil, resetKeys: [300, 900, nil, 100, 50])
        precondition(sorted.order == [1, 4, 3, 0, 2], "\(sorted.order)")
        let unsorted = teamClaudeGroupedLayout(groups: mixed, lines: plain, expanded: nil)
        precondition(unsorted.order == [1, 4, 0, 2, 3], "no keys keeps the original order")
        precondition(sorted.height == unsorted.height, "sorting never changes the height")
        let tie = teamClaudeGroupedLayout(groups: [.limited, .limited], lines: [.compact, .compact], expanded: nil, resetKeys: [100, 100])
        precondition(tie.order == [0, 1], "ties keep the original order")

        // 9. 복귀 일정: 다음 리셋(같은 분 개수)과 마지막 복귀. 지난 리셋은 뺀다.
        let r2 = reset.addingTimeInterval(30), r3 = reset.addingTimeInterval(86_400)
        let schedule = teamClaudeWeeklySchedule([r3, reset, now.addingTimeInterval(-60), r2], now: now)
        precondition(schedule == TeamClaudeWeeklySchedule(next: reset, nextCount: 2, last: r3), "\(String(describing: schedule))")
        precondition(teamClaudeWeeklySchedule([now.addingTimeInterval(-1)], now: now) == nil)
        // "복귀"가 아니라 주간 리셋 시각만 말한다(세션 한도가 겹친 계정은 더 늦게 돌아올 수 있다).
        precondition(L10n.weeklyScheduleDetail(next: "A", nextIn: "1시간", nextCount: 1, last: "B") == "주간 리셋: 다음 A (1시간 뒤) · 마지막 B")
        precondition(L10n.weeklyScheduleDetail(next: "A", nextIn: "1시간", nextCount: 3, last: nil) == "주간 리셋: 다음 A (1시간 뒤, 3개)")
        precondition(!L10n.weeklyScheduleDetail(next: "A", nextIn: "1시간", nextCount: 1, last: "B").contains("복귀"))
        L10n.language = .en
        precondition(L10n.resetMoment(reset, timeZone: seoul) == "11/18 (Wed) 10:00", L10n.resetMoment(reset, timeZone: seoul))
        L10n.language = .ko

        print("teamclaude row lines: reason/subscription gating, row geometry, expanded detail, columns, card metrics, weekly reset and schedule passed")
    }
}
