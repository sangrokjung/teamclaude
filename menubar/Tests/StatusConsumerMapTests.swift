import Foundation

// status 필드 × 메뉴바 소비자 지도(test/status-consumer-map.test.js의 메뉴바 쪽).
//
// 입력 Fixtures/status-consumer-sentinel.json은 생성물이다. JS 테스트가 실제 AccountManager.getStatus로 만들고
// 실제 키와 달라지면 JS 테스트가 실패한다(갱신: TC_UPDATE_STATUS_SENTINEL=1 node --test test/status-consumer-map.test.js).
//
// 필드마다 "바탕 응답"과 "그 필드 칸만 표식으로 바꾼 응답"을 메뉴바 디코딩(teamCodexPoolHealth)에 넣고,
// 실제 뷰가 그리는 문구·값을 비교한다. 문구·값은 뷰가 직접 부르는 공유 함수에서 받는다:
//  - teamCodexPoolHeaderText · teamCodexPoolRowText(TeamCodexPoolRowText.swift) → CodexStatusView.drawTeamCodexPool
//  - PanelDraw.meterValueText → PanelDraw.meterWithValue, codexSubscriptionStatusText → CodexStatusView 구독 상태 글
//  - teamCodexAccountRecovery(되돌리기 버튼), titleSlot·accessibilitySummary(메뉴바 제목), TeamClaudeApiCredit 행 문구
// 그래서 뷰에서 표시를 빼려면 이 공유 함수를 바꿔야 하고, 그러면 여기서 실패한다.
// 같으면 그 필드는 메뉴바에 보이지 않는 것이다. 보이지 않는 게 맞는 필드는
// test/status-consumer-exemptions.json(consumer "menubar")에 사유·만료·승인과 함께 등록한다.

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

    static let missingHint = "대신 menubar/Sources/TeamCodexPoolRowText.swift에 표시 지점을 추가하거나 exemptions에 사유·만료·승인 등록"

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

    // ── 메뉴바 표시(뷰와 공유하는 함수만 부른다) ────────────────────────

    static func render(_ payload: [String: Any], now: Date) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let pool = try? teamCodexPoolHealth(from: data, port: 3457, serverPid: 1, checkedAt: now) else {
            fatalError("메뉴바 status 디코딩 실패")
        }
        var lines = [
            pool.titleSlot(timeZone: TimeZone(identifier: "UTC")!),
            pool.accessibilitySummary,
            String(describing: teamCodexPoolHeaderText(pool)),
        ]
        for account in pool.accounts { lines += rowLines(account, pool: pool) }
        lines += apiCreditLines(payload, now: now)
        return lines.joined(separator: "\n")
    }

    static func rowLines(_ account: TeamCodexPoolAccount, pool: TeamCodexPoolHealth) -> [String] {
        let row = teamCodexPoolRowText(account, pool: pool)
        var lines = [String(describing: row)]
        lines += row.windows.map { PanelDraw.meterValueText($0.percent) }
        if let recovery = teamCodexAccountRecovery(account, now: pool.checkedAt) { lines.append(recovery.title) }
        let subscription = codexSubscriptionResolution(account: account, local: nil, now: pool.checkedAt)
        lines.append(codexSubscriptionStatusText(subscription, now: pool.checkedAt))
        return lines
    }

    /// Claude 탭 "API 크레딧" 묶음의 행 문구(TeamClaudeApiCredit.swift). 같은 응답의 계정별 credit 블록을 읽는다.
    static func apiCreditLines(_ payload: [String: Any], now: Date) -> [String] {
        var lines: [String] = []
        for row in payload["accounts"] as? [[String: Any]] ?? [] {
            guard let credit = teamClaudeApiCredit(row["credit"]) else { continue }
            lines += [teamClaudeApiCreditReason(credit, now: now), teamClaudeApiCreditBarValue(credit),
                      teamClaudeApiCreditAmountText(credit)]
            if let expiry = teamClaudeApiCreditExpiryText(credit, now: now) { lines.append(expiry) }
        }
        return lines
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
