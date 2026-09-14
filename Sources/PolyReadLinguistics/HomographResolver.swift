import Foundation
import PolyReadCore

/// §6.1 — "Homographs matter here: *the record shows* / *record the vote*, and
/// likewise *conflict*, *present*, *subject*, *contract*, *lead*. Upstream misaki
/// resolves these with POS tags."
///
/// This is the POS-tagged override layer. It runs only when the active
/// phonemizer reports `resolvesHomographs == false` — if misaki is doing this
/// properly, a second opinion here would only fight it.
public enum HomographResolver {

    struct Entry: Sendable {
        let noun: String
        let verb: String
    }

    /// Noun/adjective reading first, verb reading second. In every one of these
    /// pairs the noun is stressed on the first syllable and the verb on the
    /// second, which is the whole pattern.
    nonisolated(unsafe) static let table: [String: Entry] = [
        "record":     Entry(noun: "ɹˈɛkɚd",      verb: "ɹɪkˈɔɹd"),
        "conflict":   Entry(noun: "kˈɑnflɪkt",   verb: "kənflˈɪkt"),
        "present":    Entry(noun: "pɹˈɛzənt",    verb: "pɹɪzˈɛnt"),
        "subject":    Entry(noun: "sˈʌbʤɛkt",    verb: "səbʤˈɛkt"),
        "contract":   Entry(noun: "kˈɑntɹækt",   verb: "kəntɹˈækt"),
        "object":     Entry(noun: "ˈɑbʤɛkt",     verb: "əbʤˈɛkt"),
        "project":    Entry(noun: "pɹˈɑʤɛkt",    verb: "pɹəʤˈɛkt"),
        "conduct":    Entry(noun: "kˈɑndʌkt",    verb: "kəndˈʌkt"),
        "contest":    Entry(noun: "kˈɑntɛst",    verb: "kəntˈɛst"),
        "contrast":   Entry(noun: "kˈɑntɹæst",   verb: "kəntɹˈæst"),
        "convert":    Entry(noun: "kˈɑnvɜɹt",    verb: "kənvˈɜɹt"),
        "increase":   Entry(noun: "ˈɪnkɹis",     verb: "ɪnkɹˈis"),
        "decrease":   Entry(noun: "dˈikɹis",     verb: "dɪkɹˈis"),
        "permit":     Entry(noun: "pˈɜɹmɪt",     verb: "pɚmˈɪt"),
        "rebel":      Entry(noun: "ɹˈɛbəl",      verb: "ɹɪbˈɛl"),
        "protest":    Entry(noun: "pɹˈoʊtɛst",   verb: "pɹətˈɛst"),
        "progress":   Entry(noun: "pɹˈɑɡɹɛs",    verb: "pɹəɡɹˈɛs"),
        "produce":    Entry(noun: "pɹˈoʊdus",    verb: "pɹədˈus"),
        "address":    Entry(noun: "ˈædɹɛs",      verb: "ədɹˈɛs"),
        "transfer":   Entry(noun: "tɹˈænsfɜɹ",   verb: "tɹænsfˈɜɹ"),
        "export":     Entry(noun: "ˈɛkspɔɹt",    verb: "ɪkspˈɔɹt"),
        "import":     Entry(noun: "ˈɪmpɔɹt",     verb: "ɪmpˈɔɹt"),
        "suspect":    Entry(noun: "sˈʌspɛkt",    verb: "səspˈɛkt"),
        "survey":     Entry(noun: "sˈɜɹveɪ",     verb: "sɚvˈeɪ"),
        "refuse":     Entry(noun: "ɹˈɛfjus",     verb: "ɹɪfjˈuz"),
        "separate":   Entry(noun: "sˈɛpɚɪt",     verb: "sˈɛpɚeɪt"),
        "delegate":   Entry(noun: "dˈɛlɪɡɪt",    verb: "dˈɛlɪɡeɪt"),
        "estimate":   Entry(noun: "ˈɛstɪmɪt",    verb: "ˈɛstɪmeɪt"),
        "moderate":   Entry(noun: "mˈɑdɚɪt",     verb: "mˈɑdɚeɪt"),
        "associate":  Entry(noun: "əsˈoʊʃiɪt",   verb: "əsˈoʊʃieɪt"),
        "deliberate": Entry(noun: "dɪlˈɪbɚɪt",   verb: "dɪlˈɪbɚeɪt"),
        "alternate":  Entry(noun: "ˈɔltɚnɪt",    verb: "ˈɔltɚneɪt"),
        "appropriate":Entry(noun: "əpɹˈoʊpɹiɪt", verb: "əpɹˈoʊpɹieɪt"),
        "advocate":   Entry(noun: "ˈædvəkɪt",    verb: "ˈædvəkeɪt"),
        "aggregate":  Entry(noun: "ˈæɡɹɪɡɪt",    verb: "ˈæɡɹɪɡeɪt"),
        "elaborate":  Entry(noun: "ɪlˈæbɚɪt",    verb: "ɪlˈæbɚeɪt"),
        "articulate": Entry(noun: "ɑɹtˈɪkjəlɪt", verb: "ɑɹtˈɪkjəleɪt"),
    ]

    /// "lead" is the one pair POS cannot settle — the metal and the verb's noun
    /// form are both nouns. In a poli-sci corpus the guidance sense dominates by
    /// a wide margin, so it takes /lid/ unconditionally rather than gambling.
    nonisolated(unsafe) static let unconditional: [String: String] = [
        "lead": "lˈid",
        "leads": "lˈidz",
        "read": "ɹˈid",
        "reads": "ɹˈidz",
    ]

    public static func phonemes(for word: String, tag: POSTag) -> String? {
        let key = word.lowercased()
        if let fixed = unconditional[key] { return fixed }
        guard let entry = table[key] else { return nil }
        switch tag {
        case .verb: return entry.verb
        case .noun, .adjective: return entry.noun
        // An untagged occurrence is far likelier to be the noun in this corpus —
        // "the conflict", "a contract", "on the record".
        case .adverb, .other: return entry.noun
        }
    }

    /// Debug-build guard: every phoneme in the table has to exist in the active
    /// vocabulary, or these entries encode to something shorter than they look
    /// and every duration after them shifts.
    public static func unencodableEntries(using vocabulary: KokoroVocabulary) -> [String] {
        var bad: [String] = []
        for (word, entry) in table {
            if !vocabulary.contains(entry.noun) { bad.append("\(word) (noun): \(entry.noun)") }
            if !vocabulary.contains(entry.verb) { bad.append("\(word) (verb): \(entry.verb)") }
        }
        for (word, phonemes) in unconditional where !vocabulary.contains(phonemes) {
            bad.append("\(word): \(phonemes)")
        }
        return bad.sorted()
    }
}
