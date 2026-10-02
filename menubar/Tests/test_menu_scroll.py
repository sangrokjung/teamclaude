from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "menubar" / "Sources" / "main.swift"


class MenuScrollRegressionTests(unittest.TestCase):
    def test_cached_dashboard_refresh_preserves_existing_scroll_offset(self):
        source = SOURCE.read_text()
        match = re.search(
            r"    func updateCachedMenuPresentation\(\) \{(?P<body>.*?)\n    \}\n\n    func menuWillOpen",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "cached dashboard presentation method must remain discoverable")
        body = match.group("body")
        self.assertIn(
            "let previousScrollOrigin = (dashboardItem.view as? NSScrollView)?.contentView.bounds.origin",
            body,
            "refresh must capture the user's existing dashboard scroll position",
        )
        self.assertIn(
            "hostDashboard(dashboard, in: dashboardItem, previousScrollOrigin: previousScrollOrigin)",
            body,
            "refresh must hand the captured position to the shared hosting helper",
        )
        host = re.search(
            r"    func hostDashboard\((?P<body>.*?)\n    \}\n",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(host, "the shared dashboard hosting helper must remain discoverable")
        self.assertIn(
            "scrollView.contentView.scroll(to: NSPoint(x: previousScrollOrigin.x",
            host.group("body"),
            "hosting must restore the captured position after replacing the document view",
        )
        for text in (body, host.group("body")):
            self.assertNotIn(
                "scrollView.contentView.scroll(to: .zero)",
                text,
                "periodic status refresh must not force the open menu back to the top",
            )

    def test_cached_menu_open_does_not_rebuild_dashboard_on_the_click(self):
        source = SOURCE.read_text()
        match = re.search(
            r"func menuWillOpen\(_ menu: NSMenu\) \{(?P<body>.*?)\n    func menuDidClose",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "menu open method must remain discoverable")
        cache_hit = match.group("body").split("menu.removeAllItems()", 1)[0]
        self.assertNotIn(
            "updateCachedMenuPresentation()",
            cache_hit,
            "an open menu must not rebuild the scroll view, even on a later turn",
        )

    def test_open_menu_refresh_does_not_replace_document_view(self):
        source = SOURCE.read_text()
        match = re.search(
            r"    func refreshOpenDashboard\((?:reason: String = \"direct\")?\) \{(?P<body>.*?)\n    \}\n\n    (?:///[^\n]*\n    )*(?:func|private|@objc|var|let) ",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "open dashboard refresh must remain discoverable")
        body = match.group("body")
        self.assertNotIn(
            "documentView",
            body,
            "a refresh while the menu is open must not reassign the scrolling document",
        )
        # 닫힌 메뉴 분기가 먼저 온다: 캐시 프레젠테이션 갱신 한 번 + return. 그 뒤가 열린 메뉴 경로이고,
        # 거기서는 문서 뷰를 다시 꽂거나 geometry를 다시 만들지 않는다.
        _, _, closed_and_open = body.partition("if openDashboardView == nil {")
        self.assertNotEqual(closed_and_open, "", "the closed-menu branch must remain discoverable")
        closed_branch, _, open_path = closed_and_open.partition("return")
        self.assertIn("updateCachedMenuPresentation()", closed_branch)
        self.assertNotEqual(open_path, "")
        self.assertNotIn("updateCachedMenuPresentation()", open_path, "the open menu must not rebuild geometry")
        self.assertNotIn("documentView", open_path)

    def test_team_account_list_is_part_of_the_single_page(self):
        # 계정 표는 더 이상 자기 스크롤 뷰를 갖지 않는다. 표의 스크롤 위치는 곧 페이지의 스크롤 위치이고,
        # 그것은 updateCachedMenuPresentation → hostDashboard가 보존한다.
        source = SOURCE.read_text()
        match = re.search(
            r"    func updateContent\((?P<body>.*?)\n    \}\n}\n\nfinal class UsageDashboardView",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "dashboard update method must remain discoverable")
        body = match.group("body")
        self.assertNotIn(
            "enclosingScrollView",
            body,
            "the account table has no inner scroll view to capture or restore",
        )
        dashboard_class = source.split("final class StatusMenuDashboardView", 1)[1].split("\nfinal class ", 1)[0]
        self.assertNotIn("NSScrollView(", dashboard_class, "the dashboard must be one continuous document")


if __name__ == "__main__":
    unittest.main()
