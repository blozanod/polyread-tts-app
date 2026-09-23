import { rect, type Rect } from "../core/geometry";
import type { TextRun } from "../core/types";
import type { PdfTextItem } from "./pdfTypes";

/**
 * pdf.js text items -> words.
 *
 * pdf.js starts a new text item whenever the font changes, and a word that
 * changes font part of the way through is common in the documents this app is
 * for: small caps are a full-size capital followed by reduced ones ("T" +
 * "OCQUEVILLE"), an italicized word keeps its period in the roman font, and a
 * TeX accent is a separate glyph laid over its letter ("na" + "¨" + "ıve"). The
 * old backend cut each item at its spaces and treated every piece as a word, so
 * all of those came out as two or three tokens — "Western E UROPE", "rule .",
 * "na¨ ıve" — and every one of them was spoken as separate words.
 *
 * So pieces are joined back into words where nothing separates them: no
 * whitespace in the text on either side, and no visible gap on the page. A
 * piece raised or lowered off the line is never joined, because that is a
 * footnote marker and §4.5 needs it as a run of its own.
 */
interface Piece {
  text: string;
  x0: number;
  x1: number;
  baseline: number;
  height: number;
  spaceBefore: boolean;
  spaceAfter: boolean;
}

/** A gap wider than this, in ems, is a word space even when no space was drawn. */
const WORD_GAP = 0.15;
/** Pieces further off each other's baseline than this, in ems, are not one word. */
const BASELINE_SHIFT = 0.2;

/**
 * True for text that is not part of the reading: rotated or vertical items — a
 * download stamp up the margin, an axis label, a sideways table.
 */
function isRotated(transform: readonly number[]): boolean {
  const [a, b, c, d] = transform;
  return Math.abs(b) > Math.abs(a) * 0.2 || Math.abs(c) > Math.abs(d) * 0.2;
}

export function piecesOf(item: PdfTextItem): Piece[] {
  const text = item.str;
  if (text.trim().length === 0) return [];
  const [, , , , x, baseline] = item.transform;
  const height = Math.abs(item.height) || Math.abs(item.transform[3]) || 1;
  // Proportional by character count, which is exact at the item's two ends —
  // the only positions the joining below compares across items.
  const perCharacter = item.width / text.length;
  const pieces: Piece[] = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    pieces.push({
      text: match[0],
      x0: x + start * perCharacter,
      x1: x + end * perCharacter,
      baseline,
      height,
      spaceBefore: start > 0,
      spaceAfter: end < text.length || item.hasEOL,
    });
  }
  return pieces;
}

/** Joins `items` into word runs, in content order. */
export function assembleWords(items: readonly PdfTextItem[], pageIndex: number): TextRun[] {
  const words: Piece[][] = [];
  let previous: Piece | undefined;
  for (const item of items) {
    if (isRotated(item.transform)) {
      previous = undefined;
      continue;
    }
    if (item.str.trim().length === 0) {
      // A whitespace-only item is pdf.js marking a word break between two
      // others; it is the only trace of one in a layer drawn word by word.
      if (previous) previous.spaceAfter = true;
      continue;
    }
    for (const piece of piecesOf(item)) {
      if (previous && joins(previous, piece)) words[words.length - 1].push(piece);
      else words.push([piece]);
      previous = piece;
    }
  }
  return dedupe(words.map((pieces) => toRun(pieces, pageIndex)));
}

function joins(left: Piece, right: Piece): boolean {
  if (left.spaceAfter || right.spaceBefore) return false;
  const em = Math.max(left.height, right.height);
  if (Math.abs(right.baseline - left.baseline) > BASELINE_SHIFT * Math.min(left.height, right.height)) return false;
  const gap = right.x0 - left.x1;
  if (gap > WORD_GAP * em) return false;
  // An overlap is a kern, or an accent laid over its letter. Anything deeper
  // is the same text struck twice — simulated bold — which `dedupe` removes,
  // and which must not be welded into "ofof" first.
  const accent = ACCENT_AT_END.test(left.text) || ACCENT_AT_START.test(right.text);
  return gap >= -(accent ? em : em * 0.3);
}

const ACCENT_AT_END = /[¨´`ˆ˜¸˚ˇ˘¯˝˙\u0300-\u036F]$/u;
const ACCENT_AT_START = /^[¨´`ˆ˜¸˚ˇ˘¯˝˙\u0300-\u036F]/u;

function toRun(pieces: readonly Piece[], pageIndex: number): TextRun {
  // The piece carrying most of the word decides its size and line: the reduced
  // capitals of a small-caps word, not its larger initial.
  const main = pieces.reduce((best, p) => (p.text.length > best.text.length ? p : best), pieces[0]);
  const left = Math.min(...pieces.map((p) => p.x0));
  const right = Math.max(...pieces.map((p) => p.x1));
  const height = Math.max(...pieces.map((p) => p.height));
  const bbox: Rect = rect(left, main.baseline - height * 0.2, Math.max(0, right - left), height);
  return {
    text: cleanWord(pieces.map((p) => p.text).join("")),
    bbox,
    glyphHeight: main.height,
    baseline: main.baseline,
    pageIndex,
    columnIndex: 0,
    orderIndex: 0,
  };
}

const LIGATURES: Record<string, string> = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "st",
  "ﬆ": "st",
};

/** Spacing accents a TeX-set PDF draws as glyphs of their own. */
const SPACING_ACCENTS: Record<string, string> = {
  "¨": "\u0308",
  "´": "\u0301",
  "`": "\u0300",
  "ˆ": "\u0302",
  "˜": "\u0303",
  "¸": "\u0327",
  "˚": "\u030A",
  "ˇ": "\u030C",
  "˘": "\u0306",
  "¯": "\u0304",
  "˝": "\u030B",
  "˙": "\u0307",
};
const DOTLESS: Record<string, string> = { "ı": "i", "ȷ": "j" };

/**
 * Ligatures spelled out, accents composed onto their letters, and soft hyphens
 * resolved: one inside a word is invisible, one at its end is a line-end
 * hyphen, which §4.6 then joins.
 */
export function cleanWord(text: string): string {
  let out = text.replace(/[ﬀ-ﬆ]/gu, (c) => LIGATURES[c] ?? c);
  out = out.replace(/\u00AD(?=.)/gu, "").replace(/\u00AD$/u, "-");
  if (/[¨´`ˆ˜¸˚ˇ˘¯˝˙]/u.test(out)) {
    const chars = [...out];
    const result: string[] = [];
    for (let i = 0; i < chars.length; i++) {
      const mark = SPACING_ACCENTS[chars[i]];
      const next = chars[i + 1];
      const previousChar = result[result.length - 1];
      if (mark && next && /\p{L}/u.test(next)) {
        result.push(((DOTLESS[next] ?? next) + mark).normalize("NFC"));
        i++;
      } else if (mark && previousChar && /\p{L}/u.test(previousChar)) {
        result[result.length - 1] = ((DOTLESS[previousChar] ?? previousChar) + mark).normalize("NFC");
      } else {
        result.push(chars[i]);
      }
    }
    out = result.join("");
  }
  return out;
}

/**
 * Drops a word drawn twice in the same place.
 *
 * Simulated bold — the same text struck again a fraction of a point to the
 * right — is how a good many PDF producers set headings, and a text layer laid
 * over a page that already has one repeats every word. pdf.js reports both
 * copies, and every one of them was read aloud twice.
 */
export function dedupe(runs: readonly TextRun[]): TextRun[] {
  const seen = new Map<string, Rect[]>();
  const out: TextRun[] = [];
  for (const run of runs) {
    const boxes = seen.get(run.text);
    if (boxes?.some((box) => overlapRatio(box, run.bbox) > 0.5)) continue;
    if (boxes) boxes.push(run.bbox);
    else seen.set(run.text, [run.bbox]);
    out.push(run);
  }
  return out;
}

function overlapRatio(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  const intersection = width * height;
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? intersection / smaller : 0;
}
