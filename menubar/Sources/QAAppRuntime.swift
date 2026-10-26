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
        pendingOpen?(.success(()))
        pendingOpen = nil
    }

    func sendKey(_ key: String) -> Result<Void, Error> {
        guard let menu = delegate?.statusItem?.menu, menuIsOpen else {
            return .failure(QAExecutionError(description: "menu is not open"))
        }
        if key == "escape" {
            menu.cancelTracking()
            return .success(())
        }
        let command = key == "cmd+k"
        let characters = command ? "k" : key
        let modifiers: NSEvent.ModifierFlags = command ? [.command] : []
        let keyCode: UInt16 = characters == "r" ? 15 : (command ? 40 : UInt16(characters.utf8.first ?? 0))
        guard let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
                                           timestamp: 0, windowNumber: menu.window?.windowNumber ?? 0, context: nil,
                                           characters: characters, charactersIgnoringModifiers: characters,
                                           isARepeat: false, keyCode: keyCode), menu.performKeyEquivalent(with: event) else {
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
