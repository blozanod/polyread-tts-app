import type { Rect } from "./geometry";

// §3 Frozen interface types.
//
// These are contracts, carried over from the Swift build unchanged in meaning.
// Everything downstream — both extraction backends, the phonemizer, Kokoro,
// both highlight surfaces — meets here and nowhere else. Changing one of these
// is a spec change, not a refactor.
//
// Two representational changes the platform forces, neither of which moves a
// boundary:
//   - `CGRect` becomes `Rect`, same space (PDF user space, origin bottom-left).
//   - `NSRange` becomes `TextRange`, and its units are still UTF-16 code units,
//     which is what a JavaScript string is indexed in natively.

/** Unit of extraction. Backend-agnostic: pdf.js and OCR both produce these. */
export interface TextRun {
  text: string;
  bbox: Rect;
  glyphHeight: number;
  baseline: number;
  pageIndex: number;
  /** assigned by §4.2 */
  columnIndex: number;
  /** reading order across the document */
  orderIndex: number;
}

export type BlockRole =
  | "body"
  | "heading"
  | "footnoteMarker"
  | "footnoteBody"
  | "runningHead"
  | "pageNumber"
  | "caption";

/**
 * Roles that reach the TTS stream at all. §4.4 excludes page furniture, §4.5
 * excludes both footnote markers and bodies from the *main* stream — but
 * bodies are still phonemized and duration-run in Phase A so §8.5 can interject
 * them on demand.
 */
export function isSpoken(role: BlockRole): boolean {
  return role === "body" || role === "heading" || role === "caption" || role === "footnoteBody";
}

/** Roles carried by the continuous main stream, in document order. */
export function isInMainStream(role: BlockRole): boolean {
  return role === "body" || role === "heading" || role === "caption";
}

/** UTF-16 code-unit range into the reflow document's text. */
export interface TextRange {
  location: number;
  length: number;
}

export const textRange = (location: number, length: number): TextRange => ({ location, length });

export function rangeContains(range: TextRange, index: number): boolean {
  return index >= range.location && index < range.location + range.length;
}

/** Provenance for exactly one spoken token. */
export interface SourceSpan {
  pageIndex: number;
  /** >1 when the word was hyphenated across lines */
  bboxes: Rect[];
  reflowRange: TextRange;
}

/** Paragraph-level unit, post-normalization. */
export interface Block {
  id: string;
  role: BlockRole;
  /** normalized; markers removed, substitutions applied */
  spokenText: string;
  /**
   * INVARIANT: index-aligned 1:1 with the whitespace-split tokens of
   * `spokenText`. See §5 and `spanInvariant.ts`.
   */
  spans: SourceSpan[];
  /** footnotes referenced from inside this block */
  footnoteBodyIDs: string[];
}

/** Half-open range into a chunk's token array. */
export interface TokenRange {
  start: number;
  end: number;
}

/** <=510 phonemes. May be a fragment of a Block. */
export interface PhonemizedChunk {
  id: string;
  blockID: string;
  /** Kokoro vocab, WITHOUT the two boundary zeros */
  tokens: number[];
  /** into `tokens`; one entry per spoken token */
  wordPhonemeRanges: TokenRange[];
  /** index into Block.spans of this chunk's first word */
  spanOffset: number;
}

/** Phase A output, per chunk. */
export interface ChunkTiming {
  chunkID: string;
  /** rounded to >=1, one per token of the *framed* sequence */
  frameDurations: number[];
  /**
   * How the durations were obtained. §0.1-web: the ONNX export the browser can
   * fetch emits a waveform and nothing else, so unless a duration model has
   * been built (see scripts/make-duration-model.py) these are estimated and the
   * UI has to say so rather than let a drifting highlight look like a bug.
   */
  source: "model" | "estimated";
}

export function frameCount(timing: ChunkTiming): number {
  let total = 0;
  for (const frames of timing.frameDurations) total += frames;
  return total;
}

/** Phase A output, flattened to document level. This is the playback timeline. */
export interface WordTiming {
  start: number;
  end: number;
  span: SourceSpan;
  blockID: string;
}

export function newID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Node 18 without webcrypto exposed, and a couple of older WebViews.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
