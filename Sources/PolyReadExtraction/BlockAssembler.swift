import Foundation
import CoreGraphics
import PolyReadCore

/// One spoken token under construction. Carries every box it was built from, so
/// a hyphenated word arrives at §3 with the two boxes `SourceSpan` promises.
struct ProtoToken {
    var text: String
    var bboxes: [CGRect]
    var pageIndex: Int
}

struct ProtoBlock {
    var role: BlockRole
    var tokens: [ProtoToken]
    var pageIndex: Int
    var columnIndex: Int
    var glyphHeight: CGFloat
    var lineCount: Int
    var label: String?              // footnote bodies only
    var id: UUID = UUID()

    var text: String { tokens.map(\.text).joined(separator: " ") }

    func materialized(footnoteBodyIDs: [UUID] = []) -> Block {
        Block(
            id: id,
            role: role,
            spokenText: text,
            spans: tokens.map {
                SourceSpan(
                    pageIndex: $0.pageIndex,
                    bboxes: $0.bboxes,
                    // Filled in by ReflowDocumentBuilder once the document is laid out.
                    reflowRange: NSRange(location: 0, length: 0)
                )
            },
            footnoteBodyIDs: footnoteBodyIDs
        )
    }
}

/// §4.6 — the joining rules, plus the heading rule §4.6 relies on but does not
/// give a detector for.
public enum BlockAssembler {

    /// Gap tolerance before a vertical step counts as a paragraph break. §4.6:
    /// "vertical gap between baselines exceeding normal line-height ends a block."
    /// Set above 1.0 because justified text on a scan wobbles by a point or two.
    static let paragraphGapRatio: CGFloat = 1.35

    /// **Addition to §4.6, flagged deliberately.** Single-column book chapters —
    /// half the corpus — mark paragraphs with a first-line indent and *no* extra
    /// leading. The gap rule alone turns such a page into one 400-word block,
    /// which costs §8.4 its paragraph transport and §5 its pauses. A line that
    /// starts noticeably right of its column's left edge starts a paragraph.
    static let indentRatio: CGFloat = 0.8

    /// Headings: §4.6 requires the role but not how to find it. Vision supplies
    /// no font metadata (§4.1), so the test has to be geometric.
    static let headingHeightRatio: CGFloat = 1.12
    static let headingMaxLines = 2
    static let headingMaxTokens = 14

    static let terminalPunctuation: Set<Character> = [".", "!", "?", "\"", "”", "’", ":", ";"]

    // MARK: Paragraph grouping

    /// Splits a column's lines into paragraphs.
    static func paragraphs(lines: [Line]) -> [[Line]] {
        guard !lines.isEmpty else { return [] }

        let baselines = lines.map(\.baseline)
        var deltas: [CGFloat] = []
        if lines.count > 1 {
            for i in 1..<lines.count {
                let d = baselines[i - 1] - baselines[i]
                if d > 0 { deltas.append(d) }
            }
        }
        let lineHeight = deltas.isEmpty ? median(lines.map(\.glyphHeight)) * 1.2 : median(deltas)
        let leftEdge = lines.map(\.bbox.minX).min() ?? 0
        let bodyGlyph = median(lines.map(\.glyphHeight))

        var result: [[Line]] = []
        var current: [Line] = []

        for (i, line) in lines.enumerated() {
            var startsParagraph = current.isEmpty

            if !startsParagraph, i > 0 {
                let gap = lines[i - 1].baseline - line.baseline
                if gap > lineHeight * paragraphGapRatio { startsParagraph = true }
                // A negative or zero step means the column changed under us.
                if gap <= 0 { startsParagraph = true }
                if line.bbox.minX - leftEdge > bodyGlyph * indentRatio { startsParagraph = true }
            }

            if startsParagraph, !current.isEmpty {
                result.append(current)
                current = []
            }
            current.append(line)
        }
        if !current.isEmpty { result.append(current) }
        return result
    }

    // MARK: Tokenisation, markers, hyphenation

    /// Turns a paragraph's lines into spoken tokens, lifting out footnote markers
    /// (§4.5) and joining hyphenated words across the line break (§4.6).
    static func tokenize(
        paragraph: [Line],
        stripLeadingLabel: Bool = false
    ) -> (tokens: [ProtoToken], markers: [ProtoToken]) {
        var tokens: [ProtoToken] = []
        var markers: [ProtoToken] = []
        var pendingHyphen = false

        for (lineIndex, line) in paragraph.enumerated() {
            var lineRuns = line.runs

            // A footnote body opens with its own label; §4.5 keeps markers out of
            // speech, and that includes this one.
            if stripLeadingLabel, lineIndex == 0, let first = lineRuns.first,
               FootnoteClassifier.isMarkerText(
                   first.text.trimmingCharacters(in: CharacterSet(charactersIn: ".)]"))
               ) {
                lineRuns.removeFirst()
            }

            for run in lineRuns {
                let isMarker = FootnoteClassifier.isMarker(run: run, line: line)

                if pendingHyphen, !isMarker, var last = tokens.popLast() {
                    // §4.6 — drop the hyphen, one spoken token, two boxes.
                    last.text += run.text
                    last.bboxes.append(run.bbox)
                    tokens.append(last)
                    pendingHyphen = false
                    continue
                }

                if isMarker {
                    markers.append(
                        ProtoToken(
                            text: run.text.trimmingCharacters(in: CharacterSet(charactersIn: ".)]")),
                            bboxes: [run.bbox],
                            pageIndex: run.pageIndex
                        )
                    )
                    continue
                }

                tokens.append(
                    ProtoToken(text: run.text, bboxes: [run.bbox], pageIndex: run.pageIndex)
                )
            }

            // §4.6 — "line-final run ending in `-` or `‐`, next line begins
            // lowercase". The second half of the test needs the next line, so the
            // hyphen is only dropped once we can see it — a real compound
            // ("nation-state" broken at the hyphen) keeps its hyphen.
            pendingHyphen = false
            if var last = tokens.last, isHyphenated(last.text) {
                let nextLine = lineIndex + 1 < paragraph.count ? paragraph[lineIndex + 1] : nil
                let nextStartsLowercase = nextLine?.runs.first?.text.first?.isLowercase ?? false
                if nextStartsLowercase {
                    last.text = String(last.text.dropLast())
                    tokens[tokens.count - 1] = last
                    pendingHyphen = true
                }
            }
        }

        return (tokens.filter { !$0.text.isEmpty }, markers)
    }

    static func isHyphenated(_ text: String) -> Bool {
        guard let last = text.last else { return false }
        return (last == "-" || last == "\u{2010}") && text.count > 1
    }

    // MARK: Headings

    static func isHeading(_ block: ProtoBlock, bodyGlyphHeight: CGFloat) -> Bool {
        guard block.role == .body, !block.tokens.isEmpty else { return false }
        guard block.lineCount <= headingMaxLines, block.tokens.count <= headingMaxTokens else { return false }

        if bodyGlyphHeight > 0, block.glyphHeight >= bodyGlyphHeight * headingHeightRatio { return true }

        // Numbered section heads ("II.", "3.1", "Chapter 4") are set at body size
        // often enough that the height test alone misses them.
        let text = block.text
        guard let last = text.last, !terminalPunctuation.contains(last) else { return false }
        return isSectionNumber(block.tokens[0].text)
    }

    static func isSectionNumber(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: CharacterSet(charactersIn: ".)"))
        guard !trimmed.isEmpty, trimmed.count <= 8 else { return false }
        if trimmed.allSatisfy({ $0.isNumber || $0 == "." }) { return trimmed.contains(where: \.isNumber) }
        return trimmed.uppercased() == trimmed && trimmed.allSatisfy { "IVXLCDM".contains($0) }
    }

    // MARK: Cross-page merge

    /// §4.6 — "last block on page *N* doesn't end in terminal punctuation **and**
    /// first block on page *N+1* begins lowercase → merge into one `Block`."
    ///
    /// Without it every page break inserts a spurious pause and a chunk boundary
    /// mid-sentence.
    static func mergeAcrossPages(_ blocks: [ProtoBlock]) -> [ProtoBlock] {
        var result: [ProtoBlock] = []
        for block in blocks {
            guard
                var previous = result.last,
                previous.role == .body,
                block.role == .body,
                block.pageIndex > previous.pageIndex,
                let lastCharacter = previous.text.last,
                !terminalPunctuation.contains(lastCharacter),
                let firstCharacter = block.text.first,
                firstCharacter.isLowercase
            else {
                result.append(block)
                continue
            }

            previous.tokens.append(contentsOf: block.tokens)
            previous.lineCount += block.lineCount
            result[result.count - 1] = previous
        }
        return result
    }
}
