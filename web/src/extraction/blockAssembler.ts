import { maxX, median, minX, type Rect } from "../core/geometry";
import { textRange, type Block, type BlockRole, type SourceSpan } from "../core/types";
import {
  isMarker,
  isMarkerText,
  lineBBox,
  lineBaseline,
  lineGlyphHeight,
  type Line,
} from "./pageLayout";

/**
 * One spoken token under construction. Carries every box it was built from, so a
 * hyphenated word arrives at §3 with the two boxes `SourceSpan` promises.
 */
export interface ProtoToken {
  text: string;
  bboxes: Rect[];
  pageIndex: number;
}

export interface ProtoBlock {
  id: string;
  role: BlockRole;
  tokens: ProtoToken[];
  pageIndex: number;
  columnIndex: number;
  glyphHeight: number;
  lineCount: number;
  /** footnote bodies only */
  label?: string;
}

export function protoText(block: ProtoBlock): string {
  return block.tokens.map((t) => t.text).join(" ");
}

export function materialize(block: ProtoBlock, footnoteBodyIDs: string[] = []): Block {
  return {
    id: block.id,
    role: block.role,
    spokenText: protoText(block),
    spans: block.tokens.map(
      (t): SourceSpan => ({
        pageIndex: t.pageIndex,
        bboxes: t.bboxes,
        // Filled in by buildReflowDocument once the document is laid out.
        reflowRange: textRange(0, 0),
      }),
    ),
    footnoteBodyIDs,
  };
}

/**
 * §4.6 — "vertical gap between baselines exceeding normal line-height ends a
 * block." Set above 1.0 because justified text on a scan wobbles by a point or
 * two.
 */
export const PARAGRAPH_GAP_RATIO = 1.35;

/**
 * **Addition to §4.6, flagged deliberately.** Single-column book chapters — half
 * the corpus — mark paragraphs with a first-line indent and *no* extra leading.
 * The gap rule alone turns such a page into one 400-word block, which costs §8.4
 * its paragraph transport and §5 its pauses. A line that starts noticeably right
 * of its column's left edge starts a paragraph.
 */
export const INDENT_RATIO = 0.8;

/**
 * Headings: §4.6 requires the role but not how to find it. OCR supplies no font
 * metadata (§4.1), so the test has to be geometric.
 */
export const HEADING_HEIGHT_RATIO = 1.12;
export const HEADING_MAX_LINES = 2;
export const HEADING_MAX_TOKENS = 14;

const TERMINAL_PUNCTUATION = new Set([".", "!", "?", '"', "”", "’", ":", ";"]);

// MARK: Paragraph grouping

/** Splits a column's lines into paragraphs. */
export function paragraphs(lines: readonly Line[]): Line[][] {
  if (lines.length === 0) return [];

  const baselines = lines.map(lineBaseline);
  const deltas: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const d = baselines[i - 1] - baselines[i];
    if (d > 0) deltas.push(d);
  }
  const lineHeight = deltas.length === 0 ? median(lines.map(lineGlyphHeight)) * 1.2 : median(deltas);
  const leftEdge = Math.min(...lines.map((l) => minX(lineBBox(l))));
  const bodyGlyph = median(lines.map(lineGlyphHeight));

  const result: Line[][] = [];
  let current: Line[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let startsParagraph = current.length === 0;

    if (!startsParagraph && i > 0) {
      const gap = baselines[i - 1] - baselines[i];
      if (gap > lineHeight * PARAGRAPH_GAP_RATIO) startsParagraph = true;
      // A negative or zero step means the column changed under us.
      if (gap <= 0) startsParagraph = true;
      if (minX(lineBBox(line)) - leftEdge > bodyGlyph * INDENT_RATIO) startsParagraph = true;
    }

    if (startsParagraph && current.length > 0) {
      result.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) result.push(current);
  return result;
}

// MARK: Tokenisation, markers, hyphenation

export function isHyphenated(text: string): boolean {
  const last = text[text.length - 1];
  return (last === "-" || last === "‐") && text.length > 1;
}

export interface TokenizeResult {
  tokens: ProtoToken[];
  markers: ProtoToken[];
}

/**
 * Turns a paragraph's lines into spoken tokens, lifting out footnote markers
 * (§4.5) and joining hyphenated words across the line break (§4.6).
 */
export function tokenizeParagraph(paragraph: readonly Line[], stripLeadingLabel = false): TokenizeResult {
  const tokens: ProtoToken[] = [];
  const markers: ProtoToken[] = [];
  let pendingHyphen = false;

  for (let lineIndex = 0; lineIndex < paragraph.length; lineIndex++) {
    const line = paragraph[lineIndex];
    let lineRuns = line.runs;

    // A footnote body opens with its own label; §4.5 keeps markers out of
    // speech, and that includes this one.
    if (
      stripLeadingLabel &&
      lineIndex === 0 &&
      lineRuns[0] &&
      isMarkerText(lineRuns[0].text.replace(/^[.)\]]+|[.)\]]+$/gu, ""))
    ) {
      lineRuns = lineRuns.slice(1);
    }

    for (const run of lineRuns) {
      const marker = isMarker(run, line);

      if (pendingHyphen && !marker && tokens.length > 0) {
        // §4.6 — drop the hyphen, one spoken token, two boxes.
        const last = tokens[tokens.length - 1];
        last.text += run.text;
        last.bboxes.push(run.bbox);
        pendingHyphen = false;
        continue;
      }

      if (marker) {
        markers.push({
          text: run.text.replace(/^[.)\]]+|[.)\]]+$/gu, ""),
          bboxes: [run.bbox],
          pageIndex: run.pageIndex,
        });
        continue;
      }

      tokens.push({ text: run.text, bboxes: [run.bbox], pageIndex: run.pageIndex });
    }

    // §4.6 — "line-final run ending in `-` or `‐`, next line begins lowercase".
    // The second half of the test needs the next line, so the hyphen is only
    // dropped once we can see it — a real compound ("nation-state" broken at the
    // hyphen) keeps its hyphen.
    pendingHyphen = false;
    const last = tokens[tokens.length - 1];
    if (last && isHyphenated(last.text)) {
      const nextLine = lineIndex + 1 < paragraph.length ? paragraph[lineIndex + 1] : undefined;
      const nextFirst = nextLine?.runs[0]?.text[0];
      const nextStartsLowercase = nextFirst !== undefined && nextFirst.toLowerCase() === nextFirst && /\p{L}/u.test(nextFirst);
      if (nextStartsLowercase) {
        last.text = last.text.slice(0, -1);
        pendingHyphen = true;
      }
    }
  }

  return { tokens: tokens.filter((t) => t.text.length > 0), markers };
}

// MARK: Headings

export function isSectionNumber(token: string): boolean {
  const trimmed = token.replace(/^[.)]+|[.)]+$/gu, "");
  if (trimmed.length === 0 || trimmed.length > 8) return false;
  if (/^[\d.]+$/.test(trimmed)) return /\d/.test(trimmed);
  return trimmed.toUpperCase() === trimmed && /^[IVXLCDM]+$/.test(trimmed);
}

export function isHeading(block: ProtoBlock, bodyGlyphHeight: number): boolean {
  if (block.role !== "body" || block.tokens.length === 0) return false;
  if (block.lineCount > HEADING_MAX_LINES || block.tokens.length > HEADING_MAX_TOKENS) return false;

  if (bodyGlyphHeight > 0 && block.glyphHeight >= bodyGlyphHeight * HEADING_HEIGHT_RATIO) return true;

  // Numbered section heads ("II.", "3.1", "Chapter 4") are set at body size
  // often enough that the height test alone misses them.
  const text = protoText(block);
  const last = text[text.length - 1];
  if (last === undefined || TERMINAL_PUNCTUATION.has(last)) return false;
  return isSectionNumber(block.tokens[0].text);
}

// MARK: Cross-page merge

/**
 * §4.6 — "last block on page *N* doesn't end in terminal punctuation **and**
 * first block on page *N+1* begins lowercase → merge into one `Block`."
 *
 * Without it every page break inserts a spurious pause and a chunk boundary
 * mid-sentence.
 */
export function mergeAcrossPages(blocks: readonly ProtoBlock[]): ProtoBlock[] {
  const result: ProtoBlock[] = [];
  for (const block of blocks) {
    const previous = result[result.length - 1];
    const previousText = previous ? protoText(previous) : "";
    const lastCharacter = previousText[previousText.length - 1];
    const blockText = protoText(block);
    const firstCharacter = blockText[0];
    const startsLowercase =
      firstCharacter !== undefined &&
      /\p{L}/u.test(firstCharacter) &&
      firstCharacter.toLowerCase() === firstCharacter;

    if (
      !previous ||
      previous.role !== "body" ||
      block.role !== "body" ||
      block.pageIndex <= previous.pageIndex ||
      lastCharacter === undefined ||
      TERMINAL_PUNCTUATION.has(lastCharacter) ||
      !startsLowercase
    ) {
      result.push(block);
      continue;
    }

    previous.tokens.push(...block.tokens);
    previous.lineCount += block.lineCount;
  }
  return result;
}

export { maxX };
