// menubar/Tests/L10nTests.swift
import Foundation

@main
struct L10nTests {
    static func containsHangul(_ value: String) -> Bool {
        value.unicodeScalars.contains { (0xAC00...0xD7A3).contains($0.value) || (0x3131...0x318E).contains($0.value) }
    }

    static func main() {
        // 언어 판정: 강제 env가 먼저, 그다음 시스템 선호 언어 첫 항목.
        precondition(AppLanguage.resolve(override: "en", preferred: ["ko-KR"]) == .en)
        precondition(AppLanguage.resolve(override: "ko", preferred: ["en-US"]) == .ko)
        precondition(AppLanguage.resolve(override: nil, preferred: ["ko-KR", "en-US"]) == .ko)
        precondition(AppLanguage.resolve(override: nil, preferred: ["ko"]) == .ko)
        precondition(AppLanguage.resolve(override: nil, preferred: ["en-KR", "ko-KR"]) == .en, "첫 항목만 본다")
        precondition(AppLanguage.resolve(override: nil, preferred: []) == .en)
        precondition(AppLanguage.resolve(override: "", preferred: ["ko-KR"]) == .ko, "빈 값은 무시")
        precondition(AppLanguage.resolve(override: "fr", preferred: ["ko-KR"]) == .ko, "모르는 값은 무시")
        precondition(AppLanguage.resolve(override: "EN", preferred: ["ko-KR"]) == .en, "대소문자 무시")

        // 영어 표: 한글 0자. 한국어 표: A안 문구.
        // 표 전체의 한글 0자 검사는 test_l10n_table.py가 소스에서 한다. 여기서는 대표 항목만 본다.
        L10n.language = .en
        for value in [L10n.tabOverview, L10n.tabClaude, L10n.tabBurn, L10n.routableNow, L10n.todoBadge(3),
                      L10n.refresh, L10n.actions, L10n.notInstalled, L10n.waitingCaption("a")] {
            precondition(!containsHangul(value) && !value.isEmpty, value)
        }
        precondition(L10n.tabOverview == "Overview")
        precondition(L10n.panelTitle == "TeamClaude Usage")

        L10n.language = .ko
        precondition(L10n.tabOverview == "개요")
        precondition(L10n.tabBurn == "소진")
        precondition(L10n.panelTitle == "TeamClaude 사용량")
        precondition(L10n.routableNow == "지금 라우팅 가능")
        precondition(L10n.todoBadge(3) == "손볼 것 3")
        precondition(L10n.refresh == "새로고침")
        precondition(L10n.actions == "동작")
        precondition(L10n.waitingCaption("acct-16").hasPrefix("기다리면 풀림 — acct-16"))
        precondition(L10n.notInstalled == "미설치")

        // 시간 길이: 큰 단위 두 개만.
        precondition(L10n.duration(seconds: 2 * 3600 + 13 * 60) == "2시간 13분")
        precondition(L10n.duration(seconds: 5 * 86400 + 22 * 3600 + 59) == "5일 22시간")
        precondition(L10n.duration(seconds: 40 * 60) == "40분")
        precondition(L10n.duration(seconds: 20) == "1분")
        L10n.language = .en
        precondition(L10n.duration(seconds: 2 * 3600 + 13 * 60) == "2h 13m")
        precondition(L10n.duration(seconds: 5 * 86400 + 22 * 3600) == "5d 22h")
        precondition(L10n.duration(seconds: 3 * 86400) == "3d")
        print("L10nTests passed")
    }
}
