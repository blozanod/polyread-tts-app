import type { KokoroVocabulary } from "./vocabulary";

/**
 * §6.1 — "Homographs matter here: *the record shows* / *record the vote*, and
 * likewise *conflict*, *present*, *subject*, *contract*, *lead*. Upstream
 * misaki resolves these with POS tags."
 *
 * This is the POS-tagged override layer. It runs only when the active
 * phonemizer reports `resolvesHomographs === false` — eSpeak-NG does resolve
 * them from context, and a second opinion here would only fight it. It is kept
 * because it is the documented behaviour for any backend that does not, and
 * because the encodability check below is a real gate: an entry using a symbol
 * the vocabulary lacks encodes *shorter than it looks*, which shifts every
 * duration after it in the chunk.
 */
export type POSTag = "noun" | "verb" | "adjective" | "adverb" | "other";

interface Entry {
  noun: string;
  verb: string;
}

/**
 * Noun/adjective reading first, verb reading second. In every one of these
 * pairs the noun is stressed on the first syllable and the verb on the second,
 * which is the whole pattern.
 */
export const HOMOGRAPH_TABLE: ReadonlyMap<string, Entry> = new Map<string, Entry>([
  ["record", { noun: "ɹˈɛkɚd", verb: "ɹɪkˈɔɹd" }],
  ["conflict", { noun: "kˈɑnflɪkt", verb: "kənflˈɪkt" }],
  ["present", { noun: "pɹˈɛzənt", verb: "pɹɪzˈɛnt" }],
  ["subject", { noun: "sˈʌbʤɛkt", verb: "səbʤˈɛkt" }],
  ["contract", { noun: "kˈɑntɹækt", verb: "kəntɹˈækt" }],
  ["object", { noun: "ˈɑbʤɛkt", verb: "əbʤˈɛkt" }],
  ["project", { noun: "pɹˈɑʤɛkt", verb: "pɹəʤˈɛkt" }],
  ["conduct", { noun: "kˈɑndʌkt", verb: "kəndˈʌkt" }],
  ["contest", { noun: "kˈɑntɛst", verb: "kəntˈɛst" }],
  ["contrast", { noun: "kˈɑntɹæst", verb: "kəntɹˈæst" }],
  ["convert", { noun: "kˈɑnvɜɹt", verb: "kənvˈɜɹt" }],
  ["increase", { noun: "ˈɪnkɹis", verb: "ɪnkɹˈis" }],
  ["decrease", { noun: "dˈikɹis", verb: "dɪkɹˈis" }],
  ["permit", { noun: "pˈɜɹmɪt", verb: "pɚmˈɪt" }],
  ["rebel", { noun: "ɹˈɛbəl", verb: "ɹɪbˈɛl" }],
  ["protest", { noun: "pɹˈoʊtɛst", verb: "pɹətˈɛst" }],
  ["progress", { noun: "pɹˈɑɡɹɛs", verb: "pɹəɡɹˈɛs" }],
  ["produce", { noun: "pɹˈoʊdus", verb: "pɹədˈus" }],
  ["address", { noun: "ˈædɹɛs", verb: "ədɹˈɛs" }],
  ["transfer", { noun: "tɹˈænsfɜɹ", verb: "tɹænsfˈɜɹ" }],
  ["export", { noun: "ˈɛkspɔɹt", verb: "ɪkspˈɔɹt" }],
  ["import", { noun: "ˈɪmpɔɹt", verb: "ɪmpˈɔɹt" }],
  ["suspect", { noun: "sˈʌspɛkt", verb: "səspˈɛkt" }],
  ["survey", { noun: "sˈɜɹveɪ", verb: "sɚvˈeɪ" }],
  ["refuse", { noun: "ɹˈɛfjus", verb: "ɹɪfjˈuz" }],
  ["separate", { noun: "sˈɛpɚɪt", verb: "sˈɛpɚeɪt" }],
  ["delegate", { noun: "dˈɛlɪɡɪt", verb: "dˈɛlɪɡeɪt" }],
  ["estimate", { noun: "ˈɛstɪmɪt", verb: "ˈɛstɪmeɪt" }],
  ["moderate", { noun: "mˈɑdɚɪt", verb: "mˈɑdɚeɪt" }],
  ["associate", { noun: "əsˈoʊʃiɪt", verb: "əsˈoʊʃieɪt" }],
  ["deliberate", { noun: "dɪlˈɪbɚɪt", verb: "dɪlˈɪbɚeɪt" }],
  ["alternate", { noun: "ˈɔltɚnɪt", verb: "ˈɔltɚneɪt" }],
  ["appropriate", { noun: "əpɹˈoʊpɹiɪt", verb: "əpɹˈoʊpɹieɪt" }],
  ["advocate", { noun: "ˈædvəkɪt", verb: "ˈædvəkeɪt" }],
  ["aggregate", { noun: "ˈæɡɹɪɡɪt", verb: "ˈæɡɹɪɡeɪt" }],
  ["elaborate", { noun: "ɪlˈæbɚɪt", verb: "ɪlˈæbɚeɪt" }],
  ["articulate", { noun: "ɑɹtˈɪkjəlɪt", verb: "ɑɹtˈɪkjəleɪt" }],
]);

/**
 * "lead" is the one pair POS cannot settle — the metal and the verb's noun form
 * are both nouns. In a poli-sci corpus the guidance sense dominates by a wide
 * margin, so it takes /lid/ unconditionally rather than gambling.
 */
export const UNCONDITIONAL: ReadonlyMap<string, string> = new Map([
  ["lead", "lˈid"],
  ["leads", "lˈidz"],
  ["read", "ɹˈid"],
  ["reads", "ɹˈidz"],
]);

export function homographPhonemes(word: string, tag: POSTag): string | undefined {
  const key = word.toLowerCase();
  const fixed = UNCONDITIONAL.get(key);
  if (fixed) return fixed;
  const entry = HOMOGRAPH_TABLE.get(key);
  if (!entry) return undefined;
  switch (tag) {
    case "verb":
      return entry.verb;
    case "noun":
    case "adjective":
      return entry.noun;
    // An untagged occurrence is far likelier to be the noun in this corpus —
    // "the conflict", "a contract", "on the record".
    default:
      return entry.noun;
  }
}

/**
 * Every phoneme in the table has to exist in the active vocabulary, or these
 * entries encode to something shorter than they look and every duration after
 * them shifts. Checked by the test suite and by the benchmark screen.
 */
export function unencodableEntries(vocabulary: KokoroVocabulary): string[] {
  const bad: string[] = [];
  for (const [word, entry] of HOMOGRAPH_TABLE) {
    if (!vocabulary.contains(entry.noun)) bad.push(`${word} (noun): ${entry.noun}`);
    if (!vocabulary.contains(entry.verb)) bad.push(`${word} (verb): ${entry.verb}`);
  }
  for (const [word, phonemes] of UNCONDITIONAL) {
    if (!vocabulary.contains(phonemes)) bad.push(`${word}: ${phonemes}`);
  }
  return bad.sort();
}
