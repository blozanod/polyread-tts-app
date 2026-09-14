import Testing
import Foundation
@testable import PolyReadLinguistics
import PolyReadCore

@Suite("§6.1 phonemizer contract")
struct PhonemizerTests {

    /// §0.3 / §6.1 — "G2P **must** return per-word phoneme grouping. That
    /// grouping *is* `wordPhonemeRanges`, and it is the only thing making
    /// word-level highlighting possible."
    @Test("one entry per input token, in order")
    func grouping() throws {
        let phonemizer = FallbackPhonemizer()
        let words = ["The", "record", "shows", "that", "Przeworski", "was", "right."]
        let result = try phonemizer.phonemize(tokens: words, posTags: POSTagger().tag(tokens: words))
        #expect(result.count == words.count)
        #expect(result.map(\.token) == words)
        #expect(result.allSatisfy { !$0.phonemes.isEmpty })
    }

    /// The chunker throws rather than guessing when grouping is missing —
    /// §0.3: "stop and raise it — that's a module, not a patch."
    @Test("a phonemizer that loses word alignment is rejected, not patched over")
    func rejectsFlatOutput() {
        struct FlatPhonemizer: Phonemizer {
            let name = "flat"
            let capabilities = PhonemizerCapabilities(
                providesWordGrouping: false, resolvesHomographs: false, expandsNumbers: false
            )
            func phonemize(tokens: [String], posTags: [POSTag]) throws -> [PhonemizedWord] {
                [PhonemizedWord(token: tokens.joined(separator: " "), phonemes: "wʌnbɪɡstɹiŋ")]
            }
        }

        let block = Block(
            role: .body,
            spokenText: "one two three",
            spans: (0..<3).map { _ in
                SourceSpan(pageIndex: 0, bboxes: [], reflowRange: NSRange(location: 0, length: 0))
            }
        )
        #expect(throws: PolyReadError.self) {
            _ = try Chunker().chunk(block: block, using: FlatPhonemizer())
        }
    }

    /// §6.1 — "Homographs matter here: *the record shows* / *record the vote*."
    @Test("POS decides the homograph")
    func homographs() {
        let noun = HomographResolver.phonemes(for: "record", tag: .noun)
        let verb = HomographResolver.phonemes(for: "record", tag: .verb)
        #expect(noun != nil)
        #expect(verb != nil)
        #expect(noun != verb)
        // The noun stresses the first syllable, the verb the second.
        #expect(noun!.hasPrefix("ɹˈ"))
        #expect(verb!.contains("kˈ"))
    }

    /// A homograph entry using a symbol outside the vocabulary encodes shorter
    /// than it looks, shifting every duration after it. Debug builds should see
    /// that immediately rather than as a drifting highlight.
    @Test("every homograph entry encodes in the active vocabulary")
    func homographsEncodable() {
        let unencodable = HomographResolver.unencodableEntries(using: KokoroVocabulary.shared)
        #expect(unencodable.isEmpty, "\(unencodable)")
    }

    @Test("the fallback lexicon is entirely encodable")
    func lexiconEncodable() {
        let vocabulary = KokoroVocabulary.shared
        let bad = FallbackPhonemizer.Lexicon.exceptions
            .filter { !vocabulary.contains($0.value) }
            .map { "\($0.key): \($0.value)" }
            .sorted()
        #expect(bad.isEmpty, "\(bad)")
    }

    @Test("every rule and letter name encodes too")
    func rulesEncodable() {
        let vocabulary = KokoroVocabulary.shared
        let badRules = FallbackPhonemizer.Lexicon.all
            .filter { !vocabulary.contains($0.phonemes) }
            .map { "\($0.pattern) -> \($0.phonemes)" }
        #expect(badRules.isEmpty, "\(badRules)")

        let badNames = FallbackPhonemizer.Lexicon.letterNames
            .filter { !vocabulary.contains($0.value) }
            .map { "\($0.key): \($0.value)" }
        #expect(badNames.isEmpty, "\(badNames)")
    }

    @Test("a polysyllabic word gets exactly one stress mark")
    func stress() {
        // Both paths: "politics" and "democracy" come from the dictionary,
        // "reconsider" and "comparative" from the rules.
        for word in ["politics", "democracy", "institution", "reconsider", "comparative"] {
            let phonemes = FallbackPhonemizer.convertWord(word)
            #expect(phonemes.filter { $0 == "ˈ" }.count == 1, "\(word) -> \(phonemes)")
        }
    }

    /// Marking every "the" and "of" would be worse prosody than marking none.
    @Test("monosyllabic function words stay unstressed")
    func functionWordsUnstressed() {
        for word in ["the", "of", "as", "was", "in"] {
            #expect(!FallbackPhonemizer.convertWord(word).contains("ˈ"), word)
        }
    }

    @Test("years read as pairs, not as digit strings")
    func numbers() {
        // "nineteen ninety-three", not "one nine nine three".
        let phonemes = FallbackPhonemizer.NumberReader.phonemes(for: "1993")
        #expect(phonemes.split(separator: " ").count == 3)
        #expect(!FallbackPhonemizer.NumberReader.phonemes(for: "45").isEmpty)
    }

    @Test("punctuation survives into the phoneme stream")
    func punctuation() {
        // Kokoro reads a comma as a short break, so stripping it would flatten
        // the prosody of every clause.
        #expect(FallbackPhonemizer.convert("state,", tag: .noun).hasSuffix(","))
        #expect(FallbackPhonemizer.convert("state.", tag: .noun).hasSuffix("."))
    }
}
