// menubar/Tests/LoginItemTests.swift
import Foundation

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

        print("LoginItemTests: ok")
    }
}
