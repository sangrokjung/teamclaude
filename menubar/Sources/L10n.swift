import Foundation

// 화면 문구 표(R5). 사용자에게 보이는 문구는 이 파일 한 곳에서 한국어·영어 쌍으로 관리한다.
// 시스템 선호 언어의 첫 항목이 ko로 시작하면 한국어, 아니면 영어다. CC_MENUBAR_LANG=ko|en이 이를 덮는다(시험용).
// 한국어는 A안 문구를 따르고, 영어는 짧은 UI 문구로 쓴다. 로그(print·fputs)는 이 표 밖이다.
// 문구를 더할 때는 t("한국어", "English") 한 쌍으로 쓴다. test_l10n_table.py가 영어 쪽에 한글이 없는지 본다.

enum AppLanguage: Equatable {
    case ko, en

    static func resolve(override: String?, preferred: [String]) -> AppLanguage {
        switch override?.trimmingCharacters(in: .whitespaces).lowercased() {
        case "ko": return .ko
        case "en": return .en
        default: break
        }
        return preferred.first?.lowercased().hasPrefix("ko") == true ? .ko : .en
    }

    static var current: AppLanguage {
        resolve(override: ProcessInfo.processInfo.environment["CC_MENUBAR_LANG"], preferred: Locale.preferredLanguages)
    }
}

enum L10n {
    /// 프로세스 수명 동안 한 번 정한다. 테스트만 바꾼다.
    static var language: AppLanguage = .current

    static func t(_ ko: String, _ en: String) -> String { language == .ko ? ko : en }

    // MARK: 시간·수

    /// "2시간 13분", "5일 22시간", "40분" — 큰 단위 두 개만. 1분 미만은 1분으로 올린다.
    static func duration(seconds: Int) -> String {
        let minutes = max(1, seconds / 60)
        let days = minutes / 1440
        let hours = (minutes % 1440) / 60
        let mins = minutes % 60
        if days > 0 {
            return hours > 0 ? t("\(days)일 \(hours)시간", "\(days)d \(hours)h") : t("\(days)일", "\(days)d")
        }
        if hours > 0 {
            return mins > 0 ? t("\(hours)시간 \(mins)분", "\(hours)h \(mins)m") : t("\(hours)시간", "\(hours)h")
        }
        return t("\(mins)분", "\(mins)m")
    }

    // MARK: 패널 셸

    static var panelTitle: String { t("TeamClaude 사용량", "TeamClaude Usage") }
    static func asOf(_ stamp: String) -> String { t("\(stamp) 기준", "as of \(stamp)") }
    static func todoBadge(_ count: Int) -> String { t("손볼 것 \(count)", "To fix \(count)") }
    static var tabOverview: String { t("개요", "Overview") }
    static var tabClaude: String { "Claude" }
    static var tabCodex: String { "Codex" }
    static var tabBurn: String { t("소진", "Burn") }
    static var tabCli: String { "CLI" }
    static var refresh: String { t("새로고침", "Refresh") }
    static var actions: String { t("동작", "Actions") }

    // MARK: 개요

    static var routableNow: String { t("지금 라우팅 가능", "Routable now") }
    static var waitingReturns: String { t("기다리면 풀림", "Clears on its own") }

    // MARK: 빈 값 어휘

    static var notInstalled: String { t("미설치", "Not installed") }
}
