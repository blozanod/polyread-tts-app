import type { POSTag } from "./homographs";

/**
 * §6.1 — "If `MisakiSwift` lacks POS tagging, wire `NLTagger` as the tagger."
 *
 * There is no NLTagger on the web and a general-purpose tagger is a large
 * dependency for a narrow job. This is the narrow job: the only consumer is
 * `homographPhonemes`, which asks one question about ~40 words, and for those
 * words the answer is almost entirely determined by what precedes them.
 * "the record" is a noun, "to record" is a verb, and no amount of tagger
 * sophistication changes either. Anything it cannot place falls through to
 * "other", which the homograph table reads as the corpus-dominant noun.
 */
const DETERMINERS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "its", "his", "her",
  "their", "our", "my", "your", "any", "no", "each", "every", "some", "such",
  "one", "another", "which", "whose", "both", "all", "either", "neither",
]);

const VERB_CUES = new Set([
  "to", "will", "would", "can", "could", "may", "might", "must", "shall",
  "should", "do", "does", "did", "not", "cannot", "let", "help", "must",
]);

const SUBJECT_PRONOUNS = new Set(["i", "we", "you", "they", "who", "people", "scholars", "states"]);

const PREPOSITIONS = new Set([
  "of", "in", "on", "at", "by", "for", "with", "from", "into", "onto", "upon",
  "about", "over", "under", "between", "among", "through", "against", "without",
  "within", "during", "toward", "towards", "across",
]);

function bare(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
}

export function tagTokens(tokens: readonly string[]): POSTag[] {
  const tags: POSTag[] = new Array(tokens.length).fill("other");
  for (let i = 0; i < tokens.length; i++) {
    const previous = i > 0 ? bare(tokens[i - 1]) : "";
    const word = bare(tokens[i]);
    if (!word) continue;

    if (DETERMINERS.has(previous) || PREPOSITIONS.has(previous)) {
      tags[i] = "noun";
      continue;
    }
    if (VERB_CUES.has(previous) || SUBJECT_PRONOUNS.has(previous)) {
      tags[i] = "verb";
      continue;
    }
    // An adjective before the word ("the *sharp* conflict") still makes it a
    // noun; the determiner is usually two back rather than one.
    if (i >= 2 && DETERMINERS.has(bare(tokens[i - 2]))) {
      tags[i] = "noun";
      continue;
    }
    // Sentence-initial with a following determiner reads as an imperative or a
    // fronted verb: "Record the vote."
    if (i === 0 && i + 1 < tokens.length && DETERMINERS.has(bare(tokens[i + 1]))) {
      tags[i] = "verb";
    }
  }
  return tags;
}
