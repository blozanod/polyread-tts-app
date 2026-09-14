import Foundation
import PolyReadCore

/// §6.2 — "Chunking runs AFTER phonemization. v1 had this backwards. `tokens` is
/// capped at `[1, 3…512]` — 510 phonemes plus two boundary zeros — and you cannot
/// know a paragraph's phoneme length until you phonemize it."
public struct Chunker: Sendable {

    /// §7.1 — 510 phonemes, the two boundary zeros excluded.
    public static let budget = 510
    /// §6.2 — "back off to the most recent sentence end within the last 25% of
    /// the budget."
    public static let sentenceBackoffFraction = 0.25

    let vocabulary: KokoroVocabulary

    public init(vocabulary: KokoroVocabulary = .shared) {
        self.vocabulary = vocabulary
    }

    public struct Result: Sendable {
        public let chunks: [PhonemizedChunk]
        /// Symbols the phonemizer emitted that the vocabulary does not know. Not
        /// fatal — they are dropped — but a long list means the phoneme set and
        /// the vocabulary disagree, which is §0.3 territory.
        public let unknownSymbols: [String: Int]
    }

    /// Phonemizes and chunks one block.
    public func chunk(block: Block, using phonemizer: any Phonemizer, tagger: POSTagger = POSTagger()) throws -> Result {
        guard block.role.isSpoken else { return Result(chunks: [], unknownSymbols: [:]) }

        let tokens = SpanInvariant.tokens(of: block.spokenText).map(String.init)
        guard !tokens.isEmpty else { return Result(chunks: [], unknownSymbols: [:]) }

        let posTags = phonemizer.capabilities.resolvesHomographs ? [] : tagger.tag(tokens: tokens)
        let words = try phonemizer.phonemize(tokens: tokens, posTags: posTags)

        guard words.count == tokens.count else {
            // §0.3 — "If it only returns a flat phoneme string, stop and raise it."
            // A phonemizer that cannot keep one entry per word cannot support
            // word-level highlighting, and guessing an alignment would produce a
            // highlight that drifts instead of an error that says why.
            throw PolyReadError.phonemizerLacksWordGrouping
        }

        // Encode once. `wordPhonemeRanges` indexes into this.
        var tokenIDs: [Int32] = []
        var ranges: [Range<Int>] = []
        var unknown: [String: Int] = [:]
        // Word separator. Kokoro reads the space as a word boundary; its own
        // duration lands in the gap between two words, which is exactly where
        // Timeline expects a gap to be.
        let space = vocabulary.symbolToID[" "]

        for (index, word) in words.enumerated() {
            if index > 0, let space { tokenIDs.append(space) }
            let start = tokenIDs.count
            let (encoded, missing) = vocabulary.encode(word.phonemes)
            for symbol in missing { unknown[symbol, default: 0] += 1 }
            tokenIDs.append(contentsOf: encoded)
            // A word that encoded to nothing still needs a range, or the 1:1
            // alignment with `Block.spans` breaks. An empty range at the right
            // place gives it zero duration and keeps every later index correct.
            ranges.append(start..<tokenIDs.count)
        }

        let chunks = split(
            blockID: block.id,
            tokenIDs: tokenIDs,
            ranges: ranges,
            tokens: tokens
        )
        return Result(chunks: chunks, unknownSymbols: unknown)
    }

    /// The split itself. Separated out so it is testable without a phonemizer.
    func split(
        blockID: UUID,
        tokenIDs: [Int32],
        ranges: [Range<Int>],
        tokens: [String]
    ) -> [PhonemizedChunk] {
        guard !ranges.isEmpty else { return [] }
        let total = tokenIDs.count
        if total <= Self.budget {
            return [
                PhonemizedChunk(
                    blockID: blockID,
                    tokens: tokenIDs,
                    wordPhonemeRanges: rebased(ranges, by: ranges[0].lowerBound),
                    spanOffset: 0
                )
            ]
        }

        // §6.2 — "Emit chunks as close to uniform length as the text allows — the
        // style vector is selected by phoneme count (§7.1), so wildly varying
        // chunk lengths give wandering prosody." So aim for total/n rather than
        // filling each chunk to 510 and leaving a 40-phoneme runt at the end.
        let chunkCount = Int((Double(total) / Double(Self.budget)).rounded(.up))
        let target = min(Self.budget, Int((Double(total) / Double(chunkCount)).rounded(.up)))
        let backoff = Int(Double(target) * Self.sentenceBackoffFraction)

        var chunks: [PhonemizedChunk] = []
        var wordIndex = 0

        while wordIndex < ranges.count {
            let chunkStart = ranges[wordIndex].lowerBound
            var end = wordIndex
            var lastSentenceEnd: Int?

            while end < ranges.count {
                let wouldBe = ranges[end].upperBound - chunkStart
                // Always take at least one word, or a pathological single word
                // longer than the budget would loop forever.
                if end > wordIndex, wouldBe > target { break }
                if end > wordIndex, wouldBe > Self.budget { break }
                if isSentenceEnd(tokens[end]) { lastSentenceEnd = end }
                end += 1
            }

            // §6.2 — back off to the most recent sentence end, but only if it is
            // inside the last 25% of the budget. Backing off further would make
            // this chunk much shorter than its neighbours, which is the thing
            // uniformity is trying to avoid.
            var cut = end
            if let sentenceEnd = lastSentenceEnd, sentenceEnd + 1 < end {
                let lengthAtSentenceEnd = ranges[sentenceEnd].upperBound - chunkStart
                if lengthAtSentenceEnd >= target - backoff {
                    cut = sentenceEnd + 1
                }
            }
            cut = max(cut, wordIndex + 1)

            let sliceEnd = ranges[cut - 1].upperBound
            chunks.append(
                PhonemizedChunk(
                    blockID: blockID,
                    tokens: Array(tokenIDs[chunkStart..<sliceEnd]),
                    wordPhonemeRanges: rebased(Array(ranges[wordIndex..<cut]), by: chunkStart),
                    spanOffset: wordIndex
                )
            )
            wordIndex = cut
        }

        return chunks
    }

    private func rebased(_ ranges: [Range<Int>], by offset: Int) -> [Range<Int>] {
        ranges.map { ($0.lowerBound - offset)..<($0.upperBound - offset) }
    }

    /// Sentence-final on the *source* token, not the phonemes — "Putnam." is a
    /// sentence end and "et al" is not, and only the orthography knows that.
    func isSentenceEnd(_ token: String) -> Bool {
        let trimmed = token.trimmingCharacters(in: CharacterSet(charactersIn: "\"'”’)]}"))
        guard let last = trimmed.last else { return false }
        guard last == "." || last == "!" || last == "?" else { return false }
        // An initial ("J. S. Mill") or a surviving abbreviation is not a sentence.
        let core = String(trimmed.dropLast())
        if core.count <= 1 { return false }
        if core.allSatisfy(\.isUppercase) && core.count <= 3 { return false }
        return true
    }
}

/// Runs the whole of Agent B over a document: §5 then §6.
public struct LinguisticsPipeline: Sendable {
    let normalizer = Normalizer()
    let chunker: Chunker
    let phonemizer: any Phonemizer

    public init(phonemizer: any Phonemizer = PhonemizerFactory.make(), vocabulary: KokoroVocabulary = .shared) {
        self.phonemizer = phonemizer
        self.chunker = Chunker(vocabulary: vocabulary)
    }

    public struct Output: Sendable {
        public let blocks: [Block]
        public let reflow: ReflowDocument
        /// Main stream, in document order — body, headings, captions.
        public let mainChunks: [PhonemizedChunk]
        /// §4.5 — footnote bodies are chunked and prosody-run too, but kept out
        /// of the main stream so a page of notes does not land mid-sentence.
        public let footnoteChunks: [UUID: [PhonemizedChunk]]
        public let unknownSymbols: [String: Int]
    }

    public func run(blocks rawBlocks: [Block]) throws -> Output {
        let normalized = normalizer.normalize(rawBlocks)
        // Reflow ranges have to exist before Phase A mints WordTimings from these
        // spans, so the layout happens here rather than in the UI.
        let (reflow, blocks) = ReflowDocumentBuilder.build(blocks: normalized)

        var mainChunks: [PhonemizedChunk] = []
        var footnoteChunks: [UUID: [PhonemizedChunk]] = [:]
        var unknown: [String: Int] = [:]

        for block in blocks {
            guard block.role.isSpoken else { continue }
            let result = try chunker.chunk(block: block, using: phonemizer)
            for (symbol, count) in result.unknownSymbols { unknown[symbol, default: 0] += count }

            if block.role == .footnoteBody {
                footnoteChunks[block.id] = result.chunks
            } else {
                mainChunks.append(contentsOf: result.chunks)
            }
        }

        #if DEBUG
        for chunk in mainChunks + footnoteChunks.values.flatMap({ $0 }) {
            assert(chunk.tokens.count <= Chunker.budget, "chunk over budget: \(chunk.tokens.count)")
        }
        #endif

        return Output(
            blocks: blocks,
            reflow: reflow,
            mainChunks: mainChunks,
            footnoteChunks: footnoteChunks,
            unknownSymbols: unknown
        )
    }
}
