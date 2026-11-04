import Cocoa

// status 필드 × 메뉴바 소비자 지도(test/status-consumer-map.test.js의 메뉴바 쪽).
//
// 입력 Fixtures/status-consumer-sentinel.json은 생성물이다. JS 테스트가 실제 AccountManager.getStatus로 만들고
// 실제 키와 달라지면 JS 테스트가 실패한다(갱신: TC_UPDATE_STATUS_SENTINEL=1 node --test test/status-consumer-map.test.js).
//
// 필드마다 "바탕 응답"과 "그 필드 칸만 표식으로 바꾼 응답"을 메뉴바 디코딩(teamCodexPoolHealth)에 넣고,
// 실제 CodexStatusView를 화면 밖 비트맵에 그려 DrawnTextRecorder가 가로챈 "실제로 그려진 글자"를 비교한다
// (자식 컨트롤 제목은 collectControlTitles). 뷰가 값을 계산만 하고 그리기 호출을 빼면 글자가 같아져 실패한다.
// 같으면 그 필드는 메뉴바에 보이지 않는 것이다. 보이지 않는 게 맞는 필드는
// test/status-consumer-exemptions.json(consumer "menubar")에 사유·만료·승인과 함께 등록한다.
//
// CodexStatusView는 main.swift 타입에 의존해 러너가 직접 못 돌린다(run-tests.sh SKIP_TESTS).
// test_status_consumer_map.py가 main.swift 진입점 앞부분을 잘라 붙여 컴파일하고, 구독 버튼이 ~/.config 설정을
// 읽으므로 격리 HOME에서 실행한다. Claude 풀 표(main.swift 본체)는 여기서 그리지 않는다.

@main
struct StatusConsumerMapTests {
    struct Fixture {
        let now: Date
        let fields: [String]
        let baseline: [String: Any]
        let variants: [[String: Any]]
    }

    struct Exemption {
        let field: String
        let reason: String
        let expires: String
        let approvedBy: String
    }

    static let missingHint = "대신 menubar/Sources/CodexStatusView.swift에 표시 지점을 추가하거나 exemptions에 사유·만료·승인 등록"

    // ── 응답 패치 ────────────────────────────────────────────

    static func setField(_ object: inout [String: Any], _ field: String, _ index: Int?, _ value: Any) {
        let parts = field.split(separator: ".").map(String.init)
        guard parts.first == "accounts" else { object[parts[0]] = value; return }
        guard let index, var accounts = object["accounts"] as? [[String: Any]], accounts.indices.contains(index) else {
            fatalError("patch 대상 계정 없음: \(field)[\(String(describing: index))]")
        }
        var account = accounts[index]
        if parts.count == 2 {
            account[parts[1]] = value
        } else {
            var nested = account[parts[1]] as? [String: Any] ?? [:]
            nested[parts[2]] = value
            account[parts[1]] = nested
        }
        accounts[index] = account
        object["accounts"] = accounts
    }

    static func applyPatch(_ object: [String: Any], _ patch: Any?) -> [String: Any] {
        var out = object
        for entry in patch as? [[String: Any]] ?? [] {
            guard let field = entry["field"] as? String, let value = entry["value"] else { fatalError("잘못된 patch: \(entry)") }
            setField(&out, field, (entry["index"] as? NSNumber)?.intValue, value)
        }
        return out
    }

    // ── 메뉴바 표시: 실제 CodexStatusView가 그린 글자 ──────────────────────

    static func render(_ payload: [String: Any], now: Date) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let pool = try? teamCodexPoolHealth(from: data, port: 3457, serverPid: 1, checkedAt: now) else {
            fatalError("메뉴바 status 디코딩 실패")
        }
        return drawnStrings(pool).joined(separator: "\n")
    }

    /// 화면 밖 비트맵에 실제 draw()를 돌리고, 그 사이 NSString·NSAttributedString 그리기로 나간 글자와
    /// 보이는 컨트롤 제목(구독 버튼 등)을 그린 순서대로 모은다.
    static func drawnStrings(_ pool: TeamCodexPoolHealth) -> [String] {
        let width = StatusMenuDashboardView.preferredWidth
        let view = CodexStatusView(frame: NSRect(x: 0, y: 0, width: width, height: CodexStatusView.preferredHeight(for: pool)))
        view.appearance = NSAppearance(named: .darkAqua)
        view.pool = pool
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { fatalError("비트맵 생성 실패") }
        DrawnTextRecorder.reset()
        view.cacheDisplay(in: view.bounds, to: rep)
        DrawnTextRecorder.collectControlTitles(in: view)
        let drawn = DrawnTextRecorder.strings
        DrawnTextRecorder.reset()
        return drawn
    }

    // ── 입력 ─────────────────────────────────────────────────

    static func loadJSON(_ url: URL) -> Any {
        guard let data = try? Data(contentsOf: url), let object = try? JSONSerialization.jsonObject(with: data) else {
            fatalError("읽기 실패: \(url.lastPathComponent)")
        }
        return object
    }

    static func loadFixture(_ testsDir: URL) -> Fixture {
        guard let object = loadJSON(testsDir.appendingPathComponent("Fixtures/status-consumer-sentinel.json")) as? [String: Any],
              let nowText = object["now"] as? String, let now = teamRuntimeDate(nowText),
              let fields = object["fields"] as? [String],
              let baseline = object["baseline"] as? [String: Any],
              let variants = object["variants"] as? [[String: Any]] else {
            fatalError("표식 fixture 형식 오류 — node --test test/status-consumer-map.test.js 로 확인")
        }
        precondition(variants.compactMap { $0["field"] as? String } == fields, "fixture variants와 fields 목록이 다름")
        return Fixture(now: now, fields: fields, baseline: baseline, variants: variants)
    }

    static func loadExemptions(_ repoRoot: URL) -> [Exemption] {
        let rows = loadJSON(repoRoot.appendingPathComponent("test/status-consumer-exemptions.json")) as? [[String: Any]] ?? []
        return rows.filter { $0["consumer"] as? String == "menubar" }.map {
            Exemption(field: $0["field"] as? String ?? "", reason: $0["reason"] as? String ?? "",
                      expires: $0["expires"] as? String ?? "", approvedBy: $0["approved_by"] as? String ?? "")
        }
    }

    // ── 판정 ─────────────────────────────────────────────────

    static func variantFailures(_ fixture: Fixture, _ exemptions: [Exemption]) -> [String] {
        var failures: [String] = []
        for variant in fixture.variants {
            let field = variant["field"] as! String
            let base = applyPatch(fixture.baseline, variant["basePatch"])
            let shown = render(base, now: fixture.now) != render(applyPatch(base, variant["patch"]), now: fixture.now)
            let exempt = exemptions.contains { $0.field == field }
            if !shown && !exempt { failures.append("\(field) 누락: menubar — \(missingHint)") }
            if shown && exempt { failures.append("\(field) 불필요한 예외: menubar가 이미 표시함 — exemptions에서 제거") }
        }
        return failures
    }

    static func exemptionFailures(_ exemptions: [Exemption], fields: [String]) -> [String] {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        let today = formatter.string(from: Date())
        var failures: [String] = []
        for exemption in exemptions {
            let id = "\(exemption.field)/menubar"
            if !fields.contains(exemption.field) { failures.append("\(id): getStatus에 없는 필드의 예외") }
            if exemption.reason.isEmpty || exemption.approvedBy.isEmpty { failures.append("\(id): reason·approved_by 없음") }
            if formatter.date(from: exemption.expires) == nil { failures.append("\(id): expires는 YYYY-MM-DD") }
            else if exemption.expires < today { failures.append("\(id): 예외 만료(\(exemption.expires))") }
        }
        return failures
    }

    static func main() {
        _ = NSApplication.shared
        L10n.language = .ko
        // 구독 버튼은 ~/.config 아래 설정을 읽는다. 실제 계정 설정을 건드리지 않도록 격리 HOME에서만 돈다.
        guard NSHomeDirectory().contains("cc-status-consumer-map-") else {
            FileHandle.standardError.write("Refusing to run outside the isolated HOME (cc-status-consumer-map-*)\n".data(using: .utf8)!)
            exit(2)
        }
        DrawnTextRecorder.install()
        let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let fixture = loadFixture(testsDir)
        let exemptions = loadExemptions(testsDir.deletingLastPathComponent().deletingLastPathComponent())
        // 메뉴바가 바탕 응답을 실제로 읽는지 먼저 확인한다(빈 디코딩이면 모든 필드가 "누락"으로 보인다).
        precondition(render(fixture.baseline, now: fixture.now).contains("acct-codex"), "바탕 응답의 계정 행이 그려지지 않음")

        let failures = variantFailures(fixture, exemptions) + exemptionFailures(exemptions, fields: fixture.fields)
        if !failures.isEmpty {
            failures.forEach { print("✗ \($0)") }
            exit(1)
        }
        let pending = exemptions.filter { $0.approvedBy == "pending" }.count
        if pending > 0 { print("경고: 메뉴바 status 소비자 예외 \(pending)건 승인 대기(approved_by=pending)") }
        print("STATUS-CONSUMER-MAP: menubar \(fixture.fields.count) fields checked")
    }
}
