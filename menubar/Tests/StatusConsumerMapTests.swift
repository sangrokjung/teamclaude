import Foundation

// status 필드 × 메뉴바 소비자 지도(test/status-consumer-map.test.js의 메뉴바 쪽).
//
// JS 테스트가 실제 AccountManager.getStatus로 만든 표식 fixture(Fixtures/status-consumer-sentinel.json)를 읽어,
// 필드마다 "바탕 응답"과 "그 필드 칸만 표식으로 바꾼 응답"을 메뉴바 디코딩(teamCodexPoolHealth)에 넣고
// 메뉴바가 그리는 표시 문자열(제목·풀 요약·계정 행: 상태·막대 값·리셋·보조줄·사실 줄·구독 줄)을 비교한다.
// 문자열이 같으면 그 필드는 메뉴바에 보이지 않는 것이다. 보이지 않는 게 맞는 필드는
// test/status-consumer-exemptions.json(consumer "menubar")에 사유·만료·승인과 함께 등록한다.
//
// 표시 문자열은 CodexStatusView.drawTeamCodexPool이 부르는 라이브러리 함수를 같은 순서로 부르고,
// Claude 탭 API 크레딧 행 문구(TeamClaudeApiCredit.swift)를 더한다.
// CodexStatusView·main.swift(Claude 풀 표 본체)는 러너 라이브러리 묶음 밖이라 여기서 직접 그리지 않는다.

@main
struct StatusConsumerMapTests {
    struct Exemption {
        let field: String
        let consumer: String
        let reason: String
        let expires: String
        let approvedBy: String
    }

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

    /// 메뉴바 Codex 풀 카드·제목이 이 응답으로 그리는 문자열.
    /// 구독 버튼(플랜·결제일 줄) 제목용 저장소. 사용자 기본값·설정 파일을 건드리지 않도록 임시 위치에 둔다.
    static let subscriptionSuite = "status-consumer-map-\(UUID().uuidString)"
    static let subscriptionStore: AccountSubscriptionStore = {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(subscriptionSuite)
        return AccountSubscriptionStore(defaults: UserDefaults(suiteName: subscriptionSuite)!,
                                        configURL: dir.appendingPathComponent("teamclaude.json"),
                                        monitorURL: dir.appendingPathComponent("subscription-monitor.json"))
    }()

    static func render(_ payload: [String: Any], now: Date) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let pool = try? teamCodexPoolHealth(from: data, port: 3457, serverPid: 1, checkedAt: now) else {
            fatalError("메뉴바 status 디코딩 실패")
        }
        let utc = TimeZone(identifier: "UTC")!
        let threshold = pool.switchThresholdPercent
        var lines: [String] = [
            pool.titleSlot(timeZone: utc),
            pool.statusLabel,
            pool.accessibilitySummary,
            "\(pool.usableCount)",
            L10n.codexPoolUsable(pool: pool.poolCount, excluded: pool.excludedCount),
            pool.resetCreditSummary,
            pool.resetCreditPolicyLabel,
            pool.resetCreditAccessibilitySummary,
            L10n.codexUsableNames(pool.accounts.filter { $0.isUsable(switchThresholdPercent: threshold, now: now) }.map(\.name)),
        ]
        for account in pool.accounts {
            let state = teamCodexAccountState(account, switchThresholdPercent: threshold, now: now)
            let retired = state == .retired
            let muted = retired || state == .excluded
            // 상태 점 색은 state가 정한다.
            lines.append("tone=\(state)")
            lines.append(account.name)
            if account.isCurrent && !retired { lines.append(L10n.codexCurrent) }
            lines.append(state == .failed
                ? teamAccountErrorReasonLabel(account.errorReason)
                : teamCodexAccountStateLabel(state, status: account.status, errorReason: account.errorReason))
            let drawsResetCountdown = !account.isPermanentlyOut(now: now)
            let windows: [(Double?, Date?)] = [
                (account.sessionUsagePercent(at: now), account.sessionResetAt),
                (account.weeklyUsagePercent(at: now), account.weeklyResetAt),
            ]
            for (percent, resetAt) in windows {
                lines.append(muted || !drawsResetCountdown ? StatusVocabulary.none : formatTeamCodexResetRemaining(resetAt, now: now))
                let shown = retired ? nil : percent
                lines.append(shown.map { "\(panelPercentNumber($0))%" } ?? StatusVocabulary.none)
                if let shown, shown >= threshold, !muted { lines.append("amber") }
            }
            if let note = teamCodexAccountNote(account, switchThresholdPercent: threshold, now: now) { lines.append(note) }
            if let recovery = teamCodexAccountRecovery(account, now: now) {
                lines.append(recovery.title)
                if let followUp = recovery.followUpNote, !drawsResetCountdown { lines.append(followUp) }
            }
            lines.append(L10n.codexFacts(inflight: account.inflight, maxConcurrent: account.maxConcurrent,
                                         requests: account.totalRequests,
                                         credits: account.resetCreditLabel(at: now, online: pool.serverReachable),
                                         tokens: formatCodexTokens(account.totalTokens)))
            // 플랜·결제일 줄(AccountSubscriptionButton.refreshTitle이 그리는 제목).
            lines.append(accountSubscriptionLabel(subscriptionStore.details(provider: "codex", uuid: account.accountUuid,
                                                                            fallbackPlan: account.planType), now: now))
            let subscription = codexSubscriptionResolution(account: account, local: nil, now: now)
            lines.append(subscription.state == .unknown ? L10n.subCodexUnconfirmed
                : (subscriptionRowLine(subscription.shown, now: now) ?? subscription.state.label))
        }
        // Claude 탭 "API 크레딧" 묶음의 행 문구(TeamClaudeApiCredit.swift). 같은 응답의 계정별 credit 블록을 읽는다.
        for row in payload["accounts"] as? [[String: Any]] ?? [] {
            guard let credit = teamClaudeApiCredit(row["credit"]) else { continue }
            lines.append(teamClaudeApiCreditReason(credit, now: now))
            lines.append(teamClaudeApiCreditBarValue(credit))
            lines.append(teamClaudeApiCreditAmountText(credit))
            if let expiry = teamClaudeApiCreditExpiryText(credit, now: now) { lines.append(expiry) }
        }
        return lines.joined(separator: "\n")
    }

    static func loadJSON(_ url: URL) -> Any {
        guard let data = try? Data(contentsOf: url), let object = try? JSONSerialization.jsonObject(with: data) else {
            fatalError("읽기 실패: \(url.lastPathComponent)")
        }
        return object
    }

    static func main() {
        let testsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let repoRoot = testsDir.deletingLastPathComponent().deletingLastPathComponent()
        guard let fixture = loadJSON(testsDir.appendingPathComponent("Fixtures/status-consumer-sentinel.json")) as? [String: Any],
              let nowText = fixture["now"] as? String, let now = teamRuntimeDate(nowText),
              let fields = fixture["fields"] as? [String],
              let baseline = fixture["baseline"] as? [String: Any],
              let variants = fixture["variants"] as? [[String: Any]] else {
            fatalError("표식 fixture 형식 오류 — node --test test/status-consumer-map.test.js 로 확인")
        }
        let exemptions = (loadJSON(repoRoot.appendingPathComponent("test/status-consumer-exemptions.json")) as? [[String: Any]] ?? [])
            .map { Exemption(field: $0["field"] as? String ?? "", consumer: $0["consumer"] as? String ?? "",
                             reason: $0["reason"] as? String ?? "", expires: $0["expires"] as? String ?? "",
                             approvedBy: $0["approved_by"] as? String ?? "") }
            .filter { $0.consumer == "menubar" }

        var failures: [String] = []
        precondition(variants.compactMap { $0["field"] as? String } == fields, "fixture variants와 fields 목록이 다름")
        // 메뉴바가 바탕 응답을 실제로 읽는지 먼저 확인한다(빈 디코딩이면 모든 필드가 "누락"으로 보인다).
        precondition(render(baseline, now: now).contains("acct-codex"), "바탕 응답의 계정 행이 그려지지 않음")

        for variant in variants {
            let field = variant["field"] as! String
            let base = applyPatch(baseline, variant["basePatch"])
            let shown = render(base, now: now) != render(applyPatch(base, variant["patch"]), now: now)
            let exempt = exemptions.contains { $0.field == field }
            if !shown && !exempt {
                failures.append("\(field) 누락: menubar — 대신 menubar/Sources/TeamCodexPoolStatus.swift에 표시 지점을 추가하거나 exemptions에 사유·만료·승인 등록")
            }
            if shown && exempt { failures.append("\(field) 불필요한 예외: menubar가 이미 표시함 — exemptions에서 제거") }
        }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        let today = formatter.string(from: Date())
        for exemption in exemptions {
            if !fields.contains(exemption.field) { failures.append("\(exemption.field)/menubar: getStatus에 없는 필드의 예외") }
            if exemption.reason.isEmpty || exemption.approvedBy.isEmpty { failures.append("\(exemption.field)/menubar: reason·approved_by 없음") }
            if formatter.date(from: exemption.expires) == nil { failures.append("\(exemption.field)/menubar: expires는 YYYY-MM-DD") }
            else if exemption.expires < today { failures.append("\(exemption.field)/menubar: 예외 만료(\(exemption.expires))") }
        }

        UserDefaults().removePersistentDomain(forName: subscriptionSuite)

        if !failures.isEmpty {
            failures.forEach { print("✗ \($0)") }
            exit(1)
        }
        let pending = exemptions.filter { $0.approvedBy == "pending" }.count
        if pending > 0 { print("경고: 메뉴바 status 소비자 예외 \(pending)건 승인 대기(approved_by=pending)") }
        print("STATUS-CONSUMER-MAP: menubar \(fields.count) fields checked")
    }
}
