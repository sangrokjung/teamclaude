import Foundation

/// 이 맥의 Grok·agy 조회 결과를 CLI 탭 머신 표·스냅샷 칸으로 모은다(main.swift의 AppDelegate는 결과를 넘기기만 한다).
/// 일시 실패는 앞선 값을 지키되 — 제목 슬롯(grokPresentation)·agy 카드(agyHasValue)와 같은 규칙 —
/// 실패 표지와 마지막 성공 시각을 따로 남긴다. 그래야 새 written_at이 붙은 낡은 값이 "정상"으로 보이지 않는다(검토 I1).
struct CliLocalTracker {
    private(set) var grokOutcome: GrokMenuOutcome?
    private(set) var grokInstalled = true
    private(set) var grokLastOkAt: Date?
    private(set) var grokFetchFailed = false
    private(set) var agyOutcome: AgyFetchOutcome?
    private(set) var agyLastOkAt: Date?
    private(set) var agyFetchFailed = false
    var grokActivity = CliActivity()
    var agyActivity = CliActivity()

    /// 미설치 안내 경로(CLI도 인증 파일도 없다).
    mutating func recordGrokMissing() {
        grokOutcome = .login
        grokInstalled = false
        grokFetchFailed = false
    }

    mutating func recordGrok(_ outcome: GrokMenuOutcome, now: Date) {
        grokInstalled = true
        switch outcome {
        case .percent:
            grokOutcome = outcome
            grokLastOkAt = now
            grokFetchFailed = false
        case .expired, .login:
            grokOutcome = outcome
            grokFetchFailed = false
        case .unavailable:
            grokFetchFailed = true
            if case .percent? = grokOutcome { return } // 앞선 사용률을 지킨다
            grokOutcome = outcome
        }
    }

    mutating func recordAgy(_ outcome: AgyFetchOutcome, now: Date) {
        switch outcome {
        case .ready(let groups):
            agyOutcome = outcome
            agyFetchFailed = false
            if !agyVisibleGroups(groups).isEmpty { agyLastOkAt = now }
        case .missing:
            agyOutcome = outcome
            agyFetchFailed = false
        case .failed:
            agyFetchFailed = true
            if case .ready? = agyOutcome { return } // 앞선 값을 지킨다
            agyOutcome = outcome
        }
    }

    func state(host: String, now: Date) -> CliLocalCliState {
        CliLocalCliState(
            host: host,
            grok: grokOutcome.map {
                cliGrokStatus(outcome: $0, installed: grokInstalled, activity: grokActivity,
                              lastOkAt: grokLastOkAt, fetchFailed: grokFetchFailed)
            },
            agy: agyOutcome.map {
                cliAgyStatus(outcome: $0, activity: agyActivity, lastOkAt: agyLastOkAt, fetchFailed: agyFetchFailed)
            },
            writtenAt: now)
    }
}

/// 60초 주기 배경 읽기의 결과. 메인 스레드 밖에서 만든다.
struct CliBackgroundScan {
    let grokActivity: CliActivity
    let agyActivity: CliActivity
    let report: CliFleetReport?
    let links: [DashboardLink]

    static func run(now: Date = Date()) -> CliBackgroundScan {
        CliBackgroundScan(
            grokActivity: CliActivityScanner.grok(root: CliActivityScanner.grokSessionsURL(), now: now),
            agyActivity: CliActivityScanner.agy(root: CliActivityScanner.agyConversationsURL(), now: now),
            report: CliFleetReport.load(),
            links: DashboardLinks.load())
    }
}
