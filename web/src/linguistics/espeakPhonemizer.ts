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
 * ## What the voice hears, and what the highlight needs
 *
 * These are two different questions and this file used to answer them with one
 * string. The voice should hear exactly what kokoro-js would feed it: the
 * passage phonemized as running text, which is what gives eSpeak its context —
 * *the record shows* against *they record the vote*, weak "the" and "a" rather
 * than the stressed citation forms, "of the" run together as one `ʌvðə`. The
 * highlight needs one phoneme range per source token.
 *
 * eSpeak's word boundaries are not ours — "1993" comes back as three groups, "of
 * the" as one — so the old approach was to force the phonemes into one group
 * per token, and wherever that did not work, re-phonemize the tokens in
 * question one at a time. Re-phonemizing a word on its own is exactly what
 * reading from a word list sounds like: every "a" became the letter *A*, every
 * "the" took full stress, and roughly half the paragraphs of ordinary academic
 * prose went through that path. Worse, the repair mislocated the weld as often
 * as not and kept both copies, so "depends on the support" was spoken as
 * "depends on on-the support".
 *
 * So the phoneme stream is now never rewritten. It is eSpeak's contextual
 * output, verbatim, and only its *division* among the tokens is solved for:
 * a monotonic alignment in which one token may take several groups (a number
 * read out), several tokens may share one group (a weld), and a token with
 * nothing to say (a bare dash) may take none. A shared group is divided at the
 * point its tokens' lengths suggest and the later tokens are marked `joined`,
 * so the chunker encodes the group with no space in it — the stream the model
 * receives is byte-for-byte the one kokoro-js would have built. A misplaced cut
 * inside `ʌvðə` moves a highlight by a few milliseconds; it can no longer
 * change a single sound the listener hears.
 *
 * Per-token phonemization survives only as the fallback for a passage the
 * alignment cannot account for at all, which ordinary text does not produce.
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

/**
 * Most tokens one contextual pass covers.
 *
 * eSpeak's context never reaches across a sentence end — the punctuation split
 * in `phonemizeContextually` hands it each clause separately anyway — so a long
 * paragraph can be cut at its sentence ends without changing a single phoneme.
 * What the cut buys is a small alignment table: a 3,000-word block out of a scan
 * with no paragraph breaks is thirty small problems instead of one enormous one.
 */
const PIECE_TOKENS = 120;

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
  /** Passages that fell back to per-token phonemization. Reported as a diagnostic. */
  isolatedPassages = 0;

  constructor(language: EspeakLanguage = "a") {
    this.language = language;
  }

  async phonemize(tokens: readonly string[], posTags: readonly POSTag[]): Promise<PhonemizedWord[]> {
    if (tokens.length === 0) return [];

    const out: PhonemizedWord[] = [];
    for (const [from, to] of passages(tokens, PIECE_TOKENS)) {
      const passage = tokens.slice(from, to);
      const contextual = await this.phonemizeContextually(passage.join(" "));
      const groups = contextual.split(/\s+/u).filter((g) => g.length > 0);

      let aligned = alignContextual(passage, groups);
      if (!aligned) {
        this.isolatedPassages += 1;
        aligned = (await this.phonemizeEachToken(passage)).map((phonemes) => ({ phonemes, joined: false }));
      }

      for (let i = 0; i < passage.length; i++) {
        const token = passage[i];
        const override = this.override(token, posTags[from + i]);
        out.push({
          token,
          phonemes: override ?? aligned[i].phonemes,
          joined: override === undefined ? aligned[i].joined : false,
        });
      }
    }
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

  /** kokoro-js's `phonemize`, step for step. */
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

// MARK: - Passages

const CLAUSE_END = /[,;:—–]["'”’)\]]*$/u;
const SENTENCE_END = /[.!?…]["'”’)\]]*$/u;

/**
 * Cuts `tokens` into `[from, to)` passages of at most `limit`, preferring to cut
 * after a sentence end, then after a clause end, and only then anywhere.
 *
 * Deliberately cruder than the chunker's sentence test: a false sentence end
 * here ("Vol.") costs nothing, because eSpeak was going to be handed the text
 * on either side of that period separately anyway.
 */
export function passages(tokens: readonly string[], limit: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from = 0;
  while (from < tokens.length) {
    if (tokens.length - from <= limit) {
      out.push([from, tokens.length]);
      break;
    }
    let cut = -1;
    for (const pattern of [SENTENCE_END, CLAUSE_END]) {
      for (let i = from + limit - 1; i >= from + Math.floor(limit / 3); i--) {
        if (pattern.test(tokens[i])) {
          cut = i + 1;
          break;
        }
      }
      if (cut > 0) break;
    }
    if (cut < 0) cut = from + limit;
    out.push([from, cut]);
    from = cut;
  }
  return out;
}

// MARK: - Alignment

export interface AlignedWord {
  phonemes: string;
  /** This word's phonemes continue the previous word's group; no space between. */
  joined: boolean;
}

/** Most groups one token may take — a long number read out in full. */
const MAX_SPLIT = 12;
/** Most tokens one group may carry — eSpeak welds two or three at most. */
const MAX_MERGE = 6;

/** Something eSpeak will say: a letter, a digit, or a symbol it reads as a word. */
const WORD_CHARACTER = /[\p{L}\p{Nd}&%$£€@+=#§]/u;
const PUNCTUATION_ONLY = /^[;:,.!?¡¿—…"«»“”()'\-–]+$/u;
const NOT_A_SEGMENT = new Set(["ˈ", "ˌ", "ː", "ˑ"]);

/**
 * A rough phoneme count from the orthography, used to decide where a token's
 * share of the groups ends. English runs about 0.8 phonemes per letter once a
 * silent final e is off; a digit is read out as three or four.
 */
export function estimateSegments(token: string): number {
  const letters = token.replace(/[^\p{L}]/gu, "");
  let count = letters.length;
  if (letters.length > 3 && /e$/i.test(letters)) count -= 1;
  // An acronym or a Roman numeral is read letter by letter or as a number,
  // either way far longer than its spelling.
  let spoken = isCapitalized(letters) ? letters.length * 2.5 : count * 0.8;
  // A run of digits is read as words: "12" is twelve, "45" forty-five, "1993"
  // nineteen ninety-three. Roughly how long each of those comes out.
  for (const run of token.match(/\p{Nd}+/gu) ?? []) spoken += DIGIT_RUN[run.length] ?? run.length * 4;
  return Math.round(spoken);
}

const DIGIT_RUN: Record<number, number> = { 1: 4, 2: 7.5, 3: 13, 4: 15 };

/** "US", "XIV", "NATO" — two or more letters, every one of them a capital. */
function isCapitalized(letters: string): boolean {
  return letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

/**
 * The sounds a word can open with, by its first letter.
 *
 * Lengths alone cannot tell "pages twelve" from "twelve pages" once a number
 * nearby has taken one group too few — every shifted assignment is about as
 * plausible as the right one — but "pages" does not begin with /f/ and "twelve"
 * does not begin with /p/. This is that check, deliberately permissive: a letter
 * lists every sound English spelling lets it open with, so it only ever rules
 * out assignments that cannot be right.
 */
const OPENINGS: Record<string, string> = {
  a: "aæɐəeɑɔʌɛɪoʊ",
  b: "b",
  c: "ksʃtʧ",
  d: "dʤʒ",
  e: "ɛiɪəᵻeɐʌjɜa",
  f: "f",
  g: "ɡʤdʒn",
  h: "hwɑɔʌaɐəoʊ",
  i: "ɪaiəᵻɜ",
  j: "dʤʒjh",
  k: "kn",
  l: "l",
  m: "m",
  n: "n",
  o: "ɑoɔəʌwɐʊaɜuɪ",
  p: "psnt",
  q: "k",
  r: "ɹ",
  s: "sʃzʒ",
  t: "tθðʃʧ",
  u: "jʌʊuəɜɐɪ",
  v: "v",
  w: "wɹhʊu",
  x: "zɛe",
  y: "jaɪiə",
  z: "zts",
  // A number opens with the word for its leading digit — except that a
  // leading 1 may be ten, eleven, twelve, a teen or a century, so it opens
  // with nearly anything and is not checked at all.
  "0": "zoʊnɑ",
  "2": "t",
  "3": "θ",
  "4": "f",
  "5": "f",
  "6": "s",
  "7": "s",
  "8": "e",
  "9": "n",
};

const GROUP_LEAD = /^[;:,.!?¡¿—…"«»“”()'ˈˌ\-–]+/u;
const TOKEN_LEAD = /^[^\p{L}\p{Nd}]+/u;

/** False only when `phonemes` cannot be how `token` begins. */
export function opensLike(token: string, phonemes: string): boolean {
  const word = token.replace(TOKEN_LEAD, "").toLowerCase();
  const first = word[0];
  const sound = phonemes.replace(GROUP_LEAD, "")[0];
  if (first === undefined || sound === undefined) return true;
  // The one common digraph whose sound is not among its first letter's.
  const allowed = word.startsWith("ph") ? "f" : OPENINGS[first];
  // Accented Latin, other scripts, "1": nothing worth ruling out.
  if (allowed === undefined) return true;
  return allowed.includes(sound);
}

/** Stress and length marks are not segments of their own; punctuation is not either. */
function segmentCount(phonemes: string): number {
  let n = 0;
  for (const ch of phonemes) {
    if (NOT_A_SEGMENT.has(ch) || PUNCTUATION_ONLY.test(ch)) continue;
    n++;
  }
  return n;
}

/** How a step of the alignment consumed tokens and groups. */
const Link = {
  /** One token, no group: punctuation eSpeak did not voice. */
  Skip: 1,
  /** One group, no token: a stray punctuation group, attached to its neighbour. */
  Orphan: 2,
  /** One token, `count` groups. */
  Split: 3,
  /** `count` tokens, one group. */
  Merge: 4,
} as const;
type Link = (typeof Link)[keyof typeof Link];

/**
 * Divides eSpeak's contextual groups among `tokens` without changing a symbol
 * of them.
 *
 * Returns undefined only when the best division still leaves words with no
 * sound or sound with no word — the signature of a passage eSpeak read
 * differently from how it was tokenized, where the caller's per-token fallback
 * is the honest answer.
 */
export function alignContextual(tokens: readonly string[], groups: readonly string[]): AlignedWord[] | undefined {
  const n = tokens.length;
  const m = groups.length;
  if (n === 0) return [];
  // `passages` keeps both sides near 120; this only catches a caller that did not.
  if ((n + 1) * (m + 1) > 2_000_000) return undefined;

  const estimates = tokens.map(estimateSegments);
  const speakable = tokens.map((t) => WORD_CHARACTER.test(t));
  // A number, a date range, an abbreviation or a compound can legitimately
  // come back as several groups; an ordinary word should not.
  const expandable = tokens.map(
    (t) => /[\p{Nd}\-–—/.&%$£+@]/u.test(t) || isCapitalized(t.replace(/[^\p{L}]/gu, "")),
  );
  const punctuationGroup = groups.map((g) => PUNCTUATION_ONLY.test(g));
  const segments = groups.map(segmentCount);
  const prefix = new Float64Array(m + 1);
  for (let j = 0; j < m; j++) prefix[j + 1] = prefix[j] + segments[j];
  const tokenPrefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) tokenPrefix[i + 1] = tokenPrefix[i] + estimates[i];

  const letterCounts = tokens.map((t) => t.replace(/[^\p{L}]/gu, "").length);

  const width = m + 1;
  // Whether token i could begin with group j, for every pair the table can reach.
  const opens = new Uint8Array((n + 1) * width);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) opens[i * width + j] = opensLike(tokens[i], groups[j]) ? 1 : 0;
  }
  const INF = Number.POSITIVE_INFINITY;
  const cost = new Float64Array((n + 1) * width).fill(INF);
  // Back-pointer: link kind * 64 + count.
  const back = new Int32Array((n + 1) * width);
  cost[0] = 0;

  const relax = (i: number, j: number, value: number, kind: Link, count: number): void => {
    const at = i * width + j;
    if (value < cost[at]) {
      cost[at] = value;
      back[at] = kind * 64 + count;
    }
  };

  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const base = cost[i * width + j];
      if (base === INF) continue;

      if (i < n) relax(i + 1, j, base + (speakable[i] ? 25 : 0), Link.Skip, 1);
      if (j < m) relax(i, j + 1, base + (punctuationGroup[j] ? 0.5 : 25), Link.Orphan, 1);

      if (i < n) {
        const limit = Math.min(expandable[i] ? MAX_SPLIT : 4, m - j);
        let silent = true;
        for (let g = 1; g <= limit; g++) {
          silent &&= punctuationGroup[j + g - 1];
          const length = prefix[j + g] - prefix[j];
          let value = base + (g > 1 ? (expandable[i] ? 0.6 : 4) * (g - 1) : 0);
          if (speakable[i]) {
            // A word that took nothing but punctuation has been shifted off its
            // own sound; a word that took a sound it cannot begin with, too.
            if (silent) value += 8;
            else value += 0.5 * Math.abs(estimates[i] - length) + (opens[i * width + j] ? 0 : 3);
          } else if (!silent) {
            // A bare dash or bracket that took a real group has taken a word's.
            value += 8;
          }
          relax(i + 1, j + g, value, Link.Split, g);
        }
      }

      if (j < m && !punctuationGroup[j]) {
        const limit = Math.min(MAX_MERGE, n - i);
        let penalty = opens[i * width + j] ? 0 : 3;
        for (let k = 2; k <= limit; k++) {
          // eSpeak welds unstressed function words onto what follows them —
          // "of the", "that the", "in which", "not a" — so every token but the
          // last should be short, and the last rarely a long content word.
          const previous = i + k - 2;
          penalty += letterCounts[previous] > 4 ? 4 : 0;
          penalty += speakable[previous] ? 0 : 2;
          const last = i + k - 1;
          const tail = Math.max(0, letterCounts[last] - 5) * 0.5 + (speakable[last] ? 0 : 2);
          const estimate = tokenPrefix[i + k] - tokenPrefix[i];
          const value = base + 0.5 * Math.abs(estimate - segments[j]) + 2.5 * (k - 1) + penalty + tail;
          relax(i + k, j + 1, value, Link.Merge, k);
        }
      }
    }
  }

  if (cost[n * width + m] === INF) return undefined;

  // Walk back, then replay forwards.
  const links: Array<{ kind: Link; count: number; i: number; j: number }> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const code = back[i * width + j];
    const kind = Math.floor(code / 64) as Link;
    const count = code % 64;
    if (kind < Link.Skip || kind > Link.Merge) return undefined;
    const fromI = kind === Link.Skip || kind === Link.Split ? i - 1 : kind === Link.Merge ? i - count : i;
    const fromJ = kind === Link.Orphan || kind === Link.Merge ? j - 1 : kind === Link.Split ? j - count : j;
    links.push({ kind, count, i: fromI, j: fromJ });
    i = fromI;
    j = fromJ;
  }
  links.reverse();

  const words: AlignedWord[] = [];
  let pendingPrefix = "";
  let silentWords = 0;
  let strayGroups = 0;
  for (const link of links) {
    switch (link.kind) {
      case Link.Skip:
        if (speakable[link.i]) silentWords += 1;
        words.push({ phonemes: "", joined: false });
        break;
      case Link.Orphan: {
        const group = groups[link.j];
        if (!punctuationGroup[link.j]) strayGroups += 1;
        const previous = words[words.length - 1];
        if (previous) previous.phonemes = previous.phonemes ? `${previous.phonemes} ${group}` : group;
        else pendingPrefix = `${pendingPrefix}${group} `;
        break;
      }
      case Link.Split:
        words.push({ phonemes: pendingPrefix + groups.slice(link.j, link.j + link.count).join(" "), joined: false });
        pendingPrefix = "";
        break;
      case Link.Merge: {
        const parts = divideGroup(groups[link.j], tokens.slice(link.i, link.i + link.count));
        parts.forEach((part, index) => {
          words.push({ phonemes: index === 0 ? pendingPrefix + part : part, joined: index > 0 });
        });
        pendingPrefix = "";
        break;
      }
    }
  }
  if (pendingPrefix && words.length > 0) {
    const last = words[words.length - 1];
    last.phonemes = `${last.phonemes} ${pendingPrefix.trim()}`.trim();
  }

  if (words.length !== n) return undefined;
  // A word or two eSpeak had nothing for is a quirk; more is a passage it read
  // some other way, and the alignment above is not describing it.
  const tolerated = Math.max(1, Math.floor(n / 20));
  if (silentWords + strayGroups > tolerated) return undefined;
  return words;
}

/** Marks that modify the symbol before them and must stay with it. */
const MODIFIERS = new Set(["ː", "ˑ", "ʰ", "ʲ", "\u0303", "\u0329"]);
const STRESS = new Set(["ˈ", "ˌ"]);

/**
 * Divides one welded group among the tokens that share it, by their expected
 * lengths. Every symbol lands in exactly one part, in order, so concatenating
 * the parts gives back `group` unchanged.
 */
export function divideGroup(group: string, tokens: readonly string[]): string[] {
  const symbols = [...group];
  const k = tokens.length;
  if (k <= 1) return [group];
  const weights = tokens.map((t) => Math.max(1, estimateSegments(t)));
  const total = weights.reduce((a, b) => a + b, 0);

  const cuts: number[] = [];
  let running = 0;
  let previous = 0;
  for (let index = 0; index < k - 1; index++) {
    running += weights[index];
    let cut = Math.round((symbols.length * running) / total);
    // Leave room for every later part to have at least a symbol where it can.
    cut = Math.max(previous + 1, Math.min(cut, symbols.length - (k - 1 - index)));
    while (cut < symbols.length && MODIFIERS.has(symbols[cut])) cut++;
    // A stress mark belongs to the syllable after it.
    if (cut - 1 > previous && STRESS.has(symbols[cut - 1])) cut--;
    cut = Math.min(Math.max(cut, previous), symbols.length);
    cuts.push(cut);
    previous = cut;
  }

  const parts: string[] = [];
  let start = 0;
  for (const cut of [...cuts, symbols.length]) {
    parts.push(symbols.slice(start, cut).join(""));
    start = cut;
  }
  return parts;
}
