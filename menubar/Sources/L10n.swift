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
    static var footerBurn: String { t("목표 사용률 100%", "Target utilization 100%") }
    static var footerCli: String { "Grok · agy · Higgsfield" }
    static func footerOverview(todo: Int, waiting: Int) -> String { t("손볼 것 \(todo) · 대기 \(waiting)", "To fix \(todo) · Waiting \(waiting)") }

    // MARK: 동작 목록

    static var actionGroupRefresh: String { t("갱신", "Refresh") }
    static var actionGroupAccount: String { t("계정", "Accounts") }
    static var actionGroupApp: String { t("앱", "App") }
    static var actionMeasure: String { t("TeamClaude 계정 측정", "Measure TeamClaude accounts") }
    static var actionImport: String { t("Claude Code 계정 가져오기", "Import Claude Code account") }
    static var actionImportDetail: String { t("현재 로그인", "Current login") }
    static var actionClaudeOAuth: String { t("Claude OAuth 계정 추가", "Add Claude OAuth account") }
    static var actionCodexOAuth: String { t("Codex OAuth 계정 추가", "Add Codex OAuth account") }
    static var actionWebLoginDetail: String { t("브라우저", "Web sign-in") }
    static var actionRestart: String { t("TeamClaude 서버 재시작", "Restart TeamClaude server") }
    static var actionRestartDetail: String { t("요청 끊김 · 확인 후", "Drops requests · asks first") }
    static var actionLoginItem: String { t("로그인 시 열기", "Open at login") }
    static var actionQuit: String { t("종료", "Quit") }

    // MARK: 섹션

    static var sectionClaude: String { t("Claude 풀", "Claude pool") }
    static var sectionCodex: String { t("Codex 풀", "Codex pool") }
    static var sectionBurn: String { t("구독·소진", "Subscriptions & burn") }
    static var sectionUsage: String { t("사용량", "Usage") }
    static var sectionCli: String { t("CLI 쿼터", "CLI quotas") }
    static var sectionVocabulary: String { t("값이 없을 때 쓰는 말", "Words for missing values") }
    static func claudeSectionSummary(accounts: Int, usable: Int) -> String {
        t("계정 \(accounts) · 사용 가능 \(usable)", "\(accounts) accounts · \(usable) available")
    }
    static func codexSectionSummary(status: String, usable: Int, pool: Int) -> String {
        t("\(status) · 사용 가능 \(usable)/\(pool)", "\(status) · \(usable)/\(pool) available")
    }
    static func usageSectionSummary(today: String, total: String) -> String { t("오늘 \(today) · 총 \(total)", "Today \(today) · total \(total)") }

    // MARK: 개요(A안 문구)

    static func overviewHeadline(_ count: Int) -> String {
        t("Claude 계정 \(count)개가 지금 요청을 받습니다.", "\(count) Claude accounts are taking requests now.")
    }
    static func sessionWindowIn(_ duration: String) -> String { t("세션 창 \(duration) 뒤", "session window in \(duration)") }
    static func weeklyWindowIn(_ duration: String) -> String { t("주간 창 \(duration) 뒤", "weekly window in \(duration)") }
    static func resetsAfter(_ parts: String) -> String { t("\(parts) 리셋", "Resets: \(parts)") }
    static var fableLaneNote: String { t("Fable 주간까지 여유", "Room left on Fable weekly") }
    static var codexLaneNote: String { t("지금 배정 가능", "Assignable now") }
    static var usageRate: String { t("사용률", "Used") }
    static func agyLaneNote(_ name: String) -> String { t("\(name) 주간", "\(name) weekly") }
    static var waitingForValue: String { t("값을 기다리는 중", "Waiting for a value") }
    static var stripTitle: String { t("Claude 풀 · 주간 사용률", "Claude pool · weekly usage") }
    static func legendReady(_ count: Int) -> String { t("사용 가능 \(count)", "Available \(count)") }
    static func legendWait(_ count: Int) -> String { t("대기 \(count)", "Waiting \(count)") }
    static func legendExcluded(_ count: Int) -> String { t("제외 \(count)", "Excluded \(count)") }
    static func weekElapsedCaption(_ percent: Int) -> String {
        t("주간 창 \(percent)% 경과 — 선보다 높은 칸은 리셋 전에 찰 속도입니다.",
          "Weekly window \(percent)% elapsed — bars above the line will fill before reset.")
    }
    static var todoAside: String { t("사람이 움직여야 풀리는 계정", "Accounts that need a person") }
    static func waitingCaption(_ names: String) -> String {
        t("기다리면 풀림 — \(names) · 리셋되면 돌아옵니다.", "Clears on its own — \(names) · back after reset.")
    }
    static var burnPreviewTitle: String { t("주간 소진 전망", "Weekly burn outlook") }
    static var burnDetailsLink: String { t("구독·소진에서 자세히 ↗", "Details in Burn ↗") }
    static var lowConfidence: String { t("신뢰 낮음", "Low confidence") }
    static var todoReasonReauth: String { t("재인증하면 돌아옴", "Back after re-authentication") }
    static var todoReasonOrgBlocked: String { t("조직이 구독을 막아 둠 · 재인증으로 풀리지 않음", "Blocked by the org · re-auth won't fix it") }
    static var todoReasonDisabled: String { t("직접 꺼 둔 계정 · 라우팅 제외", "Turned off by you · not routed") }
    static var reauthenticate: String { t("재인증", "Re-auth") }
    static var checkSubscription: String { t("구독 확인", "Check plan") }
    static var serverOffline: String { t("서버 오프라인", "Server offline") }
    static var serverDelayed: String { t("서버 응답 지연", "Server slow to respond") }

    // MARK: 계정 상태

    static var stateReady: String { t("사용 가능", "Available") }
    static var stateInUse: String { t("사용 중", "In use") }
    static var stateLimited: String { t("한도 대기", "At limit") }
    static var stateCheck: String { t("확인 필요", "Needs check") }
    static var stateDisabled: String { t("꺼 둠", "Off") }
    static var stateExcluded: String { t("제외", "Excluded") }
    static var stateEnded: String { t("구독 종료", "Plan ended") }

    // MARK: Claude 표

    static func claudeTableAccessibility(ready: Int, total: Int, usable: Int, drift: Int, pending: Int, unavailable: Int,
                                         limited: Int, fableOver: Int, status: String) -> String {
        t("TeamClaude, Fable 사용 가능 \(ready)/\(total), 라우팅 가능 \(usable), 계정 연동 불일치 \(drift), 측정 필요 \(pending), 상태 확인 \(unavailable), 사용 한도 \(limited), Fable 경고 \(fableOver), 상태 \(status)",
          "TeamClaude, Fable available \(ready)/\(total), routable \(usable), config drift \(drift), measurement needed \(pending), status check \(unavailable), at limit \(limited), Fable warnings \(fableOver), status \(status)")
    }
    static var measureReturnHelp: String { t("Return 키를 누르면 미측정 계정을 지금 측정합니다.", "Press Return to measure unmeasured accounts now.") }
    static func reauthNeededLabel(_ name: String) -> String { t("재인증 필요: \(name)", "Re-auth needed: \(name)") }
    static var reauthHelp: String { t("이 계정으로 Claude OAuth를 다시 인증합니다.", "Re-authenticates Claude OAuth for this account.") }
    static func reauthToolTip(_ name: String) -> String { t("\(name) 계정 재인증", "Re-authenticate \(name)") }
    static var measureNow: String { t("지금 측정", "Measure now") }
    static var measure: String { t("측정", "Measure") }
    static var subscriptionRecord: String { t("구독 기록", "Plan record") }
    static var integrationOK: String { t("연동 정상", "Config in sync") }
    static func integrationDrift(_ count: Int) -> String { t("연동 불일치 \(count)", "Config drift \(count)") }
    static var measuringTitle: String { t("계정 사용량 측정 중", "Measuring account usage") }
    static var pleaseWait: String { t("잠시만 기다려 주세요", "One moment") }
    static func driftTitle(_ count: Int) -> String { t("\(count)개 계정 연동 불일치", "\(count) accounts out of sync") }
    static func measurePendingTitle(_ count: Int) -> String { t("\(count)개 계정 측정 필요", "\(count) accounts need measuring") }
    /// 측정 결과 문구가 실패를 말하는지. 실패면 "클릭하여 지금 측정" 대신 그 문구를 그대로 보인다.
    static func isFailureDetail(_ detail: String) -> Bool {
        detail.contains("실패") || detail.contains("확인 필요") || detail.lowercased().contains("fail") || detail.lowercased().contains("check")
    }
    static var clickToMeasure: String { t("클릭하여 지금 측정", "Click to measure now") }
    static func checkNeededTitle(_ count: Int) -> String { t("\(count)개 계정 확인 필요", "\(count) accounts need a check") }
    static var checkNeededDetail: String { t("최신 한도와 구독 종료일을 확인하세요", "Check the latest limits and plan end dates") }
    static func excludedTitle(_ count: Int) -> String { t("\(count)개 계정 이용 제외", "\(count) accounts excluded") }
    static var excludedDetail: String { t("아래에서 구독·인증·비활성 상태 확인", "Check plan, auth and disabled state below") }
    static func limitedTitle(_ count: Int) -> String { t("\(count)개 계정 한도·요청 대기", "\(count) accounts waiting on limits") }
    static var limitedDetail: String { t("세션·전체 주간·Fable 모두 여유가 필요합니다", "Session, weekly and Fable all need headroom") }
    static func fableReadyTitle(_ count: Int) -> String { t("\(count)개 계정 Fable 사용 가능", "\(count) accounts ready for Fable") }
    static var noAccounts: String { t("등록된 계정이 없습니다", "No accounts registered") }
    static var allWindowsDetail: String { t("세션·전체 주간·Fable 한도를 함께 확인", "Session, weekly and Fable limits checked together") }
    static func accountsCount(_ count: Int) -> String { t("계정 \(count)", "Accounts \(count)") }
    static var columnSession: String { t("세션 5시간", "Session 5h") }
    static var columnWeekly: String { t("주간", "Weekly") }
    static var columnFable: String { t("Fable 주간", "Fable weekly") }
    static var columnStatus: String { t("상태", "Status") }
    static func resetIn(_ duration: String) -> String { t("리셋 \(duration)", "resets \(duration)") }
    static var groupReady: String { t("사용 가능", "Available") }
    static var groupReadyNote: String { t("라우팅 중", "Routing") }
    static var groupLimited: String { t("한도 대기", "At limit") }
    static var groupLimitedNote: String { t("리셋되면 돌아옴", "Back after reset") }
    static var groupCheck: String { t("확인 필요", "Needs check") }
    static var groupCheckNote: String { t("측정·상태를 확인하면 돌아옴", "Back after a measure or check") }
    static var groupExcluded: String { t("제외", "Excluded") }
    static var groupExcludedNote: String { t("사람이 손봐야 돌아옴", "Needs a person") }
    static var quotaReset: String { t("한도리셋", "Limit reset") }
    static var remeasure: String { t("재측정", "Re-measure") }
    static var sessionShort: String { t("세션", "Session") }
    static var weeklyShort: String { t("주간", "Weekly") }
    static var factSubscription: String { t("구독", "Plan") }
    static var factConcurrent: String { t("동시 요청", "Concurrent") }
    static var factRequests: String { t("누적 요청", "Requests") }
    static var factLastProbe: String { t("마지막 측정", "Last measured") }
    static func requestCount(_ count: Int) -> String { t("\(count)회", "\(count)") }
    static func resetsLine(_ value: String) -> String { t("리셋 · \(value)", "Resets · \(value)") }
    static var legendElapsedTick: String { t("창 경과 눈금", "Window elapsed tick") }
    static func legendThreshold(_ percent: String) -> String { t("\(percent)%부터 라우팅 대기", "Routing pauses at \(percent)%") }
    static var legendRowClick: String { t("행을 누르면 구독·동시 요청", "Click a row for plan and concurrency") }

    // MARK: 사용량(ccusage)

    static func usageAccessibility(today: String, week: String, month: String) -> String {
        t("사용량 대시보드, 오늘 \(today), 이번 주 \(week), 이번 달 \(month)", "Usage, today \(today), this week \(week), this month \(month)")
    }
    static var usageActive: String { t("작업 중", "Working") }
    static var usageIdle: String { t("대기", "Idle") }
    static func parallelSessions(_ count: Int) -> String { t("병렬 \(count)", "Parallel \(count)") }
    static var usageWaiting: String { t("ccusage 데이터를 기다리는 중입니다", "Waiting for ccusage data") }
    static var usageWaitingDetail: String {
        t("새로고침을 누르거나 잠시 뒤 다시 열면 최신 사용량을 표시합니다", "Refresh, or reopen in a moment to see the latest usage")
    }
    static var today: String { t("오늘", "Today") }
    static var yesterday: String { t("어제", "Yesterday") }
    static var last7Days: String { t("최근 7일", "Last 7 days") }
    static var thisMonth: String { t("이번 달", "This month") }
    static var allTime: String { t("누적", "All time") }
    static func thisWeekShort(_ value: String) -> String { t("이번주 \(value)", "this week \(value)") }
    static var recent14Days: String { t("최근 14일 비용", "Cost, last 14 days") }
    static var noCostData: String { t("표시할 비용 데이터가 없습니다", "No cost data to show") }
    static func peakCost(_ value: String) -> String { t("최고 \(value)", "Peak \(value)") }
    static var dailyTrend: String { t("일별 추이", "Daily trend") }
    static var costByModel: String { t("모델별 비용", "Cost by model") }
    static func exchangeRate(_ rate: String) -> String { t("환율 1 USD = ₩\(rate)", "Rate 1 USD = ₩\(rate)") }
    static var noModelData: String { t("이번 달 모델별 데이터가 아직 없습니다", "No per-model data this month yet") }

    // MARK: CLI·빈 값 어휘

    static var grokChecking: String { t("Grok 확인 중", "Grok checking") }
    static var agyChecking: String { t("agy 확인 중", "agy checking") }
    static var vocabCheckingDesc: String { t("물어보는 중, 곧 값이 옴", "Asking now, value coming soon") }
    static var vocabNeedsCheckDesc: String { t("답을 못 받음, 손을 써야 함", "No answer, needs a hand") }
    static var vocabSyncingDesc: String { t("값을 받아오는 중", "Fetching the value") }
    static var vocabNotMeasuredDesc: String { t("잴 수 있는데 아직 안 잼", "Measurable, not measured yet") }
    static var vocabStaleNote: String {
        t("조회 주기의 세 배가 지나도록 성공이 없으면 값 옆에 “N분째 갱신 없음”을 붙입니다.",
          "After three missed refresh cycles, a “no update for N min” note is added next to the value.")
    }

    // MARK: 빈 값 어휘

    static var notInstalled: String { t("미설치", "Not installed") }
}
