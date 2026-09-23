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

/**
 * Where a chunk stops taking sentences, in phoneme tokens — about fifteen
 * seconds of speech.
 *
 * 510 is the model's ceiling, not a good operating point. Kokoro's prosody is
 * at its best on a sentence or a few of them and audibly flattens and rushes as
 * an input approaches the cap, which is why the reference clients all feed it
 * sentence by sentence rather than filling the window. A chunk this size also
 * renders in a fraction of the time a full one does, which is what the reader
 * is waiting on at the start of a document and after every seek into audio
 * that does not exist yet.
 */
export const TARGET = 250;

/**
 * A chunk shorter than this takes the next sentence even past `TARGET`, so a
 * three-word sentence is not rendered as an utterance of its own.
 */
export const MIN_CHUNK = 60;

/** A single sentence longer than this is divided at its clauses. */
export const LONG_SENTENCE = 340;

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
    const joined: boolean[] = [];
    const unknown: Record<string, number> = {};
    // Word separator. Kokoro reads the space as a word boundary; its own
    // duration lands in the gap between two words, which is exactly where
    // Timeline expects a gap to be.
    const space = this.vocabulary.spaceID;

    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      const { tokens: encoded, unknown: missing } = this.vocabulary.encode(word.phonemes);
      for (const symbol of missing) unknown[symbol] = (unknown[symbol] ?? 0) + 1;
      // No space before a word eSpeak welded to the previous one — the stream
      // stays exactly as eSpeak produced it — and none for a word with nothing
      // to say, which would otherwise leave two spaces in a row.
      const separated = !word.joined && encoded.length > 0 && tokenIDs.length > 0;
      if (separated && space !== undefined) tokenIDs.push(space);
      const start = tokenIDs.length;
      for (const id of encoded) tokenIDs.push(id);
      // A word that encoded to nothing still needs a range, or the 1:1
      // alignment with `Block.spans` breaks. An empty range at the right place
      // gives it zero duration and keeps every later index correct.
      ranges.push({ start, end: tokenIDs.length });
      joined.push(word.joined === true);
    }

    const chunks = splitChunks(block.id, tokenIDs, ranges, tokens, joined);
    return { chunks, unknownSymbols: unknown };
  }
}

function rebased(ranges: readonly TokenRange[], offset: number): TokenRange[] {
  return ranges.map((r) => ({ start: r.start - offset, end: r.end - offset }));
}

const CLAUSE_END = /[,;:—–]["'”’)\]]*$/u;

/**
 * The split itself. Separated out so it is testable without a phonemizer.
 *
 * A chunk is whole sentences, packed until the next one would take it past
 * `TARGET`. Kokoro renders each chunk as one utterance with its own intonation
 * contour, so a cut anywhere but a sentence end is heard: the voice drops as if
 * the sentence were over, pauses, and starts the rest on a fresh breath. Only a
 * sentence too long to render well is divided, at a clause if it has one and at
 * a word boundary if it does not — and never between two words eSpeak welded
 * together (`joined`), which share one group of phonemes.
 */
export function splitChunks(
  blockID: string,
  tokenIDs: readonly number[],
  ranges: readonly TokenRange[],
  tokens: readonly string[],
  joined: readonly boolean[] = [],
): PhonemizedChunk[] {
  if (ranges.length === 0) return [];
  const count = ranges.length;
  /** A chunk may begin at word `w`. */
  const canStart = (w: number): boolean => w <= 0 || w >= count || !joined[w];
  /** Phoneme tokens in words `[from, to)`. */
  const length = (from: number, to: number): number => ranges[to - 1].end - ranges[from].start;

  // Sentences.
  const sentences: Array<[number, number]> = [];
  let from = 0;
  for (let w = 0; w < count; w++) {
    if (w === count - 1 || (isSentenceEnd(tokens[w] ?? "") && canStart(w + 1))) {
      sentences.push([from, w + 1]);
      from = w + 1;
    }
  }

  // Sentences too long to render well, divided at clauses, then at words.
  const pieces: Array<[number, number]> = [];
  for (const [a, b] of sentences) {
    if (length(a, b) <= LONG_SENTENCE) {
      pieces.push([a, b]);
      continue;
    }
    for (const [c, d] of pack(a, b, (w) => CLAUSE_END.test(tokens[w] ?? ""), TARGET)) {
      if (length(c, d) <= LONG_SENTENCE) {
        pieces.push([c, d]);
        continue;
      }
      // No clause to cut at: as even as the words allow.
      const parts = Math.ceil(length(c, d) / TARGET);
      pieces.push(...pack(c, d, () => true, Math.ceil(length(c, d) / parts)));
    }
  }

  // Whole pieces, packed up to TARGET.
  const spans: Array<[number, number]> = [];
  for (const piece of pieces) {
    const current = spans[spans.length - 1];
    if (current) {
      const combined = length(current[0], piece[1]);
      if (combined <= TARGET || (length(current[0], current[1]) < MIN_CHUNK && combined <= BUDGET)) {
        current[1] = piece[1];
        continue;
      }
    }
    spans.push([piece[0], piece[1]]);
  }
  // A short last sentence rides with the one before it rather than alone.
  if (spans.length >= 2) {
    const last = spans[spans.length - 1];
    const previous = spans[spans.length - 2];
    if (length(last[0], last[1]) < MIN_CHUNK && length(previous[0], last[1]) <= BUDGET) {
      previous[1] = last[1];
      spans.pop();
    }
  }

  return spans.map(([a, b]) => makeChunk(blockID, tokenIDs, ranges, a, b));

  /**
   * Words `[a, b)` in runs of at most `target` tokens, cutting after a word
   * `isCut` accepts, or before the word that would pass `BUDGET` when none
   * does.
   */
  function pack(a: number, b: number, isCut: (w: number) => boolean, target: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let start = a;
    while (start < b) {
      let end = b;
      let lastCut = -1;
      for (let w = start; w < b; w++) {
        const size = length(start, w + 1);
        if (w > start && size > BUDGET) {
          end = lastCut > start ? lastCut : previousStart(w, start);
          break;
        }
        if (size > target && lastCut > start) {
          end = lastCut;
          break;
        }
        if (w + 1 < b && canStart(w + 1) && isCut(w)) lastCut = w + 1;
      }
      out.push([start, end]);
      start = end;
    }
    return out;
  }

  /** The last word at or before `w` a chunk may start at, but never `start` itself. */
  function previousStart(w: number, start: number): number {
    let at = w;
    while (at > start + 1 && !canStart(at)) at--;
    return Math.max(at, start + 1);
  }
}

function makeChunk(
  blockID: string,
  tokenIDs: readonly number[],
  ranges: readonly TokenRange[],
  from: number,
  to: number,
): PhonemizedChunk {
  const chunkStart = ranges[from].start;
  let sliceEnd = ranges[to - 1].end;
  let chunkRanges = rebased(ranges.slice(from, to), chunkStart);

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

  return {
    id: newID(),
    blockID,
    tokens: tokenIDs.slice(chunkStart, sliceEnd),
    wordPhonemeRanges: chunkRanges,
    spanOffset: from,
  };
}
