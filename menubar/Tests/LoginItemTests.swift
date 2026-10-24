// menubar/Tests/LoginItemTests.swift
import Cocoa

// "로그인 시 열기"(외부 배포 R8) 회귀 검사. 사용자 LaunchAgent 파일만 만들고 지운다.
// 내부 설치(com.qjc.cc-menubar, install.py)는 건드리지 않는다. 실제 홈 대신 임시 폴더에서만 쓴다.
@main
struct LoginItemTests {
    static func main() {
        precondition(menubarLoginItemLabel == "dev.teamclaude.cc-menubar")
        precondition(menubarLoginItemLabel != "com.qjc.cc-menubar", "내부 설치 라벨과 겹치면 안 된다")

        // 앱 번들에서 실행될 때만 메뉴를 보인다. 내부 설치(번들 없는 단일 바이너리)는 자체 LaunchAgent가 있다.
        precondition(menubarLoginItemAvailable(bundlePath: "/Applications/CC Menubar.app"))
        precondition(!menubarLoginItemAvailable(bundlePath: "/opt/apps/cc-menubar"))
        precondition(!menubarLoginItemAvailable(bundlePath: ""))

        let exe = "/Applications/CC Menubar.app/Contents/MacOS/cc-menubar"
        let plist = menubarLoginItemPlist(executablePath: exe)
        precondition(plist["Label"] as? String == "dev.teamclaude.cc-menubar")
        precondition(plist["ProgramArguments"] as? [String] == [exe])
        precondition(plist["RunAtLoad"] as? Bool == true)
        // 사용자가 종료하면 다시 띄우지 않는다.
        precondition(plist["KeepAlive"] as? Bool == false)
        precondition(plist["LimitLoadToSessionType"] as? String == "Aqua")

        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("cc-menubar-login-item-\(getpid())").path
        try? FileManager.default.removeItem(atPath: home)
        defer { try? FileManager.default.removeItem(atPath: home) }
        let url = menubarLoginItemPlistURL(home: home)
        precondition(url.path == "\(home)/Library/LaunchAgents/dev.teamclaude.cc-menubar.plist", url.path)
        precondition(!menubarLoginItemIsEnabled(home: home))

        // 내부 설치 파일이 있어도 건드리지 않는다.
        let internalAgent = URL(fileURLWithPath: "\(home)/Library/LaunchAgents/com.qjc.cc-menubar.plist")
        try? FileManager.default.createDirectory(at: internalAgent.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: internalAgent.path, contents: Data("internal".utf8))

        do {
            try setMenubarLoginItem(enabled: true, executablePath: exe, home: home)
        } catch {
            preconditionFailure("등록 실패 \(error)")
        }
        precondition(menubarLoginItemIsEnabled(home: home))
        let written = (try? Data(contentsOf: url)).flatMap {
            try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [String: Any]
        }
        precondition(written?["ProgramArguments"] as? [String] == [exe])
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        precondition((attributes?[.posixPermissions] as? NSNumber)?.intValue == 0o644,
                     "LaunchAgent는 소유자만 쓸 수 있어야 한다")

        do {
            try setMenubarLoginItem(enabled: false, executablePath: exe, home: home)
            // 두 번 꺼도 오류가 아니다.
            try setMenubarLoginItem(enabled: false, executablePath: exe, home: home)
        } catch {
            preconditionFailure("해제 실패 \(error)")
        }
        precondition(!menubarLoginItemIsEnabled(home: home))
        precondition(FileManager.default.contents(atPath: internalAgent.path) == Data("internal".utf8))

        precondition(menubarLoginItemDetail(enabled: true) == "켜짐")
        precondition(menubarLoginItemDetail(enabled: false) == "꺼짐")

        // ⌘K 항목: 메뉴를 닫지 않고, 토글이 돌려준 상태 문구가 그 자리의 detail이 된다(Phase 2 리뷰 Minor).
        var toggled = false
        let action = menubarLoginItemAction(enabled: false) {
            toggled.toggle()
            return menubarLoginItemDetail(enabled: toggled)
        }
        precondition(action.id == "login-item" && !action.closesMenu, "결과를 그 자리에서 보여야 하므로 메뉴를 닫지 않는다")
        precondition(action.detail == "꺼짐")
        let list = DashboardActionListView(frame: NSRect(x: 0, y: 0, width: DashboardActionListView.width, height: 120))
        list.actions = [action]
        for expected in ["켜짐", "꺼짐"] {
            guard let detail = list.actions[0].run() else { preconditionFailure("토글 결과 문구를 버리면 detail이 낡는다") }
            precondition(detail == expected, detail)
            list.updateDetail(id: action.id, detail: detail)
            precondition(list.actions[0].detail == expected, "열린 목록의 detail이 \(expected)로 바뀌어야 한다")
        }

        print("LoginItemTests: ok")
    }
}
