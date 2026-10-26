import Cocoa

final class QAAppRuntime: QAExecutionRuntime {
    weak var delegate: AppDelegate?
    private var pendingOpen: ((Result<Void, Error>) -> Void)?

    init(delegate: AppDelegate) { self.delegate = delegate }

    var menuIsOpen: Bool { delegate?.openDashboardView != nil }

    func requestOpenMenu(_ completion: @escaping (Result<Void, Error>) -> Void) {
        guard let delegate, let button = delegate.statusItem?.button else {
            completion(.failure(QAExecutionError(description: "status item is unavailable")))
            return
        }
        if menuIsOpen { completion(.success(())); return }
        pendingOpen = completion
        let timer = Timer(timeInterval: 0.01, repeats: false) { [weak button] _ in
            button?.performClick(nil)
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    func menuDidOpen() {
        guard let completion = pendingOpen else { return }
        pendingOpen = nil
        let timer = Timer(timeInterval: 0, repeats: false) { _ in
            completion(.success(()))
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    func sendKey(_ key: String) -> Result<Void, Error> {
        guard let menu = delegate?.statusItem?.menu, menuIsOpen else {
            return .failure(QAExecutionError(description: "menu is not open"))
        }
        let command = key == "cmd+k"
        let characters: String
        switch key {
        case "cmd+k": characters = "k"
        case "escape": characters = "\u{1b}"
        default: characters = key
        }
        let keyCode: UInt16
        switch key {
        case "1": keyCode = 18
        case "2": keyCode = 19
        case "3": keyCode = 20
        case "4": keyCode = 21
        case "5": keyCode = 23
        case "r": keyCode = 15
        case "cmd+k": keyCode = 40
        case "escape": keyCode = 53
        default:
            return .failure(QAExecutionError(description: "unsupported key: \(key)"))
        }
        let modifiers: NSEvent.ModifierFlags = command ? [.command] : []
        guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
                                           timestamp: 0, windowNumber: delegate?.openDashboardView?.window?.windowNumber ?? 0, context: nil,
                                           characters: characters, charactersIgnoringModifiers: characters,
                                           isARepeat: false, keyCode: keyCode) else {
            return .failure(QAExecutionError(description: "unsupported key: \(key)"))
        }
        if key == "escape" {
            // 메뉴가 열린 동안 Esc는 macOS 메뉴 추적 루프가 받아 메뉴를 닫는다(앱에 따로 처리하는 곳이 없다).
            // 창에 합성 이벤트를 보내면 그 루프를 지나지 않아 아무 일도 없었다(2026-10-26 실측) — 같은 결과인 닫기로 보낸다.
            _ = event
            menu.cancelTracking()
            return .success(())
        }
        guard menu.performKeyEquivalent(with: event) else {
            return .failure(QAExecutionError(description: "unsupported key: \(key)"))
        }
        return .success(())
    }

    func captureView() -> Result<Data, Error> {
        guard let view = delegate?.openDashboardView else {
            return .failure(QAExecutionError(description: "dashboard view is not open"))
        }
        guard view.bounds.width > 0, view.bounds.height > 0,
              let representation = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            return .failure(QAExecutionError(description: "dashboard view has no drawable bounds"))
        }
        view.cacheDisplay(in: view.bounds, to: representation)
        guard let data = representation.representation(using: .png, properties: [:]) else {
            return .failure(QAExecutionError(description: "PNG encoding failed"))
        }
        return .success(data)
    }

    func closeMenu() -> Result<Void, Error> {
        guard let menu = delegate?.statusItem?.menu else {
            return .failure(QAExecutionError(description: "menu is unavailable"))
        }
        menu.cancelTracking()
        return .success(())
    }

    func stateSnapshot() -> Result<QAStateSnapshot, Error> {
        guard let delegate, let dashboard = delegate.openDashboardView ?? delegate.cachedDashboardView else {
            return .failure(QAExecutionError(description: "dashboard view is not open"))
        }
        return .success(dashboard.qaSnapshot(statusTitle: delegate.statusItem?.button?.title ?? "",
                                             menuOpen: menuIsOpen, teamCodex: delegate.currentTeamCodex))
    }
}
