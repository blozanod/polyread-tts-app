import Testing
import Foundation
@testable import PolyReadCore

/// §12 — "Shared invariant to test in every agent's debug build."
@Suite("§5 span invariant")
struct SpanInvariantTests {

    private func spans(_ n: Int) -> [SourceSpan] {
        (0..<n).map { SourceSpan(pageIndex: 0, bboxes: [], reflowRange: NSRange(location: $0, length: 1)) }
    }

    @Test("token count and span count must agree")
    func holds() {
        let good = Block(role: .body, spokenText: "one two three", spans: spans(3))
        #expect(SpanInvariant.holds(for: good))

        let bad = Block(role: .body, spokenText: "one two three", spans: spans(2))
        #expect(!SpanInvariant.holds(for: bad))
        #expect(SpanInvariant.violations(in: [bad]).count == 1)
    }

    /// Collapsing runs of whitespace matters: a double space between sentences
    /// would otherwise produce a phantom token that every later span is shifted by.
    @Test("runs of whitespace produce one boundary, not several")
    func whitespaceRuns() {
        #expect(SpanInvariant.tokens(of: "one  two\tthree\nfour").count == 4)
        #expect(SpanInvariant.tokens(of: "   ").isEmpty)
        #expect(SpanInvariant.tokens(of: "").isEmpty)
    }

    @Test("an empty block is consistent")
    func empty() {
        #expect(SpanInvariant.holds(for: Block(role: .body, spokenText: "", spans: [])))
    }
}
