import type { POSTag } from "./homographs";

/**
 * One spoken token and the phonemes it maps to.
 *
 * §6.1 — "G2P **must** return per-word phoneme grouping. That grouping *is*
 * `wordPhonemeRanges`, and it is the only thing making word-level highlighting
 * possible." So this type, not a flat string, is the phonemizer's output.
 */
export interface PhonemizedWord {
  token: string;
  phonemes: string;
}

export interface PhonemizerCapabilities {
  /**
   * §0.3, the gate question. False means word-level highlighting is impossible
   * with this backend and the import must refuse rather than mislead.
   */
  providesWordGrouping: boolean;
  /**
   * §6.1 — if the backend does not do context-based homograph resolution,
   * `homographPhonemes` is wired in front of it.
   */
  resolvesHomographs: boolean;
  expandsNumbers: boolean;
}

export interface Phonemizer {
  readonly name: string;
  readonly capabilities: PhonemizerCapabilities;
  /** `posTags` is index-aligned with `tokens`, empty when tagging was skipped. */
  phonemize(tokens: readonly string[], posTags: readonly POSTag[]): Promise<PhonemizedWord[]>;
}
