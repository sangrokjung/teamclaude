import Cocoa

// Grok·agy 머신별 상세 표(CliFleetStatus.swift·CliFleetTable.swift)와 대시보드 링크(DashboardLinks.swift).
// 스냅샷 직렬화·사용 흔적 스캔·수집 결과 해석·표 행 상태 판정·링크 파일 해석을 고정한다.
@main
struct CliFleetStatusTests {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)

    static func sampleSnapshot(host: String = "node-a", age: TimeInterval = 30) -> CliStatusSnapshot {
        CliStatusSnapshot(
            host: host, writtenAt: now.addingTimeInterval(-age),
            grok: CliGrokStatus(installed: true, auth: .ok, usagePercent: 12.5,
                                periodEnd: now.addingTimeInterval(3 * 86_400 + 4 * 3_600),
                                lastUsed: now.addingTimeInterval(-180), sessionsToday: 4),
            agy: CliAgyStatus(installed: true, auth: .ok,
                              groups: [CliAgyGroupStatus(name: "Gemini Models", weeklyRemainingPercent: 78,
                                                         weeklyReset: now.addingTimeInterval(5 * 86_400),
                                                         fiveHourRemainingPercent: 95,
                                                         fiveHourReset: now.addingTimeInterval(2 * 3_600))],
                              lastUsed: now.addingTimeInterval(-7_200), conversationsToday: 2))
    }

    static func main() {
        L10n.language = .ko
        snapshotRoundTrip()
        snapshotRejectsBadShape()
        grokAndAgyMapping()
        activityScan()
        fileWriteIsAtomic()
        fleetReport()
        tableRows()
        links()
        reviewRound1()
        print("CliFleetStatusTests OK")
    }

    // MARK: 1. 스냅샷 직렬화 — 쓴 것을 그대로 다시 읽는다. 토큰 칸은 없다.
    static func snapshotRoundTrip() {
        let snapshot = sampleSnapshot()
        guard let data = snapshot.jsonData(),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            preconditionFailure("snapshot must serialize")
        }
        precondition(object["schema"] as? Int == 1)
        precondition(object["written_at"] as? Int == Int(snapshot.writtenAt.timeIntervalSince1970))
        let grok = object["grok"] as? [String: Any] ?? [:]
        precondition(grok["auth"] as? String == "ok" && grok["period_end"] as? String != nil)
        precondition(Set(grok.keys) == ["installed", "auth", "usage_pct", "period_end", "last_used", "sessions_today",
                                        "sessions_today_partial", "last_ok_at", "fetch_failed"], "\(grok.keys)")
        let agy = object["agy"] as? [String: Any] ?? [:]
        precondition(Set(agy.keys) == ["installed", "auth", "groups", "last_used", "conversations_today",
                                       "conversations_today_partial", "last_ok_at", "fetch_failed"], "\(agy.keys)")
        let text = String(decoding: data, as: UTF8.self)
        for banned in ["token", "key", "Bearer"] { precondition(!text.contains(banned), "no credential fields: \(banned)") }
        guard let back = CliStatusSnapshot.parse(object) else { preconditionFailure("round trip must parse") }
        precondition(back == snapshot, "\(back)")

        // 값이 없는 칸은 null로 쓰고 nil로 읽는다.
        var empty = snapshot
        empty.grok = CliGrokStatus(installed: false, auth: .unavailable, usagePercent: nil, periodEnd: nil, lastUsed: nil, sessionsToday: nil)
        empty.agy = CliAgyStatus(installed: false, auth: .error, groups: [], lastUsed: nil, conversationsToday: nil)
        let emptyObject = (try? JSONSerialization.jsonObject(with: empty.jsonData()!)) as? [String: Any] ?? [:]
        precondition((emptyObject["grok"] as? [String: Any])?["usage_pct"] is NSNull)
        precondition(CliStatusSnapshot.parse(emptyObject) == empty)
    }

    static func snapshotRejectsBadShape() {
        var object = (try? JSONSerialization.jsonObject(with: sampleSnapshot().jsonData()!)) as? [String: Any] ?? [:]
        precondition(CliStatusSnapshot.parse(object) != nil)
        var wrongSchema = object; wrongSchema["schema"] = 2
        precondition(CliStatusSnapshot.parse(wrongSchema) == nil, "schema mismatch is rejected")
        var badAuth = object
        var grok = object["grok"] as! [String: Any]; grok["auth"] = "maybe"; badAuth["grok"] = grok
        precondition(CliStatusSnapshot.parse(badAuth) == nil, "unknown auth is rejected")
        var noHost = object; noHost.removeValue(forKey: "host")
        precondition(CliStatusSnapshot.parse(noHost) == nil)
        // 범위 밖 값은 그 칸만 비운다.
        grok = object["grok"] as! [String: Any]; grok["usage_pct"] = 250; object["grok"] = grok
        precondition(CliStatusSnapshot.parse(object)?.grok.usagePercent == nil)
        precondition(CliStatusSnapshot.parse("not a dict") == nil)
    }

    // MARK: 2. 앱 결과 → 스냅샷 칸
    static func grokAndAgyMapping() {
        let activity = CliActivity(lastUsed: now, todayCount: 3)
        // 청구 응답에서 주간 초기화 시각(config.currentPeriod.end)을 읽는다.
        let billing = Data("""
        {"config":{"creditUsagePercent":3,"productUsage":[{"product":"GrokBuild","usagePercent":1.4}],
          "currentPeriod":{"start":"2026-11-23T00:00:00Z","end":"2026-11-30T00:00:00Z"}}}
        """.utf8)
        guard case .percent(let percent) = grokMenuOutcome(billing: billing, statusCode: 200) else {
            preconditionFailure("billing must parse")
        }
        precondition(percent.periodEnd == CliStatusCodec.isoDate("2026-11-30T00:00:00Z"), "\(String(describing: percent.periodEnd))")
        precondition(grokPeriodEnd(fromBilling: Data("{\"config\":{}}".utf8)) == nil)
        let ok = cliGrokStatus(outcome: .percent(percent), installed: true, activity: activity)
        precondition(ok.auth == .ok && ok.usagePercent == 1.4 && ok.sessionsToday == 3 && ok.periodEnd != nil)
        precondition(cliGrokStatus(outcome: .expired, installed: true, activity: activity).auth == .expired)
        precondition(cliGrokStatus(outcome: .login, installed: true, activity: activity).auth == .login)
        precondition(cliGrokStatus(outcome: .unavailable, installed: false, activity: activity).installed == false)

        let groups = [AgyQuotaGroup(name: "Gemini Models", weekly: AgyQuotaBucket(remaining: 0.785, resetAt: now),
                                    fiveHour: AgyQuotaBucket(remaining: 0.5, resetAt: nil)),
                      AgyQuotaGroup(name: "Claude Models", weekly: AgyQuotaBucket(remaining: 1, resetAt: nil), fiveHour: nil)]
        let agy = cliAgyStatus(outcome: .ready(groups), activity: activity)
        precondition(agy.auth == .ok && agy.groups.count == 1, "only the Gemini lane: \(agy.groups)")
        precondition(abs((agy.groups[0].weeklyRemainingPercent ?? 0) - 78.5) < 0.001 && agy.groups[0].weeklyReset == now)
        precondition(cliAgyStatus(outcome: .missing, activity: activity).installed == false)
        precondition(cliAgyStatus(outcome: .failed, activity: activity).auth == .error)
    }

    // MARK: 3. 사용 흔적 스캔
    static func activityScan() {
        let fm = FileManager.default
        let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("cli-fleet-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: base) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Seoul")!
        let midnight = calendar.startOfDay(for: now)
        func touch(_ url: URL, _ date: Date) {
            try! fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            fm.createFile(atPath: url.path, contents: Data("x".utf8))
            // 생성 시각을 먼저, 수정 시각을 나중에 맞춘다(수정 시각이 생성 시각보다 앞서면 파일 시스템이 생성 시각을 끌어내린다).
            try! fm.setAttributes([.creationDate: date], ofItemAtPath: url.path)
            try! fm.setAttributes([.modificationDate: date], ofItemAtPath: url.path)
        }
        // 폴더가 없으면 개수도 모른다(nil).
        let missing = CliActivityScanner.grok(root: base.appendingPathComponent("none"), now: now, calendar: calendar)
        precondition(missing == CliActivity(lastUsed: nil, todayCount: nil))

        let grok = base.appendingPathComponent("grok")
        touch(grok.appendingPathComponent("%2Fa/s1/chat_history.jsonl"), midnight.addingTimeInterval(600))
        touch(grok.appendingPathComponent("%2Fa/s2/chat_history.jsonl"), midnight.addingTimeInterval(-86_400))
        touch(grok.appendingPathComponent("%2Fb/s3/chat_history.jsonl"), midnight.addingTimeInterval(1_200))
        for s in ["s1", "s2"] { try! fm.setAttributes([.creationDate: midnight.addingTimeInterval(-90_000)],
                                                      ofItemAtPath: grok.appendingPathComponent("%2Fa/\(s)").path) }
        try! fm.setAttributes([.creationDate: midnight.addingTimeInterval(-90_000)], ofItemAtPath: grok.appendingPathComponent("%2Fb/s3").path)
        let grokActivity = CliActivityScanner.grok(root: grok, now: now, calendar: calendar)
        precondition(grokActivity.todayCount == 2, "\(grokActivity)")
        precondition(grokActivity.lastUsed == midnight.addingTimeInterval(1_200), "\(grokActivity)")

        let agy = base.appendingPathComponent("agy")
        touch(agy.appendingPathComponent("c1.db"), midnight.addingTimeInterval(-86_400))
        touch(agy.appendingPathComponent("c1.db-wal"), midnight.addingTimeInterval(300))
        touch(agy.appendingPathComponent("c2.db"), midnight.addingTimeInterval(-86_400))
        // 메뉴바의 /usage 호출은 모든 대화의 .db-shm만 건드린다. 그것만으로는 오늘 대화가 아니다.
        touch(agy.appendingPathComponent("c2.db-shm"), now)
        touch(agy.appendingPathComponent("c1.db-shm"), now)
        try! fm.setAttributes([.creationDate: midnight.addingTimeInterval(-90_000)], ofItemAtPath: agy.appendingPathComponent("c1.db-wal").path)
        let agyActivity = CliActivityScanner.agy(root: agy, now: now, calendar: calendar)
        precondition(agyActivity.todayCount == 1, "shm-only change is not a conversation: \(agyActivity)")
        precondition(agyActivity.lastUsed == midnight.addingTimeInterval(300), "\(agyActivity)")
    }

    // MARK: 4. 파일 쓰기 — 임시 파일 → rename, 남는 임시 파일 없음
    static func fileWriteIsAtomic() {
        let fm = FileManager.default
        let folder = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("cli-status-\(UUID().uuidString)/nested")
        defer { try? fm.removeItem(at: folder.deletingLastPathComponent()) }
        let target = folder.appendingPathComponent("cli-status.json")
        precondition(CliStatusFile.write(sampleSnapshot(), to: target))
        precondition(CliStatusFile.write(sampleSnapshot(host: "node-b"), to: target), "overwrite works")
        let names = (try? fm.contentsOfDirectory(atPath: folder.path)) ?? []
        precondition(names == ["cli-status.json"], "no temp leftovers: \(names)")
        let data = try! Data(contentsOf: target)
        precondition(CliStatusSnapshot.parse(try! JSONSerialization.jsonObject(with: data))?.host == "node-b")
    }

    // MARK: 5. 본체 수집 결과
    static func fleetReport() {
        let good = (try? JSONSerialization.jsonObject(with: sampleSnapshot().jsonData()!)) ?? [:]
        let report: [String: Any] = [
            "collected_at": now.timeIntervalSince1970 - 20,
            "hosts": [
                ["name": "hub", "ok": true, "error": NSNull(), "status": good],
                ["name": "node-b", "ok": false, "error": "ssh", "status": NSNull()],
                ["name": "node-c", "ok": true, "error": NSNull(), "status": ["schema": 9]],
                "garbage",
            ],
        ]
        let data = try! JSONSerialization.data(withJSONObject: report)
        guard let parsed = CliFleetReport.parse(data) else { preconditionFailure("report must parse") }
        precondition(parsed.hosts.map(\.name) == ["hub", "node-b", "node-c"], "\(parsed.hosts.map(\.name))")
        precondition(parsed.hosts[0].ok && parsed.hosts[0].status?.host == "node-a")
        precondition(!parsed.hosts[1].ok && parsed.hosts[1].error == "ssh")
        precondition(!parsed.hosts[2].ok && parsed.hosts[2].error == "parse", "bad host snapshot is parse error")
        precondition(CliFleetReport.parse(Data("[]".utf8)) == nil)
        let missing = NSTemporaryDirectory() + "no-such-\(UUID().uuidString).json"
        precondition(CliFleetReport.load(path: missing) == nil, "missing file hides the fleet rows")
        let broken = NSTemporaryDirectory() + "broken-\(UUID().uuidString).json"
        FileManager.default.createFile(atPath: broken, contents: Data("{".utf8))
        defer { try? FileManager.default.removeItem(atPath: broken) }
        precondition(CliFleetReport.load(path: broken) == .unreadable)
    }

    // MARK: 6. 표 행 — 상태 판정과 글자
    static func tableRows() {
        let fresh = sampleSnapshot()
        let row = CliFleetTable.row(name: "node-a", status: fresh, hostError: nil, now: now)
        precondition(row.level == .ok && row.statusWord == "정상", "\(row)")
        precondition(row.grok.level == .ok && row.grok.word == nil && row.grok.usagePercent == 12.5)
        precondition(row.grok.reset == "초기화 3일 4시간", row.grok.reset ?? "nil")
        precondition(row.agy.level == .ok && row.agy.weeklyRemaining == 78 && row.agy.fiveHourRemaining == 95)
        precondition(row.agy.reset == "주 5일 · 5h 2시간", row.agy.reset ?? "nil")
        precondition(row.grokLastUsed == "3분 전" && row.agyLastUsed == "2시간 전", "\(row.grokLastUsed) \(row.agyLastUsed)")
        precondition(row.grokToday == "4" && row.agyToday == "2")

        // 주의: 남은 양 20% 미만, Grok 만료.
        var low = fresh
        low.agy.groups[0].fiveHourRemainingPercent = 12
        let lowRow = CliFleetTable.row(name: "node-a", status: low, hostError: nil, now: now)
        precondition(lowRow.level == .warn && lowRow.agy.level == .warn && lowRow.agy.word == "남음 12%", "\(lowRow.agy)")
        precondition(lowRow.statusWord == "주의")
        precondition(lowRow.agy.reset == "5h 2시간", "only the short window's reset: \(lowRow.agy.reset ?? "nil")")
        var heavy = fresh
        heavy.grok.usagePercent = 85
        let heavyRow = CliFleetTable.row(name: "x", status: heavy, hostError: nil, now: now)
        precondition(heavyRow.grok.word == "남음 15%" && heavyRow.grok.reset == "초기화 3일", heavyRow.grok.reset ?? "nil")
        var expired = fresh
        expired.grok.auth = .expired
        let expiredRow = CliFleetTable.row(name: "x", status: expired, hostError: nil, now: now)
        precondition(expiredRow.grok.level == .warn && expiredRow.grok.word == "갱신 필요" && expiredRow.grok.reset == nil)
        precondition(L10n.cliFleetSummary(machines: 6, ok: 1) == "6대 중 정상 1" && L10n.cliFleetSummary(machines: 2, ok: 2) == "2대 모두 정상")

        // 문제: 로그인 필요·미설치·수집 실패·묵음.
        var login = fresh
        login.grok.auth = .login
        login.agy.auth = .login
        let loginRow = CliFleetTable.row(name: "x", status: login, hostError: nil, now: now)
        precondition(loginRow.level == .problem && loginRow.grok.word == "로그인 필요" && loginRow.agy.word == "로그인 필요")
        precondition(loginRow.statusWord == "문제")
        var missing = fresh
        missing.agy.installed = false
        precondition(CliFleetTable.row(name: "x", status: missing, hostError: nil, now: now).agy.word == "미설치")
        let failed = CliFleetTable.row(name: "node-b", status: nil, hostError: "ssh", now: now)
        precondition(failed.level == .problem && failed.statusWord == "수집 실패" && failed.grok.word == nil, "\(failed)")
        precondition(failed.grokLastUsed == "—" && failed.agyToday == "—")
        let offline = CliFleetTable.row(name: "laptop", status: nil, hostError: "offline", now: now)
        precondition(offline.level == .warn && offline.statusWord == "꺼짐", "an offline-ok laptop is a caution, not a failure")
        let stale = CliFleetTable.row(name: "x", status: sampleSnapshot(age: 7 * 60), hostError: nil, now: now)
        precondition(stale.level == .problem && stale.statusWord == "멈춤 7분" && stale.dimmed, "\(stale)")
        let quiet = CliFleetTable.row(name: "x", status: sampleSnapshot(age: 4 * 60), hostError: nil, now: now)
        precondition(quiet.level == .ok && !quiet.dimmed, "4 minutes is still fresh for a host snapshot")

        // 레인이 여럿이면 첫 레인 값을 보이고 나머지는 센다. 주의 판정은 가장 낮은 레인으로 한다.
        var twoLanes = fresh
        twoLanes.agy.groups.append(CliAgyGroupStatus(name: "Gemini Flash", weeklyRemainingPercent: 9, weeklyReset: nil,
                                                     fiveHourRemainingPercent: nil, fiveHourReset: nil))
        let twoRow = CliFleetTable.row(name: "x", status: twoLanes, hostError: nil, now: now)
        precondition(twoRow.agy.reset?.hasSuffix("외 1개 레인") == true, twoRow.agy.reset ?? "nil")
        precondition(twoRow.agy.level == .warn && twoRow.agy.word == "남음 9%" && twoRow.agy.weeklyRemaining == 78, "\(twoRow.agy)")

        // 확인 중: 첫 결과 전의 이 맥 한 줄.
        let pending = CliFleetTable.localRow(CliLocalCliState(host: "this-mac", grok: nil, agy: nil), now: now)
        precondition(pending.level == .pending && pending.grok.word == "확인 중" && pending.agy.word == "확인 중")
        // 갱신 지연 꼬리말은 값이 없는 줄에도 붙는다(예전 카드의 조기 반환 회귀 방지).
        let staleNoted = CliQuotaLanesView.withStaleNotes(pending, ["agy": "갱신 없음 5분"])
        precondition(staleNoted.agy.word == "확인 중 · 갱신 없음 5분" && staleNoted.level == .warn, "\(staleNoted)")

        // 표: 수집 파일이 없으면 이 맥 한 줄, 있으면 머신마다 한 줄.
        let local = CliLocalCliState(host: "this-mac", grok: fresh.grok, agy: fresh.agy, writtenAt: now)
        let alone = CliFleetTable.make(report: nil, local: local, now: now)
        precondition(alone.rows.count == 1 && alone.rows[0].name == "this-mac" && !alone.fromFleet && alone.collectorNote == nil)
        let goodObject = (try? JSONSerialization.jsonObject(with: fresh.jsonData()!)) ?? [:]
        let report = CliFleetReport.parse(object: [
            "collected_at": now.timeIntervalSince1970 - 20,
            "hosts": [["name": "hub", "ok": true, "status": goodObject], ["name": "node-b", "ok": false, "error": "timeout"]],
        ])!
        let fleet = CliFleetTable.make(report: report, local: local, now: now)
        precondition(fleet.fromFleet && fleet.rows.map(\.name) == ["본체", "node-b"], "\(fleet.rows.map(\.name))")
        precondition(fleet.collectorNote == nil)
        let stalled = CliFleetTable.make(report: CliFleetReport(collectedAt: now.addingTimeInterval(-600), hosts: report.hosts),
                                         local: local, now: now)
        precondition(stalled.collectorNote == "수집 멈춤 10분" && stalled.collectorLevel == .problem, "\(String(describing: stalled.collectorNote))")
        let unreadable = CliFleetTable.make(report: .unreadable, local: local, now: now)
        precondition(unreadable.rows.count == 1 && unreadable.collectorNote == "수집 파일 읽기 실패", "falls back to this Mac")
        // 높이: 머리 두 줄 + 행마다 같은 높이. 6대가 400pt 안에 든다.
        precondition(CliFleetTable.height(rows: 6) <= 400, "\(CliFleetTable.height(rows: 6))")
        precondition(CliFleetTable.height(rows: 2) > CliFleetTable.height(rows: 1))

        // 영어 문구에 한글이 없다.
        L10n.language = .en
        let english = CliFleetTable.row(name: "x", status: low, hostError: nil, now: now)
        for text in [english.statusWord, english.agy.word ?? "", english.grok.reset ?? "", english.agy.reset ?? "",
                     english.grokLastUsed, CliFleetTable.limitNote,
                     CliFleetTable.row(name: "y", status: sampleSnapshot(age: 600), hostError: nil, now: now).statusWord] {
            precondition(!text.unicodeScalars.contains { (0xAC00...0xD7A3).contains($0.value) }, "hangul in english: \(text)")
        }
        L10n.language = .ko
    }

    // MARK: 7. 대시보드 링크 파일
    static func links() {
        let valid = DashboardLinks.parse(Data("""
        {"links":[{"title":"AI 비용 대시보드","url":"http://100.0.0.1:8790/"},
                  {"title":"secure","url":"https://example.test/x"},
                  {"title":"bad scheme","url":"file:///etc/passwd"},
                  {"title":"js","url":"javascript:alert(1)"},
                  {"title":"","url":"https://example.test/"},
                  {"title":"no host","url":"http://"},
                  {"url":"https://example.test/"}]}
        """.utf8))
        precondition(valid.map(\.title) == ["AI 비용 대시보드", "secure"], "\(valid)")
        precondition(valid[0].url.absoluteString == "http://100.0.0.1:8790/")
        precondition(DashboardLinks.parse(Data("{".utf8)).isEmpty, "broken file hides the button")
        precondition(DashboardLinks.parse(Data("{\"links\": 3}".utf8)).isEmpty)
        precondition(DashboardLinks.load(path: NSTemporaryDirectory() + "missing-\(UUID().uuidString).json").isEmpty)
        precondition(DashboardLinks.defaultPath(home: "/h") == "/h/.config/cc-menubar/links.json")
        // 너무 긴 제목은 버튼 폭을 넘지 않게 자른다.
        let long = DashboardLinks.parse(Data("{\"links\":[{\"title\":\"\(String(repeating: "가", count: 80))\",\"url\":\"https://e.test\"}]}".utf8))
        precondition(long.count == 1 && long[0].title.count <= DashboardLinks.maxTitleLength)
        // 동작 목록 항목: 앱 묶음, 실행하면 메뉴를 닫는다.
        var opened: URL?
        let actions = dashboardLinkActions(valid) { opened = $0 }
        precondition(actions.count == 2 && actions[0].group == .app && actions[0].closesMenu && actions[0].title == "AI 비용 대시보드")
        _ = actions[0].run()
        precondition(opened == valid[0].url)
    }
    // MARK: 8. 적대 검토 1차(2026-11-27) 지적 고정
    static func reviewRound1() {
        let fm = FileManager.default

        // I1: 조회가 계속 실패하면 앞선 값을 보이더라도 실패와 마지막 성공 시각을 따로 싣고, 표는 그것으로 지연을 말한다.
        var tracker = CliLocalTracker()
        let billing = GrokPercentOutcome(slot: "Grok 12%", productPercent: 12, creditPercent: nil)
        tracker.recordGrok(.percent(billing), now: now.addingTimeInterval(-600))
        tracker.recordGrok(.unavailable, now: now.addingTimeInterval(-60))
        let lanes = [AgyQuotaGroup(name: "Gemini Models", weekly: AgyQuotaBucket(remaining: 0.8, resetAt: nil),
                                   fiveHour: AgyQuotaBucket(remaining: 0.9, resetAt: nil))]
        tracker.recordAgy(.ready(lanes), now: now.addingTimeInterval(-900))
        tracker.recordAgy(.failed, now: now.addingTimeInterval(-30))
        let state = tracker.state(host: "w", now: now)
        guard let grok = state.grok, let agy = state.agy, let snapshot = state.snapshot else { preconditionFailure("state must exist") }
        precondition(grok.auth == .ok && grok.usagePercent == 12, "previous value is kept")
        precondition(grok.fetchFailed && grok.lastOkAt == now.addingTimeInterval(-600), "\(grok)")
        precondition(agy.auth == .ok && agy.fetchFailed && agy.lastOkAt == now.addingTimeInterval(-900), "\(agy)")
        precondition(snapshot.writtenAt == now)
        let lagged = CliFleetTable.row(name: "w", status: snapshot, hostError: nil, now: now)
        precondition(lagged.grok.level == .warn && lagged.grok.word == "조회 지연 10분" && lagged.grok.usagePercent == 12, "\(lagged.grok)")
        precondition(lagged.agy.level == .warn && lagged.agy.word == "조회 지연 15분", "\(lagged.agy)")
        precondition(lagged.level == .warn && lagged.statusWord == "주의", "a fresh written_at alone is not fresh")
        // 직렬화를 지나도 같다(수집기가 옮기는 칸).
        let reparsed = CliStatusSnapshot.parse(try! JSONSerialization.jsonObject(with: snapshot.jsonData()!))!
        precondition(reparsed.grok.fetchFailed && reparsed.grok.lastOkAt == grok.lastOkAt && reparsed.agy.lastOkAt == agy.lastOkAt)
        // 다시 성공하면 실패 표지가 풀린다. 실패 표지 없이도 마지막 성공이 5분 넘게 지났으면 지연이다.
        tracker.recordGrok(.percent(billing), now: now)
        precondition(tracker.state(host: "w", now: now).grok?.fetchFailed == false)
        var quietOld = snapshot
        quietOld.grok.fetchFailed = false
        quietOld.grok.lastOkAt = now.addingTimeInterval(-420)
        precondition(CliFleetTable.row(name: "w", status: quietOld, hostError: nil, now: now).grok.word == "조회 지연 7분")
        quietOld.grok.lastOkAt = now.addingTimeInterval(-120)
        precondition(CliFleetTable.row(name: "w", status: quietOld, hostError: nil, now: now).grok.level == .ok)
        // 한 번도 성공하지 못한 실패는 확인 필요로 남는다(앞선 값이 없다).
        var fresh = CliLocalTracker()
        fresh.recordAgy(.failed, now: now)
        precondition(fresh.state(host: "w", now: now).agy?.auth == .error)
        // 결정된 상태(로그인·만료·미설치)는 실패 표지를 풀고 그대로 보인다.
        tracker.recordGrok(.login, now: now)
        precondition(tracker.state(host: "w", now: now).grok?.auth == .login && tracker.state(host: "w", now: now).grok?.fetchFailed == false)
        tracker.recordGrokMissing()
        precondition(tracker.state(host: "w", now: now).grok?.installed == false)

        // I3: 표시 상한 밖의 머신도 요약에 센다. 잘린 쪽에 실패가 있으면 문제로 집계한다.
        let good = (try? JSONSerialization.jsonObject(with: sampleSnapshot().jsonData()!)) ?? [:]
        var hosts: [[String: Any]] = (0..<CliFleetTable.maxRows).map { ["name": "n\($0)", "ok": true, "status": good] }
        hosts.append(["name": "late-fail", "ok": false, "error": "ssh"])
        let big = CliFleetReport.parse(object: ["collected_at": now.timeIntervalSince1970 - 10, "hosts": hosts])!
        precondition(big.hosts.count == CliFleetTable.maxRows + 1, "the report keeps every host")
        let bigTable = CliFleetTable.make(report: big, local: CliLocalCliState(host: "x"), now: now)
        precondition(bigTable.rows.count == CliFleetTable.maxRows && bigTable.hidden.count == 1)
        precondition(bigTable.totalCount == CliFleetTable.maxRows + 1 && bigTable.okCount == CliFleetTable.maxRows)
        precondition(bigTable.hiddenNote == "외 1대 · 문제 1", bigTable.hiddenNote ?? "nil")
        precondition(L10n.cliFleetSummary(machines: bigTable.totalCount, ok: bigTable.okCount) == "33대 중 정상 32")
        precondition(CliFleetTable.height(rows: CliFleetTable.maxRows, hidden: true) > CliFleetTable.height(rows: CliFleetTable.maxRows))
        // 레인: 첫 레인 뒤의 모든 레인으로 최저 잔량을 본다(이미 고정, 여기서는 9번째 레인까지).
        var nine = sampleSnapshot()
        nine.agy.groups = (0..<9).map { CliAgyGroupStatus(name: "Gemini \($0)", weeklyRemainingPercent: $0 == 8 ? 5 : 90,
                                                          weeklyReset: nil, fiveHourRemainingPercent: nil, fiveHourReset: nil) }
        precondition(CliFleetTable.row(name: "x", status: nine, hostError: nil, now: now).agy.word == "남음 5%")

        // I4: 상위 폴더 mtime이 아니라 세션 파일 mtime으로 센다. 열거 상한에 걸리면 부분 집계다.
        let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("cli-scan-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: base) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Seoul")!
        let midnight = calendar.startOfDay(for: now)
        func put(_ url: URL, _ date: Date) {
            try! fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            fm.createFile(atPath: url.path, contents: Data("x".utf8))
            try! fm.setAttributes([.creationDate: midnight.addingTimeInterval(-90_000)], ofItemAtPath: url.path)
            try! fm.setAttributes([.modificationDate: date], ofItemAtPath: url.path)
        }
        let grokRoot = base.appendingPathComponent("grok")
        for index in 0..<6 { put(grokRoot.appendingPathComponent("%2Fnew/s\(index)/chat_history.jsonl"), midnight.addingTimeInterval(-86_400)) }
        put(grokRoot.appendingPathComponent("%2Fold/today/chat_history.jsonl"), midnight.addingTimeInterval(3_600))
        for dir in ["%2Fnew", "%2Fold", "%2Fnew/s0", "%2Fnew/s1", "%2Fnew/s2", "%2Fnew/s3", "%2Fnew/s4", "%2Fnew/s5", "%2Fold/today"] {
            try! fm.setAttributes([.creationDate: midnight.addingTimeInterval(-90_000)], ofItemAtPath: grokRoot.appendingPathComponent(dir).path)
        }
        // 오래된 프로젝트 폴더의 mtime은 옛날이다. 기존 세션에 이어 써도 상위 폴더 mtime은 바뀌지 않는다.
        try! fm.setAttributes([.modificationDate: midnight.addingTimeInterval(-30 * 86_400)], ofItemAtPath: grokRoot.appendingPathComponent("%2Fold").path)
        let full = CliActivityScanner.grok(root: grokRoot, now: now, calendar: calendar)
        precondition(full.todayCount == 1 && full.lastUsed == midnight.addingTimeInterval(3_600) && !full.partial, "\(full)")
        let cut = CliActivityScanner.grok(root: grokRoot, now: now, calendar: calendar, limit: 4)
        precondition(cut.partial, "a capped scan says so: \(cut)")
        var partialStatus = sampleSnapshot()
        partialStatus.grok.sessionsToday = 3
        partialStatus.grok.sessionsTodayPartial = true
        partialStatus.agy.conversationsTodayPartial = true
        let partialRow = CliFleetTable.row(name: "x", status: partialStatus, hostError: nil, now: now)
        precondition(partialRow.grokToday == "3+" && partialRow.agyToday == "2+", "\(partialRow.grokToday) \(partialRow.agyToday)")
        let agyRoot = base.appendingPathComponent("agy")
        for index in 0..<5 { put(agyRoot.appendingPathComponent("c\(index).db"), midnight.addingTimeInterval(60)) }
        precondition(!CliActivityScanner.agy(root: agyRoot, now: now, calendar: calendar).partial)
        precondition(CliActivityScanner.agy(root: agyRoot, now: now, calendar: calendar, limit: 2).partial)

        // M3: schema는 정확히 1이어야 한다. 소수·거대한 수는 앱을 멈추지 않고 거부한다.
        var object = (try? JSONSerialization.jsonObject(with: sampleSnapshot().jsonData()!)) as? [String: Any] ?? [:]
        object["schema"] = 1.5
        precondition(CliStatusSnapshot.parse(object) == nil, "fractional schema is rejected")
        object["schema"] = 1e300
        precondition(CliStatusSnapshot.parse(object) == nil, "huge schema is rejected without trapping")
        object["schema"] = true
        precondition(CliStatusSnapshot.parse(object) == nil)
        object["schema"] = 1
        precondition(CliStatusSnapshot.parse(object) != nil)

        // 보안 검토: 수집 파일은 읽기 전에 크기로 거부하고(2MiB), 스냅샷 레인은 32개까지만 받는다.
        let huge = NSTemporaryDirectory() + "fleet-huge-\(UUID().uuidString).json"
        fm.createFile(atPath: huge, contents: Data(count: CliFleetReport.maxFileBytes + 1))
        defer { try? fm.removeItem(atPath: huge) }
        precondition(CliFleetReport.load(path: huge) == .unreadable, "oversize collector file is refused")
        var many = (try? JSONSerialization.jsonObject(with: sampleSnapshot().jsonData()!)) as? [String: Any] ?? [:]
        var manyAgy = many["agy"] as! [String: Any]
        manyAgy["groups"] = (0..<40).map { ["name": "Gemini \($0)"] }
        many["agy"] = manyAgy
        precondition(CliStatusSnapshot.parse(many)?.agy.groups.count == CliStatusSnapshot.maxGroups)

        // M1: 링크가 바뀌면 동작 목록도 새로 만든다. 지운 링크는 어디서도 실행되지 않는다.
        precondition(dashboardLinkActions([]) { _ in preconditionFailure("removed link must not run") }.isEmpty)
        let footer = DashboardPanelFooterView(frame: NSRect(x: 0, y: 0, width: 520, height: DashboardPanelFooterView.preferredHeight))
        footer.links = [DashboardLink(title: "A", url: URL(string: "http://a.test/")!)]
        render(footer)
        precondition(!footer.linkRect.isEmpty)
        footer.links = []
        render(footer)
        precondition(footer.linkRect.isEmpty, "no link → no hit area")

        // M2: 긴 링크 제목이 되돌리기 칸을 덮지 않는다(클릭은 되돌리기가 먼저).
        let wide = String(repeating: "가", count: DashboardLinks.maxTitleLength)
        footer.links = [DashboardLink(title: wide, url: URL(string: "http://a.test/")!)]
        footer.notice = DashboardFooterNotice(text: "구독 처리를 기록했습니다 결과 문장이 깁니다", failed: false, undo: true)
        render(footer)
        precondition(!footer.undoRect.isEmpty, "undo button is drawn")
        precondition(!footer.linkRect.intersects(footer.undoRect), "link \(footer.linkRect) overlaps undo \(footer.undoRect)")
    }

    static func render(_ view: NSView) {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { preconditionFailure("bitmap") }
        view.cacheDisplay(in: view.bounds, to: rep)
    }
}
