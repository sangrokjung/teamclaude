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
    static var fableLaneNote: String { t("Fable 주간까지 여유", "Fable weekly headroom") }
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

    // MARK: Codex 탭

    static var codexStatus: String { t("Codex 상태", "Codex status") }
    static var codexRecommendationHelp: String {
        t("GPT-5.6 작업 추천: 구현과 설계는 gpt-5.6 medium, 리뷰와 보안은 gpt-5.6-sol high, 탐색과 병렬 작업은 gpt-5.6-terra low, 분류와 반복 작업은 gpt-5.6-luna none 또는 low",
          "GPT-5.6 picks: build and design gpt-5.6 medium, review and security gpt-5.6-sol high, exploration gpt-5.6-terra low, triage gpt-5.6-luna none or low")
    }
    static var teamCodexPool: String { t("TeamCodex 계정 풀", "TeamCodex pool") }
    static func codexPoolUsable(pool: Int, excluded: Int) -> String {
        t("/ \(pool) 사용 가능 · 제외 \(excluded)", "/ \(pool) available · \(excluded) excluded")
    }
    static var codexAccountsHead: String { t("계정", "Accounts") }
    static func codexUsableNames(_ names: [String]) -> String {
        names.isEmpty ? t("사용 가능 계정: 없음 · 측정 또는 제한 상태 확인", "Usable accounts: none · check measurements or limits")
            : t("사용 가능 계정: ", "Usable accounts: ") + names.joined(separator: " · ")
    }
    static var codexWindowsPerAccount: String { t("계정마다 창이 따로 돕니다", "Each account has its own windows") }
    static var codexNoAccounts: String { t("TeamCodex에 등록된 계정이 없습니다", "No accounts in TeamCodex") }
    static var codexCurrent: String { t("현재", "current") }
    static var codexFiveHours: String { t("5시간", "5 hours") }
    static var codexSevenDays: String { t("7일", "7 days") }
    static func codexFacts(inflight: Int, maxConcurrent: Int, requests: Int, credits: String, tokens: String) -> String {
        t("동시 \(inflight)/\(maxConcurrent) · 요청 \(requests) · 리셋권 \(credits) · 토큰 \(tokens)",
          "concurrent \(inflight)/\(maxConcurrent) · requests \(requests) · resets \(credits) · tokens \(tokens)")
    }
    static var codexLocalTitle: String { t("이 맥의 Codex 사용량", "Codex usage on this Mac") }
    static var codexLocalLoading: String { t("로컬 사용량 집계 중입니다", "Counting local usage") }
    static func codexRecent(_ age: String) -> String { t("최근 \(age)", "last \(age)") }
    static func codexInfoLine(auth: String, model: String, plan: String) -> String {
        t("인증 \(auth)  ·  모델 \(model)  ·  플랜 \(plan)", "auth \(auth)  ·  model \(model)  ·  plan \(plan)")
    }
    static var codexCurrentFiveHours: String { t("현재 계정 · 5시간", "Current · 5h") }
    static var codexCurrentSevenDays: String { t("현재 계정 · 7일", "Current · 7d") }
    static var codexTodayTokens: String { t("오늘 토큰", "Tokens today") }
    static var codexMonthlyCost: String { t("월 환산비용", "Monthly cost") }
    static var codexNoLimitInfo: String { t("한도 정보 없음", "No limit info") }
    static func codexCallCount(_ count: Int) -> String { t("\(count)회", "\(count) calls") }
    static var codexColumnModel: String { t("모델", "Model") }
    static var codexColumnCalls: String { t("호출", "Calls") }
    static var codexColumnToday: String { t("오늘", "Today") }
    static var codexColumnWeek: String { t("7일", "7d") }
    static var codexColumnStatus: String { t("상태", "Status") }
    static var codexColumnRecent: String { t("최근", "Last") }
    static var codexNoSessions: String { t("Codex 세션 사용 기록 없음", "No Codex session history") }
    static var codexRecommendationTitle: String { t("GPT-5.6 작업 추천", "GPT-5.6 picks") }
    static func codexCurrentModel(_ model: String) -> String { t("현재 \(model)", "now \(model)") }
    static var codexPromptHint: String { t("프롬프트: 목표 · 성공 기준 · 권한 · 검증만 명확하게", "Prompt: state goal, success criteria, permissions, checks") }
    static var codexEmptyTitle: String { t("Codex 풀 데이터가 없습니다", "No Codex pool data") }
    static var codexEmptyDetail: String {
        t("연동되면 계정별 5시간·7일 사용량과 리셋 시각이 여기에 뜹니다.", "Once connected, each account's 5-hour and 7-day usage and resets appear here.")
    }

    // MARK: 소진 탭

    static var burnAccessibilityTitle: String { t("구독 지출과 한도 소진", "Subscription spend and quota burn") }
    static func burnLaneAccessibility(lane: String, paid: Int, contributing: Int) -> String {
        t("\(lane) \(paid)계정 중 기여 \(contributing)", "\(lane) \(contributing) of \(paid) accounts contributing")
    }
    static var burnMonthlyTotal: String { t("월 합계", "Monthly total") }
    static var notEntered: String { t("미입력", "Not set") }
    static var burnRatesHint: String { t("요금표를 넣으면 계정별 지출이 계산됩니다", "Add a rate table to compute spend per account") }
    static var burnRatesSet: String { t("요금표 기준", "From the rate table") }
    static var burnIdleAccounts: String { t("기여 없는 계정", "Accounts not contributing") }
    static func burnIdleBreakdown(errors: Int, disabled: Int, unsubscribed: Int) -> String {
        t("오류 \(errors) · 꺼 둠 \(disabled) · 해지 \(unsubscribed)(지출 제외)", "errors \(errors) · off \(disabled) · cancelled \(unsubscribed) (not billed)")
    }
    static var burnByService: String { t("서비스별 판정", "By service") }
    static var burnByServiceAside: String { t("계정 = 지출 (기여)", "accounts = paid (contributing)") }
    static var burnFirstSteps: String { t("먼저 할 일", "Do first") }
    static var burnFirstStepsAside: String { t("고칠 수 있는 것부터", "Fixable things first") }
    static var burnRecordsLink: String { t("계정별 구독 기록은 Claude 탭에서 행을 펼쳐 ↗", "Per-account plan records: expand a row in Claude ↗") }
    static var burnCollecting: String { t("수집 중", "Collecting") }
    static func burnHistory(cycles: Int, percent: String) -> String { t("최근 \(cycles)주 평균 \(percent)", "avg of last \(cycles) weeks \(percent)") }
    static func burnEstimate(_ current: String, _ projected: String) -> String { t("\(current) → \(projected) 추정", "\(current) → \(projected) est.") }
    static var verdictBlocked: String { t("부족", "Short") }
    static var verdictOnTarget: String { t("달성", "On target") }
    static var verdictNear: String { t("근접", "Close") }
    static var verdictSlack: String { t("여유", "Slack") }
    static var verdictExcess: String { t("과다", "Excess") }

    // MARK: CLI·Higgsfield

    static var agyAskingNote: String { t("아직 물어보는 중 — 곧 값이 옵니다", "Still asking — a value is on the way") }
    static func agyMoreLanes(_ name: String, _ count: Int) -> String { t("\(name) 외 \(count)", "\(name) +\(count)") }
    static var higgsfieldTitle: String { t("힉스필드 크레딧", "Higgsfield credits") }
    static var loading: String { t("불러오는 중...", "Loading…") }
    static func higgsfieldFailed(_ error: String) -> String { t("힉스필드 크레딧 조회 실패: \(error)", "Higgsfield credits failed: \(error)") }
    static func higgsfieldAccessibility(_ credits: String, _ dday: String) -> String {
        t("힉스필드 크레딧 \(credits), 다음 리셋 \(dday)", "Higgsfield credits \(credits), next reset \(dday)")
    }
    static var higgsfieldLoginHint: String {
        t("터미널에서 higgsfield auth login 으로 로그인한 뒤 새로고침하세요", "Run higgsfield auth login in a terminal, then refresh")
    }
    static var higgsfieldInstallHint: String { t("CLI 설치 확인: npm i -g @higgsfield/cli", "Check the CLI install: npm i -g @higgsfield/cli") }
    static func higgsfieldGrant(_ amount: String) -> String { t("주기 지급 \(amount)", "Grant per cycle \(amount)") }
    static var higgsfieldGrantUnknown: String { t("주기 지급 미상", "Grant per cycle unknown") }
    static func higgsfieldRenewal(_ when: String) -> String { t("\(when) 갱신 예정", "Renews \(when)") }
    static var higgsfieldNoRenewal: String { t("갱신 이력이 없어 예정일을 계산할 수 없습니다", "No renewal history to estimate the next date") }
    static var higgsfieldNoHistory: String { t("갱신 이력 없음", "No renewal history") }
    static var higgsfieldFutureGrant: String { t("지급 시각이 미래입니다 · 시계 확인 필요", "Grant time is in the future · check the clock") }
    static func higgsfieldElapsed(_ days: Int, _ cycle: Int) -> String { t("\(days)일 경과 / \(cycle)일", "\(days)d elapsed / \(cycle)d") }
    static var higgsfieldNoGrant: String { t("지급 기록 없음", "No grants recorded") }
    static func higgsfieldAssumedCycle(_ days: Int) -> String { t("주기 미실측 · 기본 \(days)일 가정", "Cycle not measured · assuming \(days)d") }
    static func higgsfieldMeasuredCycle(_ days: Int, _ count: Int) -> String {
        t("\(days)일 주기 · 갱신 \(count)건 실측", "\(days)d cycle · \(count) renewals measured")
    }
    static func higgsfieldSpent(_ amount: String) -> String { t("이번 주기 사용 \(amount)", "Used this cycle \(amount)") }
    static var higgsfieldExpiryUnknown: String { t("소멸 예상 계산 불가", "Expiry can't be estimated") }
    static var higgsfieldExpiryMeasuring: String { t("소멸 예상 측정 중", "Measuring expiry") }
    static func higgsfieldExpiryRatio(_ amount: String, _ percent: Int) -> String {
        t("소멸 예상 \(amount) (지급분 \(percent)%)", "Expected to expire \(amount) (\(percent)% of grant)")
    }
    static func higgsfieldExpiry(_ amount: String) -> String { t("소멸 예상 \(amount)", "Expected to expire \(amount)") }
    static func higgsfieldLastReset(_ date: String, _ amount: String) -> String {
        t("직전 갱신(\(date))에 \(amount) 소멸", "\(amount) expired at last renewal (\(date))")
    }
    static var higgsfieldEstimated: String { t("갱신일은 API 미제공 · 지급 이력으로 추정", "Renewal date not in the API · estimated from grants") }
    static func higgsfieldUnknownActions(_ list: String) -> String { t("처음 보는 거래 유형(\(list))", "New transaction types (\(list))") }
    static var higgsfieldPartial: String { t("일부만 조회됨", "Partially loaded") }

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

    // MARK: 공통 로직 문구

    static var vocabChecking: String { t("확인 중", "Checking") }
    static var vocabNeedsCheck: String { t("확인 필요", "Needs check") }
    static var vocabSyncing: String { t("동기화 중", "Syncing") }
    static var vocabNotMeasured: String { t("측정 전", "Not measured") }
    static var vocabNoData: String { t("데이터 없음", "No data") }
    static func staleSuffix(_ minutes: Int) -> String { t("\(minutes)분째 갱신 없음", "no update for \(minutes) min") }
    static var toolSubscriptionCollector: String { t("구독 수집기", "Plan collector") }
    static func envHint(_ key: String) -> String { t("설치돼 있다면 \(key)로 경로를 지정하세요", "If it is installed, set its path with \(key)") }
    static func noticeNoConfigOrServer(_ path: String) -> String {
        t("설정 파일(\(path))과 실행 중인 서버가 없습니다", "No config file (\(path)) and no running server")
    }
    static var noticeNoCodex: String { t("~/.codex의 인증·설정·세션 기록이 없습니다", "No auth, config or session history in ~/.codex") }
    static var noticeNoCodexSection: String { t("Codex CLI 기록과 TeamCodex 설정이 없습니다", "No Codex CLI history and no TeamCodex config") }
    static func noticeNoNpx(_ hint: String) -> String { t("ccusage를 실행할 npx(Node.js)가 없습니다 · \(hint)", "No npx (Node.js) to run ccusage · \(hint)") }
    static var noticeNoClaudeUsage: String { t("Claude Code 사용 기록이 아직 없습니다", "No Claude Code usage recorded yet") }
    static var noticeCollectorHeadline: String { t("수집기 미설치(선택 기능)", "Collector not installed (optional)") }
    static var noticeCollectorDetail: String {
        t("구독 확인 수집기가 없어 결제 메일·청구 페이지 확인은 건너뜁니다", "No plan collector, so billing mail and invoice checks are skipped")
    }
    static var reasonFableReady: String { t("Fable 사용 가능", "Fable available") }
    static var reasonOpusReady: String { t("Opus 사용 가능", "Opus available") }
    static var reasonOffline: String { t("오프라인 · 확인 필요", "Offline · needs check") }
    static var reasonThresholdUnknown: String { t("한도 기준 확인 필요", "Limit threshold unknown") }
    static var reasonMeasurementStale: String { t("최신 한도 측정 필요", "Needs a fresh limit measure") }
    static var reasonPlanEnded: String { t("구독 종료 · 이용 불가", "Plan ended · unavailable") }
    static var reasonDisabled: String { t("비활성 · 직접 꺼 둔 계정", "Disabled · turned off by you") }
    static var reasonNotClaude: String { t("Claude 계정 아님", "Not a Claude account") }
    static var reasonServerState: String { t("서버 상태 확인 필요", "Check server state") }
    static var reasonEndDatePassed: String { t("구독 종료일 경과 · 확인 필요", "Plan end date passed · check") }
    static var reasonResetPassed: String { t("한도 리셋 경과 · 재측정 필요", "Limit reset passed · re-measure") }
    static var reasonThrottled: String { t("일시 제한 해제 대기", "Waiting for a temporary limit to lift") }
    static var reasonQuotaReset: String { t("사용 한도 리셋 대기", "Waiting for the quota reset") }
    static var reasonProxyExcluded: String { t("프록시 라우팅 제외", "Excluded from proxy routing") }
    static var reasonProxyUnknown: String { t("프록시 사용 가능 여부 미확인", "Proxy availability unknown") }
    static var reasonConcurrencyUnknown: String { t("동시 요청 여유 미확인", "Concurrency headroom unknown") }
    static var reasonConcurrencyBusy: String { t("동시 요청 처리 중", "Busy with concurrent requests") }
    static func reasonErrorCheck(_ label: String) -> String { t("\(label) · 상태 확인 필요", "\(label) · check state") }
    static var windowAllWeekly: String { t("전체 주간", "weekly") }
    static func reasonWindowsBlocked(_ windows: String) -> String { t("\(windows) 한도 대기", "\(windows) at limit") }
    static func reasonWindowCheck(_ window: String) -> String { t("\(window) 한도 확인 필요", "\(window) limit needs check") }
    static var issueDisabledLong: String { t("비활성 계정", "Disabled account") }
    static var issueNotSyncedLong: String { t("서버 동기화 필요", "Needs server sync") }
    static var issueAccountErrorLong: String { t("인증 확인 필요", "Check authentication") }
    static var issueExhaustedLong: String { t("사용 한도 초기화 대기", "Waiting for quota reset") }
    static var issueStaleLong: String { t("세션 만료, 재측정 필요", "Session expired, re-measure") }
    static var issueSessionMissingLong: String { t("세션 사용량 미측정", "Session usage not measured") }
    static var issueWeeklyMissingLong: String { t("주간 사용량 미측정", "Weekly usage not measured") }
    static var issueFableMissingLong: String { t("Fable 사용량 미측정", "Fable usage not measured") }
    static var issueNotSyncedShort: String { t("동기화", "Sync") }
    static var issueAccountErrorShort: String { t("인증확인", "Check auth") }
    static var issueThrottledShort: String { t("제한대기", "Throttled") }
    static var issueExhaustedShort: String { t("한도대기", "At limit") }
    static var issueMeasureShort: String { t("지금측정", "Measure now") }
    static var stateInactive: String { t("비활성", "Disabled") }
    static var titleClaudeOffline: String { t("Claude 오프라인", "Claude offline") }
    static func titleClaudeDrift(_ count: Int) -> String { t("Claude 연동 확인 \(count)", "Claude sync \(count)") }
    static func titleClaudeMeasure(_ count: Int) -> String { t("Claude 측정 필요 \(count)", "Claude measure \(count)") }
    static func titleClaudeFableLimit(_ over: Int, _ known: Int) -> String { t("Claude Fable 한도 \(over)/\(known)", "Claude Fable limit \(over)/\(known)") }
    static func titleClaudeRouting(_ usable: Int, _ total: Int) -> String { t("Claude 라우팅 \(usable)/\(total)", "Claude routing \(usable)/\(total)") }
    static func titleClaudeOK(_ active: Int, _ total: Int) -> String { t("Claude 정상 \(active)/\(total)", "Claude OK \(active)/\(total)") }
    static func runtimeBuild(_ artifact: String) -> String { t("빌드 \(artifact)", "build \(artifact)") }
    static var runtimeBuildUnknown: String { t("빌드 미상", "build unknown") }
    static func runtimeUptime(_ text: String) -> String { t("가동 \(text)", "up \(text)") }
    static func runtimeRestarts(_ count: Int) -> String { t("재시작 \(count)회", "\(count) restarts") }
    static func runtimeWorkerRestarts(_ count: Int) -> String { t("워커 재시작 \(count)회", "\(count) worker restarts") }
    static func runtimeLast(_ clock: String) -> String { t(" (마지막 \(clock))", " (last \(clock))") }
    static func durationMinutes(_ minutes: Int) -> String { t("\(minutes)분", "\(minutes)m") }
    static func durationDaysHours(_ days: Int, _ hours: Int) -> String { t("\(days)일 \(hours)시간", "\(days)d \(hours)h") }
    static func durationHoursMinutes(_ hours: Int, _ minutes: Int) -> String { t("\(hours)시간 \(minutes)분", "\(hours)h \(minutes)m") }
    static var errOrgBlocked: String { t("조직차단", "Org blocked") }
    static var errPlanEnded: String { t("구독종료", "Plan ended") }
    static var errAuthExpired: String { t("인증만료", "Auth expired") }
    static var errAuthRejected: String { t("인증거부", "Auth rejected") }
    static var errRefreshFailed: String { t("갱신실패", "Refresh failed") }
    static var errSendFailed: String { t("송신실패", "Send failed") }
    static var errGeneric: String { t("오류", "Error") }
    static func creditCount(_ count: Int) -> String { t("\(count)장", "\(count)") }
    static var unconfirmed: String { t("미확인", "Unknown") }
    static func creditsUnknownAccounts(_ count: Int) -> String { t("활성 풀 리셋권 미확인 \(count)계정", "Active pool resets unknown for \(count) accounts") }
    static func creditsTotal(_ total: Int) -> String { t("활성 풀 리셋권 \(total)장", "Active pool resets \(total)") }
    static func creditsUnknownSuffix(_ count: Int) -> String { t(" · 미확인 \(count)계정", " · \(count) unknown") }
    static var autoResetUnknown: String { t("자동 리셋 상태 미확인", "Auto reset state unknown") }
    static var autoResetOff: String { t("자동 리셋 꺼짐", "Auto reset off") }
    static var autoResetAccount: String { t("계정별 한도 소진 시 자동 리셋", "Auto reset when an account runs out") }
    static var autoResetFleet: String { t("전체 풀 소진 시 자동 리셋", "Auto reset when the whole pool runs out") }
    static var autoResetPolicyUnknown: String { t("자동 리셋 정책 미확인", "Auto reset policy unknown") }
    static func creditsAccessibility(_ name: String, _ label: String) -> String { t("\(name) 리셋권 \(label)", "\(name) resets \(label)") }
    static var poolOffline: String { t("오프라인", "Offline") }
    static var poolExhausted: String { t("소진", "Exhausted") }
    static var poolOnline: String { t("온라인", "Online") }
    static var titleCodexOffline: String { t("Codex 오프라인", "Codex offline") }
    static func titleCodexExhaustedUntil(_ clock: String) -> String { t("Codex 소진 · \(clock) 복구", "Codex out · back \(clock)") }
    static func titleCodexExhausted(_ pool: Int) -> String { t("Codex 소진 0/\(pool)", "Codex out 0/\(pool)") }
    static func teamCodexAccessibility(_ status: String, _ usable: Int, _ pool: Int, _ excluded: Int) -> String {
        t("TeamCodex \(status), 지금 쓸 수 있는 계정 \(usable)개, 풀에 남은 계정 \(pool)개, 풀에서 빠진 계정 \(excluded)개",
          "TeamCodex \(status), \(usable) accounts usable now, \(pool) in the pool, \(excluded) out of the pool")
    }
    static var timeNotMeasured: String { t("시각 미측정", "Time not measured") }
    static var checkingRenewal: String { t("갱신 확인 중", "Checking renewal") }
    static func inDuration(_ duration: String) -> String { t("\(duration) 후", "in \(duration)") }
    static func durationHours(_ hours: Int) -> String { t("\(hours)시간", "\(hours)h") }
    static func durationDays(_ days: Int) -> String { t("\(days)일", "\(days)d") }
    static var codexStateEndCheck: String { t("종료확인중", "Checking end") }
    static var codexStateExhausted: String { t("한도소진", "Exhausted") }
    static var codexStatePaused: String { t("일시대기", "Paused") }
    static var codexStateWaiting: String { t("대기", "Standby") }
    static var codexStateConfigured: String { t("설정됨", "Configured") }
    static var codexNoteRetired: String { t("돌아오지 않음", "Won't come back") }
    static var codexNoteEndDate: String { t("종료일 지남 · 연결 확인 중", "End date passed · checking connection") }
    static var codexNoteDisabled: String { t("직접 꺼 둔 계정", "Turned off by you") }
    static var codexNoteEnding: String { t("구독 종료 예정", "Plan ending") }
    static var codexEnableFollowUp: String {
        t("다시 켠 뒤 터미널 안내를 확인하세요 · 반영되지 않으면 teamcodex restart", "After re-enabling, check the terminal · if it doesn't apply, run teamcodex restart")
    }
    static var codexEnableThenReauthFollowUp: String {
        t("다시 켠 뒤에도 인증 오류면 재인증이 필요합니다 · 반영은 teamcodex restart",
          "If auth still fails after re-enabling, re-auth is needed · apply with teamcodex restart")
    }
    static var reEnable: String { t("다시 켜기", "Turn on") }
    static func reEnableLabel(_ name: String) -> String { t("다시 켜기: \(name)", "Turn on: \(name)") }
    static func reEnableToolTip(_ name: String, _ note: String) -> String { t("\(name) 계정을 다시 풀에 넣습니다. \(note)", "Puts \(name) back in the pool. \(note)") }
    static var reauthNeeded: String { t("재인증 필요", "Re-auth needed") }
    static func codexReauthToolTip(_ name: String) -> String { t("\(name) 계정의 Codex 인증을 다시 연결합니다.", "Reconnects Codex auth for \(name).") }
    static var codexTaskBuild: String { t("구현·설계", "Build·design") }
    static var codexEffortBuild: String { t("medium · 복잡하면 high", "medium · high if complex") }
    static var codexTaskReview: String { t("리뷰·보안", "Review·security") }
    static var codexTaskExplore: String { t("탐색·병렬", "Explore·parallel") }
    static var codexTaskTriage: String { t("분류·반복", "Triage·repeat") }
    static var titleCodexReauth: String { t("Codex 재인증", "Codex re-auth") }
    static var titleCodexLogin: String { t("Codex 로그인", "Codex login") }
    static func titleCodexWarningCount(_ count: Int) -> String { t("Codex 주의 \(count)", "Codex warning \(count)") }
    static var titleCodexWarning: String { t("Codex 주의", "Codex warning") }
    static var statusWarning: String { t("주의", "Warning") }
    static var statusOK: String { t("정상", "OK") }
    static var justNow: String { t("방금", "just now") }
    static func ago(_ value: String) -> String { t("\(value) 전", "\(value) ago") }
    static func recErrorsFirst(_ count: Int) -> String { t("오류 \(count)개 재인증이 먼저", "Re-auth \(count) erroring accounts first") }
    static func recUnsubscribed(_ count: Int) -> String { t("해지 \(count)개 풀에서 정리", "Remove \(count) cancelled accounts from the pool") }
    static func recDisabled(_ count: Int) -> String { t("꺼 둔 \(count)개 유지 여부 결정", "Decide whether to keep \(count) turned-off accounts") }
    static func recReduce(_ lane: String, _ count: Int) -> String { t("\(lane) \(count)개 줄일 여지", "\(lane): room to drop \(count)") }
    static func recDowngrade(_ lane: String) -> String { t("\(lane) 다운그레이드 검토", "\(lane): consider a downgrade") }
    static func remainingPercent(_ value: String) -> String { t("\(value)% 남음", "\(value)% left") }
    static var agyGeminiModel: String { t("Gemini 모델", "Gemini models") }
    static var resetSoon: String { t("곧 리셋", "resets soon") }
    static func afterDuration(_ duration: String) -> String { t("\(duration) 뒤", "in \(duration)") }
    static var agyWeeklyCheck: String { t("주간 확인 필요", "weekly needs check") }
    static var agyFiveHourCheck: String { t("5시간 확인 필요", "5h needs check") }
    static func grokCredits(_ label: String) -> String { t("크레딧 \(label)", "credits \(label)") }
    static var switchOn: String { t("켜짐", "On") }
    static var switchOff: String { t("꺼짐", "Off") }
    static var dateFormatMonthDay: String { t("M월 d일", "MMM d") }
    static var dateFormatMonthDayTime: String { t("M월 d일 HH:mm", "MMM d HH:mm") }
    static func runFailed(_ bin: String, _ error: String) -> String { t("\(bin) 실행 실패: \(error)", "\(bin) failed to run: \(error)") }
    static func higgsfieldTimeout(_ seconds: Int) -> String {
        t("힉스필드 CLI가 \(seconds)초 안에 응답하지 않아 중단했습니다", "Higgsfield CLI did not answer within \(seconds)s and was stopped")
    }
    static func higgsfieldParseFailed(_ args: String) -> String { t("higgsfield \(args) JSON 파싱 실패", "higgsfield \(args): could not parse JSON") }
    static func higgsfieldExitFailed(_ args: String, _ code: Int) -> String {
        t("higgsfield \(args) 실행 실패 (종료 코드 \(code))", "higgsfield \(args) failed (exit code \(code))")
    }
    static var higgsfieldNotFound: String { t("higgsfield CLI를 찾지 못했습니다", "Could not find the higgsfield CLI") }
    static var loginRequired: String { t("로그인 필요", "Login required") }
    static var hintAuthParse: String { t("auth.json 파싱 실패", "Could not parse auth.json") }
    static var hintNoAuthFile: String { t("Codex auth 파일 없음", "No Codex auth file") }
    static var hintNoAuth: String { t("Codex 인증 정보 없음", "No Codex credentials") }
    static var hintRefreshOld: String { t("마지막 refresh 14일 초과", "Last refresh over 14 days ago") }
    static var hintNoConfig: String { t("config.toml 없음", "No config.toml") }
    static var hintNoSessions: String { t("Codex 세션 로그 없음", "No Codex session logs") }
    static func hintErrorEvents(_ count: Int) -> String { t("최근 7일 오류 이벤트 \(count)회", "\(count) error events in the last 7 days") }
    static var refuseNoState: String { t("상태 파일 없음", "No state file") }
    static var refuseOtherConfig: String { t("다른 설정 파일의 서버", "Server of another config file") }
    static var refuseBadPid: String { t("상태 파일 pid 이상", "State file pid is invalid") }
    static var refuseLaunchdMismatch: String { t("launchd 서비스 pid와 supervisor 불일치", "launchd service pid does not match the supervisor") }
    static var refuseNoWorker: String { t("worker 기록 없음", "No worker record") }
    static var refuseNotServer: String { t("teamclaude server 명령 아님", "Not a teamclaude server command") }
    static var refuseNoWorkerProcess: String { t("worker 프로세스 없음", "No worker process") }
    static var refuseWorkerMismatch: String { t("worker 프로세스가 기록과 다름", "Worker process differs from the record") }
    static func restartInflight(_ count: Int) -> String { t("진행 중 요청 \(count)건이 끊깁니다.", "\(count) in-flight requests will be dropped.") }
    static var restartNoInflight: String { t("진행 중 요청은 없습니다.", "No requests are in flight.") }
    static var restartUnknownInflight: String {
        t("서버 상태를 읽지 못해 진행 중 요청 수를 확인하지 못했습니다. 진행 중인 요청이 있으면 모두 끊깁니다.",
          "Could not read the server state, so in-flight requests are unknown. Any in-flight requests will be dropped.")
    }
    static var restartTitle: String { t("TeamClaude 서버를 재시작할까요?", "Restart the TeamClaude server?") }
    static var restartUsuallyUnneeded: String {
        t("계정 추가·재인증·켜기/끄기는 재시작 없이 자동 반영되므로 보통은 필요하지 않습니다.",
          "Adding, re-authenticating or toggling accounts applies without a restart, so this is usually not needed.")
    }
    static var restartConfirm: String { t("재시작", "Restart") }
    static var cancel: String { t("취소", "Cancel") }
    static var serverRunning: String { t("실행중", "Running") }
    static var serverSlow: String { t("응답 지연", "Slow") }
    static var driftPersists: String { t("재로딩 후에도 남음 · 재시작하지 않음", "Still there after reload · not restarting") }
    static var driftSyncing: String { t("자동 동기화 중 · 서버 반영 확인", "Auto-syncing · checking the server") }

    // MARK: 앱·제목·구독 문구

    static func hostCores(_ cores: Int) -> String { t("\(cores)코어", "\(cores) cores") }
    static var hostPrefix: String { t("호스트  ", "Host  ") }
    static func titleClaudeFable(_ ready: Int, _ total: Int) -> String { t("Claude Fable 사용 가능 \(ready)/\(total)", "Claude Fable \(ready)/\(total)") }
    static var titleClaudeSlow: String { t("Claude 응답 지연", "Claude slow") }
    static var titleClaudeMeasuring: String { t("Claude 측정 중", "Claude measuring") }
    static var hintServerConnectFailed: String { t("teamclaude 서버 연결 실패", "Could not reach the teamclaude server") }
    static var hintCheckConfig: String { t("teamclaude 계정 설정 파일 확인 필요", "Check the teamclaude account config") }
    static var hintFableAllOver: String { t("Fable 주간 쿼터가 모든 확인 계정에서 임계치 이상", "Fable weekly quota is over the threshold on every checked account") }
    static var hintFableSomeOver: String { t("일부 계정의 Fable 주간 쿼터가 임계치 이상", "Some accounts are over the Fable weekly threshold") }
    static func hintMissingOnServer(_ count: Int) -> String { t("설정 계정 \(count)개 서버 미반영 · 재시작 필요", "\(count) configured accounts missing on the server · restart needed") }
    static func hintExtraOnServer(_ count: Int) -> String { t("제거된 계정 \(count)개 서버 잔존 · 재시작 필요", "\(count) removed accounts still on the server · restart needed") }
    static func hintStateMismatch(_ count: Int) -> String { t("계정 활성 상태 \(count)개 서버 불일치 · 재시작 필요", "\(count) accounts differ in enabled state · restart needed") }
    static func hintMeasurePending(_ count: Int) -> String { t("사용량 미측정 계정 \(count)개 · 지금 측정 가능", "\(count) accounts unmeasured · measure now") }
    static func hintUnavailable(_ count: Int) -> String { t("일시 제한 상태 확인이 필요한 계정 \(count)개", "\(count) accounts need a throttle check") }
    static var hintReconnecting: String { t("서버 재연결 중 · 마지막 정상 주간/Fable 표시", "Reconnecting · showing the last good weekly/Fable values") }
    static var hintPartialSync: String { t("일부 한도 동기화 중 · 계정 상태는 최신", "Some limits syncing · account state is current") }
    static var terminalFollowUpCodex: String {
        t("완료 후 위 실행 결과를 확인하세요 · 반영되지 않으면 teamcodex restart가 필요합니다.", "Check the output above when done · if it doesn't apply, run teamcodex restart.")
    }
    static var terminalFollowUpAuto: String { t("완료되면 상태바에 자동 반영됩니다.", "The menu bar updates automatically when done.") }
    static var terminalPressAnyKey: String { t("닫으려면 아무 키나 누르세요", "Press any key to close") }
    static func slotTokens(_ value: String) -> String { t("토큰 \(value)", "tokens \(value)") }
    static func slotThisMonth(_ value: String) -> String { t("이번달 \(value)", "this month \(value)") }
    static func slotTotal(_ value: String) -> String { t("총 \(value)", "total \(value)") }
    static func tipMeasurement(_ pending: Int, _ unavailable: Int, _ limited: Int) -> String {
        t(" · 측정 필요 \(pending) · 상태 확인 \(unavailable) · 한도 리셋 \(limited)", " · measure \(pending) · check \(unavailable) · limit reset \(limited)")
    }
    static var tipPrefix: String { t("Claude Code 사용량", "Claude Code usage") }
    static var grokRefreshNeeded: String { t("Grok 갱신 필요", "Grok refresh needed") }
    static var grokRefreshDetail: String { t("토큰 기한이 지났습니다. grok을 한 번 실행하면 갱신됩니다.", "The token expired. Run grok once to refresh it.") }
    static var grokLogin: String { t("Grok 로그인", "Grok login") }
    static var grokNeedsCheck: String { t("Grok 확인 필요", "Grok needs check") }
    static var agyNoGeminiLane: String { t("agy Gemini 레인 없음", "agy has no Gemini lane") }
    static var agyNeedsCheck: String { t("agy 확인 필요", "agy needs check") }
    static var refreshingToday: String { t("오늘 사용량 갱신 중", "Refreshing today") }
    static var refreshingAll: String { t("전체 사용량 갱신 중", "Refreshing all usage") }
    static var refreshingStatus: String { t("상태 갱신 중", "Refreshing status") }
    static var refreshNow: String { t("즉시 갱신", "Now") }
    static var inProgress: String { t("진행 중", "In progress") }
    static func measurableNow(_ count: Int) -> String { t("\(count)개 지금 측정 가능", "\(count) can be measured now") }
    static func stateCheckCount(_ count: Int) -> String { t("\(count)개 상태 확인 필요", "\(count) need a state check") }
    static func measuredWaiting(_ count: Int) -> String { t("측정 완료 · \(count)개 라우팅 한도 대기", "Measured · \(count) waiting on limits") }
    static var allMeasured: String { t("모든 계정 측정 완료", "All accounts measured") }
    static var oauthRefreshing: String { t("OAuth 갱신 중", "Refreshing OAuth") }
    static var oauthRefreshFailed: String { t("OAuth 갱신 실패", "OAuth refresh failed") }
    static var serverSyncing: String { t("서버 동기화 중", "Syncing with the server") }
    static var serverSlowRetry: String { t("서버 응답 지연 · 잠시 후 다시 시도", "Server slow · try again shortly") }
    static var serverConnectFailed: String { t("서버 연결 실패", "Could not reach the server") }
    static func measureFailedRetry(_ count: Int) -> String { t("\(count)개 측정 실패 · 다시 시도", "\(count) failed to measure · try again") }
    static func measuredCount(_ count: Int) -> String { t("\(count)개 계정 측정 완료", "\(count) accounts measured") }
    static var terminalImport: String { t("현재 Claude Code 로그인 계정 가져오기", "Import the current Claude Code login") }
    static func terminalClaudeReauth(_ name: String) -> String { t("Claude OAuth 재인증: \(name)", "Claude OAuth re-auth: \(name)") }
    static var terminalCodexEnable: String { t("Codex 계정 다시 켜기", "Turn a Codex account back on") }
    static var terminalCodexReauth: String { t("Codex OAuth 재인증", "Codex OAuth re-auth") }
    static var restartNoExecutable: String {
        t("teamclaude 실행 파일을 찾지 못했습니다. CC_MENUBAR_TEAMCLAUDE_BIN으로 경로를 지정하세요.", "Could not find the teamclaude executable. Set its path with CC_MENUBAR_TEAMCLAUDE_BIN.")
    }
    static func restartUnmanaged(_ label: String) -> String {
        t("launchd 서비스(\(label))에 등록되지 않은 서버가 실행 중입니다. 앱은 이 서버를 재시작하지 않습니다. 실행한 터미널에서 직접 다시 시작하세요.",
          "A server not registered with the launchd service (\(label)) is running. The app won't restart it. Restart it from the terminal that started it.")
    }
    static var restartUndetermined: String { t("launchd 상태를 확인하지 못해 아무것도 하지 않았습니다.", "Could not check launchd, so nothing was done.") }
    static var restartNoticeTitle: String { t("TeamClaude 서버", "TeamClaude server") }
    static var ok: String { t("확인", "OK") }
    static var subPlanUnknown: String { t("구독 미확인", "Plan unknown") }
    static var subEnteredPaymentPast: String { t("입력 결제일 지남 ", "entered payment date passed ") }
    static var subEnteredPayment: String { t("입력 결제일 ", "entered payment date ") }
    static var subCancelUnknown: String { t("해지 미확인", "cancellation unknown") }
    static var subPaymentUnknown: String { t("결제일 미확인", "payment date unknown") }
    static var subExpiryUnknown: String { t("만료일 미확인", "expiry unknown") }
    static var subMailChecked: String { t("메일확인", "mail-checked") }
    static var subChecked: String { t("확인", "checked") }
    static var subRenewRecheckPast: String { t("갱신 재확인 · 지난 결제일", "recheck renewal · past payment date") }
    static var subRenewRecheckRecorded: String { t("갱신 재확인 · 기록 결제일", "recheck renewal · recorded payment date") }
    static var subRenewing: String { t("자동갱신 확인 · 다음 결제", "auto-renew confirmed · next payment") }
    static var subEndPassed: String { t("종료일 경과 · 확인 필요", "end date passed · check") }
    static var subCancelRecheck: String { t("해지 재확인 · 예정 종료", "recheck cancellation · ends") }
    static var subCancelScheduled: String { t("해지 예약 · 이용 종료", "cancellation scheduled · ends") }
    static var subEndRecheck: String { t("종료 재확인", "recheck end") }
    static var subEndConfirmed: String { t("구독 종료 확인", "plan end confirmed") }
    static var subExpiry: String { t("만료일", "expires") }
    static var subEnter: String { t("입력", "enter") }
    static var subPaymentPast: String { t("결제일 지남", "payment date passed") }
    static var subNextPayment: String { t("다음 결제", "next payment") }
    static var subMonitorDelayed: String { t("자동조회 지연", "Auto check delayed") }
    static var subMonitorOK: String { t("메일 자동조회 완료", "Mail auto check done") }
    static var subMonitorBusy: String { t("메일 사용 중 · 다음 회차 재시도", "Mail busy · retry next round") }
    static var subMonitorLogin: String { t("메일 로그인 필요", "Mail login required") }
    static var subMonitorUnsupported: String { t("이 메일 서비스는 자동 조회를 지원하지 않습니다", "This mail service does not support auto checks") }
    static var subMonitorFailed: String { t("메일 자동조회 실패 · 마지막 확인 유지", "Mail auto check failed · keeping the last check") }
    static var subStatusDelayed: String { t("조회 지연", "Check delayed") }
    static var subStatusUnsupported: String { t("자동조회 미지원", "Auto check unsupported") }
    static var subStatusWaiting: String { t("조회 대기", "Check waiting") }
    static var subStatusFailed: String { t("조회 실패", "Check failed") }
    static var subStatusMail: String { t("메일조회", "Mail check") }
    static var subEverySixHours: String { t(" (6시간마다 확인).", " (checked every 6 hours).") }
    static var subLastSuccess: String { t(" 마지막 성공 ", " Last success ") }
    static var subRejoined: String { t(". 과거 해지 이후 재가입 확인 · 현재 갱신 여부는 미확인", ". Rejoined after a past cancellation · current renewal unknown") }
    static var subStatusAuto: String { t("자동확인", "Auto-checked") }

    // MARK: 구독 기록 대화상자

    static var subRecheckMarker: String { t("재확인", "recheck") }
    static var subToolTipClaude: String {
        t("구독 관리 화면이나 해지 확인 메일의 내용을 기록합니다. 실제 구독은 변경하지 않습니다. Max/active만으로 해지 여부를 확인할 수 없습니다.",
          "Records what the billing page or cancellation mail says. It does not change the real plan. Max/active alone can't tell whether it was cancelled.")
    }
    static var subToolTipCodex: String { t("결제일을 입력하거나 수정합니다. 자동 조회된 결제일이 아닙니다.", "Enter or edit the payment date. This is not an auto-detected date.") }
    static var subSourceBilling: String { t("구독 관리 화면", "billing page") }
    static var subSourceMail: String { t("확인 메일", "confirmation mail") }
    static var subSourceProxy: String { t("TeamClaude 서버 구독 기록", "TeamClaude server record") }
    static var subSourceManual: String { t("직접 입력", "entered by hand") }
    static var subModeAuto: String { t("로그인된 메일에서 자동 확인했습니다.", "Checked automatically from the signed-in mailbox.") }
    static var subModeProxy: String { t("서버에 기록된 구독 상태입니다.", "Plan state recorded on the server.") }
    static var subModeManual: String { t("이 기록은 직접 확인한 내용입니다.", "This record was checked by hand.") }
    static func subSourceLine(_ source: String, _ mode: String) -> String { t("출처: \(source). \(mode) ", "Source: \(source). \(mode) ") }
    static func subStartLine(_ start: String) -> String { t("구독 시작일 \(start). ", "Plan started \(start). ") }
    static func subDialogTitle(_ name: String) -> String { t("\(name) 구독 확인 기록", "\(name) plan record") }
    static var subDialogBody: String {
        t("구독 관리 화면이나 확인 메일에서 확인한 상태만 기록하세요. 실제 구독 변경·해지가 아닙니다. 자동갱신은 다음 결제일, 해지 예약은 마지막 이용일을 입력하세요. 날짜를 모르면 비워 두세요.",
          "Record only what you saw on the billing page or in a confirmation mail. This does not change or cancel the plan. For auto-renew enter the next payment date; for a scheduled cancellation enter the last day of use. Leave the date empty if unknown.")
    }
    static var subSaveRecord: String { t("기록 저장", "Save record") }
    static var subClearRecord: String { t("확인 기록 지우기", "Clear record") }
    static var subEditPayment: String { t("입력 결제일 편집", "Edit payment date") }
    static var subStateRenewing: String { t("자동갱신 확인", "Auto-renew confirmed") }
    static var subStateScheduled: String { t("해지 예약", "Cancellation scheduled") }
    static var subStateLabel: String { t("확인한 구독 상태", "Confirmed plan state") }
    static var subDatePlaceholder: String { t("YYYY-MM-DD (미확인 시 비워 둠)", "YYYY-MM-DD (leave empty if unknown)") }
    static var subDateLabel: String { t("다음 결제일 또는 마지막 이용일", "Next payment date or last day of use") }
    static var subInvalidDateRecord: String {
        t("날짜를 확인하세요. 실제 존재하는 YYYY-MM-DD 날짜만 기록할 수 있습니다. 실제 구독은 변경하지 않습니다.",
          "Check the date. Only a real YYYY-MM-DD date can be recorded. The real plan is not changed.")
    }
    static func subPaymentTitle(_ name: String) -> String { t("\(name) 결제일", "\(name) payment date") }
    static var subPaymentBody: String {
        t("청구서 또는 구독 관리 화면에서 확인한 다음 결제일을 입력하세요. YYYY-MM-DD 형식입니다.", "Enter the next payment date from the invoice or billing page, as YYYY-MM-DD.")
    }
    static var save: String { t("저장", "Save") }
    static var subClearDate: String { t("날짜 지우기", "Clear date") }
    static var subNextPaymentDate: String { t("다음 결제일", "Next payment date") }
    static var subInvalidDateSave: String { t("날짜를 확인하세요. 실제 존재하는 YYYY-MM-DD 날짜만 저장할 수 있습니다.", "Check the date. Only a real YYYY-MM-DD date can be saved.") }

    // MARK: 빈 값 어휘

    static var notInstalled: String { t("미설치", "Not installed") }
}
