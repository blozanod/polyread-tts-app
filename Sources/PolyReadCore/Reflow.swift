import Foundation
import CoreGraphics

/// §10 — the compact-width surface is "a `UITextView`/TextKit view built from the
/// normalized `[Block]` list — not from `page.string`. Its character ranges are
/// `SourceSpan.reflowRange`."
///
/// So `reflowRange` cannot be filled in during extraction: nobody knows a token's
/// character offset until the whole document has been laid out as one string. This
/// builder does that layout and hands back blocks whose spans carry real ranges.
/// It runs once, after normalization and before Phase A, so every `WordTiming`
/// minted downstream already points at the right characters.
public struct ReflowDocument: Sendable, Codable {

    public struct Paragraph: Sendable, Codable {
        public let blockID: UUID
        public let role: BlockRole
        public let range: NSRange

        public init(blockID: UUID, role: BlockRole, range: NSRange) {
            self.blockID = blockID
            self.role = role
            self.range = range
        }

        private enum CodingKeys: String, CodingKey { case blockID, role, location, length }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            blockID = try c.decode(UUID.self, forKey: .blockID)
            role = try c.decode(BlockRole.self, forKey: .role)
            range = NSRange(
                location: try c.decode(Int.self, forKey: .location),
                length: try c.decode(Int.self, forKey: .length)
            )
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(blockID, forKey: .blockID)
            try c.encode(role, forKey: .role)
            try c.encode(range.location, forKey: .location)
            try c.encode(range.length, forKey: .length)
        }
    }

    /// §4.5 — markers are "kept visible and tappable in the reflow view — this is
    /// the affordance for §8.5."
    public struct Marker: Sendable, Codable {
        public let range: NSRange
        public let label: String
        public let footnoteBodyID: UUID?

        public init(range: NSRange, label: String, footnoteBodyID: UUID?) {
            self.range = range
            self.label = label
            self.footnoteBodyID = footnoteBodyID
        }

        private enum CodingKeys: String, CodingKey { case location, length, label, footnoteBodyID }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            range = NSRange(
                location: try c.decode(Int.self, forKey: .location),
                length: try c.decode(Int.self, forKey: .length)
            )
            label = try c.decode(String.self, forKey: .label)
            footnoteBodyID = try c.decodeIfPresent(UUID.self, forKey: .footnoteBodyID)
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(range.location, forKey: .location)
            try c.encode(range.length, forKey: .length)
            try c.encode(label, forKey: .label)
            try c.encodeIfPresent(footnoteBodyID, forKey: .footnoteBodyID)
        }
    }

    public let text: String
    public let paragraphs: [Paragraph]
    public let markers: [Marker]

    public init(text: String, paragraphs: [Paragraph], markers: [Marker]) {
        self.text = text
        self.paragraphs = paragraphs
        self.markers = markers
    }

    public func paragraph(for blockID: UUID) -> Paragraph? {
        paragraphs.first { $0.blockID == blockID }
    }

    public func marker(at characterIndex: Int) -> Marker? {
        markers.first { NSLocationInRange(characterIndex, $0.range) }
    }
}

public enum ReflowDocumentBuilder {

    /// Lays `blocks` out as one string and returns them with `reflowRange` filled in.
    ///
    /// `.footnoteMarker` blocks do not become paragraphs of their own — a marker
    /// belongs *inside* a sentence, and promoting it to a paragraph would shred the
    /// paragraph it interrupts. Each one is spliced into the preceding spoken
    /// paragraph at the token it follows, located geometrically (see `insertionToken`).
    public static func build(blocks: [Block]) -> (document: ReflowDocument, blocks: [Block]) {
        var text = ""
        var paragraphs: [ReflowDocument.Paragraph] = []
        var markers: [ReflowDocument.Marker] = []
        var rebuilt: [Block] = []

        // Markers are attached to the paragraph they follow, so they have to be
        // pulled out of the stream and grouped before any laying out happens.
        var pendingMarkers: [Int: [Block]] = [:]   // index into `carriers` -> markers
        var carriers: [Block] = []
        for block in blocks {
            if block.role == .footnoteMarker {
                // Attach to the most recent paragraph that can hold text.
                let target = carriers.lastIndex { $0.role.isInMainStream } ?? max(0, carriers.count - 1)
                pendingMarkers[target, default: []].append(block)
            } else {
                carriers.append(block)
            }
        }

        for (carrierIndex, block) in carriers.enumerated() {
            if !text.isEmpty {
                text += "\n\n"
            }
            let paragraphStart = text.utf16.count

            let tokens = SpanInvariant.tokens(of: block.spokenText).map(String.init)
            let attached = (pendingMarkers[carrierIndex] ?? []).sorted { a, b in
                readingOrderLess(a.spans.first, b.spans.first)
            }

            // For each token index, which markers sit immediately after it.
            var markersAfterToken: [Int: [Block]] = [:]
            for marker in attached {
                let slot = insertionToken(for: marker, in: block, tokenCount: tokens.count)
                markersAfterToken[slot, default: []].append(marker)
            }

            var newSpans: [SourceSpan] = []
            newSpans.reserveCapacity(block.spans.count)

            for (tokenIndex, token) in tokens.enumerated() {
                if tokenIndex > 0 { text += " " }
                let tokenStart = text.utf16.count
                text += token
                let tokenLength = text.utf16.count - tokenStart

                let old = block.spans[tokenIndex]
                newSpans.append(
                    SourceSpan(
                        pageIndex: old.pageIndex,
                        bboxes: old.bboxes,
                        reflowRange: NSRange(location: tokenStart, length: tokenLength)
                    )
                )

                for marker in markersAfterToken[tokenIndex] ?? [] {
                    let markerStart = text.utf16.count
                    let label = marker.spokenText.trimmingCharacters(in: .whitespacesAndNewlines)
                    text += label
                    markers.append(
                        ReflowDocument.Marker(
                            range: NSRange(location: markerStart, length: text.utf16.count - markerStart),
                            label: label,
                            footnoteBodyID: marker.footnoteBodyIDs.first
                        )
                    )
                    // The marker block keeps its own identity, with a reflow range
                    // that now points at real characters, so §8.5 can find it.
                    rebuilt.append(
                        Block(
                            id: marker.id,
                            role: .footnoteMarker,
                            spokenText: marker.spokenText,
                            spans: [
                                SourceSpan(
                                    pageIndex: marker.spans.first?.pageIndex ?? old.pageIndex,
                                    bboxes: marker.spans.first?.bboxes ?? [],
                                    reflowRange: NSRange(
                                        location: markerStart,
                                        length: text.utf16.count - markerStart
                                    )
                                )
                            ],
                            footnoteBodyIDs: marker.footnoteBodyIDs
                        )
                    )
                }
            }

            // A marker whose slot fell past the last token (or an empty paragraph).
            for marker in markersAfterToken[tokens.count] ?? [] {
                let markerStart = text.utf16.count
                let label = marker.spokenText.trimmingCharacters(in: .whitespacesAndNewlines)
                text += label
                markers.append(
                    ReflowDocument.Marker(
                        range: NSRange(location: markerStart, length: text.utf16.count - markerStart),
                        label: label,
                        footnoteBodyID: marker.footnoteBodyIDs.first
                    )
                )
                rebuilt.append(
                    Block(
                        id: marker.id,
                        role: .footnoteMarker,
                        spokenText: marker.spokenText,
                        spans: [
                            SourceSpan(
                                pageIndex: marker.spans.first?.pageIndex ?? 0,
                                bboxes: marker.spans.first?.bboxes ?? [],
                                reflowRange: NSRange(
                                    location: markerStart,
                                    length: text.utf16.count - markerStart
                                )
                            )
                        ],
                        footnoteBodyIDs: marker.footnoteBodyIDs
                    )
                )
            }

            paragraphs.append(
                ReflowDocument.Paragraph(
                    blockID: block.id,
                    role: block.role,
                    range: NSRange(location: paragraphStart, length: text.utf16.count - paragraphStart)
                )
            )
            rebuilt.append(
                Block(
                    id: block.id,
                    role: block.role,
                    spokenText: block.spokenText,
                    spans: newSpans,
                    footnoteBodyIDs: block.footnoteBodyIDs
                )
            )
        }

        SpanInvariant.check(rebuilt, stage: "ReflowDocumentBuilder.build")
        let document = ReflowDocument(text: text, paragraphs: paragraphs, markers: markers)
        return (document, rebuilt)
    }

    /// Which token does this marker sit after?
    ///
    /// A superscript marker hugs the right edge of the word it annotates, raised
    /// but still vertically overlapping that word's box. So: among tokens on the
    /// same page whose box overlaps the marker vertically and ends at or before the
    /// marker starts, take the rightmost. Falling through to "end of paragraph" is
    /// the safe failure — the marker stays visible and tappable, just late.
    static func insertionToken(for marker: Block, in block: Block, tokenCount: Int) -> Int {
        guard let markerSpan = marker.spans.first,
              let markerBox = markerSpan.bboxes.first,
              tokenCount > 0
        else { return tokenCount }

        var best: Int?
        var bestMaxX = -CGFloat.greatestFiniteMagnitude

        for (i, span) in block.spans.enumerated() where span.pageIndex == markerSpan.pageIndex {
            guard let box = span.bboxes.last else { continue }
            let verticallyOverlaps = box.maxY > markerBox.minY && box.minY < markerBox.maxY
            guard verticallyOverlaps else { continue }
            let tolerance = max(1, markerBox.width)
            guard box.maxX <= markerBox.minX + tolerance else { continue }
            if box.maxX > bestMaxX {
                bestMaxX = box.maxX
                best = i
            }
        }
        return best ?? tokenCount
    }

    static func readingOrderLess(_ a: SourceSpan?, _ b: SourceSpan?) -> Bool {
        guard let a, let b else { return false }
        if a.pageIndex != b.pageIndex { return a.pageIndex < b.pageIndex }
        guard let ab = a.bboxes.first, let bb = b.bboxes.first else { return false }
        // PDF user space: origin bottom-left, so later on the page means lower y.
        if abs(ab.midY - bb.midY) > max(ab.height, bb.height) * 0.5 {
            return ab.midY > bb.midY
        }
        return ab.minX < bb.minX
    }
}
