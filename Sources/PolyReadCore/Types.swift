import Foundation
import CoreGraphics

// MARK: - §3 Frozen interface types
//
// These are contracts. They are reproduced here exactly as specified; changing
// any of them is a spec change, not a refactor. Everything downstream — the two
// extraction backends, the phonemizer, both Core ML passes, both highlight
// surfaces — meets here and nowhere else.

/// Unit of extraction. Backend-agnostic: PDFKit and Vision both produce these.
public struct TextRun: Sendable {
    public let text: String
    public let bbox: CGRect        // PDF user space, origin bottom-left
    public let glyphHeight: CGFloat
    public let baseline: CGFloat
    public let pageIndex: Int
    public var columnIndex: Int    // assigned by §4.2
    public var orderIndex: Int     // reading order across the document

    public init(
        text: String,
        bbox: CGRect,
        glyphHeight: CGFloat,
        baseline: CGFloat,
        pageIndex: Int,
        columnIndex: Int = 0,
        orderIndex: Int = 0
    ) {
        self.text = text
        self.bbox = bbox
        self.glyphHeight = glyphHeight
        self.baseline = baseline
        self.pageIndex = pageIndex
        self.columnIndex = columnIndex
        self.orderIndex = orderIndex
    }
}

public enum BlockRole: String, Sendable, Codable, CaseIterable {
    case body, heading, footnoteMarker, footnoteBody
    case runningHead, pageNumber, caption
}

extension BlockRole {
    /// Roles that reach the TTS stream at all. §4.4 excludes page furniture,
    /// §4.5 excludes both footnote markers and bodies from the *main* stream —
    /// but bodies are still phonemized and prosody-run in Phase A so §8.5 can
    /// interject them on demand.
    public var isSpoken: Bool {
        switch self {
        case .body, .heading, .caption, .footnoteBody: return true
        case .footnoteMarker, .runningHead, .pageNumber: return false
        }
    }

    /// Roles carried by the continuous main stream, in document order.
    public var isInMainStream: Bool {
        switch self {
        case .body, .heading, .caption: return true
        case .footnoteBody, .footnoteMarker, .runningHead, .pageNumber: return false
        }
    }
}

/// Provenance for exactly one spoken token.
public struct SourceSpan: Sendable, Codable, Equatable {
    public let pageIndex: Int
    public let bboxes: [CGRect]    // >1 when the word was hyphenated across lines
    public let reflowRange: NSRange

    public init(pageIndex: Int, bboxes: [CGRect], reflowRange: NSRange) {
        self.pageIndex = pageIndex
        self.bboxes = bboxes
        self.reflowRange = reflowRange
    }

    // Coded by hand rather than leaning on NSRange's synthesized conformance —
    // the sidecar in §7.4 is a persisted format and should not move if the
    // overlay's encoding ever changes.
    private enum CodingKeys: String, CodingKey {
        case pageIndex, bboxes, reflowLocation, reflowLength
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pageIndex = try c.decode(Int.self, forKey: .pageIndex)
        bboxes = try c.decode([CGRect].self, forKey: .bboxes)
        reflowRange = NSRange(
            location: try c.decode(Int.self, forKey: .reflowLocation),
            length: try c.decode(Int.self, forKey: .reflowLength)
        )
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(pageIndex, forKey: .pageIndex)
        try c.encode(bboxes, forKey: .bboxes)
        try c.encode(reflowRange.location, forKey: .reflowLocation)
        try c.encode(reflowRange.length, forKey: .reflowLength)
    }
}

/// Paragraph-level unit, post-normalization.
public struct Block: Sendable, Codable, Identifiable {
    public let id: UUID
    public let role: BlockRole
    public let spokenText: String         // normalized; markers removed, substitutions applied
    public let spans: [SourceSpan]        // INVARIANT: index-aligned 1:1 with whitespace-split
                                          // tokens of spokenText. See §5.
    public let footnoteBodyIDs: [UUID]    // footnotes referenced from inside this block

    public init(
        id: UUID = UUID(),
        role: BlockRole,
        spokenText: String,
        spans: [SourceSpan],
        footnoteBodyIDs: [UUID] = []
    ) {
        self.id = id
        self.role = role
        self.spokenText = spokenText
        self.spans = spans
        self.footnoteBodyIDs = footnoteBodyIDs
    }
}

/// ≤510 phonemes. May be a fragment of a Block.
public struct PhonemizedChunk: Sendable, Codable, Identifiable {
    public let id: UUID
    public let blockID: UUID
    public let tokens: [Int32]                  // Kokoro vocab, WITHOUT the two boundary zeros
    public let wordPhonemeRanges: [Range<Int>]  // into tokens; one entry per spoken token
    public let spanOffset: Int                  // index into Block.spans of this chunk's first word

    public init(
        id: UUID = UUID(),
        blockID: UUID,
        tokens: [Int32],
        wordPhonemeRanges: [Range<Int>],
        spanOffset: Int
    ) {
        self.id = id
        self.blockID = blockID
        self.tokens = tokens
        self.wordPhonemeRanges = wordPhonemeRanges
        self.spanOffset = spanOffset
    }
}

/// Phase A output, per chunk.
public struct ChunkTiming: Sendable, Codable {
    public let chunkID: UUID
    public let frameDurations: [Int]            // rounded to ≥1, one per token
    public var frameCount: Int { frameDurations.reduce(0, +) }

    public init(chunkID: UUID, frameDurations: [Int]) {
        self.chunkID = chunkID
        self.frameDurations = frameDurations
    }
}

/// Phase A output, flattened to document level. This is the playback timeline.
public struct WordTiming: Sendable, Codable {
    public let start: TimeInterval
    public let end: TimeInterval
    public let span: SourceSpan
    public let blockID: UUID

    public init(start: TimeInterval, end: TimeInterval, span: SourceSpan, blockID: UUID) {
        self.start = start
        self.end = end
        self.span = span
        self.blockID = blockID
    }
}
