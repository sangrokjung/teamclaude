// menubar/Tests/AgyTitleSlotTests.swift
import Foundation

@main
struct AgyTitleSlotTests {
    static func main() {
        func bucket(_ remaining: Double) -> AgyQuotaBucket {
            AgyQuotaBucket(remaining: remaining, resetAt: nil)
        }

        // 제목에는 우리가 쓰는 레인(Gemini)의 주간 잔량만 올린다 — 같은 계정의 Claude·GPT 한도는 빼고.
        let twoGroups = AgyCardModel(message: nil, groups: [
            AgyQuotaGroup(name: "Gemini Models", weekly: bucket(0.988), fiveHour: bucket(1.0)),
            AgyQuotaGroup(name: "Claude and GPT models", weekly: bucket(0.306), fiveHour: bucket(1.0)),
        ])
        // 98.8%는 올리지 않고 98%로 쓴다.
        precondition(agyTitleSlot(twoGroups) == "Agy 98%", agyTitleSlot(twoGroups) ?? "nil")

        // 순서가 바뀌어도 Gemini를 찾아 쓴다.
        let reversed = AgyCardModel(message: nil, groups: [
            AgyQuotaGroup(name: "Claude and GPT models", weekly: bucket(0.306), fiveHour: bucket(1.0)),
            AgyQuotaGroup(name: "Gemini Models", weekly: bucket(0.5), fiveHour: bucket(1.0)),
        ])
        precondition(agyTitleSlot(reversed) == "Agy 50%", agyTitleSlot(reversed) ?? "nil")

        // Gemini 그룹이 없으면 제목에 아무것도 넣지 않는다(Claude·GPT 숫자로 대신하지 않는다).
        let noGemini = AgyCardModel(message: nil, groups: [
            AgyQuotaGroup(name: "Claude and GPT models", weekly: bucket(0.07), fiveHour: bucket(1.0)),
        ])
        precondition(agyTitleSlot(noGemini) == nil, agyTitleSlot(noGemini) ?? "nil")

        // 남은 양을 올려 말하지 않는다 — 99.5%는 99%, 0.4%는 0%.
        let almostFull = AgyCardModel(message: nil, groups: [
            AgyQuotaGroup(name: "Gemini Models", weekly: bucket(0.995), fiveHour: nil),
        ])
        precondition(agyTitleSlot(almostFull) == "Agy 99%", agyTitleSlot(almostFull) ?? "nil")
        let almostEmpty = AgyCardModel(message: nil, groups: [
            AgyQuotaGroup(name: "Gemini Models", weekly: bucket(0.004), fiveHour: nil),
        ])
        precondition(agyTitleSlot(almostEmpty) == "Agy 0%", agyTitleSlot(almostEmpty) ?? "nil")

        // 카드에도 Gemini 레인만 올린다 — 안 쓰는 Claude·GPT 쿼터가 섞이면 남은 양을 오독한다.
        let mixed = [
            AgyQuotaGroup(name: "Gemini Models", weekly: bucket(0.9), fiveHour: nil),
            AgyQuotaGroup(name: "Claude and GPT models", weekly: bucket(0.3), fiveHour: nil),
        ]
        let visible = agyVisibleGroups(mixed)
        precondition(visible.count == 1, "Gemini 레인만 남아야 한다: \(visible.count)")
        precondition(visible[0].name == "Gemini Models", visible[0].name)

        // Gemini가 없으면 비운다. Claude·GPT로 대체하지 않는다.
        precondition(agyVisibleGroups([
            AgyQuotaGroup(name: "Claude and GPT models", weekly: bucket(0.3), fiveHour: nil),
        ]).isEmpty, "Gemini가 없으면 비어야 한다")

        // 0~1 밖 값은 읽을 수 없는 값으로 보고 제목을 비운다(0%로 단정하지 않는다).
        let negative = AgyCardModel(message: nil, groups: [
            AgyQuotaGroup(name: "Gemini Models", weekly: bucket(-0.2), fiveHour: nil),
        ])
        precondition(agyTitleSlot(negative) == nil, agyTitleSlot(negative) ?? "nil")
        let overOne = AgyCardModel(message: nil, groups: [
            AgyQuotaGroup(name: "Gemini Models", weekly: bucket(1.5), fiveHour: nil),
        ])
        precondition(agyTitleSlot(overOne) == nil, agyTitleSlot(overOne) ?? "nil")

        // Gemini를 포함하는 그룹이 둘이면 앞의 것을 쓴다(카드가 둘 다 보여 준다).
        let duplicate = AgyCardModel(message: nil, groups: [
            AgyQuotaGroup(name: "Gemini Models", weekly: bucket(0.8), fiveHour: nil),
            AgyQuotaGroup(name: "Gemini Experimental", weekly: bucket(0.1), fiveHour: nil),
        ])
        precondition(agyTitleSlot(duplicate) == "Agy 80%", agyTitleSlot(duplicate) ?? "nil")

        // Gemini가 있어도 주간 버킷이 없으면 비워 둔다(5시간 값으로 대신하지 않는다).
        let fiveHourOnly = AgyCardModel(message: nil, groups: [
            AgyQuotaGroup(name: "Gemini Models", weekly: nil, fiveHour: bucket(1.0)),
        ])
        precondition(agyTitleSlot(fiveHourOnly) == nil, agyTitleSlot(fiveHourOnly) ?? "nil")

        // 데이터가 없거나 메시지만 있는 카드도 제목을 차지하지 않는다.
        precondition(agyTitleSlot(AgyCardModel(message: nil, groups: [])) == nil)
        precondition(agyTitleSlot(AgyCardModel(message: "agy 확인 필요", groups: [])) == nil)

        print("AgyTitleSlotTests: Gemini-only title slot, order independence, missing group/weekly, empty passed")
    }
}
