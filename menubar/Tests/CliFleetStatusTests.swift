import Foundation

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
        precondition(Set(grok.keys) == ["installed", "auth", "usage_pct", "period_end", "last_used", "sessions_today"], "\(grok.keys)")
        let agy = object["agy"] as? [String: Any] ?? [:]
        precondition(Set(agy.keys) == ["installed", "auth", "groups", "last_used", "conversations_today"], "\(agy.keys)")
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
            try! fm.setAttributes([.modificationDate: date, .creationDate: date], ofItemAtPath: url.path)
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
        var heavy = fresh
        heavy.grok.usagePercent = 85
        precondition(CliFleetTable.row(name: "x", status: heavy, hostError: nil, now: now).grok.word == "남음 15%")
        var expired = fresh
        expired.grok.auth = .expired
        let expiredRow = CliFleetTable.row(name: "x", status: expired, hostError: nil, now: now)
        precondition(expiredRow.grok.level == .warn && expiredRow.grok.word == "갱신 필요")

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
}
