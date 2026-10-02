import Foundation

@main
struct AgyUsageTests {
    static func main() {
        let payload = """
        {"num_turns":0,"command":{"name":"usage","data":{"groups":[
          {"name":"Gemini Models","buckets":[
            {"window":"weekly","remaining_fraction":0.9977394938468933,"reset_time":"2026-09-29T06:35:05Z"},
            {"window":"5h","remaining_fraction":0.9794501662254333,"reset_time":"2026-09-22T11:35:05Z"}
          ]},
          {"name":"Claude and GPT models","buckets":[
            {"window":"weekly","remaining_fraction":0.6647859811782837,"reset_time":"2026-09-29T06:36:57Z"},
            {"window":"5h","remaining_fraction":0,"reset_time":"2026-09-22T11:36:57Z"}
          ]}
        ]}}}
        """.data(using: .utf8)!
        let groups = agyQuotaGroups(from: payload)
        precondition(groups?.count == 2, "agy usage keeps both model groups")
        precondition(agyDisplayName(groups![0].name) == "Gemini 모델")
        precondition(agyRemainingLabel(groups![0].weekly!.remaining) == "99.8% 남음")
        precondition(agyRemainingLabel(groups![0].fiveHour!.remaining) == "97.9% 남음")
        precondition(agyDisplayName(groups![1].name) == "Claude·GPT")
        precondition(agyRemainingLabel(groups![1].weekly!.remaining) == "66.5% 남음")
        precondition(agyRemainingLabel(groups![1].fiveHour!.remaining) == "0% 남음")
        let reset = groups![1].fiveHour!.resetAt
        let now = ISO8601DateFormatter().date(from: "2026-09-22T09:22:57Z")!
        precondition(agyResetHint(reset, now: now) == "2시간 뒤")

        precondition(agyQuotaGroups(from: Data("{\"command\":{\"name\":\"usage\",\"data\":{}}}".utf8)) == nil, "missing groups fail")
        let outOfRange = """
        {"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"weekly","remaining_fraction":1.5}]}]}}}
        """.data(using: .utf8)!
        precondition(agyQuotaGroups(from: outOfRange) == nil, "fraction outside 0...1 fails the payload")
        precondition(agyRemainingLabel(1.2) == nil)
        precondition(agyRemainingLabel(0) == "0% 남음", "a real zero remaining stays visible")

        let unknown = AgyCardModel(message: "agy 확인 필요", groups: [])
        precondition(agyLogLine(unknown) == "agy 확인 필요")
        precondition(!agyLogLine(unknown).contains("0%"), "an unknown agy state must not look like zero remaining")
        let started = """
        {"num_turns":1,"command":{"name":"usage","data":{"groups":[{"name":"Gemini Models","buckets":[{"window":"weekly","remaining_fraction":1}]}]}}}
        """.data(using: .utf8)!
        precondition(agyQuotaGroups(from: started) == nil, "a model turn is not a quota snapshot")

        print("agy usage parser test passed")
    }
}
