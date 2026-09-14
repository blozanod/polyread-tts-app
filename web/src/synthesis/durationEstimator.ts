import { SAMPLES_PER_FRAME } from "../core/frameMath";
import type { KokoroVocabulary } from "../linguistics/vocabulary";

/**
 * Per-token frame durations when the model will not tell us.
 *
 * ## Why this file exists
 *
 * §7.1 describes a two-package Kokoro whose first package returns `duration`
 * directly. The ONNX export the browser can fetch is one graph with one output,
 * `waveform`, and no way to ask an ONNX Runtime session for an intermediate
 * tensor. So on the web there are two tiers:
 *
 *  - **Exact.** `scripts/make-duration-model.py` cuts a duration-only subgraph
 *    out of the same `.onnx` file, and `kokoroEngine.ts` runs it as §7.2's
 *    Phase A. This is the spec, unmodified, and it is worth the one-time
 *    Python run.
 *  - **Estimated.** With no duration model, the chunk's *total* length is known
 *    exactly the moment it is rendered — the waveform is `frames · 600` samples
 *    — and only its internal division is unknown. That total is then split
 *    across tokens by phoneme class.
 *
 * The estimated tier is honest about being estimated: `ChunkTiming.source` says
 * so, the sidecar records it, and the reader shows it. It drifts *within* a
 * chunk (tens of milliseconds early on, a couple of hundred at worst near the
 * middle of a long paragraph) and is exact at every chunk boundary, because
 * each chunk's true length re-anchors it.
 */

/**
 * Relative durations by phoneme class, in 25 ms frames. These are typical
 * values for read English, not measurements of this checkpoint: a tense vowel
 * runs about twice a plosive, a sentence-final period buys a real pause, and a
 * stress diacritic is its own token that carries almost no time.
 *
 * Only the *ratios* matter. The absolute scale is re-fitted against the first
 * rendered chunks (see `Calibration`), so a systematic error washes out.
 */
const CLASSES: Array<[string, number]> = [
  // Tense vowels and diphthong nuclei.
  ["ɑɐɒæɔɜɝeioua", 5],
  // Lax vowels and reduced vowels.
  ["ɪʊɛʌəɚᵻɘɞøɵœ", 3],
  // Plosives.
  ["ptkbdɡɢqʔʡ", 2.5],
  // Affricates.
  ["ʧʤ", 4],
  // Fricatives.
  ["fvθðszʃʒhçxɣβɸʜʢħʕχʝɧ", 4],
  // Nasals.
  ["mnŋɱɲɴ", 3],
  // Liquids and glides.
  ["lɹrjwɫɭʎʟɾɽɺʀʁɻʋɥʍɰ", 3],
  // Diacritics: their own tokens, but almost no time of their own.
  ["ˈˌʼʴʰʱʲʷˠˤ˞↓↑→↗↘", 1],
  // Length marks extend the segment before them.
  ["ːˑ", 2],
];

const SENTENCE_FINAL = new Set([".", "!", "?", "…"]);
const CLAUSE_FINAL = new Set([",", ";", ":", "—"]);

function weightForSymbol(symbol: string): number {
  if (symbol === " ") return 2;
  if (SENTENCE_FINAL.has(symbol)) return 10;
  if (CLAUSE_FINAL.has(symbol)) return 6;
  if (symbol === "$") return 1;
  for (const [members, weight] of CLASSES) {
    if (members.includes(symbol)) return weight;
  }
  // Quotes, brackets, and anything unclassified: present but brief.
  return 1.5;
}

/** Symbol weights, keyed by token id, built once per vocabulary. */
export class DurationWeights {
  private readonly byID: Float32Array;

  constructor(vocabulary: KokoroVocabulary) {
    let maxID = 0;
    for (const id of vocabulary.symbolToID.values()) maxID = Math.max(maxID, id);
    this.byID = new Float32Array(maxID + 1).fill(1.5);
    for (const [symbol, id] of vocabulary.symbolToID) this.byID[id] = weightForSymbol(symbol);
  }

  weight(tokenID: number): number {
    return tokenID >= 0 && tokenID < this.byID.length ? this.byID[tokenID] : 1.5;
  }

  total(tokens: readonly number[]): number {
    let sum = 0;
    for (const id of tokens) sum += this.weight(id);
    return sum;
  }
}

/**
 * Tracks the ratio between real chunk lengths and this file's guesses, so the
 * *un*rendered tail of a document converges on the right total within the first
 * couple of chunks instead of staying wrong for an hour.
 */
export class Calibration {
  private estimated = 0;
  private actual = 0;

  /** Frames per unit weight. Starts at the nominal rate, then becomes measured. */
  get scale(): number {
    if (this.estimated <= 0 || this.actual <= 0) return 1;
    return this.actual / this.estimated;
  }

  get samples(): number {
    return this.estimated > 0 ? 1 : 0;
  }

  observe(estimatedFrames: number, actualFrames: number): void {
    if (estimatedFrames <= 0 || actualFrames <= 0) return;
    this.estimated += estimatedFrames;
    this.actual += actualFrames;
  }
}

/**
 * A chunk's estimated total, for Phase A before any audio exists. The nominal
 * rate is one frame per unit weight, which puts read English near 14 phonemes a
 * second — and whatever it is really, `Calibration` corrects it.
 */
export function estimateChunkFrames(
  framedTokens: readonly number[],
  weights: DurationWeights,
  calibration?: Calibration,
): number {
  const total = weights.total(framedTokens);
  return Math.max(framedTokens.length, Math.round(total * (calibration?.scale ?? 1)));
}

/**
 * Splits `totalFrames` across `framedTokens` in proportion to phoneme class,
 * giving every token at least one frame and summing to exactly `totalFrames`.
 *
 * Exactness matters more than it looks: the sum *is* the chunk's position in the
 * timeline, so a one-frame rounding error repeated over a thousand chunks is
 * a second of drift.
 */
export function distributeFrames(
  framedTokens: readonly number[],
  totalFrames: number,
  weights: DurationWeights,
): number[] {
  const n = framedTokens.length;
  if (n === 0) return [];
  const target = Math.max(n, Math.round(totalFrames));

  const raw = new Float64Array(n);
  let weightSum = 0;
  for (let i = 0; i < n; i++) {
    raw[i] = weights.weight(framedTokens[i]);
    weightSum += raw[i];
  }
  if (weightSum <= 0) {
    const even = Math.floor(target / n);
    const out = new Array<number>(n).fill(Math.max(1, even));
    return settle(out, target);
  }

  // Largest-remainder apportionment: floor everything, then hand the leftover
  // frames to the tokens with the biggest fractional parts. Proportional and
  // exactly summing, which naive rounding is not.
  const scaled = new Float64Array(n);
  const out = new Array<number>(n);
  let assigned = 0;
  for (let i = 0; i < n; i++) {
    scaled[i] = (raw[i] / weightSum) * target;
    out[i] = Math.max(1, Math.floor(scaled[i]));
    assigned += out[i];
  }

  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => scaled[b] - Math.floor(scaled[b]) - (scaled[a] - Math.floor(scaled[a])),
  );
  let leftover = target - assigned;
  let cursor = 0;
  while (leftover > 0) {
    out[order[cursor % n]] += 1;
    leftover -= 1;
    cursor += 1;
  }
  return settle(out, target);
}

/** Trims any overshoot from the longest tokens, never below one frame. */
function settle(frames: number[], target: number): number[] {
  let total = frames.reduce((a, b) => a + b, 0);
  if (total <= target) return frames;
  const order = Array.from({ length: frames.length }, (_, i) => i).sort((a, b) => frames[b] - frames[a]);
  let cursor = 0;
  while (total > target) {
    const i = order[cursor % order.length];
    if (frames[i] > 1) {
      frames[i] -= 1;
      total -= 1;
    }
    cursor += 1;
    if (cursor > frames.length * 64) break;
  }
  return frames;
}

/**
 * Nudges estimated word boundaries onto the quiet spots in the rendered audio.
 *
 * Kokoro puts a real dip in energy between words. Where the estimate lands near
 * one, the dip is almost certainly the boundary and snapping to it removes most
 * of the local error; where it does not, nothing moves. The guards matter: only
 * a *clear* minimum counts (under 30% of the surrounding mean), the search is
 * narrow, and boundaries stay monotonic — so the worst case is that this does
 * nothing, not that it invents a boundary inside a word.
 */
export function snapBoundariesToEnergy(
  boundaryFrames: readonly number[],
  samples: Float32Array,
  searchFrames = 3,
): number[] {
  const frames = Math.floor(samples.length / SAMPLES_PER_FRAME);
  if (frames === 0 || boundaryFrames.length === 0) return [...boundaryFrames];

  // Mean absolute amplitude per frame — cheap, and enough to find a pause.
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * SAMPLES_PER_FRAME;
    for (let i = 0; i < SAMPLES_PER_FRAME; i++) sum += Math.abs(samples[base + i]);
    energy[f] = sum / SAMPLES_PER_FRAME;
  }

  const out = [...boundaryFrames];
  let previous = 0;
  for (let b = 0; b < out.length; b++) {
    const centre = out[b];
    if (centre <= previous || centre >= frames) {
      previous = Math.max(previous, out[b]);
      continue;
    }
    const lo = Math.max(previous + 1, centre - searchFrames);
    const hi = Math.min(frames - 1, centre + searchFrames);
    if (hi <= lo) {
      previous = out[b];
      continue;
    }

    let best = centre;
    let bestEnergy = Infinity;
    let windowSum = 0;
    for (let f = lo; f <= hi; f++) {
      windowSum += energy[f];
      if (energy[f] < bestEnergy) {
        bestEnergy = energy[f];
        best = f;
      }
    }
    const mean = windowSum / (hi - lo + 1);
    // Only a real pause moves anything.
    if (mean > 0 && bestEnergy < mean * 0.3) out[b] = best;
    previous = out[b];
  }
  return out;
}

/** Word boundary frames -> per-token durations, preserving the exact total. */
export function framesFromBoundaries(boundaries: readonly number[], totalFrames: number): number[] {
  const out: number[] = [];
  let previous = 0;
  for (const boundary of boundaries) {
    out.push(Math.max(1, boundary - previous));
    previous = boundary;
  }
  out.push(Math.max(1, totalFrames - previous));
  return out;
}
