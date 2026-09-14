import Testing
import Foundation
import CoreGraphics
@testable import PolyReadLinguistics
import PolyReadCore

private func block(_ text: String) -> Block {
    let tokens = SpanInvariant.tokens(of: text)
    return Block(
        role: .body,
        spokenText: text,
        spans: tokens.enumerated().map { index, _ in
            SourceSpan(
                pageIndex: 0,
                bboxes: [CGRect(x: CGFloat(index) * 10, y: 100, width: 8, height: 10)],
                reflowRange: NSRange(location: 0, length: 0)
            )
        }
    )
}

@Suite("§5 normalization")
struct NormalizerTests {

    let normalizer = Normalizer()

    @Test("the §5 table", arguments: [
        ("Putnam et al. 1993", "Putnam et al 1993"),
        ("some scholars, e.g. Linz, disagree", "some scholars, for example Linz, disagree"),
        ("the median voter, i.e. the pivotal one", "the median voter, that is the pivotal one"),
        ("cf. Huntington", "compare Huntington"),
        ("ibid. 44", "ibid 44"),
        ("see pp. 40-52 below", "see pages 40 to 52 below"),
    ])
    func table(input: String, expected: String) {
        #expect(normalizer.normalize(block(input)).spokenText == expected)
    }

    /// The rule fires on the abbreviation; the punctuation wrapped around it is
    /// part of the sentence and has to survive.
    @Test("punctuation around a substitution survives")
    func affixes() {
        #expect(normalizer.normalize(block("(e.g., Linz)")).spokenText == "(for example, Linz)")
        #expect(normalizer.normalize(block("ibid.,")).spokenText == "ibid,")
    }

    /// §5 — "Any substitution that changes token count **must emit one
    /// `SourceSpan` per resulting spoken token, all pointing at the same source
    /// bbox.**" This is the assertion §12 wants in every agent's build.
    @Test("the span invariant survives every substitution")
    func invariantHolds() {
        let inputs = [
            "Putnam et al. 1993 argued",
            "some scholars, e.g. Linz, disagree",
            "i.e. the pivotal voter",
            "cf. ibid. pp. 40-52",
            "(e.g., Linz) and (i.e., Stepan)",
            "no substitutions here at all",
        ]
        for input in inputs {
            let result = normalizer.normalize(block(input))
            #expect(
                SpanInvariant.holds(for: result),
                "\(input) -> \(result.spokenText) has \(result.spans.count) spans"
            )
        }
    }

    @Test("an expanded abbreviation points both new tokens at the source box")
    func expansionSpans() {
        let result = normalizer.normalize(block("scholars e.g. Linz"))
        let tokens = SpanInvariant.tokens(of: result.spokenText)
        #expect(tokens.map(String.init) == ["scholars", "for", "example", "Linz"])
        // "for" and "example" both came from the one "e.g." box.
        #expect(result.spans[1].bboxes == result.spans[2].bboxes)
        #expect(result.spans[1].bboxes.first?.minX == 10)
    }

    /// §5 — "In-text author-date citations are read naturally. Do not strip them."
    @Test("citations are left alone")
    func citationsUntouched() {
        let input = "as Putnam (1993, 45) shows"
        #expect(normalizer.normalize(block(input)).spokenText == input)
    }

    @Test("page furniture is not normalized")
    func skipsUnspokenRoles() {
        let head = Block(
            role: .runningHead,
            spokenText: "e.g. 44",
            spans: [
                SourceSpan(pageIndex: 0, bboxes: [], reflowRange: NSRange(location: 0, length: 0)),
                SourceSpan(pageIndex: 0, bboxes: [], reflowRange: NSRange(location: 0, length: 0)),
            ]
        )
        #expect(normalizer.normalize(head).spokenText == "e.g. 44")
    }
}
