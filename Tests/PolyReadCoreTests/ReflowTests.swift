import Testing
import Foundation
import CoreGraphics
@testable import PolyReadCore

private func block(
    _ role: BlockRole,
    _ text: String,
    page: Int = 0,
    boxes: [CGRect]? = nil,
    footnotes: [UUID] = []
) -> Block {
    let tokens = SpanInvariant.tokens(of: text)
    return Block(
        role: role,
        spokenText: text,
        spans: tokens.enumerated().map { index, _ in
            SourceSpan(
                pageIndex: page,
                bboxes: [boxes?[safe: index] ?? CGRect(x: CGFloat(index) * 50, y: 500, width: 45, height: 10)],
                reflowRange: NSRange(location: 0, length: 0)
            )
        },
        footnoteBodyIDs: footnotes
    )
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

@Suite("§10 reflow layout")
struct ReflowTests {

    /// §10 — "Its character ranges are `SourceSpan.reflowRange`." Nothing else
    /// can fill these in: no one knows a token's offset until the whole document
    /// is one string.
    @Test("every token's reflow range points at its own characters")
    func rangesAreCorrect() {
        let blocks = [block(.heading, "The Argument"), block(.body, "Democracy is contested here")]
        let (document, rebuilt) = ReflowDocumentBuilder.build(blocks: blocks)
        let text = document.text as NSString

        for laid in rebuilt where laid.role != .footnoteMarker {
            let tokens = SpanInvariant.tokens(of: laid.spokenText).map(String.init)
            #expect(tokens.count == laid.spans.count)
            for (token, span) in zip(tokens, laid.spans) {
                #expect(text.substring(with: span.reflowRange) == token)
            }
        }
    }

    @Test("paragraph ranges cover their blocks")
    func paragraphRanges() {
        let blocks = [block(.body, "one two"), block(.body, "three four")]
        let (document, _) = ReflowDocumentBuilder.build(blocks: blocks)
        #expect(document.paragraphs.count == 2)
        let text = document.text as NSString
        #expect(text.substring(with: document.paragraphs[0].range) == "one two")
        #expect(text.substring(with: document.paragraphs[1].range) == "three four")
    }

    /// §4.5 — markers are "kept visible and tappable in the reflow view — this is
    /// the affordance for §8.5." Promoting one to its own paragraph would shred
    /// the sentence it interrupts, so it is spliced in where it belongs.
    @Test("a marker is spliced into the sentence, not made a paragraph")
    func markerSplicedInline() {
        let noteID = UUID()
        let body = block(
            .body,
            "Democracy is contested",
            boxes: [
                CGRect(x: 0, y: 500, width: 80, height: 10),
                CGRect(x: 90, y: 500, width: 20, height: 10),
                CGRect(x: 115, y: 500, width: 90, height: 10),
            ]
        )
        // Superscript, immediately after "is".
        let marker = Block(
            role: .footnoteMarker,
            spokenText: "7",
            spans: [
                SourceSpan(
                    pageIndex: 0,
                    bboxes: [CGRect(x: 111, y: 505, width: 5, height: 7)],
                    reflowRange: NSRange(location: 0, length: 0)
                )
            ],
            footnoteBodyIDs: [noteID]
        )

        let (document, _) = ReflowDocumentBuilder.build(blocks: [body, marker])
        #expect(document.text == "Democracy is7 contested")
        #expect(document.paragraphs.count == 1)
        #expect(document.markers.count == 1)
        #expect(document.markers[0].footnoteBodyID == noteID)
        #expect((document.text as NSString).substring(with: document.markers[0].range) == "7")
    }

    @Test("a marker with no geometry lands at the end rather than vanishing")
    func markerFallback() {
        let marker = Block(
            role: .footnoteMarker,
            spokenText: "*",
            spans: [SourceSpan(pageIndex: 0, bboxes: [], reflowRange: NSRange(location: 0, length: 0))],
            footnoteBodyIDs: []
        )
        let (document, _) = ReflowDocumentBuilder.build(blocks: [block(.body, "one two"), marker])
        #expect(document.text == "one two*")
        #expect(document.markers.count == 1)
    }

    /// §4.4 — furniture is "Excluded from speech, retained in the reflow view."
    @Test("page furniture is laid out but carries no spoken role")
    func furnitureRetained() {
        let blocks = [block(.runningHead, "AMERICAN POLITICAL SCIENCE REVIEW"), block(.body, "one two")]
        let (document, _) = ReflowDocumentBuilder.build(blocks: blocks)
        #expect(document.paragraphs.count == 2)
        #expect(document.paragraphs[0].role == .runningHead)
        #expect(!BlockRole.runningHead.isSpoken)
    }

    @Test("the span invariant survives the layout pass")
    func invariantSurvives() {
        let blocks = [
            block(.heading, "One"),
            block(.body, "two three four"),
            block(.footnoteBody, "a note body"),
        ]
        let (_, rebuilt) = ReflowDocumentBuilder.build(blocks: blocks)
        #expect(SpanInvariant.violations(in: rebuilt).isEmpty)
    }
}
