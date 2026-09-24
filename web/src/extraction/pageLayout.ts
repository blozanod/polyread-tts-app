import { maxX, maxY, median, minX, minY, unionAll, type Rect } from "../core/geometry";
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

// MARK: - §4.3 Lines and columns

/**
 * A stretch of one line of type with no gutter-sized gap in it.
 *
 * Lines are built in two steps because a page does not say where its columns
 * are. The old approach assumed it could find them first — a histogram of word
 * midpoints, looking for an empty stretch 15% of the page wide — and then group
 * each column's words into lines. No journal's gutter is 15% of the page; a
 * quarter-inch gutter is 4%. So the second column was essentially never found,
 * the two columns' lines were fused at the same height, and a two-column
 * article was read straight across the page, a line from each column in turn.
 *
 * Segments invert that. Words are chained left to right into runs of one line
 * that stop at any gap wider than an em — which a word space never is and a
 * gutter always is — so the columns fall out as groups of segments rather than
 * having to be found first.
 */
export interface Segment {
  runs: TextRun[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Baseline and glyph height of the segment's last full-size run. */
  baseline: number;
  height: number;
}

/** A gap wider than this, in ems, ends a segment: a gutter, never a word space. */
export const SEGMENT_GAP = 1.0;
/** Two runs whose baselines differ by less than this, in ems, are on one line. */
export const LINE_TOLERANCE = 0.35;

/**
 * Chains runs into segments, left to right.
 *
 * Each run is compared with the *last* run of each open segment rather than
 * with where the line started, so a scan's skew — a baseline that drifts a
 * point or three across the page — never breaks a line apart, and per-word
 * baseline noise never shuffles one. A raised or lowered small run joins the
 * line it sits on without moving that line's baseline: that is a footnote
 * marker, and §4.5 finds it by exactly that shape.
 */
export function buildSegments(runs: readonly TextRun[]): Segment[] {
  const sorted = [...runs].sort((a, b) => minX(a.bbox) - minX(b.bbox) || b.baseline - a.baseline);
  const segments: Segment[] = [];
  for (const run of sorted) {
    let best: Segment | undefined;
    let bestDistance = Infinity;
    let bestIsScript = false;
    for (const segment of segments) {
      const last = segment.runs[segment.runs.length - 1];
      const em = Math.max(run.glyphHeight, segment.height);
      const gap = minX(run.bbox) - maxX(last.bbox);
      if (gap > SEGMENT_GAP * em || gap < -0.5 * em) continue;
      const dy = run.baseline - segment.baseline;
      const smaller = run.glyphHeight < segment.height * MARKER_HEIGHT_RATIO;
      const onLine = Math.abs(dy) <= LINE_TOLERANCE * Math.min(run.glyphHeight, segment.height);
      const script = smaller && Math.abs(dy) > 0.1 * segment.height && Math.abs(dy) <= 0.75 * segment.height;
      if (!onLine && !script) continue;
      const distance = Math.abs(dy) + (script ? segment.height : 0) + Math.max(0, gap) * 0.01;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = segment;
        bestIsScript = !onLine;
      }
    }
    if (best) {
      best.runs.push(run);
      best.minX = Math.min(best.minX, minX(run.bbox));
      best.maxX = Math.max(best.maxX, maxX(run.bbox));
      best.minY = Math.min(best.minY, minY(run.bbox));
      best.maxY = Math.max(best.maxY, maxY(run.bbox));
      if (!bestIsScript) {
        best.baseline = run.baseline;
        best.height = run.glyphHeight;
      }
    } else {
      segments.push({
        runs: [run],
        minX: minX(run.bbox),
        maxX: maxX(run.bbox),
        minY: minY(run.bbox),
        maxY: maxY(run.bbox),
        baseline: run.baseline,
        height: run.glyphHeight,
      });
    }
  }
  return segments;
}

export interface Gutter {
  x: number;
  width: number;
}

/**
 * The gutter between two columns of segments, if there is one.
 *
 * A gutter is a vertical strip in the middle half of the text area that almost
 * nothing crosses — only the title, the abstract and the odd full-width figure
 * caption, which is why "almost" rather than "nothing" — with column-shaped text
 * on both sides of it: text standing side by side, in segments wide enough to be
 * lines of a column rather than cells of a table. A table read row by row is
 * better than one read column by column, and the width test is what tells them
 * apart.
 */
export function findGutter(segments: readonly Segment[]): Gutter | undefined {
  if (segments.length < 6) return undefined;
  const left = Math.min(...segments.map((s) => s.minX));
  const right = Math.max(...segments.map((s) => s.maxX));
  const extent = right - left;
  if (extent <= 0) return undefined;
  const em = median(segments.map((s) => s.height));

  const from = Math.floor(left + extent * 0.25);
  const to = Math.ceil(left + extent * 0.75);
  const crossings = new Int32Array(to - from + 1);
  // A folio, a marker or a lone word is not a line of either column, and a
  // page number set in the gutter would otherwise narrow it to nothing.
  const lines = segments.filter((s) => s.maxX - s.minX >= em * 3);
  for (const segment of lines) {
    const a = Math.max(from, Math.ceil(segment.minX));
    const b = Math.min(to, Math.floor(segment.maxX));
    for (let x = a; x <= b; x++) crossings[x - from] += 1;
  }
  let fewest = Infinity;
  for (const count of crossings) fewest = Math.min(fewest, count);
  if (fewest > lines.length * 0.35) return undefined;

  // The widest stretch at that minimum.
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < crossings.length; ) {
    if (crossings[i] !== fewest) {
      i++;
      continue;
    }
    let j = i;
    while (j < crossings.length && crossings[j] === fewest) j++;
    if (j - i > bestLength) {
      bestLength = j - i;
      bestStart = i;
    }
    i = j;
  }
  if (bestStart < 0 || bestLength < Math.max(3, em * 0.4)) return undefined;
  const x = from + bestStart + bestLength / 2;

  const leftSide = lines.filter((s) => s.maxX <= x);
  const rightSide = lines.filter((s) => s.minX >= x);
  if (leftSide.length < 3 || rightSide.length < 3) return undefined;
  // Lines of a column, not cells of a table.
  if (median(leftSide.map((s) => s.maxX - s.minX)) < extent * 0.22) return undefined;
  if (median(rightSide.map((s) => s.maxX - s.minX)) < extent * 0.22) return undefined;
  // Side by side, not one above the other.
  const top = (list: Segment[]) => Math.max(...list.map((s) => s.maxY));
  const bottom = (list: Segment[]) => Math.min(...list.map((s) => s.minY));
  const overlap = Math.min(top(leftSide), top(rightSide)) - Math.max(bottom(leftSide), bottom(rightSide));
  const shorter = Math.min(top(leftSide) - bottom(leftSide), top(rightSide) - bottom(rightSide));
  if (overlap < shorter * 0.5) return undefined;
  return { x, width: bestLength };
}

/**
 * Segments in reading order, grouped into the regions they are read in.
 *
 * Where a gutter is found, whatever crosses it (a title, an abstract, a
 * full-width caption) cuts the page into bands, and each band is read left
 * column then right column before the next spanning block. That is how a
 * journal page is read, and it keeps a caption in the middle of the page from
 * being read as part of the column beside it. Each column is searched for a
 * gutter of its own, so three columns work the same way.
 */
export function readingRegions(segments: readonly Segment[], depth = 0): Segment[][] {
  if (segments.length === 0) return [];
  const gutter = depth < 3 ? findGutter(segments) : undefined;
  if (!gutter) return [[...segments]];

  const slack = Math.max(4, gutter.width * 0.25);
  const left: Segment[] = [];
  const right: Segment[] = [];
  const spanning: Segment[] = [];
  for (const segment of segments) {
    const intoLeft = gutter.x - segment.minX;
    const intoRight = segment.maxX - gutter.x;
    if (intoLeft > slack && intoRight > slack) spanning.push(segment);
    else if (intoRight <= intoLeft) left.push(segment);
    else right.push(segment);
  }

  // The last line of a full-width paragraph is usually short, and sits wholly
  // on one side of the gutter: the end of an abstract would otherwise be read
  // as the first line of the column under it. A line directly beneath a
  // spanning one, on its margin and in its size, is part of it.
  for (let grew = true; grew; ) {
    grew = false;
    for (const above of [...spanning]) {
      for (const side of [left, right]) {
        const index = side.findIndex(
          (s) =>
            Math.abs(s.minX - above.minX) <= 2 &&
            Math.abs(s.height - above.height) <= above.height * 0.1 &&
            above.baseline - s.baseline > 0 &&
            above.baseline - s.baseline <= above.height * 1.6,
        );
        if (index >= 0) {
          spanning.push(side[index]);
          side.splice(index, 1);
          grew = true;
        }
      }
    }
  }

  const out: Segment[][] = [];
  const centre = (s: Segment) => (s.minY + s.maxY) / 2;
  const emit = (upper: number, lower: number) => {
    const inBand = (s: Segment) => centre(s) < upper && centre(s) >= lower;
    out.push(...readingRegions(left.filter(inBand), depth + 1));
    out.push(...readingRegions(right.filter(inBand), depth + 1));
  };
  // Spanning segments in page order, runs of them grouped into one region.
  const blocks = [...spanning].sort((a, b) => b.maxY - a.maxY);
  let upper = Infinity;
  let i = 0;
  while (i < blocks.length) {
    let j = i + 1;
    let floor = blocks[i].minY;
    // Consecutive spanning lines with no column text between them are one block.
    while (
      j < blocks.length &&
      !left.concat(right).some((s) => centre(s) < floor && centre(s) >= blocks[j].maxY)
    ) {
      floor = Math.min(floor, blocks[j].minY);
      j++;
    }
    emit(upper, centre(blocks[i]));
    out.push(blocks.slice(i, j));
    upper = centre(blocks[j - 1]);
    i = j;
  }
  emit(upper, -Infinity);
  return out.filter((region) => region.length > 0);
}

/** One region's segments as lines of type, top to bottom, each left to right. */
function linesOfRegion(segments: readonly Segment[], columnIndex: number): Line[] {
  const sorted = [...segments].sort((a, b) => b.baseline - a.baseline || a.minX - b.minX);
  const lines: Line[] = [];
  let current: Segment[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const runs = current.flatMap((s) => s.runs);
    lines.push({ runs, columnIndex, pageIndex: runs[0].pageIndex });
    current = [];
  };
  for (const segment of sorted) {
    const head = current[0];
    const tolerance = head ? LINE_TOLERANCE * Math.min(head.height, segment.height) + 0.5 : 0;
    const overlaps = current.some((s) => s.minX < segment.maxX && segment.minX < s.maxX);
    if (head && Math.abs(segment.baseline - head.baseline) <= tolerance && !overlaps) current.push(segment);
    else {
      flush();
      current.push(segment);
    }
  }
  flush();
  // After `attachSuperscripts`, so a marker folded into its host line takes its
  // place beside the word it annotates rather than at the end of the line.
  return inReadingOrder(attachSuperscripts(lines)).sort((a, b) => lineBaseline(b) - lineBaseline(a));
}

/**
 * §4.3 for one page: every line of type, in reading order, with `columnIndex`
 * numbering the regions in the order they are read.
 */
export function layoutPage(runs: readonly TextRun[], _pageBox?: Rect): Line[] {
  const regions = readingRegions(buildSegments(runs));
  return regions.flatMap((region, index) => linesOfRegion(region, index));
}

/**
 * Lines of a single column: runs whose baselines agree are one line, read left
 * to right. Kept for callers that already know there is one column.
 */
export function groupIntoLines(runs: readonly TextRun[]): Line[] {
  return linesOfRegion(buildSegments(runs), 0);
}

/** Where the gutter is, if the page has one. */
export function columnSplitX(runs: readonly TextRun[], _pageBox?: Rect): number | undefined {
  return findGutter(buildSegments(runs))?.x;
}

/** Left-to-right within each line. The invariant every later pass relies on. */
function inReadingOrder(lines: Line[]): Line[] {
  for (const line of lines) line.runs.sort((a, b) => minX(a.bbox) - minX(b.bbox));
  return lines;
}

/**
 * Folds a line that is nothing but raised markers back into the line it
 * annotates.
 *
 * `buildSegments` keeps a marker on its line when the marker sits right after
 * the word it annotates. One set apart by a space wider than an em, or one that
 * starts a segment of its own, still arrives here alone; and a marker alone on
 * a line is exactly as tall as its line and sits exactly on its baseline, so
 * `isMarker` would read it as body text and the footnote number would be spoken
 * mid-sentence. So a line consisting *entirely* of marker-shaped runs joins the
 * nearest line below it that is tall enough for it to be a superscript of.
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

/** Assigns `columnIndex` and `orderIndex` in reading order. */
export function orderRuns(runs: readonly TextRun[], pageBox: Rect): TextRun[] {
  const result: TextRun[] = [];
  let orderIndex = 0;
  for (const line of layoutPage(runs.map((r) => ({ ...r })), pageBox)) {
    for (const run of line.runs) {
      run.columnIndex = line.columnIndex;
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
