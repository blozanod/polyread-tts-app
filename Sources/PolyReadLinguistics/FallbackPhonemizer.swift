import Foundation
import PolyReadCore

/// A rule-based English grapheme-to-phoneme converter.
///
/// **This is not the shipping phonemizer.** §6.1 is explicit that the dictionary
/// path, POS-based homograph resolution and number expansion live in
/// `MisakiSwift`, and that the Core ML repo's own G2P is OOV fallback only. This
/// exists so §12 can happen: "have each agent build against stubs." It produces
/// *correct per-word grouping* — which is the structural property the highlight
/// mechanism rests on — with mediocre pronunciation.
///
/// Concretely it lets the §0 benchmark run, Integration gates 1 and 2 produce
/// real numbers, and Agent D's fixture be generated rather than hand-written,
/// all before the §0.3 answer is in.
public struct FallbackPhonemizer: Phonemizer {
    public let name = "Fallback (rule-based)"
    public let capabilities = PhonemizerCapabilities(
        providesWordGrouping: true,
        resolvesHomographs: false,
        expandsNumbers: true
    )

    public init() {}

    public func phonemize(tokens: [String], posTags: [POSTag]) throws -> [PhonemizedWord] {
        tokens.enumerated().map { index, token in
            let tag = index < posTags.count ? posTags[index] : .other
            return PhonemizedWord(token: token, phonemes: Self.convert(token, tag: tag))
        }
    }

    // MARK: - Word

    static func convert(_ token: String, tag: POSTag) -> String {
        let (leading, core, trailing) = splitAffixes(token)
        _ = leading
        guard !core.isEmpty else { return punctuationPhonemes(trailing) }

        var body: String
        if let resolved = HomographResolver.phonemes(for: core, tag: tag) {
            body = resolved
        } else if core.contains(where: \.isNumber) {
            body = NumberReader.phonemes(for: core)
        } else {
            body = convertWord(core)
        }
        return body + punctuationPhonemes(trailing)
    }

    /// Punctuation is part of the phoneme stream — Kokoro reads a comma as a
    /// short break — so it keeps its own symbols rather than being stripped.
    static func punctuationPhonemes(_ trailing: String) -> String {
        String(trailing.filter { ";:,.!?…—\"«»“”".contains($0) })
    }

    static func splitAffixes(_ token: String) -> (String, String, String) {
        let punctuation = CharacterSet(charactersIn: "([{\"'“‘’”)]},.;:!?…—–-")
        var start = token.startIndex
        while start < token.endIndex,
              token[start].unicodeScalars.allSatisfy(punctuation.contains) {
            start = token.index(after: start)
        }
        var end = token.endIndex
        while end > start {
            let previous = token.index(before: end)
            guard token[previous].unicodeScalars.allSatisfy(punctuation.contains) else { break }
            end = previous
        }
        return (
            String(token[token.startIndex..<start]),
            String(token[start..<end]),
            String(token[end..<token.endIndex])
        )
    }

    static func convertWord(_ word: String) -> String {
        let lowercased = word.lowercased()
        if let exception = Lexicon.exceptions[lowercased] {
            return Stress.assignIfPolysyllabic(exception, spelling: lowercased)
        }

        // An all-caps token of 2–5 letters is an initialism far more often than a
        // word — APSR, NATO is the exception, not the rule, in this corpus.
        if word.count >= 2, word.count <= 5, word == word.uppercased(),
           word.allSatisfy(\.isLetter), !isPronounceable(lowercased) {
            return word.compactMap { Lexicon.letterNames[Character($0.lowercased())] }
                .joined(separator: " ")
        }

        let stem = applyRules(Array(lowercased))
        return Stress.assign(stem, spelling: lowercased)
    }

    /// A crude syllabicity test: an all-caps token with no vowel cannot be a word.
    static func isPronounceable(_ word: String) -> Bool {
        word.contains { "aeiouy".contains($0) }
    }

    // MARK: - Rule engine

    enum Context {
        case anything
        case vowel
        case consonant
        case wordEnd
        case notWordEnd
        case literal(String)

        func matches(_ letters: [Character], at index: Int, forward: Bool) -> Bool {
            switch self {
            case .anything:
                return true
            case .wordEnd:
                return forward ? index >= letters.count : index < 0
            case .notWordEnd:
                return forward ? index < letters.count : index >= 0
            case .vowel:
                guard index >= 0, index < letters.count else { return false }
                return "aeiouy".contains(letters[index])
            case .consonant:
                guard index >= 0, index < letters.count else { return false }
                return letters[index].isLetter && !"aeiou".contains(letters[index])
            case .literal(let text):
                let characters = Array(text)
                if forward {
                    guard index + characters.count <= letters.count else { return false }
                    return Array(letters[index..<(index + characters.count)]) == characters
                } else {
                    let start = index - characters.count + 1
                    guard start >= 0, index < letters.count else { return false }
                    return Array(letters[start...index]) == characters
                }
            }
        }
    }

    struct LTSRule {
        let left: Context
        let pattern: String
        let right: Context
        let phonemes: String

        init(_ left: Context = .anything, _ pattern: String, _ right: Context = .anything, _ phonemes: String) {
            self.left = left
            self.pattern = pattern
            self.right = right
            self.phonemes = phonemes
        }
    }

    static func applyRules(_ letters: [Character]) -> String {
        var out = ""
        var i = 0
        while i < letters.count {
            var matched = false
            // Longest pattern first, so "ough" beats "ou" beats "o".
            for length in stride(from: min(Lexicon.longestPattern, letters.count - i), through: 1, by: -1) {
                let candidate = String(letters[i..<(i + length)])
                guard let rules = Lexicon.rules[candidate] else { continue }
                for rule in rules {
                    guard rule.left.matches(letters, at: i - 1, forward: false) else { continue }
                    guard rule.right.matches(letters, at: i + length, forward: true) else { continue }
                    out += rule.phonemes
                    i += length
                    matched = true
                    break
                }
                if matched { break }
            }
            if !matched {
                out += Lexicon.defaults[letters[i]] ?? ""
                i += 1
            }
        }
        return out
    }
}
