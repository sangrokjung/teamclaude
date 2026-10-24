// menubar/Tests/CodexPoolRowLayoutTests.swift
import Cocoa
import ObjectiveC

// Codex 풀 행의 구독 버튼이 같은 행의 보조 줄(동시·요청·리셋권·토큰, 상태 안내)을 덮지 않는지 본다
// (Phase 2 독립 리뷰 Important). 실제 CodexStatusView를 화면 밖에서 그리고, draw()가 그린 글자의 사각형을
// NSString 그리기 메서드에서 그대로 받아 버튼 프레임과 맞대 본다. 상수로 다시 계산하지 않는다.
// CodexStatusView가 main.swift 타입에 의존해 러너가 직접 못 돌린다 — test_codex_pool_row_layout.py가
// main.swift 진입점 앞부분을 잘라 붙여 컴파일하고, 격리 HOME에서 실행한다.

private struct DrawnText {
    let string: String
    let rect: NSRect
}

private enum RowTextRecorder {
    static var recording = false
    static var texts: [DrawnText] = []

    static func install() {
        guard let a = class_getInstanceMethod(NSString.self, #selector(NSString.draw(at:withAttributes:))),
              let b = class_getInstanceMethod(NSString.self, #selector(NSString.cc_rowLayoutDraw(at:withAttributes:))) else {
            preconditionFailure("NSString.draw(at:withAttributes:) swizzle failed")
        }
        method_exchangeImplementations(a, b)
    }
}

extension NSString {
    @objc func cc_rowLayoutDraw(at point: NSPoint, withAttributes attrs: [NSAttributedString.Key: Any]?) {
        if RowTextRecorder.recording {
            let size = size(withAttributes: attrs)
            let value = (self as String).trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty {
                RowTextRecorder.texts.append(DrawnText(string: value, rect: NSRect(origin: point, size: size)))
            }
        }
        cc_rowLayoutDraw(at: point, withAttributes: attrs)
    }
}

@main
struct CodexPoolRowLayoutTests {
    static func main() throws {
        _ = NSApplication.shared
        L10n.language = .ko
        // 구독 버튼은 ~/.config 아래 설정을 읽는다. 실제 계정 설정을 건드리지 않도록 격리 HOME에서만 돈다.
        guard NSHomeDirectory().contains("cc-codex-row-layout-") else {
            FileHandle.standardError.write("Refusing to run outside the isolated HOME (cc-codex-row-layout-*)\n".data(using: .utf8)!)
            exit(2)
        }
        RowTextRecorder.install()
        let now = Date()
        func account(_ index: Int, uuid: String?, enabled: Bool = true, status: String = "active", errorReason: String? = nil,
                     subscriptionState: String? = nil, subscriptionEndsAt: Date? = nil, session: Double = 23, weekly: Double = 45) -> TeamCodexPoolAccount {
            var row = TeamCodexPoolAccount(
                name: "행 배치 계정 \(index + 1)", accountUuid: uuid, isCurrent: index == 0, enabled: enabled,
                status: status, errorReason: errorReason, usableFromProxy: enabled && errorReason == nil,
                sessionPercent: session, sessionResetAt: now.addingTimeInterval(3_600), weeklyPercent: weekly,
                weeklyResetAt: now.addingTimeInterval(86_400 * 3), inflight: 2, maxConcurrent: 3,
                totalRequests: 123_456, totalTokens: 98_765_432, planType: "pro", accountType: "oauth", providerName: "codex",
                codexResetCredits: 3, codexResetCreditsAt: now)
            row.subscriptionState = subscriptionState
            row.subscriptionEndsAt = subscriptionEndsAt
            return row
        }
        let run = UUID().uuidString
        let rows = [
            account(0, uuid: "row-layout-\(run)-0"),
            // 꺼 둔 계정: 노트("직접 껐다") + 다시 켜기 버튼 + 후속 안내.
            account(1, uuid: "row-layout-\(run)-1", enabled: false, status: "error", errorReason: "auth-revoked"),
            // 인증 끊김: 재인증 버튼.
            account(2, uuid: "row-layout-\(run)-2", status: "error", errorReason: "auth-revoked"),
            // 해지 예약: 노트 + 남은 시간.
            account(3, uuid: "row-layout-\(run)-3", subscriptionState: "cancellation-scheduled",
                    subscriptionEndsAt: now.addingTimeInterval(86_400 * 5), session: 99, weekly: 99),
            // uuid가 없는 계정도 버튼(비활성)이 같은 자리에 선다.
            account(4, uuid: nil),
        ]
        let pool = TeamCodexPoolHealth(checkedAt: now, serverReachable: true, serverPort: 3457, serverPid: nil,
                                       currentAccount: rows[0].name, currentAccountUuid: rows[0].accountUuid,
                                       switchThresholdPercent: 98, accounts: rows,
                                       resetCreditsEnabled: true, resetCreditsPolicy: "account")
        let notes = rows.map { teamCodexAccountNote($0, switchThresholdPercent: 98, now: now) }
        precondition(notes[1] != nil && notes[3] != nil, "fixture must exercise the notes line")
        let recoveries = rows.map { teamCodexAccountRecovery($0, now: now) }
        precondition(recoveries[1]?.kind == .enable && recoveries[2]?.kind == .reauth, "fixture must exercise both recovery kinds")

        let width = StatusMenuDashboardView.preferredWidth
        let height = CodexStatusView.preferredHeight(for: pool)
        let view = CodexStatusView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        view.appearance = NSAppearance(named: .darkAqua)
        view.pool = pool
        view.layoutSubtreeIfNeeded()

        // 화면 밖 비트맵에 실제 draw()를 돌리며 그린 글자의 사각형을 모은다(자식 버튼의 제목은 섞이지 않는다).
        let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
        let context = NSGraphicsContext(bitmapImageRep: bitmap)!
        let flipped = NSGraphicsContext(cgContext: context.cgContext, flipped: true)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = flipped
        let transform = NSAffineTransform()
        transform.translateX(by: 0, yBy: view.bounds.height)
        transform.scaleX(by: 1, yBy: -1)
        transform.concat()
        RowTextRecorder.recording = true
        view.draw(view.bounds)
        RowTextRecorder.recording = false
        NSGraphicsContext.restoreGraphicsState()
        let drawn = RowTextRecorder.texts
        precondition(!drawn.isEmpty, "draw() recorded no text")

        // 총높이: 풀 블록 = 머리 + 행 수 × 행 높이, 패널 = 사용량 블록 + 풀 블록 + 간격.
        let section = CodexStatusView.poolSectionHeight(for: pool)
        precondition(section == CodexStatusView.poolHeaderHeight + CGFloat(rows.count) * CodexStatusView.poolRowHeight,
                     "poolSectionHeight \(section) must be header + rows × poolRowHeight")
        precondition(height == CodexStatusView.baseHeight + section + 16, "preferredHeight must include the pool section")
        let layout = codexStatusLayout(topY: 4, poolHeight: Double(section), hasPool: true, localUsageLoaded: false)
        let poolY = CGFloat(layout.poolY)
        precondition(CGFloat(layout.metricsY) >= poolY + section, "local usage block must start below the pool section")

        let subscriptions = view.subviews.compactMap { $0 as? AccountSubscriptionButton }
        let recoveryButtons = view.subviews.compactMap { $0 as? PanelButton }
        precondition(subscriptions.count == rows.count, "one subscription entry per account")
        precondition(recoveryButtons.count == recoveries.compactMap { $0 }.count, "one recovery button per recoverable account")

        var rowsWithNotes = 0
        var failures: [String] = []
        for (index, button) in subscriptions.enumerated() {
            let rowTop = poolY + CodexStatusView.poolHeaderHeight + CGFloat(index) * CodexStatusView.poolRowHeight
            let rowBand = NSRect(x: 0, y: rowTop, width: width, height: CodexStatusView.poolRowHeight)
            if !(button.frame.minY >= rowBand.minY && button.frame.maxY <= rowBand.maxY) {
                failures.append("row \(index): subscription \(button.frame) outside row band \(rowBand)")
            }
            if !view.bounds.contains(button.frame) { failures.append("row \(index): subscription outside view bounds") }
            if !(button.attributedTitle.size().width < button.frame.width) { failures.append("row \(index): subscription title clipped") }
            let rowTexts = drawn.filter { $0.rect.intersects(rowBand) }
            if let note = notes[index] {
                let shown = rowTexts.contains { $0.string.hasPrefix(String(note.prefix(4))) }
                if !shown { failures.append("row \(index): notes line was not drawn") } else { rowsWithNotes += 1 }
            }
            for text in rowTexts where button.frame.intersects(text.rect) {
                failures.append("row \(index): subscription \(button.frame) covers drawn text \"\(text.string)\" \(text.rect)")
            }
            for other in view.subviews.compactMap({ $0 as? NSButton }) where other !== button && button.frame.intersects(other.frame) {
                failures.append("row \(index): subscription overlaps another button \(other.frame)")
            }
        }
        // 되돌리기 버튼은 이름 줄 오른쪽, 그 행 안에 앉고 막대·보조 줄 글자를 덮지 않는다.
        let recoverIndices = recoveries.enumerated().compactMap { $0.element == nil ? nil : $0.offset }
        for (button, index) in zip(recoveryButtons, recoverIndices) {
            let rowTop = poolY + CodexStatusView.poolHeaderHeight + CGFloat(index) * CodexStatusView.poolRowHeight
            let rowBand = NSRect(x: 0, y: rowTop, width: width, height: CodexStatusView.poolRowHeight)
            if !(button.frame.minY >= rowBand.minY && button.frame.maxY <= rowBand.maxY) {
                failures.append("row \(index): recovery \(button.frame) outside row band \(rowBand)")
            }
            if abs(button.frame.maxX - (view.bounds.width - CodexStatusView.padding)) > 0.5 {
                failures.append("row \(index): recovery button must be right-aligned to the pool edge")
            }
            for text in drawn.filter({ $0.rect.intersects(rowBand) }) where button.frame.intersects(text.rect) {
                failures.append("row \(index): recovery \(button.frame) covers drawn text \"\(text.string)\" \(text.rect)")
            }
        }
        if rowsWithNotes != 2 { failures.append("expected 2 rows with a notes line, saw \(rowsWithNotes)") }

        if let index = CommandLine.arguments.firstIndex(of: "--screenshot"), index + 1 < CommandLine.arguments.count {
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[index + 1]))
        }
        guard failures.isEmpty else {
            failures.forEach { print("FAIL \($0)") }
            exit(1)
        }
        print("CODEX-ROW-LAYOUT: subscription band below facts/notes, recovery placement and section height passed (\(rows.count) rows)")
    }
}
