import Testing
import Foundation
@testable import PolyReadLinguistics
import PolyReadCore

@Suite("§6.2 chunking")
struct ChunkerTests {

    let chunker = Chunker()

    /// Builds token ids and word ranges directly, so the split is tested without
    /// a phonemizer in the way.
    private func synthetic(wordCount: Int, phonemesPerWord: Int, sentenceEvery: Int? = nil)
        -> (tokens: [Int32], ranges: [Range<Int>], words: [String]) {
        var tokens: [Int32] = []
        var ranges: [Range<Int>] = []
        var words: [String] = []
        for i in 0..<wordCount {
            if i > 0 { tokens.append(16) }   // a separator
            let start = tokens.count
            tokens.append(contentsOf: (0..<phonemesPerWord).map { _ in Int32.random(in: 40...90) })
            ranges.append(start..<tokens.count)
            let isSentenceEnd = sentenceEvery.map { (i + 1) % $0 == 0 } ?? false
            words.append(isSentenceEnd ? "word\(i)." : "word\(i)")
        }
        return (tokens, ranges, words)
    }

    /// §6.2 — "`tokens` is capped at `[1, 3…512]` — 510 phonemes plus two
    /// boundary zeros". Nothing may exceed it.
    @Test("no chunk exceeds the 510-phoneme budget")
    func budget() {
        for wordCount in [1, 40, 120, 400, 1200] {
            let (tokens, ranges, words) = synthetic(wordCount: wordCount, phonemesPerWord: 6)
            let chunks = chunker.split(blockID: UUID(), tokenIDs: tokens, ranges: ranges, tokens: words)
            for chunk in chunks {
                #expect(chunk.tokens.count <= Chunker.budget)
            }
        }
    }

    @Test("a short block is one chunk")
    func shortBlock() {
        let (tokens, ranges, words) = synthetic(wordCount: 20, phonemesPerWord: 5)
        let chunks = chunker.split(blockID: UUID(), tokenIDs: tokens, ranges: ranges, tokens: words)
        #expect(chunks.count == 1)
        #expect(chunks[0].tokens == tokens)
        #expect(chunks[0].spanOffset == 0)
    }

    /// The whole point of `spanOffset` — a chunk has to know which of its
    /// block's spans its first word corresponds to, or the highlight starts at
    /// the top of the paragraph on every chunk boundary.
    @Test("chunks partition the words exactly once, in order")
    func partition() {
        let (tokens, ranges, words) = synthetic(wordCount: 600, phonemesPerWord: 7)
        let chunks = chunker.split(blockID: UUID(), tokenIDs: tokens, ranges: ranges, tokens: words)

        var expected = 0
        for chunk in chunks {
            #expect(chunk.spanOffset == expected)
            expected += chunk.wordPhonemeRanges.count
        }
        #expect(expected == words.count)
    }

    @Test("word ranges stay inside their own chunk's token array")
    func rangesAreRebased() {
        let (tokens, ranges, words) = synthetic(wordCount: 600, phonemesPerWord: 7)
        for chunk in chunker.split(blockID: UUID(), tokenIDs: tokens, ranges: ranges, tokens: words) {
            #expect(chunk.wordPhonemeRanges.first?.lowerBound == 0)
            for range in chunk.wordPhonemeRanges {
                #expect(range.lowerBound >= 0)
                #expect(range.upperBound <= chunk.tokens.count)
            }
        }
    }

    /// §6.2 — "Emit chunks as close to uniform length as the text allows — the
    /// style vector is selected by phoneme count (§7.1), so wildly varying chunk
    /// lengths give wandering prosody."
    @Test("chunks come out close to uniform, not full-then-runt")
    func uniformity() {
        let (tokens, ranges, words) = synthetic(wordCount: 300, phonemesPerWord: 6)
        let chunks = chunker.split(blockID: UUID(), tokenIDs: tokens, ranges: ranges, tokens: words)
        #expect(chunks.count > 2)
        let lengths = chunks.map(\.tokens.count)
        let shortest = lengths.min() ?? 0
        let longest = lengths.max() ?? 0
        // A greedy fill-to-510 would leave a final chunk a fraction of the size
        // of its neighbours. Within a third of each other is the bar.
        #expect(Double(shortest) > Double(longest) * 0.66, "lengths: \(lengths)")
    }

    /// §6.2 — "Prefer sentence boundaries: when a split is needed, back off to
    /// the most recent sentence end within the last 25% of the budget."
    @Test("splits prefer a sentence boundary when one is in reach")
    func sentenceBackoff() {
        let (tokens, ranges, words) = synthetic(wordCount: 300, phonemesPerWord: 6, sentenceEvery: 9)
        let chunks = chunker.split(blockID: UUID(), tokenIDs: tokens, ranges: ranges, tokens: words)

        var boundaries = 0
        var index = 0
        for chunk in chunks.dropLast() {
            index += chunk.wordPhonemeRanges.count
            if chunker.isSentenceEnd(words[index - 1]) { boundaries += 1 }
        }
        #expect(boundaries == chunks.count - 1, "\(boundaries) of \(chunks.count - 1) splits landed on a sentence end")
    }

    @Test("an initial is not a sentence end")
    func abbreviations() {
        #expect(chunker.isSentenceEnd("shows."))
        #expect(chunker.isSentenceEnd("vote?"))
        #expect(chunker.isSentenceEnd("argued.\""))
        #expect(!chunker.isSentenceEnd("J."))
        #expect(!chunker.isSentenceEnd("APSR."))
        #expect(!chunker.isSentenceEnd("word"))
    }
}
