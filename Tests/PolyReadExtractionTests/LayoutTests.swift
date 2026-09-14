import Testing
import Foundation
import CoreGraphics
@testable import PolyReadExtraction
import PolyReadCore

/// US Letter, the shape of every reading in the corpus.
private let page = CGRect(x: 0, y: 0, width: 612, height: 792)

private func run(
    _ text: String,
    x: CGFloat,
    y: CGFloat,
    width: CGFloat = 40,
    height: CGFloat = 10,
    glyph: CGFloat? = nil,
    pageIndex: Int = 0
) -> TextRun {
    TextRun(
        text: text,
        bbox: CGRect(x: x, y: y, width: width, height: height),
        glyphHeight: glyph ?? height,
        baseline: y,
        pageIndex: pageIndex
    )
}

/// One line of `count` words starting at `x`, on baseline `y`.
private func line(_ words: [String], x: CGFloat, y: CGFloat, glyph: CGFloat = 10, pageIndex: Int = 0) -> [TextRun] {
    words.enumerated().map { index, word in
        run(word, x: x + CGFloat(index) * 45, y: y, width: 40, height: glyph, glyph: glyph, pageIndex: pageIndex)
    }
}

@Suite("§4.3 column detection")
struct ColumnDetectorTests {

    /// APSR and *World Politics* are two-column; book chapters are not. Both are
    /// in the corpus, so getting this wrong scrambles half of it.
    @Test("a two-column page is detected and ordered column-major")
    func twoColumns() {
        var runs: [TextRun] = []
        for row in 0..<12 {
            let y = 700 - CGFloat(row) * 14
            runs += line(["left", "column", "text"], x: 60, y: y)
            runs += line(["right", "column", "text"], x: 330, y: y)
        }

        let split = ColumnDetector.splitX(runs: runs, pageBox: page)
        #expect(split != nil)

        let ordered = ColumnDetector.order(runs: runs, pageBox: page)
        // Every word of the left column comes before any word of the right.
        let firstRightIndex = ordered.firstIndex { $0.bbox.minX > 300 }
        let lastLeftIndex = ordered.lastIndex { $0.bbox.minX < 300 }
        #expect(firstRightIndex != nil && lastLeftIndex != nil)
        #expect(lastLeftIndex! < firstRightIndex!)
        #expect(ordered.filter { $0.bbox.minX < 300 }.allSatisfy { $0.columnIndex == 0 })
    }

    @Test("a single-column page is ordered by descending y")
    func singleColumn() {
        var runs: [TextRun] = []
        for row in 0..<14 {
            runs += line(["single", "column", "body", "text", "here"], x: 72, y: 700 - CGFloat(row) * 14)
        }
        #expect(ColumnDetector.splitX(runs: runs, pageBox: page) == nil)

        let ordered = ColumnDetector.order(runs: runs, pageBox: page)
        #expect(ordered.first?.bbox.minY == 700)
        #expect(ordered.allSatisfy { $0.columnIndex == 0 })
    }

    /// §4.3 puts the gap "centred between 30% and 70% of page width". A wide left
    /// margin is a gap too, and must not be read as a gutter.
    @Test("a margin is not a gutter")
    func marginIsNotAGutter() {
        var runs: [TextRun] = []
        for row in 0..<14 {
            runs += line(["indented", "body", "text", "here", "now"], x: 260, y: 700 - CGFloat(row) * 14)
        }
        #expect(ColumnDetector.splitX(runs: runs, pageBox: page) == nil)
    }
}

@Suite("§4.4 running heads and page numbers")
struct FurnitureTests {

    /// §4.4 — "Position alone is insufficient — footnote bodies also live in the
    /// bottom region."
    @Test("a repeating head is furniture, body text in the same band is not")
    func repeatingHead() {
        var classifier = FurnitureClassifier()
        var pages: [[Line]] = []
        for pageIndex in 0..<10 {
            let head = Line(
                runs: line(["AMERICAN", "POLITICAL", "SCIENCE", "REVIEW"], x: 72, y: 760, pageIndex: pageIndex),
                columnIndex: 0,
                pageIndex: pageIndex
            )
            let folio = Line(
                runs: [run("\(100 + pageIndex)", x: 300, y: 40, pageIndex: pageIndex)],
                columnIndex: 0,
                pageIndex: pageIndex
            )
            let note = Line(
                runs: line(["a", "footnote", "body", "down", "here"], x: 72, y: 50, glyph: 8, pageIndex: pageIndex),
                columnIndex: 0,
                pageIndex: pageIndex
            )
            pages.append([head, folio, note])
            classifier.observe(lines: [head, folio, note], pageBox: page, pageIndex: pageIndex)
        }

        #expect(classifier.role(for: pages[3][0], pageBox: page) == .runningHead)
        #expect(classifier.role(for: pages[3][1], pageBox: page) == .pageNumber)
        // The footnote is in the bottom band but does not repeat, so it survives.
        #expect(classifier.role(for: pages[3][2], pageBox: page) == nil)
    }

    @Test("digit normalization makes a varying folio line repeat")
    func normalizedForm() {
        #expect(FurnitureClassifier.normalizedForm("Chapter 3") == "chapter #")
        #expect(FurnitureClassifier.normalizedForm("Chapter 47") == "chapter #")
        #expect(FurnitureClassifier.isBareNumber("44"))
        #expect(FurnitureClassifier.isBareNumber("[12]"))
        #expect(FurnitureClassifier.isBareNumber("xiv"))
        #expect(!FurnitureClassifier.isBareNumber("Introduction"))
    }

    @Test("text in the middle of the page is never furniture")
    func middleOfPage() {
        var classifier = FurnitureClassifier()
        let body = Line(runs: line(["body", "text"], x: 72, y: 400), columnIndex: 0, pageIndex: 0)
        classifier.observe(lines: [body], pageBox: page, pageIndex: 0)
        #expect(classifier.role(for: body, pageBox: page) == nil)
    }
}

@Suite("§4.5 footnotes")
struct FootnoteTests {

    /// §4.5 — smaller than the line median, raised above its baseline, and digits
    /// or one of † ‡ * §. All three, or a subscript or a small-caps word would
    /// qualify.
    @Test("a marker needs all three properties")
    func markerRequiresAllThree() {
        let body = Line(runs: line(["ordinary", "body", "text"], x: 72, y: 500), columnIndex: 0, pageIndex: 0)

        let marker = run("12", x: 200, y: 507, width: 6, height: 7, glyph: 7)
        #expect(FootnoteClassifier.isMarker(run: marker, line: body))

        // Right size and position, wrong text.
        let word = run("the", x: 200, y: 507, width: 6, height: 7, glyph: 7)
        #expect(!FootnoteClassifier.isMarker(run: word, line: body))

        // Right text and size, sitting on the baseline.
        let inline = run("12", x: 200, y: 500, width: 6, height: 7, glyph: 7)
        #expect(!FootnoteClassifier.isMarker(run: inline, line: body))

        // Right text and position, full size.
        let large = run("12", x: 200, y: 507, width: 6, height: 10, glyph: 10)
        #expect(!FootnoteClassifier.isMarker(run: large, line: body))

        #expect(FootnoteClassifier.isMarkerText("†"))
        #expect(FootnoteClassifier.isMarkerText("3."))
        #expect(!FootnoteClassifier.isMarkerText("word"))
    }

    /// §4.5 — "grouped upward from the page bottom until glyph height returns to
    /// body size."
    @Test("the apparatus is grouped upward and stops at body size")
    func bodiesGroupUpward() {
        var lines: [Line] = []
        // Body text down to y = 200.
        for row in 0..<20 {
            lines.append(
                Line(runs: line(["body", "text"], x: 72, y: 600 - CGFloat(row) * 20), columnIndex: 0, pageIndex: 0)
            )
        }
        // Three lines of notes at the bottom, in 8pt.
        for row in 0..<3 {
            lines.append(
                Line(
                    runs: line(["note", "text"], x: 72, y: 120 - CGFloat(row) * 12, glyph: 8),
                    columnIndex: 0,
                    pageIndex: 0
                )
            )
        }

        let indices = FootnoteClassifier.bodyLineIndices(lines: lines, bodyGlyphHeight: 10, pageBox: page)
        #expect(indices == Set([20, 21, 22]))
    }

    @Test("a page set entirely in small type is not one giant footnote")
    func noRunawayGrouping() {
        // Every line is 8pt, and the document's body median is 8pt too.
        let lines = (0..<20).map { row in
            Line(runs: line(["text"], x: 72, y: 700 - CGFloat(row) * 20, glyph: 8), columnIndex: 0, pageIndex: 0)
        }
        #expect(FootnoteClassifier.bodyLineIndices(lines: lines, bodyGlyphHeight: 8, pageBox: page).isEmpty)
    }
}

@Suite("§4.6 joining")
struct BlockAssemblerTests {

    @Test("a vertical gap ends a paragraph")
    func gapEndsParagraph() {
        var lines: [Line] = []
        for row in 0..<4 {
            lines.append(Line(runs: line(["a", "b"], x: 72, y: 700 - CGFloat(row) * 14), columnIndex: 0, pageIndex: 0))
        }
        // A gap of 30pt where the line height is 14.
        for row in 0..<3 {
            lines.append(Line(runs: line(["c", "d"], x: 72, y: 614 - CGFloat(row) * 14), columnIndex: 0, pageIndex: 0))
        }
        #expect(BlockAssembler.paragraphs(lines: lines).count == 2)
    }

    /// The deviation from §4.6 flagged in the commit message: book chapters mark
    /// paragraphs by indent alone, and the gap rule cannot see them.
    @Test("a first-line indent also starts a paragraph")
    func indentStartsParagraph() {
        var lines: [Line] = []
        for row in 0..<8 {
            // Evenly spaced; only the indent distinguishes the second paragraph.
            let x: CGFloat = row == 4 ? 90 : 72
            lines.append(Line(runs: line(["a", "b"], x: x, y: 700 - CGFloat(row) * 14), columnIndex: 0, pageIndex: 0))
        }
        #expect(BlockAssembler.paragraphs(lines: lines).count == 2)
    }

    /// §4.6 — "line-final run ending in `-` or `‐`, next line begins lowercase →
    /// join into one spoken token, drop the hyphen, emit one `SourceSpan`
    /// carrying **two** bboxes."
    @Test("a hyphenated word joins into one token with two boxes")
    func hyphenationJoin() {
        let paragraph = [
            Line(runs: [run("demo-", x: 72, y: 700)], columnIndex: 0, pageIndex: 0),
            Line(runs: [run("cracy", x: 72, y: 686), run("is", x: 130, y: 686)], columnIndex: 0, pageIndex: 0),
        ]
        let (tokens, _) = BlockAssembler.tokenize(paragraph: paragraph)
        #expect(tokens.map(\.text) == ["democracy", "is"])
        #expect(tokens[0].bboxes.count == 2)
        #expect(tokens[1].bboxes.count == 1)
    }

    @Test("a real compound keeps its hyphen when the next line is capitalised")
    func compoundKeepsHyphen() {
        let paragraph = [
            Line(runs: [run("Anglo-", x: 72, y: 700)], columnIndex: 0, pageIndex: 0),
            Line(runs: [run("American", x: 72, y: 686)], columnIndex: 0, pageIndex: 0),
        ]
        let (tokens, _) = BlockAssembler.tokenize(paragraph: paragraph)
        #expect(tokens.map(\.text) == ["Anglo-", "American"])
    }

    @Test("markers are lifted out of the spoken stream")
    func markersLifted() {
        let body = line(["The", "argument"], x: 72, y: 500)
        let marker = run("7", x: 170, y: 507, width: 5, height: 7, glyph: 7)
        let paragraph = [Line(runs: body + [marker], columnIndex: 0, pageIndex: 0)]

        let (tokens, markers) = BlockAssembler.tokenize(paragraph: paragraph)
        #expect(tokens.map(\.text) == ["The", "argument"])
        #expect(markers.map(\.text) == ["7"])
    }

    /// §4.6 — "v1 missed this; without it every page break inserts a spurious
    /// pause and a chunk boundary mid-sentence."
    @Test("a sentence running over a page break becomes one block")
    func crossPageMerge() {
        let first = ProtoBlock(
            role: .body,
            tokens: [ProtoToken(text: "the", bboxes: [], pageIndex: 0),
                     ProtoToken(text: "argument", bboxes: [], pageIndex: 0)],
            pageIndex: 0, columnIndex: 0, glyphHeight: 10, lineCount: 3
        )
        let second = ProtoBlock(
            role: .body,
            tokens: [ProtoToken(text: "continues", bboxes: [], pageIndex: 1),
                     ProtoToken(text: "here.", bboxes: [], pageIndex: 1)],
            pageIndex: 1, columnIndex: 0, glyphHeight: 10, lineCount: 2
        )
        let merged = BlockAssembler.mergeAcrossPages([first, second])
        #expect(merged.count == 1)
        #expect(merged[0].text == "the argument continues here.")
    }

    @Test("a finished sentence is not merged across a page break")
    func noMergeAfterTerminalPunctuation() {
        let first = ProtoBlock(
            role: .body,
            tokens: [ProtoToken(text: "done.", bboxes: [], pageIndex: 0)],
            pageIndex: 0, columnIndex: 0, glyphHeight: 10, lineCount: 1
        )
        let second = ProtoBlock(
            role: .body,
            tokens: [ProtoToken(text: "next", bboxes: [], pageIndex: 1)],
            pageIndex: 1, columnIndex: 0, glyphHeight: 10, lineCount: 1
        )
        #expect(BlockAssembler.mergeAcrossPages([first, second]).count == 2)

        // Nor when the next page opens with a capital.
        let capitalised = ProtoBlock(
            role: .body,
            tokens: [ProtoToken(text: "However", bboxes: [], pageIndex: 1)],
            pageIndex: 1, columnIndex: 0, glyphHeight: 10, lineCount: 1
        )
        let unfinished = ProtoBlock(
            role: .body,
            tokens: [ProtoToken(text: "and", bboxes: [], pageIndex: 0)],
            pageIndex: 0, columnIndex: 0, glyphHeight: 10, lineCount: 1
        )
        #expect(BlockAssembler.mergeAcrossPages([unfinished, capitalised]).count == 2)
    }

    /// §4.6 requires the role but gives no detector; this is the geometric one,
    /// which has to work for Vision too (no font metadata — §4.1).
    @Test("headings are found by size or by a section number")
    func headings() {
        let large = ProtoBlock(
            role: .body,
            tokens: [ProtoToken(text: "The", bboxes: [], pageIndex: 0),
                     ProtoToken(text: "Argument", bboxes: [], pageIndex: 0)],
            pageIndex: 0, columnIndex: 0, glyphHeight: 14, lineCount: 1
        )
        #expect(BlockAssembler.isHeading(large, bodyGlyphHeight: 10))

        let numbered = ProtoBlock(
            role: .body,
            tokens: [ProtoToken(text: "II.", bboxes: [], pageIndex: 0),
                     ProtoToken(text: "Evidence", bboxes: [], pageIndex: 0)],
            pageIndex: 0, columnIndex: 0, glyphHeight: 10, lineCount: 1
        )
        #expect(BlockAssembler.isHeading(numbered, bodyGlyphHeight: 10))

        let paragraph = ProtoBlock(
            role: .body,
            tokens: (0..<40).map { ProtoToken(text: "word\($0)", bboxes: [], pageIndex: 0) },
            pageIndex: 0, columnIndex: 0, glyphHeight: 10, lineCount: 5
        )
        #expect(!BlockAssembler.isHeading(paragraph, bodyGlyphHeight: 10))
    }
}
