import Foundation

// 패널에서 한 번 눌러 여는 외부 링크(예: AI 비용 대시보드). 주소는 공개 저장소에 박지 않고
// ~/.config/cc-menubar/links.json에서 읽는다: {"links":[{"title":"AI 비용 대시보드","url":"http://…"}]}
// 파일이 없거나 깨졌거나 url이 http·https가 아니면 그 항목(전부 틀리면 버튼)을 숨긴다.

struct DashboardLink: Equatable {
    let title: String
    let url: URL
}

enum DashboardLinks {
    static let maxLinks = 5
    static let maxTitleLength = 24

    static func defaultPath(home: String = NSHomeDirectory()) -> String {
        (home as NSString).appendingPathComponent(".config/cc-menubar/links.json")
    }

    static func load(path: String = defaultPath()) -> [DashboardLink] {
        guard let data = FileManager.default.contents(atPath: path) else { return [] }
        return parse(data)
    }

    static func parse(_ data: Data) -> [DashboardLink] {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let items = root["links"] as? [Any] else { return [] }
        return Array(items.compactMap(link).prefix(maxLinks))
    }

    private static func link(_ raw: Any) -> DashboardLink? {
        guard let row = raw as? [String: Any],
              let rawTitle = row["title"] as? String,
              let rawURL = row["url"] as? String else { return nil }
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty,
              let components = URLComponents(string: rawURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty,
              let url = components.url else { return nil }
        let shown = title.count > maxTitleLength ? String(title.prefix(maxTitleLength - 1)) + "…" : title
        return DashboardLink(title: shown, url: url)
    }
}

/// 하단 동작 목록(앱 묶음)에 넣을 링크 항목. 실행하면 메뉴를 닫는다(closesMenu 기본값).
/// open은 호스트가 NSWorkspace.shared.open과 메뉴 닫기를 묶어 넘긴다.
func dashboardLinkActions(_ links: [DashboardLink], open: @escaping (URL) -> Void) -> [DashboardAction] {
    links.enumerated().map { index, link in
        DashboardAction(id: "link-\(index)", group: .app, title: link.title, detail: L10n.linkActionDetail) {
            open(link.url)
            return nil
        }
    }
}
