import Foundation

extension FallbackPhonemizer {

    /// Kokoro expects stress marks in the phoneme stream; a stream without them
    /// comes out flat and robotic. This is a heuristic, not a lexicon — the real
    /// stress assignment lives in misaki's dictionary (§6.1).
    enum Stress {
        static let primary = "ˈ"
        static let vowelNuclei: Set<Character> = [
            "ɑ", "ɐ", "ɒ", "æ", "ɔ", "ə", "ɚ", "ɛ", "ɜ", "ɝ", "ɪ", "ʊ", "ʌ", "ᵻ",
            "i", "u", "e", "o", "a",
        ]

        /// Prefixes that are essentially never stressed, so stress falls on the
        /// syllable after them. Half the vocabulary of an academic article —
        /// "reconsider", "distribution", "constitutional" — starts with one.
        static let unstressedPrefixes = [
            "abs", "ac", "ad", "af", "ag", "al", "ap", "as", "at", "be", "col",
            "com", "con", "cor", "de", "dis", "em", "en", "ex", "im", "in", "ir",
            "ob", "oc", "of", "op", "per", "pre", "pro", "re", "sub", "suc", "suf",
            "sug", "sup", "sur", "sus", "trans", "un",
        ]

        /// Suffixes that pull stress onto the syllable immediately before them.
        static let prestressSuffixes = [
            "tion", "sion", "cian", "ity", "ety", "ical", "ic", "ial", "ian",
            "ious", "eous", "uous", "graphy", "logy", "cracy", "ogy", "ify",
        ]

        static func assign(_ phonemes: String, spelling: String) -> String {
            guard !phonemes.isEmpty, !phonemes.contains(primary) else { return phonemes }

            let characters = Array(phonemes)
            let nuclei = characters.indices.filter { vowelNuclei.contains(characters[$0]) }
            // Collapse diphthongs: "eɪ" is one nucleus, not two.
            var syllables: [Int] = []
            for index in nuclei {
                if let last = syllables.last, index == last + 1 { continue }
                syllables.append(index)
            }
            guard !syllables.isEmpty else { return phonemes }
            if syllables.count == 1 {
                return insert(primary, into: characters, before: syllables[0])
            }

            var target = 0
            if let suffix = prestressSuffixes.first(where: { spelling.hasSuffix($0) }) {
                // One syllable back from where the suffix starts.
                let suffixSyllables = max(1, syllableCount(of: suffix))
                target = max(0, syllables.count - suffixSyllables - 1)
            } else if unstressedPrefixes.contains(where: { spelling.hasPrefix($0) }), syllables.count >= 2 {
                target = 1
            }

            return insert(primary, into: characters, before: syllables[target])
        }

        static func syllableCount(of spelling: String) -> Int {
            var count = 0
            var previousWasVowel = false
            for character in spelling {
                let isVowel = "aeiouy".contains(character)
                if isVowel, !previousWasVowel { count += 1 }
                previousWasVowel = isVowel
            }
            return count
        }

        /// The stress mark goes at the start of the syllable's onset, not on the
        /// vowel itself — so "ˈpɑlɪtɪks", not "pˈɑlɪtɪks".
        static func insert(_ mark: String, into characters: [Character], before nucleus: Int) -> String {
            var onset = nucleus
            while onset > 0, !vowelNuclei.contains(characters[onset - 1]) {
                onset -= 1
            }
            var out = String(characters[0..<onset])
            out += mark
            out += String(characters[onset...])
            return out
        }
    }
}
