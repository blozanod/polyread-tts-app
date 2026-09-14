import Foundation
import PolyReadCore

/// §5 — "Ordered find-replace on block text, before G2P. Not an NLP layer."
///
/// It operates on the *token array*, not the string, because the span invariant
/// is defined over tokens: "Any substitution that changes token count must emit
/// one `SourceSpan` per resulting spoken token, all pointing at the same source
/// bbox." Rewriting the string and re-splitting would lose that alignment, and
/// §5 is explicit that when it breaks "the bug will look like a timing bug."
public struct Normalizer: Sendable {

    /// A rule sees the token array at a position and either declines or reports
    /// how many tokens it consumed and what it produced.
    struct Rule: Sendable {
        let name: String
        let apply: @Sendable (_ tokens: [String], _ index: Int) -> (consumed: Int, output: [String])?
    }

    public init() {}

    public func normalize(_ blocks: [Block]) -> [Block] {
        let out = blocks.map(normalize(_:))
        SpanInvariant.check(out, stage: "Normalizer.normalize")
        return out
    }

    public func normalize(_ block: Block) -> Block {
        guard block.role.isSpoken else { return block }

        let tokens = SpanInvariant.tokens(of: block.spokenText).map(String.init)
        guard tokens.count == block.spans.count else {
            // The invariant is already broken upstream; substituting would only
            // bury the evidence. Debug builds trap in `check`; release passes it
            // through untouched so the import still completes.
            SpanInvariant.check(block, stage: "Normalizer.normalize (input)")
            return block
        }

        var outTokens: [String] = []
        var outSpans: [SourceSpan] = []
        var i = 0

        while i < tokens.count {
            var matched = false
            for rule in Self.rules {
                guard let (consumed, output) = rule.apply(tokens, i), consumed > 0 else { continue }

                // §5 — every output token points at every source box the match
                // consumed. One source token becoming two spoken tokens means two
                // spans on the same bbox; the highlight lights that word twice,
                // which is exactly right.
                let sourceSpans = block.spans[i..<min(i + consumed, block.spans.count)]
                let mergedBoxes = sourceSpans.flatMap(\.bboxes)
                let page = sourceSpans.first?.pageIndex ?? 0
                for token in output {
                    outTokens.append(token)
                    outSpans.append(
                        SourceSpan(
                            pageIndex: page,
                            bboxes: mergedBoxes,
                            reflowRange: NSRange(location: 0, length: 0)
                        )
                    )
                }
                i += consumed
                matched = true
                break
            }

            if !matched {
                outTokens.append(tokens[i])
                outSpans.append(block.spans[i])
                i += 1
            }
        }

        let result = Block(
            id: block.id,
            role: block.role,
            spokenText: outTokens.joined(separator: " "),
            spans: outSpans,
            footnoteBodyIDs: block.footnoteBodyIDs
        )
        SpanInvariant.check(result, stage: "Normalizer.normalize (output)")
        return result
    }

    // MARK: - §5's table, in order

    /// §5 lists exactly these. §11 adds: "No number-expansion layer beyond §5.
    /// Fix what you actually hear; don't pre-solve." So nothing else goes here
    /// without having been heard to be wrong first.
    static let rules: [Rule] = [
        .init(name: "et al.") { tokens, i in
            guard i + 1 < tokens.count else { return nil }
            guard core(tokens[i]).lowercased() == "et" else { return nil }
            let (_, next, trail) = affixes(tokens[i + 1])
            guard next.lowercased() == "al" else { return nil }
            return (2, ["et", "al" + keepingNonPeriods(trail)])
        },
        .init(name: "e.g.") { tokens, i in
            expand(tokens, i, from: "e.g", to: ["for", "example"])
        },
        .init(name: "i.e.") { tokens, i in
            expand(tokens, i, from: "i.e", to: ["that", "is"])
        },
        .init(name: "cf.") { tokens, i in
            expand(tokens, i, from: "cf", to: ["compare"])
        },
        .init(name: "ibid.") { tokens, i in
            expand(tokens, i, from: "ibid", to: ["ibid"])
        },
        .init(name: "pp. A-B") { tokens, i in
            guard i + 1 < tokens.count else { return nil }
            let head = core(tokens[i]).lowercased()
            guard head == "pp" else { return nil }

            let (lead, body, trail) = affixes(tokens[i + 1])
            guard let dash = body.firstIndex(where: { $0 == "-" || $0 == "–" || $0 == "—" })
            else { return nil }
            let from = String(body[body.startIndex..<dash])
            let to = String(body[body.index(after: dash)...])
            guard !from.isEmpty, !to.isEmpty,
                  from.allSatisfy(\.isNumber), to.allSatisfy(\.isNumber)
            else { return nil }

            return (2, [lead + "pages", from, "to", to + keepingNonPeriods(trail)])
        },
    ]

    // MARK: - Affix handling
    //
    // "(e.g.," has to come out as "(for example," — the substitution is on the
    // abbreviation, not on the punctuation wrapped around it.

    nonisolated(unsafe) static let leadingPunctuation = CharacterSet(charactersIn: "([{\"'“‘")
    nonisolated(unsafe) static let trailingPunctuation = CharacterSet(charactersIn: ".,;:)]}\"'”’")

    static func affixes(_ token: String) -> (leading: String, core: String, trailing: String) {
        var start = token.startIndex
        while start < token.endIndex, token[start].unicodeScalars.allSatisfy(leadingPunctuation.contains) {
            start = token.index(after: start)
        }
        var end = token.endIndex
        while end > start {
            let previous = token.index(before: end)
            guard token[previous].unicodeScalars.allSatisfy(trailingPunctuation.contains) else { break }
            end = previous
        }
        return (
            String(token[token.startIndex..<start]),
            String(token[start..<end]),
            String(token[end..<token.endIndex])
        )
    }

    static func core(_ token: String) -> String { affixes(token).core }

    /// The abbreviating period is part of the abbreviation and goes away with it;
    /// a comma or a closing paren belongs to the sentence and stays.
    static func keepingNonPeriods(_ trailing: String) -> String {
        String(trailing.filter { $0 != "." })
    }

    static func expand(
        _ tokens: [String],
        _ i: Int,
        from: String,
        to output: [String]
    ) -> (consumed: Int, output: [String])? {
        let (lead, body, trail) = affixes(tokens[i])
        guard body.lowercased() == from else { return nil }
        var result = output
        result[0] = lead + result[0]
        result[result.count - 1] += keepingNonPeriods(trail)
        return (1, result)
    }
}
