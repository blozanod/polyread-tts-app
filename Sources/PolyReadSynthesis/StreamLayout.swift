import Foundation
import PolyReadCore

/// Where every chunk sits in the source timeline, and how much silence precedes it.
///
/// Both phases read this. They have to: §5 says paragraph pauses are "real
/// silence inserted between rendered chunks", so if Phase A accounted for a
/// 400 ms gap that Phase B did not write, every word after it would highlight
/// early — and the bug would look like a timing bug, which §5 warns about
/// specifically.
public struct StreamLayout: Sendable {

    public struct Entry: Sendable {
        public let chunk: PhonemizedChunk
        /// Silence written *before* this chunk, in frames.
        public let leadingSilenceFrames: Int
        /// Absolute frame offset of this chunk's audio, silence included.
        public let startFrame: Int
        public let frameCount: Int

        public var endFrame: Int { startFrame + frameCount }
    }

    public let entries: [Entry]
    public let totalFrames: Int
    /// Index `i` is `entries[i].startFrame - entries[i].leadingSilenceFrames`;
    /// the final element is `totalFrames`. This is what `RenderProgress` stores,
    /// so a chunk's region covers the silence that introduces it.
    public let chunkFrameOffsets: [Int]

    /// §4.6 — headings get 400 ms of silence before and after; §5 — paragraphs
    /// get 300–500 ms. Chunks *within* one block are one utterance and get none.
    public static func silenceFrames(between previous: Block?, and next: Block) -> Int {
        guard let previous else { return 0 }
        if previous.id == next.id { return Pause.frames(Pause.withinBlock) }
        if previous.role == .heading || next.role == .heading {
            return Pause.frames(Pause.heading)
        }
        return Pause.frames(Pause.paragraph)
    }

    public init(chunks: [PhonemizedChunk], timings: [UUID: ChunkTiming], blocks: [Block]) {
        var blocksByID: [UUID: Block] = [:]
        for block in blocks { blocksByID[block.id] = block }

        var entries: [Entry] = []
        var offsets: [Int] = []
        var cursor = 0
        var previousBlock: Block?

        for chunk in chunks {
            guard let block = blocksByID[chunk.blockID] else { continue }
            let silence = Self.silenceFrames(between: previousBlock, and: block)
            offsets.append(cursor)
            cursor += silence
            let frames = timings[chunk.id]?.frameCount ?? 0
            entries.append(
                Entry(
                    chunk: chunk,
                    leadingSilenceFrames: silence,
                    startFrame: cursor,
                    frameCount: frames
                )
            )
            cursor += frames
            previousBlock = block
        }

        offsets.append(cursor)
        self.entries = entries
        self.totalFrames = cursor
        self.chunkFrameOffsets = offsets
    }

    public var duration: TimeInterval { FrameMath.seconds(frames: totalFrames) }
}

/// Flattens Phase A's per-chunk durations into the document-level timeline §3
/// calls "the playback timeline".
public enum TimelineBuilder {

    /// `ChunkTiming.frameDurations` covers the *framed* token sequence — §7.1's
    /// "Token 0 at both ends" — so it has two more entries than
    /// `PhonemizedChunk.tokens`, and a word range `r` over the unframed tokens
    /// corresponds to `frameDurations[r.lowerBound + 1 ..< r.upperBound + 1]`.
    public static let boundaryOffset = 1

    public static func build(
        layout: StreamLayout,
        timings: [UUID: ChunkTiming],
        blocks: [Block]
    ) -> [WordTiming] {
        var blocksByID: [UUID: Block] = [:]
        for block in blocks { blocksByID[block.id] = block }

        var words: [WordTiming] = []
        for entry in layout.entries {
            guard
                let timing = timings[entry.chunk.id],
                let block = blocksByID[entry.chunk.blockID]
            else { continue }

            // Prefix sums so each word's bounds are two lookups, not a re-scan.
            var prefix = [Int](repeating: 0, count: timing.frameDurations.count + 1)
            for (i, frames) in timing.frameDurations.enumerated() {
                prefix[i + 1] = prefix[i] + frames
            }

            for (wordIndex, range) in entry.chunk.wordPhonemeRanges.enumerated() {
                let spanIndex = entry.chunk.spanOffset + wordIndex
                guard spanIndex < block.spans.count else { continue }

                let lower = min(range.lowerBound + boundaryOffset, prefix.count - 1)
                let upper = min(range.upperBound + boundaryOffset, prefix.count - 1)
                let startFrame = entry.startFrame + prefix[lower]
                let endFrame = entry.startFrame + prefix[upper]

                words.append(
                    WordTiming(
                        start: FrameMath.seconds(frames: startFrame),
                        end: FrameMath.seconds(frames: max(endFrame, startFrame)),
                        span: block.spans[spanIndex],
                        blockID: block.id
                    )
                )
            }
        }
        return words
    }
}
