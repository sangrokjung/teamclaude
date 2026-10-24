import Cocoa
import ObjectiveC

// 스냅샷이 "화면에 실제로 그려진 글자"를 모으는 기록기(A5: 영어 화면에 한글 0자).
// NSString·NSAttributedString의 그리기 메서드를 스냅샷 프로세스에서만 바꿔 끼워, 어떤 뷰가 어떤 경로로 그리든
// 글자를 빠짐없이 모은다. 운영 경로에서는 install()을 부르지 않으므로 아무 일도 하지 않는다.
// 셀이 직접 그리는 컨트롤(NSButton·NSTextField) 제목은 collectControlTitles가 뷰 트리에서 따로 모은다.

enum DrawnTextRecorder {
    private(set) static var strings: [String] = []
    private static var installed = false

    static func reset() { strings = [] }

    static func record(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { strings.append(trimmed) }
    }

    /// 보이는 컨트롤의 제목을 모은다. 숨은 뷰와 그 자식은 건너뛴다.
    static func collectControlTitles(in view: NSView) {
        guard !view.isHidden, view.alphaValue > 0 else { return }
        if let button = view as? NSButton, !(view is PanelButton) {
            record(button.attributedTitle.string.isEmpty ? button.title : button.attributedTitle.string)
        } else if let field = view as? NSTextField {
            record(field.stringValue)
        }
        for child in view.subviews { collectControlTitles(in: child) }
    }

    static func install() {
        guard !installed else { return }
        installed = true
        swap(NSString.self, #selector(NSString.draw(at:withAttributes:)), #selector(NSString.cc_recordingDraw(at:withAttributes:)))
        swap(NSString.self, #selector(NSString.draw(in:withAttributes:)), #selector(NSString.cc_recordingDraw(in:withAttributes:)))
        swap(NSString.self, #selector(NSString.draw(with:options:attributes:context:)),
             #selector(NSString.cc_recordingDraw(with:options:attributes:context:)))
        swap(NSAttributedString.self, #selector(NSAttributedString.draw(at:)), #selector(NSAttributedString.cc_recordingDraw(at:)))
        swap(NSAttributedString.self, #selector(NSAttributedString.draw(in:)), #selector(NSAttributedString.cc_recordingDraw(in:)))
        swap(NSAttributedString.self, #selector(NSAttributedString.draw(with:options:context:)),
             #selector(NSAttributedString.cc_recordingDraw(with:options:context:)))
    }

    private static func swap(_ cls: AnyClass, _ original: Selector, _ replacement: Selector) {
        guard let a = class_getInstanceMethod(cls, original), let b = class_getInstanceMethod(cls, replacement) else { return }
        method_exchangeImplementations(a, b)
    }
}

extension NSString {
    @objc func cc_recordingDraw(at point: NSPoint, withAttributes attrs: [NSAttributedString.Key: Any]?) {
        DrawnTextRecorder.record(self as String)
        cc_recordingDraw(at: point, withAttributes: attrs)
    }

    @objc func cc_recordingDraw(in rect: NSRect, withAttributes attrs: [NSAttributedString.Key: Any]?) {
        DrawnTextRecorder.record(self as String)
        cc_recordingDraw(in: rect, withAttributes: attrs)
    }

    @objc func cc_recordingDraw(with rect: NSRect, options: NSString.DrawingOptions, attributes: [NSAttributedString.Key: Any]?,
                                context: NSStringDrawingContext?) {
        DrawnTextRecorder.record(self as String)
        cc_recordingDraw(with: rect, options: options, attributes: attributes, context: context)
    }
}

extension NSAttributedString {
    @objc func cc_recordingDraw(at point: NSPoint) {
        DrawnTextRecorder.record(string)
        cc_recordingDraw(at: point)
    }

    @objc func cc_recordingDraw(in rect: NSRect) {
        DrawnTextRecorder.record(string)
        cc_recordingDraw(in: rect)
    }

    @objc func cc_recordingDraw(with rect: NSRect, options: NSString.DrawingOptions, context: NSStringDrawingContext?) {
        DrawnTextRecorder.record(string)
        cc_recordingDraw(with: rect, options: options, context: context)
    }
}
