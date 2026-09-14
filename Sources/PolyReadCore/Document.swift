import Foundation

/// §7.4 — "a JSON sidecar holding `[WordTiming]` and `[Block]`. Keyed by PDF
/// content hash so reopening a document is instant."
///
/// This is that sidecar plus the two things it would be silly to recompute: the
/// laid-out reflow text (§10) and the per-footnote timelines Phase A already paid
/// for (§4.5, §8.5).
public struct DocumentSidecar: Sendable, Codable {
    /// Bumped whenever anything upstream of the cache changes meaning — a new
    /// normalization rule, a different voice, a chunker fix. A mismatch forces a
    /// re-import rather than replaying a stale timeline against fresh audio.
    public static let currentVersion = 3

    public let version: Int
    public let contentHash: String
    public let title: String
    public let pageCount: Int
    public let voiceName: String
    public let blocks: [Block]
    public let words: [WordTiming]
    /// Phase A's inputs and outputs, kept so a document whose Phase B was
    /// interrupted resumes rendering without paying for prosody a second time.
    public let mainChunks: [PhonemizedChunk]
    public let footnoteChunks: [UUID: [PhonemizedChunk]]
    public let chunkTimings: [ChunkTiming]
    public let reflow: ReflowDocument
    /// Footnote bodies are not in the main stream, so they get their own
    /// timelines, keyed by the footnote body block's id.
    public let footnoteTimelines: [UUID: [WordTiming]]
    public let createdAt: Date

    public init(
        version: Int = DocumentSidecar.currentVersion,
        contentHash: String,
        title: String,
        pageCount: Int,
        voiceName: String,
        blocks: [Block],
        words: [WordTiming],
        mainChunks: [PhonemizedChunk],
        footnoteChunks: [UUID: [PhonemizedChunk]],
        chunkTimings: [ChunkTiming],
        reflow: ReflowDocument,
        footnoteTimelines: [UUID: [WordTiming]],
        createdAt: Date = Date()
    ) {
        self.version = version
        self.contentHash = contentHash
        self.title = title
        self.pageCount = pageCount
        self.voiceName = voiceName
        self.blocks = blocks
        self.words = words
        self.mainChunks = mainChunks
        self.footnoteChunks = footnoteChunks
        self.chunkTimings = chunkTimings
        self.reflow = reflow
        self.footnoteTimelines = footnoteTimelines
        self.createdAt = createdAt
    }

    public var duration: TimeInterval { words.last?.end ?? 0 }
}

/// How far Phase B has rendered. Persisted alongside the CAF so a half-rendered
/// document resumes where it stopped instead of starting over (§7.3).
///
/// Chunks are tracked as a set rather than a high-water mark because §7.3
/// requires seeking into unrendered territory to work: that renders one chunk
/// out of order, and the file has a hole in it until Phase B walks past.
public struct RenderProgress: Sendable, Codable, Equatable {
    /// Indices into the document's main-stream chunk list.
    public var renderedChunks: Set<Int>
    public var totalChunks: Int
    /// Exact frame offsets, from Phase A. Index `i` is where chunk `i` starts;
    /// the last element is the document's total frame count.
    public var chunkFrameOffsets: [Int]

    public init(renderedChunks: Set<Int> = [], totalChunks: Int = 0, chunkFrameOffsets: [Int] = []) {
        self.renderedChunks = renderedChunks
        self.totalChunks = totalChunks
        self.chunkFrameOffsets = chunkFrameOffsets
    }

    public var isComplete: Bool { totalChunks > 0 && renderedChunks.count == totalChunks }

    /// §7.3 — "Show the rendered-through edge on the scrubber permanently, like a
    /// video preload bar." That edge is the end of the *contiguous* rendered run
    /// from the start, not the furthest chunk rendered.
    public var contiguousChunkCount: Int {
        var count = 0
        while count < totalChunks, renderedChunks.contains(count) { count += 1 }
        return count
    }

    public var framesRendered: Int {
        let index = contiguousChunkCount
        guard index < chunkFrameOffsets.count else { return chunkFrameOffsets.last ?? 0 }
        return chunkFrameOffsets[index]
    }

    public var renderedThrough: TimeInterval { FrameMath.seconds(frames: framesRendered) }

    /// Is the audio under this timestamp on disk?
    public func isRendered(at time: TimeInterval) -> Bool {
        chunkIndex(at: time).map(renderedChunks.contains) ?? false
    }

    public func chunkIndex(at time: TimeInterval) -> Int? {
        let frame = FrameMath.frames(seconds: time)
        guard chunkFrameOffsets.count > 1 else { return nil }
        var lo = 0
        var hi = chunkFrameOffsets.count - 2
        guard frame >= chunkFrameOffsets[0], frame < chunkFrameOffsets[hi + 1] else { return nil }
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if chunkFrameOffsets[mid] <= frame { lo = mid } else { hi = mid - 1 }
        }
        return lo
    }
}

public enum PolyReadError: LocalizedError {
    case noPages
    case extractionProducedNothing
    case ocrQualityTooLow(score: Double)
    case modelMissing(String)
    case modelShapeMismatch(String)
    case voicesFileMalformed(String)
    case voiceNotFound(String)
    case phonemizerUnavailable(String)
    case phonemizerLacksWordGrouping
    case chunkExceedsBudget(count: Int)
    case cacheWriteFailed(String)
    case audioFormatUnavailable

    public var errorDescription: String? {
        switch self {
        case .noPages:
            return "That PDF has no pages."
        case .extractionProducedNothing:
            return "No readable text came out of that PDF."
        case .ocrQualityTooLow(let score):
            return "Text recognition scored \(String(format: "%.2f", score)) — the result is likely to be nonsense."
        case .modelMissing(let name):
            return "Core ML package \(name) is not in the app bundle."
        case .modelShapeMismatch(let detail):
            return "A Core ML package returned an unexpected shape: \(detail)"
        case .voicesFileMalformed(let detail):
            return "Voices.bin is malformed: \(detail)"
        case .voiceNotFound(let name):
            return "Voices.bin has no voice named \(name)."
        case .phonemizerUnavailable(let detail):
            return "The phonemizer is unavailable: \(detail)"
        case .phonemizerLacksWordGrouping:
            return "The phonemizer returned a flat phoneme string. Word-level highlighting needs per-word grouping (§0.3)."
        case .chunkExceedsBudget(let count):
            return "A chunk came out at \(count) phonemes, over the 510 budget."
        case .cacheWriteFailed(let detail):
            return "Could not write to the audio cache: \(detail)"
        case .audioFormatUnavailable:
            return "Could not build the 24 kHz mono audio format."
        }
    }
}
