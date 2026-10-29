import Cocoa

// 구독 상태 보기·처리(웹랩 시안 B 2차본)의 판정·명령 조립·되돌리기를 고정한다.
// 러너가 main.swift 없이 라이브러리 소스와 함께 컴파일해 돌린다.
@main
struct SubscriptionStateTests {
    static func day(_ ymd: String, hour: Int = 12) -> Date {
        accountSubscriptionDate(ymd)!.addingTimeInterval(TimeInterval(hour * 3600))
    }

    static func confirmation(_ state: AccountSubscriptionState, _ date: String?, at: Date, source: String = "user-confirmed")
        -> AccountSubscriptionConfirmation {
        AccountSubscriptionConfirmation(state: state, date: date, checkedAt: at, source: source)
    }

    static func codexAccount(name: String = "codex-01", uuid: String? = "uuid-codex-01", state: String? = nil,
                             endsAt: Date? = nil, status: String = "active", errorReason: String? = nil,
                             enabled: Bool = true) -> TeamCodexPoolAccount {
        var account = TeamCodexPoolAccount(
            name: name, accountUuid: uuid, isCurrent: false, enabled: enabled, status: status, errorReason: errorReason,
            usableFromProxy: nil, sessionPercent: nil, sessionResetAt: nil, weeklyPercent: nil, weeklyResetAt: nil,
            inflight: 0, maxConcurrent: 3, totalRequests: 0, totalTokens: 0)
        account.subscriptionState = state
        account.subscriptionEndsAt = endsAt
        account.accountType = "oauth"
        account.providerName = "codex"
        return account
    }

    // 1. 상태 5가지와 종료일 지남 계산
    static func fiveStates() {
        let now = day("2026-10-29")
        precondition(subscriptionRecordView(nil, now: now) == nil)
        precondition(subscriptionRecordView(confirmation(.renewing, nil, at: now), now: now)?.state == .active)
        precondition(subscriptionRecordView(confirmation(.scheduled, "2026-11-12", at: now), now: now)?.state == .scheduled)
        precondition(subscriptionRecordView(confirmation(.scheduled, nil, at: now), now: now)?.state == .scheduled)
        // 종료일 당일은 아직 쓸 수 있다(그날까지 사용 가능). 다음 날부터 지남.
        precondition(subscriptionRecordView(confirmation(.scheduled, "2026-10-29", at: now), now: now)?.state == .scheduled)
        precondition(subscriptionRecordView(confirmation(.scheduled, "2026-10-28", at: now), now: now)?.state == .overdue)
        precondition(subscriptionRecordView(confirmation(.ended, nil, at: now), now: now)?.state == .ended)
        precondition(subscriptionDayOffset("2026-11-12", now: now) == 14)
        precondition(subscriptionDayOffset("2026-10-27", now: now) == -2)
        precondition(subscriptionDayOffset("bad", now: now) == nil)
        precondition(Set(SubscriptionDisplayState.allCases.map(\.label)).count == 5)

        // 행 아래 한 줄: 해지 계열만.
        let scheduled = SubscriptionRecordView(state: .scheduled, endDate: "2026-11-12")
        precondition(subscriptionRowLine(scheduled, now: now) == "해지 예약 · 11/12 종료 · 14일 남음")
        precondition(subscriptionRowLine(SubscriptionRecordView(state: .scheduled), now: now) == "해지 예약 · 종료일 모름")
        precondition(subscriptionRowLine(SubscriptionRecordView(state: .overdue, endDate: "2026-10-20"), now: now)
                     == "종료일 지남 · 10/20 종료 · 확정 전")
        precondition(subscriptionRowLine(SubscriptionRecordView(state: .ended, endDate: nil, source: "user-confirmed"), now: now)
                     == "해지 확정 · 종료일 미상 · 사용자 확인")
        precondition(subscriptionRowLine(SubscriptionRecordView(state: .active), now: now) == nil)
        precondition(subscriptionRowLine(SubscriptionRecordView(state: .unknown), now: now) == nil)
    }

    // 2. Claude: 프록시 값과 로컬 기록 합치기
    static func claudeMerge() {
        let now = day("2026-10-29")
        let earlier = now.addingTimeInterval(-3600)
        let proxy = confirmation(.scheduled, "2026-11-12", at: earlier, source: "proxy-record")
        // 로컬 기록이 없으면 프록시 값.
        var r = claudeSubscriptionResolution(local: nil, proxy: proxy, errorReason: nil, proxyEndReached: false, now: now)
        precondition(r.state == .scheduled && r.shown.source == "proxy-record" && !r.disagrees)
        // 더 새 로컬 기록(종료로 확정)이 이긴다. 두 값이 다르면 둘 다 남긴다.
        r = claudeSubscriptionResolution(local: confirmation(.ended, nil, at: now), proxy: proxy, errorReason: nil,
                                         proxyEndReached: false, now: now)
        precondition(r.state == .ended && r.disagrees && r.proxy?.state == .scheduled && r.local?.state == .ended)
        // 더 새 프록시 기록이 이긴다.
        r = claudeSubscriptionResolution(local: confirmation(.renewing, nil, at: earlier.addingTimeInterval(-60)), proxy: proxy,
                                         errorReason: nil, proxyEndReached: false, now: now)
        precondition(r.state == .scheduled && r.disagrees)
        // 프록시가 구독 종료로 판정한 오류는 무엇보다 강하다.
        r = claudeSubscriptionResolution(local: confirmation(.renewing, nil, at: now), proxy: nil,
                                         errorReason: "subscription-ended", proxyEndReached: false, now: now)
        precondition(r.state == .ended && r.disagrees)
        // 프록시가 종료일 도달로 본 해지 예약은 날짜가 없어도 종료일 지남이다.
        r = claudeSubscriptionResolution(local: nil, proxy: confirmation(.scheduled, nil, at: earlier, source: "proxy-record"),
                                         errorReason: nil, proxyEndReached: true, now: now)
        precondition(r.state == .overdue)
        // 아무 기록도 없으면 확인 안 됨.
        r = claudeSubscriptionResolution(local: nil, proxy: nil, errorReason: "auth-rejected", proxyEndReached: false, now: now)
        precondition(r.state == .unknown && !r.isCancelled)
    }

    // 3. Codex: 프록시 설정이 정본, 로컬 확정은 즉시 보인다
    static func codexMerge() {
        let now = day("2026-10-29")
        var r = codexSubscriptionResolution(account: codexAccount(), local: nil, now: now)
        precondition(r.state == .unknown)
        r = codexSubscriptionResolution(account: codexAccount(state: "cancellation-scheduled", endsAt: day("2026-11-13", hour: 0)),
                                        local: nil, now: now)
        precondition(r.state == .scheduled && r.shown.endDate == "2026-11-12")
        r = codexSubscriptionResolution(account: codexAccount(state: "end-date-reached"), local: nil, now: now)
        precondition(r.state == .overdue)
        // 바로 종료로 확정: 로컬 확정이 즉시 보이고, 프록시 값은 따로 남는다.
        r = codexSubscriptionResolution(account: codexAccount(state: "cancellation-scheduled"),
                                        local: confirmation(.ended, nil, at: now), now: now)
        precondition(r.state == .ended && r.disagrees && r.proxy?.state == .scheduled)
        // 재시작 전이라 프록시에 아직 없는 해지 기록도 로컬로 보인다.
        r = codexSubscriptionResolution(account: codexAccount(), local: confirmation(.scheduled, "2026-11-12", at: now), now: now)
        precondition(r.state == .scheduled && !r.disagrees)
        // 프록시 값이 ended가 되면 그 값을 쓴다.
        r = codexSubscriptionResolution(account: codexAccount(state: "ended"), local: confirmation(.scheduled, nil, at: now), now: now)
        precondition(r.state == .ended && r.shown.source == "proxy-record")
        r = codexSubscriptionResolution(account: codexAccount(errorReason: "subscription-ended"), local: nil, now: now)
        precondition(r.state == .ended)
    }

    // 4. 손볼 것 분기
    static func todoPlans() {
        // Claude: 해지 기록 + 인증 오류 → 종료로 확정.
        var plan = claudeSubscriptionTodoPlan(canReauth: true, orgBlocked: false, subscription: .scheduled, baseReason: "재인증하면 돌아옴")
        precondition(plan?.action == .confirmSubscriptionEnd && plan?.title == "종료로 확정" && plan?.primary == true)
        plan = claudeSubscriptionTodoPlan(canReauth: true, orgBlocked: false, subscription: .overdue, baseReason: "x")
        precondition(plan?.action == .confirmSubscriptionEnd)
        // 해지 확정은 손볼 것에서 빠진다.
        precondition(claudeSubscriptionTodoPlan(canReauth: true, orgBlocked: false, subscription: .ended, baseReason: "x") == nil)
        // 기록 없는 인증 오류는 재인증 유지 + 안내.
        plan = claudeSubscriptionTodoPlan(canReauth: true, orgBlocked: false, subscription: .unknown, baseReason: "재인증하면 돌아옴")
        precondition(plan?.action == .reauthenticate && plan?.reason == "재인증하면 돌아옴 · 다시 로그인해도 안 풀리면 해지 기록")
        // 조직 차단은 지금처럼 구독 확인.
        plan = claudeSubscriptionTodoPlan(canReauth: false, orgBlocked: true, subscription: .unknown, baseReason: "조직 차단")
        precondition(plan?.action == .subscriptionRecord && plan?.title == "구독 확인")

        // Codex: 해지 계정에 다시 켜기를 권하지 않는다.
        let now = day("2026-10-29")
        let disabled = codexAccount(enabled: false)
        let scheduledLocal = codexSubscriptionResolution(account: disabled, local: confirmation(.scheduled, nil, at: now), now: now)
        precondition(teamCodexAccountRecovery(disabled, now: now)?.kind == .enable)
        precondition(teamCodexSubscriptionAwareRecovery(disabled, subscription: scheduledLocal, now: now) == nil)
        precondition(codexSubscriptionTodoPlan(disabled, subscription: scheduledLocal, now: now) == nil)
        let endedLocal = codexSubscriptionResolution(account: disabled, local: confirmation(.ended, nil, at: now), now: now)
        precondition(teamCodexSubscriptionAwareRecovery(disabled, subscription: endedLocal, now: now) == nil)
        precondition(codexSubscriptionTodoPlan(disabled, subscription: endedLocal, now: now) == nil)
        // 인증 오류 + 해지 기록 → 재인증 대신 종료로 확정.
        let failed = codexAccount(status: "error", errorReason: "auth-rejected")
        let cancelled = codexSubscriptionResolution(account: failed, local: confirmation(.scheduled, "2026-11-12", at: now), now: now)
        precondition(teamCodexSubscriptionAwareRecovery(failed, subscription: cancelled, now: now) == nil)
        precondition(codexSubscriptionTodoPlan(failed, subscription: cancelled, now: now)?.action == .confirmSubscriptionEnd)
        // 기록이 없으면 지금 재인증 그대로.
        let plain = codexSubscriptionResolution(account: failed, local: nil, now: now)
        precondition(teamCodexSubscriptionAwareRecovery(failed, subscription: plain, now: now)?.kind == .reauth)
        precondition(codexSubscriptionTodoPlan(failed, subscription: plain, now: now)?.action == .codexRecover(.reauth))
    }

    // 5. teamcodex CLI 인자 조립
    static func cliArguments() {
        precondition(teamCodexSubscriptionArguments(.recordCancel(endDate: "2026-11-12", source: "billing-page"),
                                                    name: "codex-01", accountUuid: "u1")
                     == ["codex", "subscription", "cancel", "codex-01", "--ends-on", "2026-11-12", "--account-uuid", "u1"])
        precondition(teamCodexSubscriptionArguments(.recordCancel(endDate: nil, source: "user-confirmed"), name: "codex-01", accountUuid: "u1")
                     == ["codex", "subscription", "cancel", "codex-01", "--account-uuid", "u1"])
        // 바로 종료로 확정 = 종료일 없는 cancel(다음 인증 실패에 프록시가 확정).
        precondition(teamCodexSubscriptionArguments(.confirmEnd(endDate: "2026-11-12", source: "user-confirmed"), name: "codex-01", accountUuid: "u1")
                     == ["codex", "subscription", "cancel", "codex-01", "--account-uuid", "u1"])
        precondition(teamCodexSubscriptionArguments(.editEndDate("2026-12-01"), name: "codex-01", accountUuid: "u1")
                     == ["codex", "subscription", "cancel", "codex-01", "--ends-on", "2026-12-01", "--account-uuid", "u1"])
        precondition(teamCodexSubscriptionArguments(.clear, name: "codex-01", accountUuid: "u1")
                     == ["codex", "subscription", "clear", "codex-01", "--account-uuid", "u1"])
        // 신원 확인이 안 된 행·잘못된 날짜에는 명령을 만들지 않는다.
        precondition(teamCodexSubscriptionArguments(.clear, name: "codex-01", accountUuid: nil) == nil)
        precondition(teamCodexSubscriptionArguments(.clear, name: "codex-01", accountUuid: "") == nil)
        precondition(teamCodexSubscriptionArguments(.editEndDate("2026-02-30"), name: "codex-01", accountUuid: "u1") == nil)
        precondition(teamCodexSubscriptionArguments(.clear, name: "--evil", accountUuid: "u1") == nil)
        // 되돌리기 인자: 직전 설정 상태로.
        precondition(teamCodexSubscriptionRestoreArguments(previous: nil, name: "c", accountUuid: "u")
                     == ["codex", "subscription", "clear", "c", "--account-uuid", "u"])
        precondition(teamCodexSubscriptionRestoreArguments(previous: SubscriptionRecordView(state: .scheduled, endDate: "2026-11-12"),
                                                           name: "c", accountUuid: "u")
                     == ["codex", "subscription", "cancel", "c", "--ends-on", "2026-11-12", "--account-uuid", "u"])
        precondition(teamCodexSubscriptionRestoreArguments(previous: SubscriptionRecordView(state: .ended), name: "c", accountUuid: "u")
                     == ["codex", "subscription", "cancel", "c", "--account-uuid", "u"])
        precondition(teamCodexSubscriptionNeedsRestart("x\nApply the change with: teamcodex restart\n"))
        precondition(!teamCodexSubscriptionNeedsRestart("Applied to the running server without restarting active connections."))
        precondition(teamCodexSubscriptionFailureReason(SubscriptionCLIResult(status: 1, output: "Subscription tracking rejected: no such account\n"))
                     == "Subscription tracking rejected: no such account")
    }

    static func freshStore(clock: @escaping () -> Date) -> (AccountSubscriptionStore, UserDefaults) {
        let suite = "cc.subscription-state-tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let monitor = FileManager.default.temporaryDirectory.appendingPathComponent("missing-monitor-\(UUID().uuidString).json")
        return (AccountSubscriptionStore(defaults: defaults, monitorURL: monitor, clock: clock), defaults)
    }

    // 6. 처리·되돌리기·CLI 실패 시 로컬 기록 불변·중복 실행 잠금
    static func actionsAndUndo() {
        let now = day("2026-10-29")
        let (store, _) = freshStore { now }
        var calls: [[String]] = []
        var nextResult = SubscriptionCLIResult(status: 0, output: "Tracking cancelled subscription\nApply the change with: teamcodex restart\n")
        var pending: ((SubscriptionCLIResult) -> Void)?
        var deferRunner = false
        let center = SubscriptionActionCenter(store: store) { args, completion in
            calls.append(args)
            if deferRunner { pending = completion } else { completion(nextResult) }
        }
        let claude = SubscriptionTarget(provider: "anthropic", name: "acct-01", accountUuid: "uuid-a")
        let codex = SubscriptionTarget(provider: "codex", name: "codex-01", accountUuid: "uuid-c")
        let unknown = SubscriptionResolution(shown: SubscriptionRecordView(state: .unknown))

        // Claude: 로컬 기록만. CLI를 부르지 않는다.
        var outcome: SubscriptionOutcome?
        precondition(center.perform(.recordCancel(endDate: "2026-11-12", source: "billing-page"), target: claude, current: unknown) { outcome = $0 })
        precondition(outcome?.succeeded == true && calls.isEmpty)
        precondition(outcome?.message == "acct-01 해지 예약으로 기록함")
        let saved = store.localConfirmation(provider: "anthropic", uuid: "uuid-a")
        precondition(saved?.state == .scheduled && saved?.date == "2026-11-12" && saved?.source == "billing-page")
        // 되돌리기: 직전 기록(없음)으로.
        let undo = outcome!.undo!
        outcome = nil
        precondition(center.undo(undo) { outcome = $0 })
        precondition(outcome?.succeeded == true && store.localConfirmation(provider: "anthropic", uuid: "uuid-a") == nil)
        // 지난 날짜로 기록하면 문구가 종료일 지남을 말한다.
        precondition(center.perform(.recordCancel(endDate: "2026-10-01", source: "user-confirmed"), target: claude, current: unknown) { outcome = $0 })
        precondition(outcome?.message == "acct-01 해지 기록 · 종료일 지남")
        // 기록 지우기 = 구독 중(사용자 확인).
        let scheduledNow = SubscriptionResolution(shown: SubscriptionRecordView(state: .overdue, endDate: "2026-10-01"))
        precondition(center.perform(.clear, target: claude, current: scheduledNow) { outcome = $0 })
        precondition(store.localConfirmation(provider: "anthropic", uuid: "uuid-a")?.state == .renewing)
        // 그 되돌리기는 지우기 전 기록(해지 예약 10/01)을 그대로 살린다.
        precondition(center.undo(outcome!.undo!) { outcome = $0 })
        precondition(store.localConfirmation(provider: "anthropic", uuid: "uuid-a")?.date == "2026-10-01")

        // Codex: 바로 종료로 확정 → CLI cancel(종료일 없음) + 로컬 확정, 재시작 안내.
        precondition(center.perform(.confirmEnd(endDate: nil, source: "user-confirmed"), target: codex, current: unknown) { outcome = $0 })
        precondition(calls.last == ["codex", "subscription", "cancel", "codex-01", "--account-uuid", "uuid-c"])
        precondition(outcome?.succeeded == true && outcome?.restartNeeded == true)
        precondition(outcome?.message == "codex-01 바로 종료로 확정함 · 프록시 재시작 뒤 반영")
        precondition(store.localConfirmation(provider: "codex", uuid: "uuid-c")?.state == .ended)
        // 되돌리기: 로컬 기록 복원 + CLI clear(직전 설정 상태가 기록 없음).
        nextResult = SubscriptionCLIResult(status: 0, output: "Applied to the running server without restarting active connections.\n")
        precondition(center.undo(outcome!.undo!) { outcome = $0 })
        precondition(calls.last == ["codex", "subscription", "clear", "codex-01", "--account-uuid", "uuid-c"])
        precondition(outcome?.succeeded == true && outcome?.restartNeeded == false)
        precondition(store.localConfirmation(provider: "codex", uuid: "uuid-c") == nil)

        // CLI 실패: 로컬 기록을 바꾸지 않고 사유를 말한다.
        precondition(store.saveCodexConfirmation(.scheduled, date: "2026-11-12", uuid: "uuid-c"))
        let before = store.localConfirmation(provider: "codex", uuid: "uuid-c")
        nextResult = SubscriptionCLIResult(status: 1, output: "Subscription tracking rejected: account identity changed\n")
        precondition(center.perform(.clear, target: codex, current: unknown) { outcome = $0 })
        precondition(outcome?.succeeded == false && outcome?.undo == nil)
        precondition(outcome?.message == "codex-01 처리 실패 · Subscription tracking rejected: account identity changed")
        let after = store.localConfirmation(provider: "codex", uuid: "uuid-c")
        precondition(after?.state == before?.state && after?.date == before?.date && after?.checkedAt == before?.checkedAt)
        // 시간 초과도 실패다.
        nextResult = SubscriptionCLIResult(status: -1, output: "", timedOut: true)
        precondition(center.perform(.clear, target: codex, current: unknown) { outcome = $0 })
        precondition(outcome?.succeeded == false && outcome?.message == "codex-01 처리 실패 · teamcodex 명령이 응답하지 않았습니다")

        // 되돌리기 인자는 직전 로컬 기록(해지 예약 11/12)에서 나온다.
        nextResult = SubscriptionCLIResult(status: 0, output: "")
        precondition(center.perform(.confirmEnd(endDate: "2026-11-12", source: "user-confirmed"), target: codex, current: unknown) { outcome = $0 })
        precondition(store.localConfirmation(provider: "codex", uuid: "uuid-c")?.date == "2026-11-12")
        precondition(center.undo(outcome!.undo!) { outcome = $0 })
        precondition(calls.last == ["codex", "subscription", "cancel", "codex-01", "--ends-on", "2026-11-12", "--account-uuid", "uuid-c"])
        precondition(store.localConfirmation(provider: "codex", uuid: "uuid-c")?.state == .scheduled)

        // 처리 중에는 그 행을 잠근다(중복 실행 금지). 끝나면 풀린다.
        deferRunner = true
        let callsBefore = calls.count
        precondition(center.perform(.clear, target: codex, current: unknown) { outcome = $0 })
        precondition(center.isBusy(codex))
        precondition(!center.perform(.clear, target: codex, current: unknown) { _ in preconditionFailure("second run") })
        precondition(calls.count == callsBefore + 1)
        pending?(SubscriptionCLIResult(status: 0, output: ""))
        precondition(!center.isBusy(codex))

        // 신원이 없는 Codex 행은 실행하지 않는다.
        deferRunner = false
        let anonymous = SubscriptionTarget(provider: "codex", name: "codex-02", accountUuid: nil)
        precondition(center.perform(.clear, target: anonymous, current: unknown) { outcome = $0 })
        precondition(outcome?.succeeded == false && calls.count == callsBefore + 1)
    }

    // 7. 기록 대화상자 값 → 명령, 두 번 눌러 확정
    static func dialogAndArming() {
        precondition(SubscriptionRecordDialog.command(mode: .record, endChoice: 0, typedDate: "", billingDay: nil, sourceIndex: 1,
                                                      confirmNow: false) == .recordCancel(endDate: nil, source: "billing-page"))
        precondition(SubscriptionRecordDialog.command(mode: .record, endChoice: 1, typedDate: "", billingDay: "2026-11-12", sourceIndex: 0,
                                                      confirmNow: true) == .confirmEnd(endDate: "2026-11-12", source: "user-confirmed"))
        precondition(SubscriptionRecordDialog.command(mode: .record, endChoice: 1, typedDate: "", billingDay: nil, sourceIndex: 0,
                                                      confirmNow: false) == nil)
        precondition(SubscriptionRecordDialog.command(mode: .record, endChoice: 2, typedDate: " 2026-12-01 ", billingDay: nil, sourceIndex: 2,
                                                      confirmNow: false) == .recordCancel(endDate: "2026-12-01", source: "confirmation-email"))
        precondition(SubscriptionRecordDialog.command(mode: .record, endChoice: 2, typedDate: "2026-13-01", billingDay: nil, sourceIndex: 0,
                                                      confirmNow: false) == nil)
        precondition(SubscriptionRecordDialog.command(mode: .edit, endChoice: 0, typedDate: "", billingDay: nil, sourceIndex: 0,
                                                      confirmNow: false) == .editEndDate(nil))
        let target = SubscriptionTarget(provider: "codex", name: "codex-01", accountUuid: "u")
        let now = Date()
        precondition(!SubscriptionActionButtons.isArmed(target, .confirmEnd, now: now))
        SubscriptionActionButtons.arm(target, .confirmEnd, now: now)
        precondition(SubscriptionActionButtons.isArmed(target, .confirmEnd, now: now.addingTimeInterval(1)))
        precondition(!SubscriptionActionButtons.isArmed(target, .clear, now: now.addingTimeInterval(1)))
        precondition(!SubscriptionActionButtons.isArmed(target, .confirmEnd, now: now.addingTimeInterval(5)))
        precondition(SubscriptionActionButtons.title(.confirmEnd, state: .scheduled, armed: true) == "한 번 더 눌러 확정")
        precondition(SubscriptionActionButtons.kinds(for: SubscriptionResolution(shown: SubscriptionRecordView(state: .unknown))) == [.record])
        precondition(SubscriptionActionButtons.kinds(for: SubscriptionResolution(shown: SubscriptionRecordView(state: .overdue))) == [.confirmEnd, .editEnd, .clear])
        precondition(SubscriptionActionButtons.kinds(for: SubscriptionResolution(shown: SubscriptionRecordView(state: .ended))) == [.clear])
        SubscriptionActionButtons.disarm(target)
    }

    // 8. 프록시가 확정한 종료는 이 맥에서 되돌릴 수 없다(기록 지우기를 주지 않고, 불러도 성공으로 보이지 않는다)
    static func proxyLockedEnd() {
        let now = day("2026-10-29")
        let claude = claudeSubscriptionResolution(local: nil, proxy: nil, errorReason: "subscription-ended", proxyEndReached: false, now: now)
        precondition(claude.state == .ended && claude.proxyLocked)
        precondition(SubscriptionActionButtons.kinds(for: claude).isEmpty)
        let localEnded = claudeSubscriptionResolution(local: confirmation(.ended, nil, at: now), proxy: nil, errorReason: nil,
                                                      proxyEndReached: false, now: now)
        precondition(!localEnded.proxyLocked && SubscriptionActionButtons.kinds(for: localEnded) == [.clear])
        let codexLocked = codexSubscriptionResolution(account: codexAccount(status: "error", errorReason: "subscription-ended"), local: nil, now: now)
        precondition(codexLocked.proxyLocked && SubscriptionActionButtons.kinds(for: codexLocked).isEmpty)
        // 프록시 설정의 해지 기록(ended)은 CLI clear로 지울 수 있다.
        let codexConfig = codexSubscriptionResolution(account: codexAccount(state: "ended"), local: nil, now: now)
        precondition(!codexConfig.proxyLocked && SubscriptionActionButtons.kinds(for: codexConfig) == [.clear])

        let (store, _) = freshStore { now }
        var ran = 0
        let center = SubscriptionActionCenter(store: store) { _, completion in ran += 1; completion(SubscriptionCLIResult(status: 0, output: "")) }
        var outcome: SubscriptionOutcome?
        let target = SubscriptionTarget(provider: "anthropic", name: "acct-01", accountUuid: "uuid-locked")
        precondition(center.perform(.clear, target: target, current: claude) { outcome = $0 })
        precondition(outcome?.succeeded == false && outcome?.undo == nil)
        precondition(outcome?.message == "acct-01 처리 실패 · 프록시가 구독 종료로 확정해 이 맥에서 되돌릴 수 없습니다")
        precondition(store.localConfirmation(provider: "anthropic", uuid: "uuid-locked") == nil)
        let codexTarget = SubscriptionTarget(provider: "codex", name: "codex-01", accountUuid: "uuid-codex-01")
        precondition(center.perform(.clear, target: codexTarget, current: codexLocked) { outcome = $0 })
        precondition(outcome?.succeeded == false && ran == 0)
    }

    // 9. 같은 이름 계정이 둘이어도 엉뚱한 행을 고르지 않는다
    static func duplicateNames() {
        let names = ["dup", "other", "dup"]
        let uuids: [String?] = ["u-1", "u-2", "u-3"]
        precondition(subscriptionRowIndex(names: names, uuids: uuids, name: "dup", accountUuid: "u-3") == 2)
        precondition(subscriptionRowIndex(names: names, uuids: uuids, name: "dup", accountUuid: "u-1") == 0)
        // uuid가 다른 행을 가리키면(이름 불일치) 고르지 않는다.
        precondition(subscriptionRowIndex(names: names, uuids: uuids, name: "dup", accountUuid: "u-2") == nil)
        // uuid 없이 이름만 오면 하나뿐일 때만.
        precondition(subscriptionRowIndex(names: names, uuids: uuids, name: "dup", accountUuid: nil) == nil)
        precondition(subscriptionRowIndex(names: names, uuids: uuids, name: "other", accountUuid: nil) == 1)
        precondition(subscriptionRowIndex(names: names, uuids: [nil, nil, nil], name: "dup", accountUuid: "u-3") == nil)
        precondition(subscriptionRowIndex(names: names, uuids: uuids, name: "missing", accountUuid: nil) == nil)
    }

    // 10. teamcodex 실행 환경: 화면이 읽는 기본 설정 파일과 같은 파일을 고친다
    static func cliEnvironment() {
        let base = ["TEAMCLAUDE_CONFIG": "/elsewhere/config.json", "XDG_CONFIG_HOME": "/elsewhere", "TEAMCLAUDE_PROVIDER": "anthropic",
                    "PATH": "/usr/bin", "LANG": "en_US.UTF-8"]
        let env = teamCodexSubscriptionEnvironment(base: base, home: "/home/test", executableBin: "/opt/tool/bin")
        precondition(env["TEAMCLAUDE_CONFIG"] == "/home/test/.config/teamcodex.json")
        precondition(env["XDG_CONFIG_HOME"] == nil && env["TEAMCLAUDE_PROVIDER"] == nil)
        precondition(env["HOME"] == "/home/test" && env["LANG"] == "en_US.UTF-8")
        precondition(env["PATH"]?.hasPrefix("/opt/tool/bin:") == true)
        precondition(teamCodexSubscriptionConfigPath(home: "/home/test") == "/home/test/.config/teamcodex.json")
    }

    static func main() {
        L10n.language = .ko
        fiveStates()
        claudeMerge()
        codexMerge()
        todoPlans()
        cliArguments()
        actionsAndUndo()
        dialogAndArming()
        proxyLockedEnd()
        duplicateNames()
        cliEnvironment()
        L10n.language = .en
        precondition(SubscriptionDisplayState.allCases.allSatisfy { $0.label.range(of: "[가-힣]", options: .regularExpression) == nil })
        print("SubscriptionStateTests: all assertions passed")
    }
}
