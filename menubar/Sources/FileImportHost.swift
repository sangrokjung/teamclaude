import Cocoa
import UniformTypeIdentifiers

// 파일 넣기의 AppKit 쪽(동작 목록 → 파일 고르기 창, 메뉴바 아이콘 끌어다 놓기, 알림).
// 판단·실행은 FileImporters.swift가 맡고 여기서는 화면과 이어 주기만 한다.
// main.swift의 AppDelegate에 의존하므로 run-tests.sh의 라이브러리 묶음에서는 뺀다(EXCLUDE_SOURCES).

/// 다른 델리게이트 때문에 끌어다 놓기를 못 켰다는 로그를 한 번만 남기기 위한 표식.
private var fileDropDelegateWarned = false

extension AppDelegate {
    /// 넣기 설정이 바뀌면 동작 목록(⌘K)을 새로 만든다. 끌어다 놓기는 currentImporters를 그때그때 본다.
    func applyImporters(_ importers: [FileImporter]) {
        guard importers != currentImporters else { return }
        currentImporters = importers
        // 드래그 판단(fileDropVerdict)은 지우지 않는다. 세션의 처음 대상과 지금 첫 항목을 비교해 바뀌었으면 그 드래그를 거절한다.
        ensureFileDropTarget()
        for dashboard in [cachedDashboardView, openDashboardView].compactMap({ $0 }) {
            if let menu = statusItem?.menu { dashboard.actions = dashboardActions(menu: menu) }
        }
    }

    /// 메뉴를 닫고 파일 고르기 창을 띄운다. 메뉴 추적이 끝난 뒤에 열어야 창이 앞에 뜬다.
    func chooseFilesForImport(_ importer: FileImporter, menu: NSMenu?) {
        menu?.cancelTracking()
        DispatchQueue.main.async { [weak self] in
            NSApp.activate(ignoringOtherApps: true)
            let panel = NSOpenPanel()
            panel.title = importer.title
            panel.prompt = L10n.importPanelPrompt
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowsMultipleSelection = true
            panel.resolvesAliases = true
            if !importer.extensions.isEmpty {
                panel.allowedContentTypes = importer.extensions.compactMap { UTType(filenameExtension: $0) }
            }
            guard panel.runModal() == .OK, let self else { return }
            // 창을 열어 둔 사이 설정에서 이 항목이 빠졌으면 실행하지 않는다.
            guard self.currentImporters.contains(importer) else { return }
            self.runFileImport(importer, urls: panel.urls)
        }
    }

    /// 고른 파일·끌어다 놓은 파일을 넣기 명령에 넘긴다. 받아들였으면 true(이미 넣는 중이면 false).
    /// 파일 고르기·상한 검사·실행은 배경에서 하고 결과는 알림으로 보인다.
    @discardableResult
    func runFileImport(_ importer: FileImporter, urls: [URL]) -> Bool {
        let started = fileImportRunner.run(importer, urls: urls) { outcome in
            let note = fileImportNotification(title: importer.title, outcome: outcome)
            print("FILE-IMPORT: \(outcome)")
            fflush(stdout)
            postFileImportNotification(title: note.title, body: note.body)
        }
        postFileImportNotification(title: importer.title, body: started ? L10n.importStarted : L10n.importBusy)
        return started
    }

    /// 메뉴바 아이콘 창을 끌어다 놓기 대상으로 등록한다(창의 델리게이트로 받는다). 창이 바뀌면 이전 창 등록을 풀고
    /// 새 창에 건다. 다른 델리게이트가 이미 있으면 받을 수 없으므로 등록하지 않는다. 넣기 설정이 없으면 등록을 푼다.
    func ensureFileDropTarget() {
        let window = statusItem?.button?.window
        // 설정이 비었거나, 창이 바뀌었거나, 같은 창이라도 델리게이트가 이 앱이 아니게 됐으면 등록을 다시 본다.
        if currentImporters.isEmpty || window == nil || fileDropWindow !== window || fileDropWindow?.delegate !== self {
            if let previous = fileDropWindow {
                // 아직 이 앱이 받는 창일 때만 등록을 푼다. 다른 수신자가 델리게이트를 가져갔으면 그쪽 등록은 건드리지 않는다.
                if previous.delegate === self {
                    previous.unregisterDraggedTypes()
                    previous.delegate = nil
                }
                fileDropWindow = nil
            }
        }
        guard !currentImporters.isEmpty, let window, fileDropWindow !== window else { return }
        if window.delegate == nil { window.delegate = self }
        guard window.delegate === self else {
            if !fileDropDelegateWarned {  // 1초마다 다시 보므로 한 번만 적는다
                fileDropDelegateWarned = true
                print("FILE-IMPORT: 메뉴바 아이콘 창에 다른 델리게이트가 있어 끌어다 놓기를 켜지 않음")
                fflush(stdout)
            }
            return
        }
        window.registerForDraggedTypes([.fileURL])
        fileDropWindow = window
    }

    func droppedFileURLs(_ sender: NSDraggingInfo) -> [URL] {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        return (sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL]) ?? []
    }

    /// 드래그 세션마다 한 번만, 디스크를 보지 않고 확장자로만 판단한다. 넣는 중이면 바로 거절한다.
    func fileDropOperation(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard !fileImportRunner.isRunning else { return [] }
        let session = sender.draggingSequenceNumber
        let target = currentImporters.first
        if let verdict = fileDropVerdict, verdict.session == session {
            // 드래그 도중 받는 항목이 바뀌면 이 드래그는 받지 않는다(새로 끌어 오게 한다).
            return verdict.accept && verdict.target == target ? .copy : []
        }
        let accept = target.map { fileImportHasCandidate(droppedFileURLs(sender), importer: $0) } ?? false
        fileDropVerdict = (session, target, accept)
        return accept ? .copy : []
    }
}

/// 메뉴바 아이콘 창에 끌어다 놓은 파일을 받는다(ensureFileDropTarget이 창을 등록하고 이 델리게이트를 건다).
extension AppDelegate: NSWindowDelegate, NSDraggingDestination {
    func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        fileDropOperation(sender)
    }

    func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        fileDropOperation(sender)
    }

    func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let importer = currentImporters.first, fileDropOperation(sender) == .copy else { return false }
        return runFileImport(importer, urls: droppedFileURLs(sender))
    }
}
