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

        /// For dictionary entries. A monosyllabic function word — "the", "of",
        /// "as" — is unstressed in running speech, and marking every one of them
        /// would be worse prosody than marking none. Anything longer gets the
        /// same treatment as a word that came through the rules.
        static func assignIfPolysyllabic(_ phonemes: String, spelling: String) -> String {
            guard !phonemes.contains(primary), syllableCount(phonemes: phonemes) > 1 else {
                return phonemes
            }
            return assign(phonemes, spelling: spelling)
        }

        /// Counts nuclei, collapsing diphthongs: "eɪ" is one syllable, not two.
        static func syllableCount(phonemes: String) -> Int {
            var count = 0
            var previousWasNucleus = false
            for character in phonemes {
                let isNucleus = vowelNuclei.contains(character)
                if isNucleus, !previousWasNucleus { count += 1 }
                previousWasNucleus = isNucleus
            }
            return count
        }

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

        /// Two-consonant clusters English allows at the start of a syllable.
        /// Everything else in a cluster belongs to the *previous* syllable's coda.
        static let validOnsets: Set<String> = [
            "pɹ", "pl", "pj", "bɹ", "bl", "bj", "tɹ", "tw", "tj", "dɹ", "dw",
            "kɹ", "kl", "kw", "kj", "ɡɹ", "ɡl", "fɹ", "fl", "fj", "vj", "θɹ",
            "θw", "ʃɹ", "sp", "st", "sk", "sl", "sm", "sn", "sw", "sj", "mj",
            "hj", "nj", "lj", "bj",
        ]

        /// The stress mark goes at the start of the syllable's onset, not on the
        /// vowel itself — so "ˈpɑlɪtɪks", not "pˈɑlɪtɪks".
        ///
        /// Which consonants count as the onset is the maximal-onset principle,
        /// not "all of them": "comparative" is kəm-ˈpæ-ɹə-tɪv, so the /m/ closes
        /// the previous syllable and only the /p/ opens the stressed one.
        /// Walking back over the whole cluster would give "kəˈmpæɹətɪv", which
        /// Kokoro reads with the stress a syllable early.
        static func insert(_ mark: String, into characters: [Character], before nucleus: Int) -> String {
            var clusterStart = nucleus
            while clusterStart > 0, !vowelNuclei.contains(characters[clusterStart - 1]) {
                clusterStart -= 1
            }

            var onset = nucleus
            if clusterStart == 0 {
                // Word-initial: there is no previous syllable to take a coda, so
                // the whole cluster is the onset however unlikely it looks.
                onset = 0
            } else {
                let cluster = String(characters[clusterStart..<nucleus])
                if cluster.count >= 2 {
                    // Longest valid suffix of the cluster, preferring "stɹ"-style
                    // three-consonant onsets.
                    let chars = Array(cluster)
                    if chars.count >= 3, chars[chars.count - 3] == "s",
                       validOnsets.contains(String(chars.suffix(2))) {
                        onset = nucleus - 3
                    } else if validOnsets.contains(String(chars.suffix(2))) {
                        onset = nucleus - 2
                    } else {
                        onset = nucleus - 1
                    }
                } else {
                    onset = clusterStart
                }
            }

            var out = String(characters[0..<onset])
            out += mark
            out += String(characters[onset...])
            return out
        }
    }
}
