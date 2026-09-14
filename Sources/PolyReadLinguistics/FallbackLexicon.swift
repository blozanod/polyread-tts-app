import Foundation

// American English phoneme inventory, in Kokoro's symbol set.
//
// Careful: ɡ is U+0261 (script g), not ASCII "g"; ɹ is U+0279, not "r"; ʤ and ʧ
// are single code points. ASCII look-alikes exist in the vocabulary at different
// ids, so a substitution here is not a typo — it is silently wrong audio.

extension FallbackPhonemizer {

    enum Lexicon {
        static let longestPattern = 5

        /// Default single-letter mapping, used when no rule fires.
        nonisolated(unsafe) static let defaults: [Character: String] = [
            "a": "æ", "b": "b", "c": "k", "d": "d", "e": "ɛ", "f": "f", "ɡ": "ɡ",
            "g": "ɡ", "h": "h", "i": "ɪ", "j": "ʤ", "k": "k", "l": "l", "m": "m",
            "n": "n", "o": "ɑ", "p": "p", "q": "k", "r": "ɹ", "s": "s", "t": "t",
            "u": "ʌ", "v": "v", "w": "w", "x": "ks", "y": "ɪ", "z": "z",
            "'": "", "-": "", "é": "eɪ", "è": "ɛ", "ü": "u", "ö": "ɜ", "ä": "æ",
            "ñ": "nj", "ç": "s", "á": "ɑ", "í": "i", "ó": "oʊ", "ú": "u",
        ]

        /// Keyed by the grapheme the rule matches, so the engine can look up by
        /// candidate substring instead of scanning the whole table at every
        /// position.
        nonisolated(unsafe) static let rules: [String: [LTSRule]] = {
            var table: [String: [LTSRule]] = [:]
            for rule in all {
                table[rule.pattern, default: []].append(rule)
            }
            return table
        }()

        /// Order within a pattern matters: the first rule whose contexts match wins.
        nonisolated(unsafe) static let all: [LTSRule] = [
            // ── Four- and three-letter graphemes ───────────────────────────────
            .init(.anything, "ough", .wordEnd, "ʌf"),
            .init(.anything, "ough", .anything, "ɔ"),
            .init(.anything, "augh", .anything, "æf"),
            .init(.anything, "eigh", .anything, "eɪ"),
            .init(.anything, "tion", .anything, "ʃən"),
            .init(.anything, "sion", .vowel, "ʒən"),
            .init(.anything, "sion", .anything, "ʃən"),
            .init(.anything, "cial", .anything, "ʃəl"),
            .init(.anything, "tial", .anything, "ʃəl"),
            .init(.anything, "ture", .wordEnd, "ʧɚ"),
            .init(.anything, "sure", .wordEnd, "ʒɚ"),
            .init(.anything, "cious", .anything, "ʃəs"),
            .init(.anything, "tious", .anything, "ʃəs"),

            .init(.anything, "igh", .anything, "aɪ"),
            .init(.anything, "dge", .anything, "ʤ"),
            .init(.anything, "tch", .anything, "ʧ"),
            .init(.anything, "sch", .anything, "sk"),
            .init(.anything, "que", .wordEnd, "k"),
            .init(.anything, "ing", .wordEnd, "ɪŋ"),
            .init(.anything, "ism", .wordEnd, "ɪzəm"),
            .init(.anything, "ist", .wordEnd, "ɪst"),
            .init(.anything, "ity", .wordEnd, "ɪti"),
            .init(.anything, "ate", .wordEnd, "eɪt"),
            .init(.anything, "age", .wordEnd, "ɪʤ"),
            .init(.anything, "ous", .wordEnd, "əs"),
            .init(.anything, "ful", .wordEnd, "fəl"),
            .init(.anything, "ble", .wordEnd, "bəl"),
            .init(.anything, "cle", .wordEnd, "kəl"),
            .init(.anything, "dle", .wordEnd, "dəl"),
            .init(.anything, "tle", .wordEnd, "təl"),
            .init(.anything, "ple", .wordEnd, "pəl"),
            .init(.anything, "gle", .wordEnd, "ɡəl"),
            .init(.anything, "zle", .wordEnd, "zəl"),
            .init(.anything, "sle", .wordEnd, "səl"),
            .init(.anything, "ery", .wordEnd, "ɚi"),
            .init(.anything, "ary", .wordEnd, "ɛɹi"),
            .init(.anything, "ory", .wordEnd, "ɔɹi"),
            .init(.anything, "war", .anything, "wɔɹ"),
            .init(.anything, "wor", .anything, "wɜɹ"),
            .init(.anything, "qui", .anything, "kwɪ"),
            .init(.anything, "qua", .anything, "kwɑ"),
            .init(.anything, "quo", .anything, "kwoʊ"),

            // ── Vowel digraphs ─────────────────────────────────────────────────
            .init(.anything, "eau", .anything, "oʊ"),
            .init(.anything, "ai", .anything, "eɪ"),
            .init(.anything, "ay", .anything, "eɪ"),
            .init(.anything, "au", .anything, "ɔ"),
            .init(.anything, "aw", .anything, "ɔ"),
            .init(.anything, "ea", .literal("r"), "ɪɹ"),
            .init(.anything, "ea", .anything, "i"),
            .init(.anything, "ee", .anything, "i"),
            .init(.anything, "ei", .anything, "i"),
            .init(.anything, "eu", .anything, "u"),
            .init(.anything, "ew", .anything, "u"),
            .init(.anything, "ey", .wordEnd, "i"),
            .init(.anything, "ey", .anything, "eɪ"),
            .init(.anything, "ie", .wordEnd, "i"),
            .init(.anything, "ie", .anything, "i"),
            .init(.anything, "oa", .anything, "oʊ"),
            .init(.anything, "oe", .wordEnd, "oʊ"),
            .init(.anything, "oi", .anything, "ɔɪ"),
            .init(.anything, "oy", .anything, "ɔɪ"),
            .init(.anything, "oo", .literal("k"), "ʊ"),
            .init(.anything, "oo", .literal("d"), "ʊ"),
            .init(.anything, "oo", .anything, "u"),
            .init(.anything, "ou", .literal("s"), "aʊ"),
            .init(.anything, "ou", .literal("n"), "aʊ"),
            .init(.anything, "ou", .literal("t"), "aʊ"),
            .init(.anything, "ou", .literal("r"), "ɜɹ"),
            .init(.anything, "ou", .anything, "aʊ"),
            .init(.anything, "ow", .wordEnd, "oʊ"),
            .init(.anything, "ow", .consonant, "oʊ"),
            .init(.anything, "ow", .anything, "aʊ"),
            .init(.anything, "ui", .anything, "u"),
            .init(.anything, "uy", .anything, "aɪ"),

            // ── R-coloured vowels ──────────────────────────────────────────────
            .init(.anything, "ar", .wordEnd, "ɑɹ"),
            .init(.anything, "ar", .consonant, "ɑɹ"),
            .init(.anything, "er", .wordEnd, "ɚ"),
            .init(.anything, "er", .consonant, "ɜɹ"),
            .init(.anything, "ir", .wordEnd, "ɜɹ"),
            .init(.anything, "ir", .consonant, "ɜɹ"),
            .init(.anything, "or", .wordEnd, "ɔɹ"),
            .init(.anything, "or", .consonant, "ɔɹ"),
            .init(.anything, "ur", .wordEnd, "ɜɹ"),
            .init(.anything, "ur", .consonant, "ɜɹ"),
            .init(.anything, "yr", .consonant, "ɜɹ"),

            // ── Consonant digraphs ─────────────────────────────────────────────
            .init(.anything, "ch", .anything, "ʧ"),
            .init(.anything, "ck", .anything, "k"),
            .init(.anything, "gh", .wordEnd, ""),
            .init(.anything, "gh", .anything, "ɡ"),
            .init(.anything, "gn", .wordEnd, "n"),
            .init(.wordEnd, "gn", .anything, "n"),
            .init(.anything, "kn", .anything, "n"),
            .init(.anything, "ng", .wordEnd, "ŋ"),
            .init(.anything, "ng", .anything, "ŋɡ"),
            .init(.anything, "ph", .anything, "f"),
            .init(.anything, "ps", .anything, "s"),
            .init(.anything, "sh", .anything, "ʃ"),
            .init(.anything, "th", .wordEnd, "θ"),
            .init(.anything, "th", .anything, "θ"),
            .init(.anything, "wh", .anything, "w"),
            .init(.anything, "wr", .anything, "ɹ"),
            .init(.anything, "mb", .wordEnd, "m"),
            .init(.anything, "mn", .wordEnd, "m"),
            .init(.anything, "qu", .anything, "kw"),
            .init(.anything, "sc", .literal("e"), "s"),
            .init(.anything, "sc", .literal("i"), "s"),

            // ── Soft c and g ───────────────────────────────────────────────────
            .init(.anything, "c", .literal("e"), "s"),
            .init(.anything, "c", .literal("i"), "s"),
            .init(.anything, "c", .literal("y"), "s"),
            .init(.anything, "g", .literal("e"), "ʤ"),
            .init(.anything, "g", .literal("i"), "ʤ"),
            .init(.anything, "g", .literal("y"), "ʤ"),

            // ── Endings ────────────────────────────────────────────────────────
            .init(.literal("t"), "ed", .wordEnd, "ɪd"),
            .init(.literal("d"), "ed", .wordEnd, "ɪd"),
            .init(.consonant, "ed", .wordEnd, "d"),
            .init(.vowel, "ed", .wordEnd, "d"),
            .init(.literal("s"), "es", .wordEnd, "ɪz"),
            .init(.literal("z"), "es", .wordEnd, "ɪz"),
            .init(.literal("x"), "es", .wordEnd, "ɪz"),
            .init(.anything, "es", .wordEnd, "z"),
            .init(.literal("s"), "s", .wordEnd, ""),
            .init(.consonant, "s", .wordEnd, "s"),

            // ── Silent and magic e ─────────────────────────────────────────────
            .init(.consonant, "e", .wordEnd, ""),
            .init(.anything, "a", .literal("ke"), "eɪ"),
            .init(.anything, "a", .literal("te"), "eɪ"),
            .init(.anything, "a", .literal("me"), "eɪ"),
            .init(.anything, "a", .literal("ne"), "eɪ"),
            .init(.anything, "a", .literal("le"), "eɪ"),
            .init(.anything, "a", .literal("ve"), "eɪ"),
            .init(.anything, "a", .literal("ce"), "eɪ"),
            .init(.anything, "a", .literal("ge"), "eɪ"),
            .init(.anything, "i", .literal("ke"), "aɪ"),
            .init(.anything, "i", .literal("te"), "aɪ"),
            .init(.anything, "i", .literal("me"), "aɪ"),
            .init(.anything, "i", .literal("ne"), "aɪ"),
            .init(.anything, "i", .literal("le"), "aɪ"),
            .init(.anything, "i", .literal("ve"), "ɪ"),
            .init(.anything, "i", .literal("ce"), "aɪ"),
            .init(.anything, "o", .literal("ke"), "oʊ"),
            .init(.anything, "o", .literal("te"), "oʊ"),
            .init(.anything, "o", .literal("me"), "ʌ"),
            .init(.anything, "o", .literal("ne"), "oʊ"),
            .init(.anything, "o", .literal("le"), "oʊ"),
            .init(.anything, "o", .literal("ve"), "ʌ"),
            .init(.anything, "u", .literal("te"), "u"),
            .init(.anything, "u", .literal("se"), "u"),
            .init(.anything, "e", .literal("te"), "i"),
            .init(.anything, "e", .literal("ne"), "i"),
            .init(.anything, "e", .literal("me"), "i"),

            // ── Single vowels in open syllables ────────────────────────────────
            .init(.anything, "i", .wordEnd, "i"),
            .init(.anything, "y", .wordEnd, "i"),
            .init(.wordEnd, "y", .anything, "j"),
            .init(.anything, "o", .wordEnd, "oʊ"),
            .init(.anything, "a", .wordEnd, "ə"),
            .init(.anything, "e", .wordEnd, "i"),
            .init(.anything, "x", .wordEnd, "ks"),
            .init(.wordEnd, "x", .anything, "z"),
        ]

        /// The high-frequency irregulars. These are the words a rule engine gets
        /// wrong most visibly, and they are the ones that occur on every line.
        nonisolated(unsafe) static let exceptions: [String: String] = [
            "a": "ə", "an": "ən", "the": "ðə", "of": "ʌv", "to": "tu", "and": "ænd",
            "in": "ɪn", "is": "ɪz", "it": "ɪt", "that": "ðæt", "for": "fɔɹ",
            "as": "æz", "was": "wʌz", "with": "wɪð", "be": "bi", "by": "baɪ",
            "on": "ɑn", "not": "nɑt", "this": "ðɪs", "but": "bʌt", "are": "ɑɹ",
            "from": "fɹʌm", "or": "ɔɹ", "have": "hæv", "has": "hæz", "had": "hæd",
            "one": "wʌn", "two": "tu", "three": "θɹi", "four": "fɔɹ", "eight": "eɪt",
            "were": "wɜɹ", "they": "ðeɪ", "their": "ðɛɹ", "them": "ðɛm", "there": "ðɛɹ",
            "these": "ðiz", "those": "ðoʊz", "then": "ðɛn", "than": "ðæn",
            "which": "wɪʧ", "what": "wʌt", "when": "wɛn", "where": "wɛɹ", "who": "hu",
            "would": "wʊd", "could": "kʊd", "should": "ʃʊd", "been": "bɪn",
            "some": "sʌm", "said": "sɛd", "says": "sɛz", "do": "du", "does": "dʌz",
            "done": "dʌn", "goes": "ɡoʊz", "gone": "ɡɔn", "more": "mɔɹ",
            "most": "moʊst", "other": "ʌðɚ", "another": "ənʌðɚ", "over": "oʊvɚ",
            "into": "ɪntu", "only": "oʊnli", "also": "ɔlsoʊ", "very": "vɛɹi",
            "many": "mɛni", "any": "ɛni", "such": "sʌʧ", "both": "boʊθ",
            "because": "bɪkɔz", "between": "bɪtwin", "through": "θɹu",
            "about": "əbaʊt", "after": "æftɚ", "before": "bɪfɔɹ", "under": "ʌndɚ",
            "against": "əɡɛnst", "among": "əmʌŋ", "during": "dʊɹɪŋ",
            "however": "haʊɛvɚ", "therefore": "ðɛɹfɔɹ", "thus": "ðʌs",
            "although": "ɔlðoʊ", "though": "ðoʊ", "whether": "wɛðɚ",
            "people": "pipəl", "government": "ɡʌvɚnmənt", "political": "pəlɪtɪkəl",
            "politics": "pɑlɪtɪks", "policy": "pɑlɪsi", "power": "paʊɚ",
            "state": "steɪt", "states": "steɪts", "nation": "neɪʃən",
            "public": "pʌblɪk", "social": "soʊʃəl", "society": "səsaɪəti",
            "economic": "ɛkənɑmɪk", "economy": "ɪkɑnəmi", "democracy": "dɪmɑkɹəsi",
            "democratic": "dɛməkɹætɪk", "institution": "ɪnstɪtuʃən",
            "institutions": "ɪnstɪtuʃənz", "theory": "θɪɹi", "theories": "θɪɹiz",
            "argument": "ɑɹɡjəmənt", "evidence": "ɛvɪdəns", "analysis": "ənæləsɪs",
            "example": "ɪɡzæmpəl", "war": "wɔɹ", "world": "wɜɹld",
            "law": "lɔ", "laws": "lɔz", "party": "pɑɹti",
            "parties": "pɑɹtiz", "citizen": "sɪtɪzən", "citizens": "sɪtɪzənz",
            "authority": "əθɔɹɪti", "regime": "ɹəʒim", "regimes": "ɹəʒimz",
            "bureaucracy": "bjʊɹɑkɹəsi", "elite": "ɪlit", "elites": "ɪlits",
            "data": "deɪtə", "results": "ɹɪzʌlts", "model": "mɑdəl",
            "women": "wɪmɪn", "woman": "wʊmən", "again": "əɡɛn", "great": "ɡɹeɪt",
            "give": "ɡɪv", "given": "ɡɪvən", "live": "lɪv", "lives": "laɪvz",
            "move": "muv", "prove": "pɹuv", "whose": "huz", "work": "wɜɹk",
            "year": "jɪɹ", "years": "jɪɹz", "use": "juz", "used": "juzd",
            "sure": "ʃʊɹ", "eye": "aɪ", "own": "oʊn", "know": "noʊ", "known": "noʊn",
            "new": "nu", "now": "naʊ", "how": "haʊ", "why": "waɪ", "each": "iʧ",
            "made": "meɪd", "make": "meɪk", "come": "kʌm", "came": "keɪm",
            "put": "pʊt", "want": "wɑnt", "wants": "wɑnts", "series": "sɪɹiz",
            "ibid": "ɪbɪd", "et": "ɛt", "al": "æl", "versus": "vɜɹsəs",
        ]

        nonisolated(unsafe) static let letterNames: [Character: String] = [
            "a": "eɪ", "b": "bi", "c": "si", "d": "di", "e": "i", "f": "ɛf",
            "g": "ʤi", "h": "eɪʧ", "i": "aɪ", "j": "ʤeɪ", "k": "keɪ", "l": "ɛl",
            "m": "ɛm", "n": "ɛn", "o": "oʊ", "p": "pi", "q": "kju", "r": "ɑɹ",
            "s": "ɛs", "t": "ti", "u": "ju", "v": "vi", "w": "dʌbəlju", "x": "ɛks",
            "y": "waɪ", "z": "zi",
        ]
    }
}
