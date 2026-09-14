export type PolyReadErrorKind =
  | "noPages"
  | "extractionProducedNothing"
  | "ocrQualityTooLow"
  | "modelMissing"
  | "modelShapeMismatch"
  | "voicesFileMalformed"
  | "voiceNotFound"
  | "phonemizerUnavailable"
  | "phonemizerLacksWordGrouping"
  | "chunkExceedsBudget"
  | "cacheWriteFailed"
  | "audioUnavailable";

/**
 * The §3 error list, carried over. Kept as one class with a `kind` rather than
 * a class hierarchy so it survives `postMessage` out of the pipeline worker,
 * which structured-clone strips subclasses from.
 */
export class PolyReadError extends Error {
  readonly kind: PolyReadErrorKind;
  readonly detail: string;

  constructor(kind: PolyReadErrorKind, detail = "") {
    super(PolyReadError.describe(kind, detail));
    this.name = "PolyReadError";
    this.kind = kind;
    this.detail = detail;
  }

  static describe(kind: PolyReadErrorKind, detail: string): string {
    switch (kind) {
      case "noPages":
        return "That PDF has no pages.";
      case "extractionProducedNothing":
        return "No readable text came out of that PDF.";
      case "ocrQualityTooLow":
        return `Text recognition scored ${detail} — the result is likely to be nonsense.`;
      case "modelMissing":
        return `Model file ${detail} is not available. Run "npm run assets", or set a model URL in Settings.`;
      case "modelShapeMismatch":
        return `The Kokoro model returned an unexpected shape: ${detail}`;
      case "voicesFileMalformed":
        return `The voice file is malformed: ${detail}`;
      case "voiceNotFound":
        return `No voice named ${detail}.`;
      case "phonemizerUnavailable":
        return `The phonemizer is unavailable: ${detail}`;
      case "phonemizerLacksWordGrouping":
        return "The phonemizer returned a flat phoneme string. Word-level highlighting needs per-word grouping (§0.3).";
      case "chunkExceedsBudget":
        return `A chunk came out at ${detail} phonemes, over the 510 budget.`;
      case "cacheWriteFailed":
        return `Could not write to the audio cache: ${detail}`;
      case "audioUnavailable":
        return "Could not open a 24 kHz audio output.";
    }
  }

  /** Structured-clone survivor -> Error, for the worker boundary. */
  static from(value: unknown): PolyReadError | Error {
    if (value instanceof PolyReadError) return value;
    if (value instanceof Error) return value;
    if (value && typeof value === "object" && "kind" in value) {
      const v = value as { kind: PolyReadErrorKind; detail?: string };
      return new PolyReadError(v.kind, v.detail ?? "");
    }
    return new Error(String(value));
  }
}
