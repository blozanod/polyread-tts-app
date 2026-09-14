import Foundation
import CoreGraphics
import PDFKit
import PolyReadCore

public struct ExtractionResult: Sendable {
    public let blocks: [Block]
    public let decision: BackendDecision
    public let title: String
    public let pageCount: Int
    /// Non-fatal §5 invariant breaks, for the import diagnostics panel.
    public let invariantViolations: [String]
}

/// Agent A — §4. PDF URL in, `[Block]` out, source-agnostic from §4.2 onward.
public struct DocumentExtractor {

    public typealias ProgressHandler = @Sendable (_ pagesDone: Int, _ pagesTotal: Int) -> Void

    public init() {}

    /// §4.2 — scores both backends and reports which it would use, without doing
    /// the full extraction. The import flow calls this first so it can stop and
    /// ask before spending a minute on OCR that will produce nonsense.
    public func survey(url: URL) throws -> BackendDecision {
        guard let document = PDFDocument(url: url) else { throw PolyReadError.noPages }
        guard document.pageCount > 0 else { throw PolyReadError.noPages }
        return BackendSelector().decide(document: document)
    }

    public func extract(
        url: URL,
        decision: BackendDecision? = nil,
        progress: ProgressHandler? = nil
    ) throws -> ExtractionResult {
        guard let document = PDFDocument(url: url) else { throw PolyReadError.noPages }
        let pageCount = document.pageCount
        guard pageCount > 0 else { throw PolyReadError.noPages }

        let decision = try decision ?? BackendSelector().decide(document: document)
        let backend: any TextRunBackend = (decision.choice == .embedded)
            ? PDFKitBackend()
            : VisionBackend()

        // Pass 1 — runs and lines per page, plus the cross-page statistics §4.4
        // needs before it can call anything a running head.
        var pageLines: [[Line]] = []
        var pageBoxes: [CGRect] = []
        var furniture = FurnitureClassifier()
        var allGlyphHeights: [CGFloat] = []

        for index in 0..<pageCount {
            defer { progress?(index + 1, pageCount * 2) }
            guard let page = document.page(at: index) else {
                pageLines.append([])
                pageBoxes.append(.zero)
                continue
            }
            let box = page.bounds(for: .cropBox)
            pageBoxes.append(box)

            let raw = (try? backend.runs(forPageAt: index, in: document)) ?? []
            let ordered = ColumnDetector.order(runs: raw, pageBox: box)
            let lines = orderedLines(from: ordered)
            pageLines.append(lines)
            furniture.observe(lines: lines, pageBox: box, pageIndex: index)
            allGlyphHeights.append(contentsOf: lines.map(\.glyphHeight))
        }

        // The document's body glyph height. Taken across the whole document, not
        // per page, so a page that is *entirely* footnotes does not redefine what
        // body size means.
        let bodyGlyphHeight = median(allGlyphHeights)

        // Pass 2 — classify, tokenize, assemble.
        var proto: [ProtoBlock] = []
        var footnoteBodies: [ProtoBlock] = []
        var markerBlocks: [(marker: ProtoBlock, hostIndex: Int, label: String)] = []

        for index in 0..<pageCount {
            defer { progress?(pageCount + index + 1, pageCount * 2) }
            let lines = pageLines[index]
            let box = pageBoxes[index]
            guard !lines.isEmpty else { continue }

            // §4.4 furniture, §4.5 footnote bodies, everything else is main text.
            var furnitureLines: [(Line, BlockRole)] = []
            var candidateLines: [Line] = []
            for line in lines {
                if let role = furniture.role(for: line, pageBox: box) {
                    furnitureLines.append((line, role))
                } else {
                    candidateLines.append(line)
                }
            }

            let bodyIndices = FootnoteClassifier.bodyLineIndices(
                lines: candidateLines,
                bodyGlyphHeight: bodyGlyphHeight,
                pageBox: box
            )
            let mainLines = candidateLines.enumerated()
                .filter { !bodyIndices.contains($0.offset) }
                .map(\.element)
            let noteLines = candidateLines.enumerated()
                .filter { bodyIndices.contains($0.offset) }
                .map(\.element)

            // Page furniture is excluded from speech but kept for the reflow view.
            for (line, role) in furnitureLines {
                proto.append(
                    ProtoBlock(
                        role: role,
                        tokens: line.runs.map {
                            ProtoToken(text: $0.text, bboxes: [$0.bbox], pageIndex: $0.pageIndex)
                        },
                        pageIndex: index,
                        columnIndex: line.columnIndex,
                        glyphHeight: line.glyphHeight,
                        lineCount: 1
                    )
                )
            }

            // Main text, per column so a paragraph never straddles the gutter.
            for column in Set(mainLines.map(\.columnIndex)).sorted() {
                let columnLines = mainLines.filter { $0.columnIndex == column }
                for paragraph in BlockAssembler.paragraphs(lines: columnLines) {
                    let (tokens, markers) = BlockAssembler.tokenize(paragraph: paragraph)
                    guard !tokens.isEmpty || !markers.isEmpty else { continue }

                    var block = ProtoBlock(
                        role: .body,
                        tokens: tokens,
                        pageIndex: index,
                        columnIndex: column,
                        glyphHeight: median(paragraph.map(\.glyphHeight)),
                        lineCount: paragraph.count
                    )
                    if BlockAssembler.isHeading(block, bodyGlyphHeight: bodyGlyphHeight) {
                        block.role = .heading
                    }
                    if !tokens.isEmpty { proto.append(block) }

                    let hostIndex = proto.count - 1
                    for marker in markers {
                        markerBlocks.append(
                            (
                                ProtoBlock(
                                    role: .footnoteMarker,
                                    tokens: [marker],
                                    pageIndex: index,
                                    columnIndex: column,
                                    glyphHeight: 0,
                                    lineCount: 1
                                ),
                                hostIndex,
                                marker.text
                            )
                        )
                    }
                }
            }

            // §4.5 footnote bodies — one block per note, split on the leading label.
            for column in Set(noteLines.map(\.columnIndex)).sorted() {
                let columnLines = noteLines.filter { $0.columnIndex == column }
                    .sorted { $0.baseline > $1.baseline }
                var current: [Line] = []
                var currentLabel: String?

                func flush() {
                    guard !current.isEmpty else { return }
                    let (tokens, _) = BlockAssembler.tokenize(paragraph: current, stripLeadingLabel: true)
                    guard !tokens.isEmpty else { current = []; return }
                    footnoteBodies.append(
                        ProtoBlock(
                            role: .footnoteBody,
                            tokens: tokens,
                            pageIndex: index,
                            columnIndex: column,
                            glyphHeight: median(current.map(\.glyphHeight)),
                            lineCount: current.count,
                            label: currentLabel
                        )
                    )
                    current = []
                }

                for line in columnLines {
                    if let label = FootnoteClassifier.leadingLabel(of: line), !current.isEmpty {
                        flush()
                        currentLabel = label
                    } else if current.isEmpty {
                        currentLabel = FootnoteClassifier.leadingLabel(of: line)
                    }
                    current.append(line)
                }
                flush()
            }
        }

        // §4.6 cross-page paragraph merge. Runs over main-stream blocks only —
        // footnote bodies were pulled out above and never straddle a page.
        proto = BlockAssembler.mergeAcrossPages(proto)

        // Pair each marker with the footnote body it points at: same page, same
        // label. Falls back to the k-th note on the page when labels are symbols
        // rather than numbers, which is the convention §8.5's tap relies on.
        var bodiesByPage: [Int: [ProtoBlock]] = [:]
        for body in footnoteBodies { bodiesByPage[body.pageIndex, default: []].append(body) }

        var footnoteIDsByHost: [UUID: [UUID]] = [:]
        // marker block index -> (resolved marker, host block index, body id)
        var resolved: [(marker: ProtoBlock, hostIndex: Int, bodyID: UUID?)] = []
        var markerOrdinal: [Int: Int] = [:]

        for (marker, hostIndex, label) in markerBlocks {
            var marker = marker
            let page = marker.pageIndex
            let ordinal = markerOrdinal[page, default: 0]
            markerOrdinal[page] = ordinal + 1

            let candidates = bodiesByPage[page] ?? []
            let matched = candidates.first { $0.label == label }
                ?? (ordinal < candidates.count ? candidates[ordinal] : nil)

            marker.label = label
            if let matched, hostIndex >= 0, hostIndex < proto.count {
                footnoteIDsByHost[proto[hostIndex].id, default: []].append(matched.id)
            }
            resolved.append((marker, hostIndex, matched?.id))
        }

        // Interleave: each main block, then the markers that came out of it, then
        // this page's footnote bodies after the last block on the page.
        var blocks: [Block] = []
        var markersByHost: [Int: [(ProtoBlock, UUID?)]] = [:]
        for entry in resolved {
            markersByHost[entry.hostIndex, default: []].append((entry.marker, entry.bodyID))
        }

        var emittedNotesForPage = Set<Int>()
        for (i, block) in proto.enumerated() {
            blocks.append(block.materialized(footnoteBodyIDs: footnoteIDsByHost[block.id] ?? []))
            for (marker, bodyID) in markersByHost[i] ?? [] {
                blocks.append(marker.materialized(footnoteBodyIDs: bodyID.map { [$0] } ?? []))
            }
            let isLastOnPage = (i + 1 >= proto.count) || proto[i + 1].pageIndex != block.pageIndex
            if isLastOnPage, !emittedNotesForPage.contains(block.pageIndex) {
                emittedNotesForPage.insert(block.pageIndex)
                for body in bodiesByPage[block.pageIndex] ?? [] {
                    blocks.append(body.materialized())
                }
            }
        }
        // Notes on pages with no main text at all still have to reach §8.5.
        for (page, bodies) in bodiesByPage.sorted(by: { $0.key < $1.key })
        where !emittedNotesForPage.contains(page) {
            for body in bodies { blocks.append(body.materialized()) }
        }

        guard !blocks.isEmpty else { throw PolyReadError.extractionProducedNothing }
        SpanInvariant.check(blocks, stage: "DocumentExtractor.extract")

        return ExtractionResult(
            blocks: blocks,
            decision: decision,
            title: title(of: document, url: url),
            pageCount: pageCount,
            invariantViolations: SpanInvariant.violations(in: blocks)
        )
    }

    private func orderedLines(from runs: [TextRun]) -> [Line] {
        let lines = ColumnDetector.groupIntoLines(runs: runs)
        return lines.sorted { a, b in
            if a.columnIndex != b.columnIndex { return a.columnIndex < b.columnIndex }
            return a.baseline > b.baseline
        }
    }

    /// §9 — "title from the PDF's document title or filename".
    private func title(of document: PDFDocument, url: URL) -> String {
        if let attributes = document.documentAttributes,
           let title = attributes[PDFDocumentAttribute.titleAttribute] as? String,
           !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return title
        }
        return url.deletingPathExtension().lastPathComponent
    }
}
