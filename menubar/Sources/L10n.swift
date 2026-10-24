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

    // MARK: 빈 값 어휘

    static var notInstalled: String { t("미설치", "Not installed") }
}
