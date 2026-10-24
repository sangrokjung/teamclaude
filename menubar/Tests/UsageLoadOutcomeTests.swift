// menubar/Tests/UsageLoadOutcomeTests.swift
import Cocoa

// ccusage 수집 실패가 "데이터 없음"으로 조용히 축약되지 않는지, 실제 로더(AppDelegate.loadUsageInBackground)와
// 실제 판정(currentToolNotices)·실제 대시보드(StatusMenuDashboardView)를 거쳐 확인한다.
// npx 자리에 가짜 실행 파일(CC_MENUBAR_NPX_BIN)을 두고, 같은 폴더의 mode 파일로 실패 모양을 바꾼다.
// main.swift의 선언부를 함께 컴파일해야 하므로 짝인 test_usage_load_outcome.py가 빌드·실행한다.
@main
struct UsageLoadOutcomeTests {
    static var fakeDir = ""

    static func setMode(_ mode: String) {
        try! mode.write(toFile: fakeDir + "/mode", atomically: true, encoding: .utf8)
    }

    static func runFull(_ delegate: AppDelegate) {
        delegate.loadUsageInBackground()
        let deadline = Date().addingTimeInterval(20)
        while delegate.isFetching && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        precondition(!delegate.isFetching, "사용량 로더가 끝나지 않았다")
    }

    static func runQuick(_ delegate: AppDelegate) {
        delegate.loadUsageQuickInBackground(reason: "test")
        let deadline = Date().addingTimeInterval(20)
        while delegate.isFetchingUsageQuick && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        precondition(!delegate.isFetchingUsageQuick, "quick 사용량 로더가 끝나지 않았다")
    }

    /// 앱과 같은 판정으로 대시보드 한 장을 그린다. 그려진 안내·섹션 요약·카드 꼬리말·카드 접근성 라벨을 돌려준다.
    static func render(_ delegate: AppDelegate) -> (drawn: String?, summary: String, cardNote: String?, label: String) {
        ToolNoticeDrawLog.reset()
        let notices = delegate.currentToolNotices
        let view = StatusMenuDashboardView(frame: NSRect(
            x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth,
            height: StatusMenuDashboardView.preferredHeight(
                teamClaude: nil, codex: nil, teamCodex: nil, usage: delegate.currentData, higgsfield: nil,
                burnModel: delegate.currentBurnModel, notices: notices, maxBodyHeight: .greatestFiniteMagnitude)))
        view.configure(teamClaude: nil, codex: nil, teamCodex: nil, usage: delegate.currentData, higgsfield: nil,
                       burnModel: delegate.currentBurnModel, notices: notices,
                       laneStaleNotes: delegate.dashboardStaleNotes,
                       parallelCount: 0, active: false, isMeasuringTeamClaude: false,
                       teamClaudeMeasureDetail: nil, onMeasureTeamClaude: nil)
        // Phase 2: 사용량 카드와 안내는 소진 탭 문서에 있다. 그 탭을 띄워 실제로 그린다.
        view.selectTab(.burn)
        view.frame.size.height = StatusMenuDashboardView.chromeHeight + max(view.snapshotDocumentHeight(.burn), 120)
        view.layoutSubtreeIfNeeded()
        ToolNoticeDrawLog.reset()
        DrawnTextRecorder.install()
        DrawnTextRecorder.reset()
        let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
        view.cacheDisplay(in: view.bounds, to: rep)
        let texts = DrawnTextRecorder.strings
        // 폭이 모자라면 PanelDraw.clipped가 뒤를 "…"로 줄인다(전문은 도움말 풍선·접근성 라벨). 그때도 앞부분은 그려져야 한다.
        func drawn(_ value: String) -> Bool {
            texts.contains { $0 == value || ($0.hasSuffix("…") && $0.count > 1 && value.hasPrefix(String($0.dropLast()))) }
        }
        let summary = view.sections.first(where: { $0.id == "usage" })?.summary ?? ""
        // 헤더 요약은 값만이 아니라 실제로 그려져야 한다(소진 탭의 섹션 헤더).
        if !summary.isEmpty {
            precondition(drawn(summary), "헤더 요약이 그려지지 않았다: \(summary)")
            let header = allSubviews(view).compactMap { $0 as? DashboardSectionHeaderView }.first { $0.section?.id == "usage" }
            precondition(header?.toolTip == summary, "헤더 도움말 풍선에 요약 전문이 없다")
        }
        let card = allSubviews(view).compactMap { $0 as? UsageDashboardView }.first
        if let note = card?.staleNote, card?.usage?.today != nil {
            precondition(drawn(note), "카드 꼬리말이 그려지지 않았다: \(note)")
            precondition(card?.toolTip == note, "카드 도움말 풍선에 꼬리말 전문이 없다")
        }
        return (ToolNoticeDrawLog.drawn["usage"], summary, card?.staleNote, card?.accessibilityLabel() ?? "")
    }

    static func allSubviews(_ root: NSView) -> [NSView] {
        root.subviews + root.subviews.flatMap { allSubviews($0) }
    }

    static func main() {
        _ = NSApplication.shared
        ToolNoticeDrawLog.isEnabled = true
        fakeDir = CommandLine.arguments[1]
        let delegate = AppDelegate()
        // 운영은 60초. 시간 초과 경로를 빨리 밟으려고 줄인다(가짜 npx는 TERM을 무시하고 30초 잔다).
        delegate.ccusageTimeoutSeconds = 1

        // MARK: 수집기 실패는 "데이터 없음"이 아니다
        let cases = [("exit", "종료 코드 3"), ("garbage", "출력 해석 실패"), ("empty", "빈 출력"), ("hang", "1초 시간 초과")]
        for (mode, why) in cases {
            setMode(mode)
            delegate.currentData = nil
            runFull(delegate)
            let notice = delegate.currentToolNotices.sections["usage"]
            precondition(notice != nil, "\(why): 안내가 없다")
            precondition(notice?.kind != .noData, "\(why): 실패가 데이터 없음으로 보였다 — \(notice?.headline ?? "nil")")
            precondition(notice?.headline == "사용량 확인 필요", "\(why): \(notice?.headline ?? "nil")")
            precondition(notice?.kind == .loadFailed)
            precondition(notice?.detail.contains(why) == true, "\(why): 원인이 안내에 없다 — \(notice?.detail ?? "nil")")
            let drawn = render(delegate)
            precondition(drawn.drawn == "사용량 확인 필요", "\(why): 카드가 그린 안내 \(drawn.drawn ?? "nil")")
            precondition(drawn.summary == "사용량 확인 필요", "\(why): 헤더 요약 \(drawn.summary)")
        }

        // 시간 초과는 제한 안에 끝나야 한다(가짜 npx의 30초 잠을 기다리지 않는다).
        setMode("hang")
        let hangStarted = Date()
        runFull(delegate)
        precondition(Date().timeIntervalSince(hangStarted) < 6, "시간 초과 경로가 제한을 넘겼다")

        // MARK: 성공적으로 읽은 빈 결과만 "데이터 없음"
        setMode("nodata")
        delegate.currentData = nil
        runFull(delegate)
        precondition(delegate.currentToolNotices.sections["usage"]?.headline == "사용량 데이터 없음")

        // MARK: 정상 결과는 안내 없이 값을 그린다
        setMode("today")
        runFull(delegate)
        precondition(delegate.currentData?.today != nil, "정상 출력이 반영되지 않았다")
        precondition(delegate.currentToolNotices.sections["usage"] == nil)
        let fresh = render(delegate)
        precondition(!fresh.summary.contains("갱신 실패") && fresh.cardNote == nil)

        // MARK: 이전 값이 있는데 갱신이 실패하면 값은 두고 낡았다고 표시한다
        setMode("exit")
        runFull(delegate)
        precondition(delegate.currentData?.today != nil, "실패가 이전 값을 지웠다")
        precondition(delegate.currentToolNotices.sections["usage"] == nil, "이전 값이 있으면 본문을 안내로 바꾸지 않는다")
        let stale = render(delegate)
        precondition(stale.summary.contains("갱신 실패"), "헤더 요약에 낡은 값 표시가 없다: \(stale.summary)")
        precondition(stale.summary.hasPrefix("오늘 "), "헤더 요약이 이전 값을 잃었다: \(stale.summary)")
        precondition(stale.cardNote == "갱신 실패(종료 코드 3) · 이전 값", "카드 꼬리말: \(stale.cardNote ?? "nil")")

        // MARK: quick 로더도 같은 판정을 남긴다
        setMode("today")
        runFull(delegate)
        precondition(delegate.dashboardStaleNotes["usage"] == nil, "성공 뒤에도 낡은 표시가 남았다")
        setMode("garbage")
        runQuick(delegate)
        precondition(delegate.usageLoadOutcome == .failed(.unparsable), "\(String(describing: delegate.usageLoadOutcome))")
        precondition(delegate.dashboardStaleNotes["usage"] == "갱신 실패(출력 해석 실패) · 이전 값")
        delegate.currentData = nil
        setMode("exit")
        runQuick(delegate)
        precondition(delegate.currentToolNotices.sections["usage"]?.headline == "사용량 확인 필요")

        overlappingLoaderChecks(delegate)
        missingTodayChecks(delegate)
        midnightChecks(delegate)
        outputCapChecks(delegate)
        pipeBoundChecks()
        partialRefreshChecks(delegate)
        auxSchemaChecks()

        print("UsageLoadOutcomeTests: ok")
    }
}

// MARK: - 겹친 실행과 오늘 항목이 빠진 결과
extension UsageLoadOutcomeTests {
    final class Box {
        let lock = NSLock()
        var loads: [Int: CcusageDailyLoad] = [:]
        func set(_ index: Int, _ load: CcusageDailyLoad) { lock.lock(); loads[index] = load; lock.unlock() }
    }

    /// 전체 갱신과 quick 갱신이 동시에 daily를 돌려도 서로의 출력을 섞거나 끊지 않는다.
    /// 가짜 npx(slow)는 daily JSON을 반으로 나눠 0.5초 사이를 두고 쓴다 — 두 실행이 반드시 겹친다.
    static func overlappingLoaderChecks(_ delegate: AppDelegate) {
        setMode("slow")
        // 두 로더가 부르는 같은 함수를 동시에 띄운다. 둘 다 정상 해석돼야 한다.
        let box = Box()
        let group = DispatchGroup()
        for index in 0..<2 {
            group.enter()
            DispatchQueue.global(qos: .utility).async {
                box.set(index, loadCcusageDaily(timeoutSeconds: 10))
                group.leave()
            }
        }
        precondition(group.wait(timeout: .now() + 30) == .success, "겹친 daily 실행이 끝나지 않았다")
        for index in 0..<2 {
            let load = box.loads[index]
            precondition(load?.outcome == .loaded, "겹친 실행 \(index): \(String(describing: load?.outcome))")
            precondition(load?.quick?.today?.totalCost == 1.25,
                         "겹친 실행 \(index) 값: \(load?.quick?.today?.totalCost ?? -1)")
        }

        // 실제 두 로더(전체·quick)를 겹쳐 띄워도 결과는 정상이다.
        let savedTimeout = delegate.ccusageTimeoutSeconds
        delegate.ccusageTimeoutSeconds = 10
        delegate.currentData = nil
        delegate.loadUsageInBackground()
        delegate.loadUsageQuickInBackground(reason: "overlap")
        let deadline = Date().addingTimeInterval(30)
        while (delegate.isFetching || delegate.isFetchingUsageQuick) && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        precondition(!delegate.isFetching && !delegate.isFetchingUsageQuick, "겹친 로더가 끝나지 않았다")
        precondition(delegate.usageLoadOutcome == .loaded, "겹친 로더 판정: \(String(describing: delegate.usageLoadOutcome))")
        precondition(delegate.currentData?.today?.totalCost == 1.25, "겹친 로더 값: \(delegate.currentData?.today?.totalCost ?? -1)")
        delegate.ccusageTimeoutSeconds = savedTimeout
    }

    /// 유효한 JSON인데 오늘 날짜 항목이 없으면(어제 기록만) 어제 값을 오늘로 보이지 않는다.
    /// 지난 기록(주·월·누적)은 두고 오늘은 0, 판정은 noData, 카드·헤더에는 "오늘 사용 기록 없음" 꼬리말.
    static func missingTodayChecks(_ delegate: AppDelegate) {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        let yesterday = formatter.string(from: Calendar(identifier: .gregorian).date(byAdding: .day, value: -1, to: Date())!)
        let todayKey = formatter.string(from: Date())

        setMode("yesterday")
        delegate.currentData = nil
        runFull(delegate)
        precondition(delegate.usageLoadOutcome == .noData, "오늘 항목 없음 판정: \(String(describing: delegate.usageLoadOutcome))")
        let today = delegate.currentData?.today
        precondition(today?.period != yesterday, "어제 항목을 오늘로 썼다: \(today?.period ?? "nil")")
        precondition(today?.period == todayKey && today?.totalCost == 0, "오늘은 0이어야 한다: \(today?.totalCost ?? -1)")
        precondition(delegate.currentData?.allTimeCost == 7.77, "지난 기록이 사라졌다: \(delegate.currentData?.allTimeCost ?? -1)")
        let slots = delegate.displaySlots()
        let todaySlots = slots.filter { $0.hasPrefix("오늘 ") }
        precondition(!todaySlots.isEmpty, "제목에 오늘 슬롯이 없다: \(slots)")
        precondition(!todaySlots.contains { $0.contains("7.77") || $0.contains("1만") }, "제목이 어제 값을 오늘로 보였다: \(todaySlots)")
        precondition(delegate.currentToolNotices.sections["usage"] == nil, "지난 기록이 있으면 본문을 안내로 바꾸지 않는다")
        let drawn = render(delegate)
        precondition(drawn.cardNote == "오늘 사용 기록 없음", "카드 꼬리말: \(drawn.cardNote ?? "nil")")
        precondition(drawn.summary.hasPrefix("오늘 ₩0"), "헤더 요약이 어제 값을 오늘로 보였다: \(drawn.summary)")
        precondition(drawn.summary.contains("오늘 사용 기록 없음"), "헤더 요약에 표시가 없다: \(drawn.summary)")

        // quick 로더도 같은 판정이다.
        setMode("today")
        runFull(delegate)
        precondition(delegate.usageLoadOutcome == .loaded)
        setMode("yesterday")
        runQuick(delegate)
        precondition(delegate.usageLoadOutcome == .noData, "quick 오늘 항목 없음: \(String(describing: delegate.usageLoadOutcome))")
        precondition(delegate.currentData?.today?.totalCost == 0, "quick이 어제 값을 오늘로 썼다")
    }
}

// MARK: - 자정 경계
extension UsageLoadOutcomeTests {
    /// 처음 한 번은 23:59:59, 그 뒤로는 다음 날 00:00:01을 돌려주는 시계. daily 판정 뒤 weekly·monthly가
    /// 자정을 넘긴 상황을 만든다(실제 날짜와도 겹치지 않게 지난 날짜를 쓴다).
    final class MidnightClock {
        let lock = NSLock()
        var calls = 0
        let before: Date
        let after: Date
        init(day: String) {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
            formatter.locale = Locale(identifier: "en_US_POSIX")
            before = formatter.date(from: "\(day) 23:59:59")!
            after = before.addingTimeInterval(2)
        }
        func now() -> Date {
            lock.lock(); defer { lock.unlock() }
            calls += 1
            return calls == 1 ? before : after
        }
    }

    /// daily 판정과 최종 해석이 같은 "오늘"을 본다. 판정은 loaded인데 오늘 값이 새 날짜의 0원으로 덮이면 안 된다.
    static func midnightChecks(_ delegate: AppDelegate) {
        let day = "2020-01-15"
        setMode("fixedday")

        let full = MidnightClock(day: day)
        delegate.ccusageClock = full.now
        delegate.currentData = nil
        runFull(delegate)
        precondition(delegate.usageLoadOutcome == .loaded, "자정 경계 full 판정: \(String(describing: delegate.usageLoadOutcome))")
        let fullToday = delegate.currentData?.today
        precondition(fullToday?.period == day && fullToday?.totalCost == 4.5,
                     "자정 경계 full: 판정은 \(day)인데 오늘 값은 \(fullToday?.period ?? "nil") \(fullToday?.totalCost ?? -1)")
        precondition(delegate.currentData?.thisMonthCost == 4.5,
                     "자정 경계 full: 이번 달이 다른 날짜로 계산됐다 \(delegate.currentData?.thisMonthCost ?? -1)")

        let quick = MidnightClock(day: day)
        delegate.ccusageClock = quick.now
        delegate.currentData = nil
        runQuick(delegate)
        precondition(delegate.usageLoadOutcome == .loaded, "자정 경계 quick 판정: \(String(describing: delegate.usageLoadOutcome))")
        precondition(delegate.currentData?.today?.period == day && delegate.currentData?.today?.totalCost == 4.5,
                     "자정 경계 quick 오늘 값: \(delegate.currentData?.today?.period ?? "nil")")

        delegate.ccusageClock = { Date() }
    }
}

// MARK: - 출력 크기 상한
extension UsageLoadOutcomeTests {
    /// 출력이 상한을 넘으면 시간 제한을 기다리지 않고 그룹째 끊고, 넘친 출력은 메모리에 올리지 않으며,
    /// "출력 크기 상한 초과" 실패로 판정한다.
    /// 가짜 npx(flood)는 8MB를 64KB씩 흘린 뒤 TERM을 무시하고 30초 잔다. 상한은 256KB로 줄인다.
    static func outputCapChecks(_ delegate: AppDelegate) {
        let cap = 256 * 1024

        // 상한 안의 정상 출력은 그대로 읽는다.
        setMode("today")
        let ok = runCcusageCommand("daily", timeoutSeconds: 10, outputLimitBytes: cap)
        precondition(ok.successOutput != nil && !ok.outputTooLarge, "상한 안의 출력이 실패했다")

        setMode("flood")
        let pidFile = fakeDir + "/flood.pid"
        try? FileManager.default.removeItem(atPath: pidFile)
        let started = Date()
        let flood = runCcusageCommand("daily", timeoutSeconds: 10, outputLimitBytes: cap)
        let elapsed = Date().timeIntervalSince(started)
        precondition(elapsed < 3, "상한 초과를 바로 끊지 않았다: \(elapsed)초")
        precondition(flood.launched && flood.outputTooLarge && !flood.timedOut,
                     "상한 초과 판정: tooLarge=\(flood.outputTooLarge) timedOut=\(flood.timedOut)")
        precondition(flood.successOutput == nil, "상한을 넘긴 출력을 성공으로 넘겼다")
        precondition(flood.output.count <= cap, "상한을 넘긴 출력을 메모리에 올렸다: \(flood.output.count)바이트")
        precondition(flood.output.isEmpty, "상한을 넘긴 출력 일부를 남겼다: \(flood.output.count)바이트")
        // 쓰던 자식이 그룹째 사라졌다.
        let leader = (try? String(contentsOfFile: pidFile, encoding: .utf8))
            .flatMap { pid_t($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
        precondition(leader != nil, "가짜 npx가 pid를 남기지 않았다")
        // KILL된 손자는 launchd가 거둘 때까지 잠깐 좀비로 그룹에 남는다. 그 짧은 틈만 기다린다(sleep 30보다 한참 짧다).
        let groupDeadline = Date().addingTimeInterval(2)
        var groupGone = false
        while !groupGone && Date() < groupDeadline {
            groupGone = Darwin.killpg(leader!, 0) == -1 && errno == ESRCH
            if !groupGone { usleep(20_000) }
        }
        precondition(groupGone, "상한 초과 뒤 자식 그룹이 남았다")

        // 상한을 넘긴 출력을 다 쓰고 정상 종료해도 같은 실패다.
        setMode("burst")
        let burst = runCcusageCommand("daily", timeoutSeconds: 10, outputLimitBytes: cap)
        precondition(burst.outputTooLarge && burst.output.isEmpty && burst.successOutput == nil,
                     "정상 종료한 큰 출력: tooLarge=\(burst.outputTooLarge) bytes=\(burst.output.count)")

        setMode("flood")
        let load = loadCcusageDaily(timeoutSeconds: 10, outputLimitBytes: cap)
        precondition(load.outcome == .failed(.outputTooLarge), "daily 판정: \(load.outcome)")
        precondition(load.daily == nil && load.quick == nil)

        // 실제 로더·안내 카드·헤더 요약까지 같은 실패가 닿는다.
        let savedTimeout = delegate.ccusageTimeoutSeconds
        delegate.ccusageTimeoutSeconds = 10
        delegate.ccusageOutputLimitBytes = cap
        delegate.currentData = nil
        let loaderStarted = Date()
        runFull(delegate)
        precondition(Date().timeIntervalSince(loaderStarted) < 4, "로더가 상한 초과를 바로 끊지 않았다")
        let notice = delegate.currentToolNotices.sections["usage"]
        precondition(notice?.kind == .loadFailed && notice?.headline == "사용량 확인 필요",
                     "상한 초과 안내: \(notice?.headline ?? "nil")")
        precondition(notice?.detail.contains("출력 크기 상한 초과") == true, "원인이 안내에 없다: \(notice?.detail ?? "nil")")
        let drawn = render(delegate)
        precondition(drawn.drawn == "사용량 확인 필요" && drawn.summary == "사용량 확인 필요",
                     "카드 \(drawn.drawn ?? "nil") 요약 \(drawn.summary)")
        delegate.ccusageOutputLimitBytes = ccusageDefaultOutputLimitBytes
        delegate.ccusageTimeoutSeconds = savedTimeout
    }
}

// MARK: - 출력 상한은 실제 상한이다
extension UsageLoadOutcomeTests {
    /// 그룹이 사라질 때까지(KILL된 구성원이 거둬질 짧은 틈만) 기다린다. 남았으면 정리하고 false.
    static func waitGroupGone(_ leader: pid_t, extra: pid_t? = nil) -> Bool {
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline {
            let groupGone = Darwin.killpg(leader, 0) == -1 && errno == ESRCH
            let extraGone = extra.map { kill($0, 0) == -1 && errno == ESRCH } ?? true
            if groupGone && extraGone { return true }
            usleep(20_000)
        }
        // 실패한 실행이 무한히 쓰는 프로세스를 남기지 않게 치운다.
        _ = Darwin.killpg(leader, SIGKILL)
        if let extra { _ = kill(extra, SIGKILL) }
        return false
    }

    static func readPid(_ name: String) -> pid_t? {
        (try? String(contentsOfFile: fakeDir + "/" + name, encoding: .utf8))
            .flatMap { pid_t($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }

    static func pipeBoundChecks() {
        let cap = 256 * 1024

        // 한 번의 큰 write()도 상한을 넘겨 받아 두지 못한다. 자식은 상한 근처에서 막혔다가 끊긴다
        // (끝까지 썼다면 표시 파일이 남는다 — 파일로 받으면 한 번에 다 써진다).
        setMode("bigwrite")
        let done = fakeDir + "/bigwrite.done"
        try? FileManager.default.removeItem(atPath: done)
        let started = Date()
        let big = runCcusageCommand("daily", timeoutSeconds: 10, outputLimitBytes: cap)
        let elapsed = Date().timeIntervalSince(started)
        precondition(elapsed < 3, "한 번의 큰 출력을 바로 끊지 않았다: \(elapsed)초")
        precondition(big.outputTooLarge && !big.timedOut && big.successOutput == nil,
                     "한 번의 큰 출력 판정: tooLarge=\(big.outputTooLarge) timedOut=\(big.timedOut)")
        precondition(big.output.isEmpty, "상한을 넘긴 출력 일부를 남겼다: \(big.output.count)바이트")
        let bigLeader = readPid("flood.pid")
        precondition(bigLeader != nil, "가짜 npx가 pid를 남기지 않았다")
        precondition(waitGroupGone(bigLeader!), "큰 출력 뒤 자식 그룹이 남았다")
        precondition(!FileManager.default.fileExists(atPath: done),
                     "자식이 상한을 넘긴 64MB를 끝까지 썼다(출력이 상한 없이 받아졌다)")

        // 직접 자식이 바로 끝나도 같은 그룹의 손자(TERM 무시, 계속 씀)까지 끝내고 곧 돌아온다.
        setMode("orphan")
        try? FileManager.default.removeItem(atPath: fakeDir + "/orphan.pid")
        let orphanStarted = Date()
        let orphan = runCcusageCommand("daily", timeoutSeconds: 10, outputLimitBytes: cap)
        let orphanElapsed = Date().timeIntervalSince(orphanStarted)
        precondition(orphan.launched && !orphan.timedOut, "손자 남김: timedOut=\(orphan.timedOut)")
        precondition(orphanElapsed < 3, "손자를 정리하느라 늦었다: \(orphanElapsed)초")
        let leader = readPid("flood.pid")
        let grandchild = readPid("orphan.pid")
        precondition(leader != nil && grandchild != nil, "가짜 npx가 pid를 남기지 않았다")
        precondition(waitGroupGone(leader!, extra: grandchild), "직접 자식이 끝난 뒤 손자가 살아남았다")
        precondition(orphan.output.count <= cap, "손자 출력이 상한을 넘겨 쌓였다: \(orphan.output.count)")
    }
}

// MARK: - weekly·monthly만 실패한 부분 갱신
extension UsageLoadOutcomeTests {
    static func partialRefreshChecks(_ delegate: AppDelegate) {
        let cap = 256 * 1024

        // 이전 weekly·monthly 값이 없으면 daily 파생값을 쓰되, 부분 실패라고 알린다.
        let fresh = AppDelegate()
        fresh.ccusageTimeoutSeconds = 10
        fresh.ccusageOutputLimitBytes = cap
        setMode("monthlyexit")
        runFull(fresh)
        precondition(fresh.usageLoadOutcome == .loaded, "부분 실패 판정: \(String(describing: fresh.usageLoadOutcome))")
        precondition(fresh.currentData?.thisWeekCost == 3.0, "새 weekly가 반영되지 않았다: \(fresh.currentData?.thisWeekCost ?? -1)")
        precondition(fresh.currentData?.thisMonthCost == 1.25,
                     "이전 값이 없으면 daily 파생값이어야 한다: \(fresh.currentData?.thisMonthCost ?? -1)")
        let monthlyExitNote = "일부 갱신 실패(월간: 종료 코드 3) · 일별만 최신"
        precondition(fresh.currentToolNotices.sections["usage"] == nil, "부분 실패가 본문을 안내로 바꿨다")
        let noPrevious = render(fresh)
        precondition(noPrevious.cardNote == monthlyExitNote, "카드 꼬리말: \(noPrevious.cardNote ?? "nil")")
        precondition(noPrevious.summary.hasPrefix("오늘 ") && noPrevious.summary.contains(monthlyExitNote),
                     "헤더 요약: \(noPrevious.summary)")
        precondition(noPrevious.label.contains(monthlyExitNote), "접근성 라벨: \(noPrevious.label)")

        // 이전 값이 있으면 monthly가 넘쳐도 이전 월간 합계·모델 분해·누적을 두고, 부분 실패라고 알린다.
        delegate.ccusageTimeoutSeconds = 10
        delegate.ccusageOutputLimitBytes = cap
        setMode("native")
        runFull(delegate)
        precondition(delegate.currentData?.thisMonthCost == 9.5, "native monthly: \(delegate.currentData?.thisMonthCost ?? -1)")
        precondition(delegate.dashboardStaleNotes["usage"] == nil, "정상 전체 갱신에 꼬리말이 붙었다")
        setMode("monthlyflood")
        let started = Date()
        runFull(delegate)
        precondition(Date().timeIntervalSince(started) < 4, "monthly 상한 초과를 바로 끊지 않았다")
        let data = delegate.currentData
        precondition(data?.today?.totalCost == 1.25, "오늘 값: \(data?.today?.totalCost ?? -1)")
        precondition(data?.thisMonthCost == 9.5, "이전 월간 합계를 daily 파생값으로 바꿨다: \(data?.thisMonthCost ?? -1)")
        precondition(data?.modelBreakdown.first?.model == "claude-opus-4-8", "이전 모델 분해를 버렸다")
        precondition(data?.allTimeCost == 20.0, "이전 누적을 버렸다: \(data?.allTimeCost ?? -1)")
        precondition(data?.thisWeekCost == 3.0, "weekly: \(data?.thisWeekCost ?? -1)")
        let floodNote = "일부 갱신 실패(월간: 출력 크기 상한 초과) · 일별만 최신"
        let flooded = render(delegate)
        precondition(flooded.cardNote == floodNote, "카드 꼬리말: \(flooded.cardNote ?? "nil")")
        precondition(flooded.summary.hasPrefix("오늘 ") && flooded.summary.contains(floodNote),
                     "헤더 요약: \(flooded.summary)")
        precondition(flooded.label.contains(floodNote), "접근성 라벨: \(flooded.label)")

        // 둘 다 같은 원인으로 실패하면 한 번에 적는다. 이전 weekly도 둔다.
        setMode("auxexit")
        runFull(delegate)
        precondition(delegate.currentData?.thisWeekCost == 3.0 && delegate.currentData?.thisMonthCost == 9.5,
                     "이전 주간·월간 값을 잃었다")
        precondition(delegate.dashboardStaleNotes["usage"] == "일부 갱신 실패(주간/월간: 종료 코드 3) · 일별만 최신",
                     "둘 다 실패: \(delegate.dashboardStaleNotes["usage"] ?? "nil")")

        // 다시 다 읽으면 꼬리말이 사라진다.
        setMode("native")
        runFull(delegate)
        precondition(delegate.dashboardStaleNotes["usage"] == nil, "회복 뒤에도 부분 실패 꼬리말이 남았다")
        delegate.ccusageOutputLimitBytes = ccusageDefaultOutputLimitBytes
    }

    /// weekly·monthly가 종료 코드 0으로 JSON 객체를 냈어도 명령별 기간 배열이 없거나 형식이 틀리면 해석 실패다.
    static func auxSchemaChecks() {
        func run(_ json: String) -> CcusageRun {
            CcusageRun(launched: true, timedOut: false, exitStatus: 0, outputTooLarge: false, output: Data(json.utf8))
        }
        let previous = Data(#"{"weekly":[],"totals":{"totalCost":1}}"#.utf8)
        let bad = resolveCcusageAux(weekly: run(#"{"weekly":"invalid","totals":{"totalCost":999}}"#),
                                    monthly: run(#"{"totals":{"totalCost":999}}"#),
                                    previousWeekly: previous, previousMonthly: nil, timeoutSeconds: 60)
        precondition(bad.failures == [CcusageAuxFailure(command: .weekly, failure: .unparsable),
                                      CcusageAuxFailure(command: .monthly, failure: .unparsable)],
                     "스키마가 틀린 보조 출력을 성공으로 받았다: \(bad.failures)")
        precondition(bad.weekly == previous && bad.monthly == nil, "스키마 실패 뒤 이전 값·daily 폴백을 쓰지 않았다")

        // 명령 키가 바뀌어 들어온 경우(주간 결과에 monthly 배열)도 실패다.
        let swapped = resolveCcusageAux(weekly: run(#"{"monthly":[]}"#), monthly: run(#"{"monthly":[]}"#),
                                        previousWeekly: nil, previousMonthly: nil, timeoutSeconds: 60)
        precondition(swapped.failures == [CcusageAuxFailure(command: .weekly, failure: .unparsable)],
                     "명령별 배열 키를 보지 않았다: \(swapped.failures)")

        // 객체가 아닌 원소의 배열도 해석기가 읽지 못하므로 실패다.
        let scalars = resolveCcusageAux(weekly: run(#"{"weekly":[1,2]}"#), monthly: run(#"{"monthly":[]}"#),
                                        previousWeekly: nil, previousMonthly: nil, timeoutSeconds: 60)
        precondition(scalars.failures == [CcusageAuxFailure(command: .weekly, failure: .unparsable)],
                     "객체가 아닌 배열을 받았다: \(scalars.failures)")

        // 기간 항목·누적 합계의 필드 형식이 틀리면 실패다(해석기가 0으로 읽어 정상값처럼 보이게 된다).
        let malformed: [(String, String)] = [
            (#"{"weekly":[{"period":"2020-01-06","totalCost":"bad","totalTokens":1}]}"#, "비용이 문자열"),
            (#"{"weekly":[{"period":123,"totalCost":999,"totalTokens":1}]}"#, "기간이 숫자"),
            (#"{"weekly":[{"period":"2020-01-06","totalTokens":1}]}"#, "비용 없음"),
            (#"{"weekly":[{"period":"2020-01-06","totalCost":1,"totalTokens":true}]}"#, "토큰이 불리언"),
            (#"{"weekly":[],"totals":{"totalCost":"x","totalTokens":1}}"#, "합계 비용이 문자열"),
            (#"{"weekly":[],"totals":[]}"#, "합계가 객체 아님"),
            (#"{"weekly":[{"period":"2020-01-06","totalCost":-5,"totalTokens":1}]}"#, "음수 비용"),
            (#"{"weekly":[{"period":"2020-01-06","totalCost":1,"totalTokens":1.5}]}"#, "소수 토큰"),
            (#"{"weekly":[{"period":"2020-01-06","totalCost":1,"totalTokens":-1}]}"#, "음수 토큰"),
            (#"{"weekly":[{"period":"garbage","totalCost":1,"totalTokens":1}]}"#, "기간 형식이 틀림"),
            (#"{"weekly":[{"period":"2020-01","totalCost":1,"totalTokens":1}]}"#, "주간에 월 형식"),
            (#"{"weekly":[{"period":"2026-10-99","totalCost":1,"totalTokens":1}]}"#, "없는 날짜"),
            (#"{"weekly":[{"period":"2026-02-30","totalCost":1,"totalTokens":1}]}"#, "없는 2월 30일"),
            (#"{"weekly":[{"period":"2026-10-21","totalCost":1,"totalTokens":1}]}"#, "월요일이 아닌 주 시작일"),
            (#"{"weekly":[],"totals":{"totalCost":-1,"totalTokens":1}}"#, "음수 합계"),
            (#"{"weekly":[{"period":"2020-01-06","totalCost":1,"totalTokens":1,"modelBreakdowns":[{"modelName":"x","cost":"bad","inputTokens":1}]}]}"#, "모델 비용이 문자열"),
            (#"{"weekly":[{"period":"2020-01-06","totalCost":1,"totalTokens":1,"modelBreakdowns":[{"modelName":"x","cost":1,"inputTokens":"bad"}]}]}"#, "모델 토큰이 문자열"),
            (#"{"weekly":[{"period":"2020-01-06","totalCost":1,"totalTokens":1,"modelBreakdowns":[{"cost":1}]}]}"#, "모델 이름 없음"),
            (#"{"weekly":[{"period":"2020-01-06","totalCost":1,"totalTokens":1,"modelBreakdowns":{}}]}"#, "모델 내역이 배열 아님"),
        ]
        // 월간은 YYYY-MM만 받는다.
        let monthlyWeekShape = resolveCcusageAux(weekly: run(#"{"weekly":[]}"#),
                                                 monthly: run(#"{"monthly":[{"period":"2020-01-06","totalCost":1,"totalTokens":1}]}"#),
                                                 previousWeekly: nil, previousMonthly: nil, timeoutSeconds: 60)
        precondition(monthlyWeekShape.failures == [CcusageAuxFailure(command: .monthly, failure: .unparsable)],
                     "월간에 주 형식 기간을 받았다: \(monthlyWeekShape.failures)")
        let badMonth = resolveCcusageAux(weekly: run(#"{"weekly":[]}"#),
                                         monthly: run(#"{"monthly":[{"period":"2026-13","totalCost":1,"totalTokens":1}]}"#),
                                         previousWeekly: nil, previousMonthly: nil, timeoutSeconds: 60)
        precondition(badMonth.failures == [CcusageAuxFailure(command: .monthly, failure: .unparsable)],
                     "13월을 받았다: \(badMonth.failures)")
        for (json, why) in malformed {
            let r = resolveCcusageAux(weekly: run(json), monthly: run(#"{"monthly":[]}"#),
                                      previousWeekly: nil, previousMonthly: nil, timeoutSeconds: 60)
            precondition(r.failures == [CcusageAuxFailure(command: .weekly, failure: .unparsable)],
                         "형식이 틀린 보조 출력(\(why))을 받았다: \(r.failures)")
        }

        // 빈 배열, 필드가 맞는 항목과 합계는 정상이다.
        let ok = resolveCcusageAux(weekly: run(#"{"weekly":[{"period":"2026-10-19","totalCost":1,"totalTokens":1}]}"#),
                                   monthly: run(#"{"monthly":[{"period":"2020-01","totalCost":1.5,"totalTokens":10,"modelBreakdowns":[{"modelName":"claude-x","cost":1.5,"inputTokens":4,"outputTokens":6,"cacheCreationTokens":0,"cacheReadTokens":0}]}],"totals":{"totalCost":1.5,"totalTokens":10}}"#),
                                   previousWeekly: nil, previousMonthly: nil, timeoutSeconds: 60)
        precondition(ok.failures.isEmpty, "정상 보조 출력을 실패로 봤다: \(ok.failures)")
    }
}
