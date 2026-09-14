import { PolyReadError } from "../core/errors";
import { tokensOf } from "../core/spanInvariant";
import { isSpoken, newID, type Block, type PhonemizedChunk, type TokenRange } from "../core/types";
import { tagTokens } from "./posTagger";
import type { Phonemizer } from "./phonemizer";
import { defaultVocabulary, type KokoroVocabulary } from "./vocabulary";

/**
 * §6.2 — "Chunking runs AFTER phonemization. v1 had this backwards. `tokens` is
 * capped at `[1, 3…512]` — 510 phonemes plus two boundary zeros — and you
 * cannot know a paragraph's phoneme length until you phonemize it."
 */
export const BUDGET = 510;
/** §6.2 — "back off to the most recent sentence end within the last 25% of the budget." */
export const SENTENCE_BACKOFF_FRACTION = 0.25;

export interface ChunkResult {
  chunks: PhonemizedChunk[];
  /**
   * Symbols the phonemizer emitted that the vocabulary does not know. Not fatal
   * — they are dropped — but a long list means the phoneme set and the
   * vocabulary disagree, which is §0.3 territory.
   */
  unknownSymbols: Record<string, number>;
}

/**
 * Abbreviations that survive §5 — its table covers the ones that need *reading*
 * differently, which is a different list from the ones that merely end in a
 * period.
 */
const ABBREVIATIONS = new Set([
  "vol", "vols", "no", "nos", "ed", "eds", "ch", "chap", "chaps", "fig",
  "figs", "tab", "tabs", "pp", "esp", "vs", "mr", "mrs", "ms", "dr",
  "prof", "st", "jr", "sr", "rev", "trans", "repr", "sec", "secs", "nn",
  "cit", "ff", "inc", "dept", "univ", "co", "corp", "et", "al", "cf",
]);

/**
 * Sentence-final on the *source* token, not the phonemes — "Putnam." is a
 * sentence end and "Vol." is not, and only the orthography knows that.
 *
 * Being wrong here is cheap in one direction and not the other: a missed
 * sentence end just means the split falls on a word boundary instead, while a
 * false one puts a chunk break inside a sentence. So the abbreviation tests are
 * deliberately generous.
 */
export function isSentenceEnd(token: string): boolean {
  const trimmed = token.replace(/["'”’)\]}]+$/u, "");
  const last = trimmed[trimmed.length - 1];
  if (last !== "." && last !== "!" && last !== "?") return false;
  if (last !== ".") return true;

  const core = trimmed.slice(0, -1);
  // An initial: "J. S. Mill".
  if (core.length <= 1) return false;
  // An internal period: "U.S.", and anything §5 did not rewrite.
  if (core.includes(".")) return false;
  return !ABBREVIATIONS.has(core.toLowerCase());
}

export class Chunker {
  private readonly vocabulary: KokoroVocabulary;

  constructor(vocabulary: KokoroVocabulary = defaultVocabulary) {
    this.vocabulary = vocabulary;
  }

  /** Phonemizes and chunks one block. */
  async chunk(block: Block, phonemizer: Phonemizer): Promise<ChunkResult> {
    if (!isSpoken(block.role)) return { chunks: [], unknownSymbols: {} };

    const tokens = tokensOf(block.spokenText);
    if (tokens.length === 0) return { chunks: [], unknownSymbols: {} };

    const posTags = phonemizer.capabilities.resolvesHomographs ? [] : tagTokens(tokens);
    const words = await phonemizer.phonemize(tokens, posTags);

    if (words.length !== tokens.length) {
      // §0.3 — "If it only returns a flat phoneme string, stop and raise it."
      // A phonemizer that cannot keep one entry per word cannot support
      // word-level highlighting, and guessing an alignment would produce a
      // highlight that drifts instead of an error that says why.
      throw new PolyReadError("phonemizerLacksWordGrouping");
    }

    // Encode once. `wordPhonemeRanges` indexes into this.
    const tokenIDs: number[] = [];
    const ranges: TokenRange[] = [];
    const unknown: Record<string, number> = {};
    // Word separator. Kokoro reads the space as a word boundary; its own
    // duration lands in the gap between two words, which is exactly where
    // Timeline expects a gap to be.
    const space = this.vocabulary.spaceID;

    for (let index = 0; index < words.length; index++) {
      if (index > 0 && space !== undefined) tokenIDs.push(space);
      const start = tokenIDs.length;
      const { tokens: encoded, unknown: missing } = this.vocabulary.encode(words[index].phonemes);
      for (const symbol of missing) unknown[symbol] = (unknown[symbol] ?? 0) + 1;
      for (const id of encoded) tokenIDs.push(id);
      // A word that encoded to nothing still needs a range, or the 1:1
      // alignment with `Block.spans` breaks. An empty range at the right place
      // gives it zero duration and keeps every later index correct.
      ranges.push({ start, end: tokenIDs.length });
    }

    const chunks = splitChunks(block.id, tokenIDs, ranges, tokens);
    return { chunks, unknownSymbols: unknown };
  }
}

function rebased(ranges: readonly TokenRange[], offset: number): TokenRange[] {
  return ranges.map((r) => ({ start: r.start - offset, end: r.end - offset }));
}

/** The split itself. Separated out so it is testable without a phonemizer. */
export function splitChunks(
  blockID: string,
  tokenIDs: readonly number[],
  ranges: readonly TokenRange[],
  tokens: readonly string[],
): PhonemizedChunk[] {
  if (ranges.length === 0) return [];
  const total = tokenIDs.length;
  if (total <= BUDGET) {
    return [
      {
        id: newID(),
        blockID,
        tokens: [...tokenIDs],
        wordPhonemeRanges: rebased(ranges, ranges[0].start),
        spanOffset: 0,
      },
    ];
  }

  // §6.2 — "Emit chunks as close to uniform length as the text allows — the
  // style vector is selected by phoneme count (§7.1), so wildly varying chunk
  // lengths give wandering prosody." So aim for total/n rather than filling each
  // chunk to 510 and leaving a 40-phoneme runt at the end.
  const chunkCount = Math.ceil(total / BUDGET);
  const target = Math.min(BUDGET, Math.ceil(total / chunkCount));
  const backoff = Math.trunc(target * SENTENCE_BACKOFF_FRACTION);

  const chunks: PhonemizedChunk[] = [];
  let wordIndex = 0;

  while (wordIndex < ranges.length) {
    const chunkStart = ranges[wordIndex].start;
    let end = wordIndex;
    let lastSentenceEnd = -1;

    while (end < ranges.length) {
      const wouldBe = ranges[end].end - chunkStart;
      // Always take at least one word, or a pathological single word longer
      // than the budget would loop forever.
      if (end > wordIndex && wouldBe > target) break;
      if (end > wordIndex && wouldBe > BUDGET) break;
      if (isSentenceEnd(tokens[end])) lastSentenceEnd = end;
      end += 1;
    }

    // §6.2 — back off to the most recent sentence end, but only if it is inside
    // the last 25% of the budget. Backing off further would make this chunk much
    // shorter than its neighbours, which is the thing uniformity is avoiding.
    let cut = end;
    if (lastSentenceEnd >= 0 && lastSentenceEnd + 1 < end) {
      const lengthAtSentenceEnd = ranges[lastSentenceEnd].end - chunkStart;
      if (lengthAtSentenceEnd >= target - backoff) cut = lastSentenceEnd + 1;
    }
    cut = Math.max(cut, wordIndex + 1);

    let sliceEnd = ranges[cut - 1].end;
    let chunkRanges = rebased(ranges.slice(wordIndex, cut), chunkStart);

    // A single "word" longer than the whole budget is not English — it is a URL,
    // or two pages of a scan that came back without spaces. The model's input is
    // capped at [1, 3…512], so it has to be cut somewhere; cutting is better
    // than throwing away the paragraph around it.
    if (sliceEnd - chunkStart > BUDGET) {
      sliceEnd = chunkStart + BUDGET;
      chunkRanges = chunkRanges.map((range) => {
        const start = Math.min(range.start, BUDGET);
        return { start, end: Math.max(start, Math.min(range.end, BUDGET)) };
      });
    }

    chunks.push({
      id: newID(),
      blockID,
      tokens: tokenIDs.slice(chunkStart, sliceEnd),
      wordPhonemeRanges: chunkRanges,
      spanOffset: wordIndex,
    });
    wordIndex = cut;
  }

  return chunks;
}
