import Testing
import Foundation
@testable import PolyReadSynthesis
import PolyReadCore

private func makeBlock(_ role: BlockRole, words: Int) -> Block {
    Block(
        role: role,
        spokenText: (0..<words).map { "w\($0)" }.joined(separator: " "),
        spans: (0..<words).map {
            SourceSpan(pageIndex: 0, bboxes: [], reflowRange: NSRange(location: $0 * 3, length: 2))
        }
    )
}

/// Builds a chunk plus its Phase A timing. `frameDurations` covers the framed
/// token sequence — §7.1's "Token 0 at both ends" — so it has two more entries
/// than the chunk's own tokens.
private func makeChunk(block: Block, phonemesPerWord: Int, framesPerPhoneme: Int)
    -> (PhonemizedChunk, ChunkTiming) {
    let wordCount = SpanInvariant.tokens(of: block.spokenText).count
    var tokens: [Int32] = []
    var ranges: [Range<Int>] = []
    for i in 0..<wordCount {
        if i > 0 { tokens.append(16) }
        let start = tokens.count
        tokens.append(contentsOf: (0..<phonemesPerWord).map { _ in Int32(50) })
        ranges.append(start..<tokens.count)
    }
    let chunk = PhonemizedChunk(blockID: block.id, tokens: tokens, wordPhonemeRanges: ranges, spanOffset: 0)
    let timing = ChunkTiming(
        chunkID: chunk.id,
        frameDurations: [Int](repeating: framesPerPhoneme, count: tokens.count + 2)
    )
    return (chunk, timing)
}

@Suite("§7.2 timeline construction")
struct StreamLayoutTests {

    @Test("word timings are monotonic and gap-free within a chunk")
    func monotonic() {
        let block = makeBlock(.body, words: 12)
        let (chunk, timing) = makeChunk(block: block, phonemesPerWord: 4, framesPerPhoneme: 3)
        let timings = [chunk.id: timing]
        let layout = StreamLayout(chunks: [chunk], timings: timings, blocks: [block])
        let words = TimelineBuilder.build(layout: layout, timings: timings, blocks: [block])

        #expect(words.count == 12)
        for i in 1..<words.count {
            #expect(words[i].start >= words[i - 1].end - 1e-9)
            #expect(words[i].end > words[i].start)
        }
        // §13 gate 2: total duration has to be plausible against the frame count.
        #expect(abs(words.last!.end - FrameMath.seconds(frames: timing.frameCount)) < 0.1)
    }

    /// §5 — "paragraph pauses are real silence inserted between rendered
    /// chunks". Phase A has to account for the same silence Phase B writes, or
    /// every word after it highlights early.
    @Test("paragraph silence lands between blocks, not inside one")
    func silence() {
        let first = makeBlock(.body, words: 4)
        let second = makeBlock(.body, words: 4)
        let (c1, t1) = makeChunk(block: first, phonemesPerWord: 3, framesPerPhoneme: 2)
        let (c2, t2) = makeChunk(block: second, phonemesPerWord: 3, framesPerPhoneme: 2)
        let timings = [c1.id: t1, c2.id: t2]

        let layout = StreamLayout(chunks: [c1, c2], timings: timings, blocks: [first, second])
        #expect(layout.entries[0].leadingSilenceFrames == 0)
        #expect(layout.entries[1].leadingSilenceFrames == Pause.frames(Pause.paragraph))
        #expect(layout.entries[1].startFrame == t1.frameCount + Pause.frames(Pause.paragraph))
        #expect(layout.totalFrames == t1.frameCount + t2.frameCount + Pause.frames(Pause.paragraph))
    }

    @Test("two chunks of one block run together with no pause")
    func noPauseWithinBlock() {
        let block = makeBlock(.body, words: 8)
        let (c1, t1) = makeChunk(block: block, phonemesPerWord: 3, framesPerPhoneme: 2)
        let c2 = PhonemizedChunk(
            blockID: block.id, tokens: c1.tokens, wordPhonemeRanges: c1.wordPhonemeRanges, spanOffset: 0
        )
        let t2 = ChunkTiming(chunkID: c2.id, frameDurations: t1.frameDurations)
        let layout = StreamLayout(
            chunks: [c1, c2], timings: [c1.id: t1, c2.id: t2], blocks: [block]
        )
        #expect(layout.entries[1].leadingSilenceFrames == 0)
    }

    /// §4.6 — headings get 400 ms before and after.
    @Test("a heading is set off by silence on both sides")
    func headingSilence() {
        let body = makeBlock(.body, words: 3)
        let heading = makeBlock(.heading, words: 3)
        #expect(StreamLayout.silenceFrames(between: body, and: heading) == Pause.frames(Pause.heading))
        #expect(StreamLayout.silenceFrames(between: heading, and: body) == Pause.frames(Pause.heading))
        #expect(StreamLayout.silenceFrames(between: nil, and: body) == 0)
    }

    /// The `spanOffset` contract: chunk two of a block must point at that block's
    /// later spans, not start over at its first.
    @Test("a split block's second chunk highlights the right words")
    func spanOffsetRespected() {
        let block = makeBlock(.body, words: 10)
        let (full, _) = makeChunk(block: block, phonemesPerWord: 3, framesPerPhoneme: 2)

        // Words 0-4 in one chunk, 5-9 in the next.
        let firstRanges = Array(full.wordPhonemeRanges[0..<5])
        let secondSource = Array(full.wordPhonemeRanges[5..<10])
        let shift = secondSource[0].lowerBound
        let secondRanges = secondSource.map { ($0.lowerBound - shift)..<($0.upperBound - shift) }

        let c1 = PhonemizedChunk(
            blockID: block.id,
            tokens: Array(full.tokens[0..<firstRanges[4].upperBound]),
            wordPhonemeRanges: firstRanges,
            spanOffset: 0
        )
        let c2 = PhonemizedChunk(
            blockID: block.id,
            tokens: Array(full.tokens[shift...]),
            wordPhonemeRanges: secondRanges,
            spanOffset: 5
        )
        let timings = [
            c1.id: ChunkTiming(chunkID: c1.id, frameDurations: [Int](repeating: 2, count: c1.tokens.count + 2)),
            c2.id: ChunkTiming(chunkID: c2.id, frameDurations: [Int](repeating: 2, count: c2.tokens.count + 2)),
        ]
        let layout = StreamLayout(chunks: [c1, c2], timings: timings, blocks: [block])
        let words = TimelineBuilder.build(layout: layout, timings: timings, blocks: [block])

        #expect(words.count == 10)
        // Each word's span is the one at its own index, in order.
        for (i, word) in words.enumerated() {
            #expect(word.span.reflowRange.location == i * 3)
        }
    }

    @Test("chunk frame offsets cover the document with no holes")
    func offsetsPartitionTheDocument() {
        let blocks = (0..<5).map { _ in makeBlock(.body, words: 6) }
        var chunks: [PhonemizedChunk] = []
        var timings: [UUID: ChunkTiming] = [:]
        for block in blocks {
            let (chunk, timing) = makeChunk(block: block, phonemesPerWord: 3, framesPerPhoneme: 2)
            chunks.append(chunk)
            timings[chunk.id] = timing
        }
        let layout = StreamLayout(chunks: chunks, timings: timings, blocks: blocks)

        #expect(layout.chunkFrameOffsets.count == chunks.count + 1)
        #expect(layout.chunkFrameOffsets.first == 0)
        #expect(layout.chunkFrameOffsets.last == layout.totalFrames)
        for i in 1..<layout.chunkFrameOffsets.count {
            #expect(layout.chunkFrameOffsets[i] > layout.chunkFrameOffsets[i - 1])
        }
    }
}

@Suite("§7.3 render progress")
struct RenderProgressTests {

    private func progress(chunks: Int, frames: Int) -> RenderProgress {
        RenderProgress(
            renderedChunks: [],
            totalChunks: chunks,
            chunkFrameOffsets: (0...chunks).map { $0 * frames }
        )
    }

    /// §7.3 — "Show the rendered-through edge on the scrubber permanently."
    /// The edge is the contiguous prefix: a chunk rendered out of order by a
    /// seek does not move it.
    @Test("the edge follows the contiguous prefix, not the furthest chunk")
    func contiguousEdge() {
        var p = progress(chunks: 10, frames: 40)
        #expect(p.framesRendered == 0)

        p.renderedChunks = [0, 1, 2]
        #expect(p.contiguousChunkCount == 3)
        #expect(p.renderedThrough == 3.0)   // 120 frames at 40 fps

        // A seek rendered chunk 7 on demand. The edge stays at 3.
        p.renderedChunks.insert(7)
        #expect(p.contiguousChunkCount == 3)
        #expect(p.isRendered(at: 7.5))      // but that chunk is playable
        #expect(!p.isRendered(at: 5.0))
    }

    @Test("progress is complete only when every chunk is on disk")
    func completion() {
        var p = progress(chunks: 4, frames: 40)
        p.renderedChunks = [0, 1, 2]
        #expect(!p.isComplete)
        p.renderedChunks.insert(3)
        #expect(p.isComplete)
        #expect(p.framesRendered == 160)
    }

    @Test("a timestamp maps to the chunk that covers it")
    func chunkLookup() {
        let p = progress(chunks: 5, frames: 40)
        #expect(p.chunkIndex(at: 0) == 0)
        #expect(p.chunkIndex(at: 0.9) == 0)
        #expect(p.chunkIndex(at: 1.0) == 1)
        #expect(p.chunkIndex(at: 4.9) == 4)
        #expect(p.chunkIndex(at: 99) == nil)
    }
}
