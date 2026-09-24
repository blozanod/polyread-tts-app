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
  /**
   * True when this word's phonemes run straight on from the previous word's,
   * with no word boundary between them.
   *
   * eSpeak welds short function words together — "of the" comes back as the
   * single group `ʌvðə` — and that welded form is what it would have fed the
   * voice. Keeping it means the model hears exactly the phoneme stream the
   * reference client gives it; `joined` is how the per-word grouping §6.1
   * needs survives that, by marking where one word's share of the group
   * starts without putting a space into the stream that was never there.
   */
  joined?: boolean;
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
