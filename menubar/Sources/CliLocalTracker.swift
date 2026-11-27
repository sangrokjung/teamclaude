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

    /// 60초 배경 스캔 결과(사용 흔적)를 넣는다.
    mutating func apply(_ scan: CliBackgroundScan) {
        grokActivity = scan.grokActivity
        agyActivity = scan.agyActivity
    }

    mutating func recordAgy(_ outcome: AgyFetchOutcome, now: Date) {
        switch outcome {
        case .ready:
            // 조회 성공이다. Gemini 레인이 없어도 "확인한 빈 상태"라 성공 시각을 갱신한다
            // (앞선 값을 지키는 실패 상태와 구분해, 빈 상태가 "조회 지연"으로 덮이지 않게 한다).
            agyOutcome = outcome
            agyFetchFailed = false
            agyLastOkAt = now
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
    var importers: [FileImporter] = []

    static func run(now: Date = Date()) -> CliBackgroundScan {
        CliBackgroundScan(
            grokActivity: CliActivityScanner.grok(root: CliActivityScanner.grokSessionsURL(), now: now),
            agyActivity: CliActivityScanner.agy(root: CliActivityScanner.agyConversationsURL(), now: now),
            report: CliFleetReport.load(),
            links: DashboardLinks.load(),
            importers: FileImporters.load())
    }
}

/// 60초 주기 배경 읽기와 스냅샷 쓰기의 조정(main.swift에서 옮김). 겹쳐 돌지 않게 하고,
/// 읽기는 메인 스레드 밖, 결과 반영은 호출한 쪽 큐(기본 메인), 파일 쓰기는 다시 메인 밖에서 한다.
final class CliFleetRefresher {
    private let lock = NSLock()
    private var running = false
    private let work: DispatchQueue
    private let callback: DispatchQueue
    private let scan: () -> CliBackgroundScan
    private let write: (CliStatusSnapshot) -> Bool

    init(work: DispatchQueue = .global(qos: .utility), callback: DispatchQueue = .main,
         scan: @escaping () -> CliBackgroundScan = { CliBackgroundScan.run() },
         write: @escaping (CliStatusSnapshot) -> Bool = { CliStatusFile.write($0) }) {
        self.work = work
        self.callback = callback
        self.scan = scan
        self.write = write
    }

    /// 이미 돌고 있으면 false(건너뜀). apply는 callback 큐에서 불리고, 쓸 스냅샷을 돌려주면 메인 밖에서 쓴다.
    /// done은 쓰기까지 끝난 뒤 불린다(쓰기 성공 여부, 쓸 것이 없으면 nil).
    @discardableResult
    func refresh(apply: @escaping (CliBackgroundScan) -> CliStatusSnapshot?, done: ((Bool?) -> Void)? = nil) -> Bool {
        lock.lock()
        guard !running else { lock.unlock(); return false }
        running = true
        lock.unlock()
        work.async { [self] in
            let result = scan()
            callback.async { [self] in
                let snapshot = apply(result)
                guard let snapshot else { finish(nil, done); return }
                work.async { [self] in
                    let ok = write(snapshot)
                    if !ok {
                        print("CLI-STATUS: 스냅샷 쓰기 실패")
                        fflush(stdout)
                    }
                    finish(ok, done)
                }
            }
        }
        return true
    }

    private func finish(_ result: Bool?, _ done: ((Bool?) -> Void)?) {
        lock.lock()
        running = false
        lock.unlock()
        done?(result)
    }
}
