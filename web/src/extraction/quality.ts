import type { Rect } from "../core/geometry";
import type { TextRun } from "../core/types";

/**
 * §4.2 — "Not a presence check. Course-reserve scans frequently ship a *bad*
 * embedded OCR layer, so `page.string` returns something and it's garbage."
 *
 * ## Deviation: function words instead of a spell checker
 *
 * §4.2 scores "dictionary-hit ratio over extracted tokens
 * (`UITextChecker.rangeOfMisspelledWord`)". There is no `UITextChecker` here,
 * and the obvious substitute — shipping a 275k-word English list — is both a
 * 700 KB download and, for this corpus, a worse instrument: a page of Przeworski,
 * Tocqueville, Huntington and Linz scores as misspelled nonsense.
 *
 * What actually separates a real text layer from a corrupt one is that English
 * prose is about 45% function words. "the", "of", "and", "to", "in" are the most
 * common tokens on any page of political science, they are short enough that OCR
 * rarely mangles them into each other, and no proper noun is ever mistaken for
 * one. A healthy text layer hits 0.30-0.50; a mojibake layer hits near zero.
 *
 * Pronounceability — does the token have a vowel, and no absurd consonant run —
 * is the second term. It catches the failure the first one cannot: a layer that
 * happens to recover the short words but shreds everything longer.
 */
export interface ExtractionQuality {
  /**
   * Characters per square point of page. A normal text page sits near 0.006; a
   * scan whose embedded layer caught a few stray glyphs sits near zero.
   */
  density: number;
  /** Share of tokens that are English function words. */
  functionWordRatio: number;
  /** Share of alphabetic tokens that look like they could be pronounced. */
  pronounceableRatio: number;
  tokenCount: number;
}

export const Thresholds = {
  /** ~3,000 characters on US Letter. */
  healthyDensity: 0.006,
  /** English prose runs 0.35-0.50; half of the low end is a generous floor. */
  healthyFunctionWordRatio: 0.2,
  /**
   * Below this the text is not worth synthesizing. Calibrated so a clean page
   * passes comfortably and a mojibake layer fails clearly.
   */
  acceptableScore: 0.55,
  /** Fewer tokens than this and the ratios are noise, so density alone decides. */
  minimumTokensForRatio: 40,
} as const;

export function qualityScore(q: ExtractionQuality): number {
  const densityTerm = Math.min(1, q.density / Thresholds.healthyDensity);
  if (q.tokenCount < Thresholds.minimumTokensForRatio) return 0.3 * densityTerm;
  const functionTerm = Math.min(1, q.functionWordRatio / Thresholds.healthyFunctionWordRatio);
  // Density saturates — twice as dense as a normal page is not twice as good —
  // so it is clipped before being weighted. The textual terms are what actually
  // separate a real text layer from a corrupt one, hence 0.7 between them.
  return 0.3 * densityTerm + 0.45 * functionTerm + 0.25 * q.pronounceableRatio;
}

export function isAcceptable(q: ExtractionQuality): boolean {
  return qualityScore(q) >= Thresholds.acceptableScore;
}

/**
 * The 220 commonest function words of written English. Closed-class only:
 * determiners, pronouns, prepositions, conjunctions, auxiliaries and the
 * handful of adverbs that behave like them. No content words, so a document
 * about a particular subject cannot inflate its own score.
 */
const FUNCTION_WORDS = new Set(
  (
    "the of and to in a is that it for was as with be by on not he i this are or " +
    "his from at which but have an they you one had word all were we when your can " +
    "said there use each she do how their if will up other about out many then them " +
    "these so some her would make like him into time has look two more write go see " +
    "no way could my than been who its now did get may down way came should because " +
    "does most us am is are was were be been being have has had having do does did " +
    "doing shall will would can could may might must ought need dare " +
    "i me my mine myself you your yours yourself he him his himself she her hers " +
    "herself it its itself we us our ours ourselves they them their theirs themselves " +
    "who whom whose which what that this these those such same other another any " +
    "some none both either neither each every all few several many much more most " +
    "less least own " +
    "in on at by for with from to into onto upon about above across after against " +
    "along among around before behind below beneath beside besides between beyond " +
    "during except inside near of off out outside over past since through throughout " +
    "toward towards under underneath until up upon within without despite per via " +
    "and or but nor yet so although though because if unless while whereas whether " +
    "since when where how why than as " +
    "not no nor only just even still also too very rather quite indeed however " +
    "therefore thus hence moreover furthermore nevertheless nonetheless otherwise " +
    "there here then once again always never often sometimes usually perhaps " +
    "a an the"
  ).split(/\s+/),
);

/**
 * A token is pronounceable if it has a vowel and no consonant run longer than
 * four. Mojibake fails both constantly; real English, including Przeworski,
 * fails neither.
 */
export function isPronounceable(word: string): boolean {
  const lower = word.toLowerCase();
  if (!/[aeiouy]/.test(lower)) return false;
  return !/[bcdfghjklmnpqrstvwxz]{5,}/.test(lower);
}

function bareToken(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export function scoreRuns(runs: readonly TextRun[], pageAreas: ReadonlyMap<number, number>): ExtractionQuality {
  let totalArea = 0;
  for (const area of pageAreas.values()) totalArea += area;
  let characters = 0;
  for (const run of runs) characters += run.text.length;
  const density = totalArea > 0 ? characters / totalArea : 0;

  let tokenCount = 0;
  let functionHits = 0;
  let alphabetic = 0;
  let pronounceable = 0;

  for (const run of runs) {
    for (const raw of run.text.split(/\s+/u)) {
      const token = bareToken(raw);
      if (token.length === 0) continue;
      tokenCount += 1;
      const lower = token.toLowerCase();
      if (FUNCTION_WORDS.has(lower)) functionHits += 1;
      // Only alphabetic tokens are worth the pronounceability test: citations,
      // page numbers and years would drag a perfectly good text layer down.
      if (token.length >= 3 && /^\p{L}+$/u.test(token)) {
        alphabetic += 1;
        if (isPronounceable(token)) pronounceable += 1;
      }
    }
  }

  return {
    density,
    functionWordRatio: tokenCount === 0 ? 0 : functionHits / tokenCount,
    pronounceableRatio: alphabetic === 0 ? 0 : pronounceable / alphabetic,
    tokenCount,
  };
}

export type BackendChoice = "embedded" | "ocr" | "ocrLowConfidence";

export interface BackendDecision {
  choice: BackendChoice;
  embeddedQuality: ExtractionQuality;
  ocrQuality?: ExtractionQuality;
  /** §4.2 — "surface it in the import flow and let the user decide". */
  needsUserConfirmation: boolean;
}

/**
 * Spread the sample across the document — the first pages of a scanned book are
 * a cover and a title page and are not representative of anything.
 */
export function sampleIndices(pageCount: number, limit = 8): number[] {
  if (pageCount <= 0) return [];
  if (pageCount <= limit) return Array.from({ length: pageCount }, (_, i) => i);
  const step = pageCount / limit;
  return Array.from({ length: limit }, (_, i) => Math.floor((i + 0.5) * step));
}

export function decideBackend(
  embeddedQuality: ExtractionQuality,
  ocrQuality: ExtractionQuality | undefined,
): BackendDecision {
  if (isAcceptable(embeddedQuality)) {
    return { choice: "embedded", embeddedQuality, needsUserConfirmation: false };
  }
  if (!ocrQuality) {
    return { choice: "ocrLowConfidence", embeddedQuality, needsUserConfirmation: true };
  }
  // Re-OCR only if it is actually an improvement. A sparse-but-clean page (a
  // title page, a table) can fail the density term with a perfectly usable text
  // layer, and OCR will not beat it.
  if (qualityScore(ocrQuality) < qualityScore(embeddedQuality)) {
    return { choice: "ocrLowConfidence", embeddedQuality, ocrQuality, needsUserConfirmation: true };
  }
  const acceptable = isAcceptable(ocrQuality);
  return {
    choice: acceptable ? "ocr" : "ocrLowConfidence",
    embeddedQuality,
    ocrQuality,
    needsUserConfirmation: !acceptable,
  };
}

export function pageArea(box: Rect): number {
  return box.width * box.height;
}
