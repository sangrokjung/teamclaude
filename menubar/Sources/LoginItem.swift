import Foundation

// "로그인 시 열기"(외부 배포 R8). 사용자 LaunchAgent(~/Library/LaunchAgents/dev.teamclaude.cc-menubar.plist)
// 파일을 만들거나 지운다. 다음 로그인부터 launchd가 읽는다. 지금 실행 중인 앱은 건드리지 않는다.
// 내부 설치(com.qjc.cc-menubar, install.py가 관리)와 라벨·파일이 겹치지 않는다.

let menubarLoginItemLabel = "dev.teamclaude.cc-menubar"

/// `.app` 번들에서 실행될 때만(외부 배포본) 메뉴를 보인다. 내부 설치는 번들 없는 단일 바이너리라 자체 LaunchAgent를 쓴다.
func menubarLoginItemAvailable(bundlePath: String) -> Bool {
    bundlePath.hasSuffix(".app")
}

func menubarLoginItemPlistURL(home: String) -> URL {
    URL(fileURLWithPath: home)
        .appendingPathComponent("Library/LaunchAgents/\(menubarLoginItemLabel).plist")
}

func menubarLoginItemPlist(executablePath: String) -> [String: Any] {
    [
        "Label": menubarLoginItemLabel,
        "ProgramArguments": [executablePath],
        "RunAtLoad": true,
        // 사용자가 메뉴에서 종료하면 다시 띄우지 않는다.
        "KeepAlive": false,
        "LimitLoadToSessionType": "Aqua",
        "ProcessType": "Interactive",
    ]
}

func menubarLoginItemIsEnabled(home: String) -> Bool {
    FileManager.default.fileExists(atPath: menubarLoginItemPlistURL(home: home).path)
}

func setMenubarLoginItem(enabled: Bool, executablePath: String, home: String) throws {
    let url = menubarLoginItemPlistURL(home: home)
    guard enabled else {
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        return
    }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try PropertyListSerialization.data(
        fromPropertyList: menubarLoginItemPlist(executablePath: executablePath), format: .xml, options: 0)
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
}

func menubarLoginItemDetail(enabled: Bool) -> String {
    enabled ? "켜짐" : "꺼짐"
}
