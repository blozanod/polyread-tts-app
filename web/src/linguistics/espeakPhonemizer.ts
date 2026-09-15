import { PolyReadError } from "../core/errors";
import { homographPhonemes, type POSTag } from "./homographs";
import { normalizeText, postProcessPhonemes, splitOnPunctuation } from "./kokoroText";
import type { Phonemizer, PhonemizerCapabilities, PhonemizedWord } from "./phonemizer";

/**
 * §6.1's backend, on the web.
 *
 * The Swift build left this as an integration point because MisakiSwift had not
 * been evaluated against §0.3. The web has a decided answer instead: eSpeak-NG,
 * compiled to WebAssembly and shipped in the `phonemizer` package (Apache-2.0),
 * which is the same G2P `kokoro-js` uses for this checkpoint. It resolves
 * homographs from context and expands numbers, so `homographPhonemes` stays
 * dormant behind `resolvesHomographs`.
 *
 * ## The §0.3 problem, and what is done about it
 *
 * eSpeak does not answer §0.3 by itself. It phonemizes *text*, and its word
 * boundaries are its own: "1993" comes back as three groups, a bare "(" as
 * none. The grouping the highlight rests on has to be exactly one group per
 * source token, and §0.3 is explicit that guessing an alignment is worse than
 * failing — "the bug will look like a timing bug."
 *
 * So the alignment is not guessed, it is solved and then checked:
 *
 *  1. Phonemize the whole block at once, which is what gives context-sensitive
 *     pronunciation (*the record shows* vs *they record the vote*).
 *  2. If the group count already matches the token count, take it 1:1. This is
 *     the overwhelmingly common case for ordinary prose.
 *  3. Otherwise run a monotonic dynamic program that assigns each token a
 *     contiguous, possibly empty, run of groups, scored against what each token
 *     *structurally* implies: a token with no letters or digits takes none, a
 *     token with digits may take many, an ordinary word takes one.
 *  4. Verify the solution token by token. If any token came out with a group
 *     count its structure forbids, the alignment is discarded rather than
 *     shipped.
 *  5. Work out *which* tokens eSpeak ran together — it welds short function
 *     words, so "of the" comes back as one `ʌvðə` — and phonemize only those
 *     separately. If that cannot be localized either, every token is
 *     phonemized separately, which is 1:1 by construction and costs only
 *     cross-word context.
 *
 * Steps 4 and 5 are why this is allowed to exist at all: there is always a
 * correct answer to fall back to, so the DP is an optimization of *quality*,
 * never a load-bearing guess about *alignment*.
 */

type EspeakFn = (text: string, language?: string) => Promise<string[]>;

let espeakPromise: Promise<EspeakFn> | undefined;

async function loadEspeak(): Promise<EspeakFn> {
  if (!espeakPromise) {
    espeakPromise = import("phonemizer")
      .then((module) => module.phonemize as EspeakFn)
      .catch((cause) => {
        espeakPromise = undefined;
        throw new PolyReadError(
          "phonemizerUnavailable",
          `eSpeak-NG (the "phonemizer" package) failed to load: ${String(cause)}`,
        );
      });
  }
  return espeakPromise;
}

export type EspeakLanguage = "a" | "b";

const ESPEAK_VOICE: Record<EspeakLanguage, string> = { a: "en-us", b: "en" };

export class EspeakPhonemizer implements Phonemizer {
  readonly name = "eSpeak-NG (wasm)";
  readonly capabilities: PhonemizerCapabilities = {
    providesWordGrouping: true,
    resolvesHomographs: true,
    expandsNumbers: true,
  };

  private readonly language: EspeakLanguage;
  /** Academic prose repeats heavily; this saves most of the per-token passes. */
  private readonly wordCache = new Map<string, string>();

  constructor(language: EspeakLanguage = "a") {
    this.language = language;
  }

  async phonemize(tokens: readonly string[], posTags: readonly POSTag[]): Promise<PhonemizedWord[]> {
    if (tokens.length === 0) return [];

    const contextual = await this.phonemizeContextually(tokens.join(" "));
    const groups = contextual.split(/\s+/u).filter((g) => g.length > 0);

    let phonemes: string[];
    if (groups.length === tokens.length) {
      phonemes = groups;
    } else {
      phonemes = (await this.repairAlignment(tokens, groups)) ?? (await this.phonemizeEachToken(tokens));
    }

    return tokens.map((token, i) => ({
      token,
      phonemes: this.override(token, posTags[i]) ?? phonemes[i] ?? "",
    }));
  }

  /**
   * Rescues the context-sensitive pass when eSpeak has welded two tokens into
   * one group.
   *
   * This is the common failure, not an exotic one: eSpeak runs short function
   * words together, so "of the" comes back as `ʌvðə` and "that the" as `ðætðə`,
   * and roughly half the paragraphs in ordinary academic prose contain at least
   * one. Step 4's verification correctly refuses that alignment — there is no
   * honest way to say where inside `ʌvðə` the word boundary is — but discarding
   * the *whole* paragraph over it threw away the cross-word context for every
   * other word in it and paid for a separate eSpeak pass per token, which is
   * the slowest path in §6 by a wide margin.
   *
   * So the merged run is located and only its tokens are re-phonemized. A
   * token's phonemes still come from one place or the other, never from a guess
   * about how to cut a group in half, and §0.3's 1:1 guarantee is unchanged.
   */
  private async repairAlignment(
    tokens: readonly string[],
    groups: readonly string[],
  ): Promise<string[] | undefined> {
    const strict = alignTokens(tokens, groups);
    if (strict) return strict.phonemes;
    if (groups.length >= tokens.length) return undefined;

    const loose = alignTokens(tokens, groups, { allowMerges: true });
    if (!loose) return undefined;

    // A run is a token that took a group followed by the tokens that took none.
    const suspect = new Set<number>();
    for (let i = 0; i < tokens.length; i++) {
      if (loose.counts[i] !== 0) continue;
      suspect.add(i);
      for (let j = i - 1; j >= 0; j--) {
        suspect.add(j);
        if (loose.counts[j] !== 0) break;
      }
    }
    // Nothing worth keeping if the merge touched most of the paragraph.
    if (suspect.size > tokens.length / 2) return undefined;

    const indices = [...suspect].sort((a, b) => a - b);
    const redone = await this.phonemizeEachToken(indices.map((i) => tokens[i]));
    const out = [...loose.phonemes];
    indices.forEach((index, at) => {
      out[index] = redone[at] ?? "";
    });
    return out;
  }

  /**
   * Only consulted when the backend says it does not resolve homographs, which
   * eSpeak does. Kept wired so swapping in a backend that does not is a
   * one-line capability change rather than a rewrite.
   */
  private override(token: string, tag: POSTag | undefined): string | undefined {
    if (this.capabilities.resolvesHomographs) return undefined;
    const bare = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (!bare) return undefined;
    return homographPhonemes(bare, tag ?? "other");
  }

  private async phonemizeContextually(text: string): Promise<string> {
    const espeak = await loadEspeak();
    const voice = ESPEAK_VOICE[this.language];
    const normalized = normalizeText(text);
    const segments = splitOnPunctuation(normalized);
    const parts = await Promise.all(
      segments.map(async (segment) => {
        if (segment.isPunctuation) return segment.text;
        const trimmed = segment.text.trim();
        if (!trimmed) return segment.text;
        const spoken = (await espeak(segment.text, voice)).join(" ");
        // Keep the segment's own outer spacing: it is what separates this run
        // of words from the punctuation on either side, and dropping it would
        // weld two tokens into one group.
        const lead = /^\s/.test(segment.text) ? " " : "";
        const tail = /\s$/.test(segment.text) ? " " : "";
        return lead + spoken + tail;
      }),
    );
    return postProcessPhonemes(parts.join(""), this.language);
  }

  private async phonemizeEachToken(tokens: readonly string[]): Promise<string[]> {
    const espeak = await loadEspeak();
    const voice = ESPEAK_VOICE[this.language];
    const out: string[] = [];
    for (const token of tokens) {
      const cached = this.wordCache.get(token);
      if (cached !== undefined) {
        out.push(cached);
        continue;
      }
      const normalized = normalizeText(token);
      const segments = splitOnPunctuation(normalized);
      const parts: string[] = [];
      for (const segment of segments) {
        if (segment.isPunctuation) {
          parts.push(segment.text.trim());
          continue;
        }
        const trimmed = segment.text.trim();
        if (!trimmed) continue;
        parts.push((await espeak(trimmed, voice)).join(" "));
      }
      // One source token is one spoken token whatever eSpeak did inside it, so
      // the internal spaces collapse: this is the branch that guarantees 1:1.
      const phonemes = postProcessPhonemes(parts.join(" "), this.language).replace(/\s+/gu, "");
      this.wordCache.set(token, phonemes);
      out.push(phonemes);
    }
    return out;
  }
}

// MARK: - Alignment

/** How many phoneme groups a token's *structure* permits. */
export function allowedGroupRange(token: string): { min: number; max: number; natural: number } {
  const hasLetter = /\p{L}/u.test(token);
  const hasDigit = /\p{Nd}/u.test(token);
  if (!hasLetter && !hasDigit) return { min: 0, max: 0, natural: 0 };
  // eSpeak reads a number out as words, and a four-digit year as two or three.
  if (hasDigit) return { min: 1, max: 8, natural: 1 };
  // A compound or a slashed pair can legitimately come back as two or three.
  if (/[-–—/]/u.test(token)) return { min: 1, max: 4, natural: 1 };
  return { min: 1, max: 2, natural: 1 };
}

/**
 * A rough phoneme count from the orthography, used only as a soft tiebreak.
 * English runs about 0.8 phonemes per letter once silent endings are taken off.
 */
function estimatePhonemeCount(token: string): number {
  const letters = token.replace(/[^\p{L}]/gu, "");
  if (letters.length === 0) return 0;
  let count = letters.length;
  if (letters.length > 3 && /e$/i.test(letters)) count -= 1;
  return Math.max(1, Math.round(count * 0.8));
}

/** Stress marks and length marks are not segments; they should not be counted. */
function segmentCount(phonemes: string): number {
  let n = 0;
  for (const ch of phonemes) {
    if ("ˈˌːˑ".includes(ch)) continue;
    n++;
  }
  return n;
}

const MISMATCH_PENALTY = 6;

/**
 * Monotonic alignment of eSpeak's groups onto our tokens.
 *
 * Returns one phoneme string per token, or `undefined` when the best solution
 * still violates a token's structural range — in which case the caller falls
 * back to per-token phonemization rather than shipping a bad alignment.
 */
export function alignGroupsToTokens(
  tokens: readonly string[],
  groups: readonly string[],
): string[] | undefined {
  return alignTokens(tokens, groups)?.phonemes;
}

export interface Alignment {
  phonemes: string[];
  /** How many groups each token took; 0 means eSpeak merged it into a neighbour. */
  counts: number[];
}

/**
 * The alignment itself.
 *
 * `allowMerges` lets a token take no groups at all, which is never a shippable
 * answer on its own — a word with no phonemes has no duration — but does
 * identify *which* tokens eSpeak ran together so the caller can re-do just
 * those. The strict mode is the one whose output can be used directly.
 */
export function alignTokens(
  tokens: readonly string[],
  groups: readonly string[],
  options: { allowMerges?: boolean } = {},
): Alignment | undefined {
  const n = tokens.length;
  const m = groups.length;
  if (n === 0) return { phonemes: [], counts: [] };
  // The table below is (n+1) x (m+1); a runaway OCR block with thousands of
  // both would allocate hundreds of megabytes for an answer nobody can trust
  // anyway. Per-token phonemization is 1:1 by construction, so it is the right
  // answer here rather than a fallback.
  if (n * m > 4_000_000) return undefined;

  const ranges = tokens.map((token) => {
    const range = allowedGroupRange(token);
    return options.allowMerges && range.max > 0 ? { ...range, min: 0 } : range;
  });
  const estimates = tokens.map(estimatePhonemeCount);

  // Prefix sums of group segment counts, so scoring a run is O(1).
  const groupSegments = groups.map(segmentCount);
  const prefix = new Array<number>(m + 1).fill(0);
  for (let i = 0; i < m; i++) prefix[i + 1] = prefix[i] + groupSegments[i];

  const INF = Number.POSITIVE_INFINITY;
  // dp[i][j]: best cost having consumed i tokens and j groups.
  const dp: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
  const take: Int16Array[] = Array.from({ length: n + 1 }, () => new Int16Array(m + 1).fill(-1));
  dp[0][0] = 0;

  for (let i = 0; i < n; i++) {
    const { min, max, natural } = ranges[i];
    const estimate = estimates[i];
    const remainingTokens = n - i - 1;
    for (let j = 0; j <= m; j++) {
      const base = dp[i][j];
      if (base === INF) continue;
      for (let g = min; g <= max; g++) {
        const next = j + g;
        if (next > m) break;
        // Every later token needs at least its own minimum; prune runs that
        // would starve them.
        if (m - next < 0 || m - next > remainingTokens * 8) continue;
        const segments = prefix[next] - prefix[j];
        const cost =
          base +
          (g === natural ? 0 : MISMATCH_PENALTY) +
          (estimate > 0 ? Math.abs(segments - estimate) * 0.5 : segments * 0.5);
        if (cost < dp[i + 1][next]) {
          dp[i + 1][next] = cost;
          take[i + 1][next] = g;
        }
      }
    }
  }

  if (dp[n][m] === INF) return undefined;

  const counts = new Array<number>(n).fill(0);
  let j = m;
  for (let i = n; i > 0; i--) {
    const g = take[i][j];
    if (g < 0) return undefined;
    counts[i - 1] = g;
    j -= g;
  }
  if (j !== 0) return undefined;

  // Step 4: verify rather than trust.
  const out: string[] = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const g = counts[i];
    const { min, max } = ranges[i];
    if (g < min || g > max) return undefined;
    out.push(groups.slice(cursor, cursor + g).join(""));
    cursor += g;
  }
  return { phonemes: out, counts };
}
