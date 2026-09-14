import SwiftUI
import UIKit
import PolyReadCore

/// §10 — "**Compact width (iPhone): reflowed text.** A `UITextView`/TextKit view
/// built from the normalized `[Block]` list — not from `page.string`. Its
/// character ranges are `SourceSpan.reflowRange`. Highlight = a background
/// attribute on the current word's range, auto-scrolled to stay on screen. This
/// is the primary surface; build it first."
public struct ReflowTextView: UIViewRepresentable {

    let document: ReflowDocument
    let blocks: [Block]
    let highlightedRange: NSRange?
    let onTapMarker: (UUID) -> Void
    let onTapWord: (Int) -> Void

    public init(
        document: ReflowDocument,
        blocks: [Block],
        highlightedRange: NSRange?,
        onTapMarker: @escaping (UUID) -> Void,
        onTapWord: @escaping (Int) -> Void
    ) {
        self.document = document
        self.blocks = blocks
        self.highlightedRange = highlightedRange
        self.onTapMarker = onTapMarker
        self.onTapWord = onTapWord
    }

    public func makeCoordinator() -> Coordinator {
        Coordinator(onTapMarker: onTapMarker, onTapWord: onTapWord)
    }

    public func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.alwaysBounceVertical = true
        textView.backgroundColor = .systemBackground
        textView.textContainerInset = UIEdgeInsets(top: 24, left: 20, bottom: 120, right: 20)
        textView.textContainer.lineFragmentPadding = 0

        let tap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleTap(_:))
        )
        // Let the text view keep its own selection gestures.
        tap.cancelsTouchesInView = false
        textView.addGestureRecognizer(tap)

        context.coordinator.textView = textView
        context.coordinator.apply(document: document, blocks: blocks)
        return textView
    }

    public func updateUIView(_ textView: UITextView, context: Context) {
        context.coordinator.onTapMarker = onTapMarker
        context.coordinator.onTapWord = onTapWord
        context.coordinator.apply(document: document, blocks: blocks)
        context.coordinator.highlight(highlightedRange)
    }

    @MainActor
    public final class Coordinator: NSObject {
        weak var textView: UITextView?
        var onTapMarker: (UUID) -> Void
        var onTapWord: (Int) -> Void

        private var appliedText: String?
        private var currentRange: NSRange?
        private var markerTargets: [(range: NSRange, id: UUID)] = []
        private var wordRanges: [(range: NSRange, index: Int)] = []

        static let highlightColor = UIColor.tintColor.withAlphaComponent(0.28)

        init(onTapMarker: @escaping (UUID) -> Void, onTapWord: @escaping (Int) -> Void) {
            self.onTapMarker = onTapMarker
            self.onTapWord = onTapWord
        }

        /// Building the attributed string is the expensive part, so it happens
        /// once per document rather than once per highlight tick.
        func apply(document: ReflowDocument, blocks: [Block]) {
            guard let textView, appliedText != document.text else { return }
            appliedText = document.text

            let attributed = NSMutableAttributedString(string: document.text)
            let full = NSRange(location: 0, length: attributed.length)
            attributed.addAttribute(.foregroundColor, value: UIColor.label, range: full)

            for paragraph in document.paragraphs {
                guard paragraph.range.location + paragraph.range.length <= attributed.length else { continue }
                attributed.addAttributes(Self.attributes(for: paragraph.role), range: paragraph.range)
            }

            // §4.5 — markers stay "visible and tappable". Set apart so they read
            // as superscripts rather than as stray numbers in the sentence.
            markerTargets = []
            for marker in document.markers {
                guard marker.range.location + marker.range.length <= attributed.length else { continue }
                attributed.addAttributes(
                    [
                        .font: UIFont.systemFont(ofSize: 11, weight: .semibold),
                        .foregroundColor: UIColor.tintColor,
                        .baselineOffset: 6,
                    ],
                    range: marker.range
                )
                if let id = marker.footnoteBodyID {
                    markerTargets.append((marker.range, id))
                }
            }

            textView.attributedText = attributed

            // Flattened word ranges, for tap-to-seek and for resolving a tap
            // location back to a timeline index.
            wordRanges = []
            var index = 0
            for block in blocks where block.role.isInMainStream {
                for span in block.spans {
                    wordRanges.append((span.reflowRange, index))
                    index += 1
                }
            }
            currentRange = nil
        }

        static func attributes(for role: BlockRole) -> [NSAttributedString.Key: Any] {
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = 5
            paragraph.paragraphSpacing = 14

            switch role {
            case .heading:
                return [
                    .font: UIFont.preferredFont(forTextStyle: .title3).withWeight(.semibold),
                    .paragraphStyle: paragraph,
                ]
            case .footnoteBody:
                paragraph.firstLineHeadIndent = 12
                paragraph.headIndent = 12
                return [
                    .font: UIFont.preferredFont(forTextStyle: .footnote),
                    .foregroundColor: UIColor.secondaryLabel,
                    .paragraphStyle: paragraph,
                ]
            case .runningHead, .pageNumber:
                // §4.4 — "Excluded from speech, retained in the reflow view."
                return [
                    .font: UIFont.preferredFont(forTextStyle: .caption2),
                    .foregroundColor: UIColor.tertiaryLabel,
                    .paragraphStyle: paragraph,
                ]
            case .caption:
                return [
                    .font: UIFont.preferredFont(forTextStyle: .subheadline),
                    .foregroundColor: UIColor.secondaryLabel,
                    .paragraphStyle: paragraph,
                ]
            case .body, .footnoteMarker:
                return [
                    .font: UIFont.preferredFont(forTextStyle: .body),
                    .paragraphStyle: paragraph,
                ]
            }
        }

        /// Only the two changed ranges are touched — repainting the whole string
        /// at screen refresh would drop frames on a long document.
        func highlight(_ range: NSRange?) {
            guard let textView else { return }
            let storage = textView.textStorage
            guard range != currentRange else { return }

            storage.beginEditing()
            if let old = currentRange, NSMaxRange(old) <= storage.length {
                storage.removeAttribute(.backgroundColor, range: old)
            }
            if let range, NSMaxRange(range) <= storage.length {
                storage.addAttribute(.backgroundColor, value: Self.highlightColor, range: range)
            }
            storage.endEditing()
            currentRange = range

            if let range { scrollToKeepVisible(range, in: textView) }
        }

        /// §10 — "auto-scrolled to stay on screen." Scrolls only when the word has
        /// left a comfortable band, so the text is not twitching on every word.
        private func scrollToKeepVisible(_ range: NSRange, in textView: UITextView) {
            guard
                let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
                let end = textView.position(from: start, offset: range.length),
                let textRange = textView.textRange(from: start, to: end)
            else { return }

            let rect = textView.firstRect(for: textRange)
            guard rect.isFinite, !rect.isNull else { return }

            let visible = textView.bounds.inset(
                by: UIEdgeInsets(
                    top: textView.adjustedContentInset.top + 60,
                    left: 0,
                    bottom: textView.adjustedContentInset.bottom + 200,
                    right: 0
                )
            )
            let visibleInContent = visible.offsetBy(dx: 0, dy: textView.contentOffset.y)
            guard !visibleInContent.contains(rect) else { return }

            // Park the word about a third of the way down: enough of the next
            // sentences visible to read ahead, enough behind to keep the thread.
            let target = rect.midY - textView.bounds.height / 3
            let maximum = max(0, textView.contentSize.height - textView.bounds.height
                + textView.adjustedContentInset.bottom)
            textView.setContentOffset(
                CGPoint(x: 0, y: min(max(0, target), maximum)),
                animated: true
            )
        }

        @objc func handleTap(_ gesture: UITapGestureRecognizer) {
            guard let textView else { return }
            let point = gesture.location(in: textView)
            guard let position = textView.closestPosition(to: point) else { return }
            let offset = textView.offset(from: textView.beginningOfDocument, to: position)

            // §4.5 / §8.5 — a marker wins over the word underneath it.
            if let marker = markerTargets.first(where: { NSLocationInRange(offset, $0.range) }) {
                onTapMarker(marker.id)
                return
            }
            if let word = wordRanges.first(where: { NSLocationInRange(offset, $0.range) }) {
                onTapWord(word.index)
            }
        }
    }
}

extension UIFont {
    func withWeight(_ weight: UIFont.Weight) -> UIFont {
        let descriptor = fontDescriptor.addingAttributes([
            .traits: [UIFontDescriptor.TraitKey.weight: weight]
        ])
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}
