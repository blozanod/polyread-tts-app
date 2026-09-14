import { maxX, maxY, median, midX, minX, minY, unionAll, type Rect } from "../core/geometry";
import type { BlockRole, TextRun } from "../core/types";

/**
 * A run of text on one baseline, in one column. Lines are the working unit for
 * §4.4 and §4.5 — a classifier that looks at single words gets confused by the
 * first word of a footnote, and one that looks at whole paragraphs cannot see a
 * running head at all.
 */
export interface Line {
  runs: TextRun[];
  columnIndex: number;
  pageIndex: number;
}

export const lineBBox = (line: Line): Rect => unionAll(line.runs.map((r) => r.bbox));
export const lineBaseline = (line: Line): number => median(line.runs.map((r) => r.baseline));
export const lineGlyphHeight = (line: Line): number => median(line.runs.map((r) => r.glyphHeight));
export const lineText = (line: Line): string => line.runs.map((r) => r.text).join(" ");

// MARK: - §4.3 Column detection

/**
 * "Per page, histogram run bbox x-midpoints in ~10 pt bins. Look for a
 * zero-density gap spanning >15% of page width, centred between 30% and 70% of
 * page width."
 */
export const BIN_WIDTH = 10;
export const MINIMUM_GAP_FRACTION = 0.15;
export const GAP_CENTRE_MIN = 0.3;
export const GAP_CENTRE_MAX = 0.7;

/** Returns the x of the column split, or undefined for a single column. */
export function columnSplitX(runs: readonly TextRun[], pageBox: Rect): number | undefined {
  if (runs.length < 12 || pageBox.width <= 0) return undefined;

  const binCount = Math.max(1, Math.ceil(pageBox.width / BIN_WIDTH));
  const histogram = new Int32Array(binCount);
  for (const run of runs) {
    const offset = midX(run.bbox) - minX(pageBox);
    const bin = Math.floor(offset / BIN_WIDTH);
    if (bin < 0 || bin >= binCount) continue;
    histogram[bin] += 1;
  }

  // Longest zero-density stretch that is not the outer margin.
  let best: { start: number; length: number } | undefined;
  let runStart = -1;
  const consider = (start: number, end: number): void => {
    const length = end - start;
    if (!best || length > best.length) best = { start, length };
  };
  for (let i = 0; i < binCount; i++) {
    if (histogram[i] === 0) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      consider(runStart, i);
      runStart = -1;
    }
  }
  if (runStart >= 0) consider(runStart, binCount);

  if (!best) return undefined;
  const gapWidth = best.length * BIN_WIDTH;
  if (gapWidth <= pageBox.width * MINIMUM_GAP_FRACTION) return undefined;

  const centre = (best.start + best.length / 2) * BIN_WIDTH;
  const centreFraction = centre / pageBox.width;
  if (centreFraction < GAP_CENTRE_MIN || centreFraction > GAP_CENTRE_MAX) return undefined;

  return minX(pageBox) + centre;
}

/** Runs whose baselines agree within half a glyph height are one line. */
export function groupIntoLines(runs: readonly TextRun[]): Line[] {
  if (runs.length === 0) return [];
  const byColumn = new Map<number, TextRun[]>();
  for (const run of runs) {
    const list = byColumn.get(run.columnIndex);
    if (list) list.push(run);
    else byColumn.set(run.columnIndex, [run]);
  }

  const lines: Line[] = [];
  for (const [column, columnRuns] of byColumn) {
    const sorted = [...columnRuns].sort((a, b) => b.baseline - a.baseline);
    let current: TextRun[] = [];
    let currentBaseline = 0;
    for (const run of sorted) {
      const tolerance = Math.max(2, run.glyphHeight * 0.5);
      if (current.length === 0 || Math.abs(run.baseline - currentBaseline) <= tolerance) {
        if (current.length === 0) currentBaseline = run.baseline;
        current.push(run);
      } else {
        lines.push({ runs: current, columnIndex: column, pageIndex: current[0].pageIndex });
        current = [run];
        currentBaseline = run.baseline;
      }
    }
    if (current.length > 0) {
      lines.push({ runs: current, columnIndex: column, pageIndex: current[0].pageIndex });
    }
  }
  return attachSuperscripts(lines);
}

/**
 * Folds a line that is nothing but raised markers back into the line it
 * annotates.
 *
 * **A fix, not a port.** The baseline tolerance above is half the *run's* own
 * glyph height, and a footnote marker is set at roughly 0.58x the body size and
 * raised by roughly 0.33x an em. For 11 pt body text that is a 6.4 pt glyph
 * lifted 3.6 pt, against a tolerance of 3.2 — so the marker misses its line by a
 * fraction of a point and becomes a line of its own.
 *
 * That is silently fatal to §4.5. `isMarker` asks whether a run is small and
 * raised *relative to its line*, and a marker alone on a line is neither: it is
 * exactly as tall as its line and sits exactly on its baseline. It reads as
 * body text, so the footnote number is spoken aloud in the middle of the
 * sentence, and §8.5 loses the tap target it was promised.
 *
 * Widening the general tolerance would work but risks welding genuinely
 * adjacent lines together — single-spaced leading is only about 1.2x the body
 * size. This is narrower: a line has to consist *entirely* of marker-shaped
 * runs, and it joins the nearest line below it that is tall enough for it to be
 * a superscript of.
 */
function attachSuperscripts(lines: Line[]): Line[] {
  if (lines.length < 2) return lines;

  const orphans: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.runs.every((run) => isMarkerText(run.text))) orphans.push(i);
  }
  if (orphans.length === 0) return lines;

  const absorbed = new Set<number>();
  for (const index of orphans) {
    const marker = lines[index];
    const markerBaseline = lineBaseline(marker);
    const markerHeight = lineGlyphHeight(marker);

    let best = -1;
    let bestGap = Infinity;
    for (let j = 0; j < lines.length; j++) {
      if (j === index || absorbed.has(j) || orphans.includes(j)) continue;
      const host = lines[j];
      if (host.columnIndex !== marker.columnIndex || host.pageIndex !== marker.pageIndex) continue;
      const hostHeight = lineGlyphHeight(host);
      // A superscript sits above its own line's baseline, and is smaller than it.
      const gap = markerBaseline - lineBaseline(host);
      if (gap <= 0 || gap > hostHeight * 0.6) continue;
      if (markerHeight >= hostHeight * MARKER_HEIGHT_RATIO) continue;
      if (gap < bestGap) {
        bestGap = gap;
        best = j;
      }
    }
    if (best >= 0) {
      lines[best].runs.push(...marker.runs);
      absorbed.add(index);
    }
  }

  return lines.filter((_, i) => !absorbed.has(i));
}

/**
 * Assigns `columnIndex` and sorts into reading order: column-major for two
 * columns, plain descending-y for one.
 */
export function orderRuns(runs: readonly TextRun[], pageBox: Rect): TextRun[] {
  const out = runs.map((r) => ({ ...r }));
  const split = columnSplitX(out, pageBox);

  for (const run of out) {
    run.columnIndex = split !== undefined && midX(run.bbox) >= split ? 1 : 0;
  }

  // Group into lines before sorting: sorting individual runs by y alone
  // shuffles words whose baselines differ by a fraction of a point.
  const lines = groupIntoLines(out);
  const sorted = lines.sort((a, b) => {
    if (a.columnIndex !== b.columnIndex) return a.columnIndex - b.columnIndex;
    const ab = lineBaseline(a);
    const bb = lineBaseline(b);
    if (Math.abs(ab - bb) > Math.max(lineGlyphHeight(a), lineGlyphHeight(b)) * 0.5) {
      return bb - ab; // origin bottom-left: higher y is earlier
    }
    return minX(lineBBox(a)) - minX(lineBBox(b));
  });

  const result: TextRun[] = [];
  let orderIndex = 0;
  for (const line of sorted) {
    for (const run of [...line.runs].sort((a, b) => minX(a.bbox) - minX(b.bbox))) {
      run.orderIndex = orderIndex++;
      result.push(run);
    }
  }
  return result;
}

// MARK: - §4.4 Running heads and page numbers

export const BAND_FRACTION = 0.08;
export const REPEAT_THRESHOLD = 0.4;

export function normalizedForm(text: string): string {
  let out = "";
  let inDigits = false;
  for (const character of text.toLowerCase()) {
    if (/\p{Nd}/u.test(character)) {
      if (!inDigits) {
        out += "#";
        inDigits = true;
      }
    } else {
      inDigits = false;
      if (/\p{L}/u.test(character) || character === " ") out += character;
    }
  }
  return out.trim();
}

export function isBareNumber(text: string): boolean {
  const trimmed = text.replace(/^[ .[\]()\-–—]+|[ .[\]()\-–—]+$/gu, "");
  if (trimmed.length === 0) return false;
  if (/^\p{Nd}+$/u.test(trimmed)) return true;
  // Front matter is numbered in lowercase roman.
  return trimmed.length <= 7 && /^[ivxlcdm]+$/.test(trimmed);
}

/**
 * "Position alone is insufficient — footnote bodies also live in the bottom
 * region." So: band **and** (bare number **or** a digit-normalized form that
 * repeats across the document).
 */
export class FurnitureClassifier {
  /**
   * Digit-normalized forms seen per page, built in a first pass over the
   * document because the repeat test is inherently cross-page.
   */
  private readonly formPages = new Map<string, Set<number>>();
  private pageCount = 0;

  /** First pass: which candidate line forms appear in the band, and on how many pages. */
  observe(lines: readonly Line[], pageBox: Rect, pageIndex: number): void {
    this.pageCount = Math.max(this.pageCount, pageIndex + 1);
    for (const line of lines) {
      if (!this.inBand(lineBBox(line), pageBox)) continue;
      const form = normalizedForm(lineText(line));
      const pages = this.formPages.get(form);
      if (pages) pages.add(pageIndex);
      else this.formPages.set(form, new Set([pageIndex]));
    }
  }

  /** Second pass: classify. */
  role(line: Line, pageBox: Rect): BlockRole | undefined {
    if (!this.inBand(lineBBox(line), pageBox)) return undefined;
    const text = lineText(line).trim();
    if (text.length === 0) return undefined;

    if (isBareNumber(text)) return "pageNumber";

    const form = normalizedForm(text);
    if (form.length === 0 || this.pageCount === 0) return undefined;
    const pagesSeen = this.formPages.get(form)?.size ?? 0;
    if (pagesSeen / this.pageCount < REPEAT_THRESHOLD) return undefined;

    // A repeating form that is mostly digits is a folio; anything else is a
    // running head.
    return /\p{L}/u.test(form) ? "runningHead" : "pageNumber";
  }

  private inBand(box: Rect, pageBox: Rect): boolean {
    const band = pageBox.height * BAND_FRACTION;
    return maxY(box) >= maxY(pageBox) - band || minY(box) <= minY(pageBox) + band;
  }
}

// MARK: - §4.5 Footnotes

export const MARKER_HEIGHT_RATIO = 0.8;
export const MARKER_BASELINE_LIFT = 0.15;
export const BODY_HEIGHT_RATIO = 0.85;
const MARKER_SYMBOLS = new Set(["†", "‡", "*", "§", "¶", "‖"]);

export function isMarkerText(text: string): boolean {
  const trimmed = text.replace(/^[.,;:)\]]+|[.,;:)\]]+$/gu, "");
  if (trimmed.length === 0 || trimmed.length > 4) return false;
  if (/^\p{Nd}+$/u.test(trimmed)) return true;
  return [...trimmed].every((c) => MARKER_SYMBOLS.has(c));
}

/**
 * "**Markers**: `glyphHeight < 0.8 ×` line median, **and** baseline offset
 * `> 0.15 ×` line height above the line baseline, **and** text is digits or
 * `† ‡ * §`."
 */
export function isMarker(run: TextRun, line: Line): boolean {
  const lineHeight = lineGlyphHeight(line);
  if (lineHeight <= 0) return false;
  if (run.glyphHeight >= lineHeight * MARKER_HEIGHT_RATIO) return false;
  if (run.baseline - lineBaseline(line) <= lineHeight * MARKER_BASELINE_LIFT) return false;
  return isMarkerText(run.text);
}

/**
 * "**Bodies**: contiguous runs in the bottom region whose median `glyphHeight <
 * 0.85 ×` the page's body median, grouped upward from the page bottom until
 * glyph height returns to body size."
 *
 * Returns the indices of `lines` (assumed in reading order within a column) that
 * belong to the footnote apparatus.
 */
export function footnoteBodyLineIndices(
  lines: readonly Line[],
  bodyGlyphHeight: number,
  pageBox: Rect,
): Set<number> {
  const result = new Set<number>();
  if (bodyGlyphHeight <= 0) return result;
  const ceiling = bodyGlyphHeight * BODY_HEIGHT_RATIO;
  // The apparatus never climbs above the lower third; without this a page set
  // entirely in small type reads as one giant footnote.
  const highestAllowedY = minY(pageBox) + pageBox.height * 0.4;

  const byColumn = new Map<number, number[]>();
  for (let i = 0; i < lines.length; i++) {
    const list = byColumn.get(lines[i].columnIndex);
    if (list) list.push(i);
    else byColumn.set(lines[i].columnIndex, [i]);
  }

  for (const indices of byColumn.values()) {
    // Grouping upward from the page bottom means walking reading order
    // backwards, per column.
    const ordered = [...indices].sort((a, b) => lineBaseline(lines[a]) - lineBaseline(lines[b]));
    for (const index of ordered) {
      const line = lines[index];
      if (lineGlyphHeight(line) >= ceiling) break;
      if (minY(lineBBox(line)) > highestAllowedY) break;
      result.add(index);
    }
  }
  return result;
}

/**
 * Footnote bodies open with their own label — the counterpart of the marker in
 * the text. Used to pair marker to body (§8.5) and to strip the label from what
 * gets spoken.
 */
export function leadingLabel(line: Line): string | undefined {
  const first = line.runs[0];
  if (!first) return undefined;
  const trimmed = first.text.replace(/^[.)\]]+|[.)\]]+$/gu, "");
  return isMarkerText(trimmed) ? trimmed : undefined;
}

export { maxX, minX };
