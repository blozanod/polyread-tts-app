import { maxX, median, minX, type Rect } from "../core/geometry";
import { textRange, type Block, type BlockRole, type SourceSpan } from "../core/types";
import {
  isMarker,
  isMarkerText,
  lineBBox,
  lineBaseline,
  lineGlyphHeight,
  lineText,
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
  /** The first line starts right of its column's margin: a new paragraph, if the document indents them. */
  startsIndented?: boolean;
  /** The last line runs to the column's right margin: the paragraph may well go on in the next column. */
  endsFull?: boolean;
  /** Width of the column the block is set in. */
  columnWidth?: number;
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
 * block." Set above 1.0 because a scan's baselines wobble by a point or so, and
 * below the 1.35 it used to be because a heading set with a few points of space
 * after it was being run into the paragraph beneath.
 */
export const PARAGRAPH_GAP_RATIO = 1.25;

/**
 * **Addition to §4.6, flagged deliberately.** Single-column book chapters — half
 * the corpus — mark paragraphs with a first-line indent and *no* extra leading.
 * The gap rule alone turns such a page into one 400-word block, which costs §8.4
 * its paragraph transport and §5 its pauses. A line that starts noticeably right
 * of its column's margin starts a paragraph.
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

/** Ends a sentence, once closing quotes, brackets and a trailing footnote number are set aside. */
export function endsSentence(text: string): boolean {
  const trimmed = text.trimEnd().replace(/[\p{Nd}*†‡]+$/u, "").replace(/["'”’)\]]+$/u, "");
  return /[.!?:;…]$/u.test(trimmed);
}

// MARK: Paragraph grouping

/** How a column's paragraphs begin and end, which the cross-column merge needs. */
export interface ColumnParagraphs {
  paragraphs: Line[][];
  /** Per paragraph: its first line is indented from the column's margin. */
  startsIndented: boolean[];
  /** Per paragraph: its last line runs to the column's right margin. */
  endsFull: boolean[];
}

/**
 * Splits a column's lines into paragraphs.
 *
 * The old rule called any line that started right of the column's leftmost
 * line an indent, and so a new paragraph. That is right for the first line of
 * an indented paragraph and wrong for everything else that is set in from the
 * margin: every line of a block quote, every line of a centred title, every
 * line of a scan whose skew moves the margin a few points down the page. Each
 * of those became a paragraph of its own — the "three-word paragraphs" — and
 * a word hyphenated at the end of one could no longer be joined to its other
 * half at the start of the next.
 *
 * So the margin is fitted rather than taken as a minimum (a straight line
 * through where most lines start, which follows a scan's skew), and an indent
 * only starts a paragraph where the line before it could have ended one: a
 * run of lines set in *together* — a quotation, a title — is one block, and
 * returning to the margin after it is the break.
 */
export function analyzeColumn(lines: readonly Line[]): ColumnParagraphs {
  const empty: ColumnParagraphs = { paragraphs: [], startsIndented: [], endsFull: [] };
  const n = lines.length;
  if (n === 0) return empty;

  const baselines = lines.map(lineBaseline);
  const lefts = lines.map((l) => minX(lineBBox(l)));
  const rights = lines.map((l) => maxX(lineBBox(l)));
  const heights = lines.map(lineGlyphHeight);
  const em = median(heights) || 10;

  const steps: number[] = [];
  for (let i = 1; i < n; i++) {
    const d = baselines[i - 1] - baselines[i];
    if (d > em * 0.5 && d < em * 3) steps.push(d);
  }
  const pitch = steps.length > 0 ? median(steps) : em * 1.2;

  // The margin: a line through the starts of the lines that sit on it.
  const sortedLefts = [...lefts].sort((a, b) => a - b);
  const low = sortedLefts[Math.floor((n - 1) * 0.2)];
  // Only lines close to it: a wider line above (a title over an abstract) is
  // not on this margin, and would drag the fit off it.
  const onMargin = lefts.map((_, i) => i).filter((i) => Math.abs(lefts[i] - low) <= em * 0.6);
  let slope = 0;
  let intercept = low;
  if (onMargin.length >= 4) {
    const ys = onMargin.map((i) => baselines[i]);
    const xs = onMargin.map((i) => lefts[i]);
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    let num = 0;
    let den = 0;
    for (let k = 0; k < ys.length; k++) {
      num += (ys[k] - my) * (xs[k] - mx);
      den += (ys[k] - my) ** 2;
    }
    // A skew past a degree and a half is not a skew; it is a fit to noise.
    slope = den > 0 ? Math.max(-0.025, Math.min(0.025, num / den)) : 0;
    intercept = mx - slope * my;
  }
  const marginAt = (i: number) => intercept + slope * baselines[i];
  const rightEdges = rights.map((x, i) => x - slope * baselines[i]).sort((a, b) => a - b);
  const rightIntercept = rightEdges[Math.floor((n - 1) * 0.8)];
  const rightAt = (i: number) => rightIntercept + slope * baselines[i];
  const width = Math.max(em, rightIntercept - intercept);

  const inset = lines.map((_, i) => lefts[i] - marginAt(i));
  const indented = inset.map((x) => x > em * INDENT_RATIO);
  const short = lines.map((_, i) => rights[i] < rightAt(i) - Math.max(em * 1.5, width * 0.06));
  const ends = lines.map((l) => endsSentence(lineText(l)));
  // Ragged-right text has short lines everywhere, so a short line says nothing.
  const shortInside = short.filter((isShort, i) => isShort && i < n - 1 && !ends[i]).length;
  const ragged = n >= 6 && shortInside / (n - 1) > 0.25;

  const breaks: boolean[] = new Array<boolean>(n).fill(false);
  breaks[0] = true;
  let indentRun = indented[0] ? 1 : 0;
  for (let i = 1; i < n; i++) {
    const gap = baselines[i - 1] - baselines[i];
    const couldEnd = ends[i - 1] || short[i - 1];
    let starts = false;
    // Larger type is set on proportionally larger leading: a two-line title is
    // not two paragraphs because its lines are further apart than the body's.
    const expected = pitch * Math.max(1, Math.min(heights[i], heights[i - 1]) / em);
    const ratio = heights[i] / heights[i - 1];
    if (gap > expected * PARAGRAPH_GAP_RATIO || gap <= em * 0.3) starts = true;
    // An indent where the line before could have ended a paragraph.
    else if (indented[i] && !indented[i - 1] && couldEnd) starts = true;
    // Back to the margin after two or more lines set in together.
    else if (!indented[i] && indented[i - 1] && indentRun >= 2 && couldEnd) starts = true;
    // From one depth of indent to another: out of a block quote straight into
    // an indented paragraph, or into one from a paragraph's first line.
    else if (indented[i] && indented[i - 1] && Math.abs(inset[i] - inset[i - 1]) > em * INDENT_RATIO && couldEnd)
      starts = true;
    // A short line that ends a sentence, where lines are otherwise full.
    else if (!ragged && short[i - 1] && ends[i - 1] && !indented[i] && !indented[i - 1]) starts = true;
    // A change of type size: a heading set without space around it. A short
    // line's size is a median of two or three words, so a small change there
    // is noise; a large one never is.
    else if (ratio > 1.3 || ratio < 0.77) starts = true;
    else if ((ratio > 1.15 || ratio < 0.87) && lines[i].runs.length >= 3 && lines[i - 1].runs.length >= 3)
      starts = true;
    breaks[i] = starts;
    indentRun = indented[i] ? (indented[i - 1] && !starts ? indentRun + 1 : 1) : 0;
  }

  const result: ColumnParagraphs = { paragraphs: [], startsIndented: [], endsFull: [] };
  let current: Line[] = [];
  let first = 0;
  const close = (last: number) => {
    if (current.length === 0) return;
    result.paragraphs.push(current);
    result.startsIndented.push(indented[first]);
    result.endsFull.push(!short[last]);
  };
  for (let i = 0; i < n; i++) {
    if (breaks[i] && current.length > 0) {
      close(i - 1);
      current = [];
      first = i;
    }
    current.push(lines[i]);
  }
  close(n - 1);
  return result;
}

/** Splits a column's lines into paragraphs. */
export function paragraphs(lines: readonly Line[]): Line[][] {
  return analyzeColumn(lines).paragraphs;
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
    // dropped once we can see it.
    //
    // Every line-break hyphen is treated as a soft one. A compound that happens
    // to break at its own hyphen ("nation-state") therefore loses it and is
    // spoken as one word, which is the right trade: telling the two apart needs
    // a dictionary, soft hyphens outnumber compounds heavily in justified
    // academic prose, and "nationstate" is spoken correctly by a G2P that never
    // sees the spelling anyway. `mergeAcrossPages` applies the same rule at a
    // page break, so a word broken there comes out identically.
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

  return { tokens: attachPunctuation(tokens.filter((t) => t.text.length > 0)), markers };
}

const CLOSING_ONLY = /^[,.;:!?)\]}”’»…%]+$/u;
const OPENING_ONLY = /^[(\[{“‘«]+$/u;
const EITHER_WAY = /^["']+$/u;

/**
 * Folds a token that is nothing but punctuation into the word it belongs to.
 *
 * A PDF often sets its quotation marks, brackets and closing periods in a
 * different font from the words beside them, and a scan's OCR layer boxes them
 * separately. Each then arrived as a token of its own: the reflow view showed
 * `“ The state ” ,` with the quotes floating free, and the phonemizer was handed
 * a "word" that is a comma. An opening mark joins the word after it, a closing
 * one the word before; a straight quote, which could be either, joins whichever
 * word it sits closer to on the page. Both boxes are kept, so the highlight
 * still covers the mark.
 */
export function attachPunctuation(source: readonly ProtoToken[]): ProtoToken[] {
  const tokens = [...source];
  const out: ProtoToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const previous = out[out.length - 1];
    const next = tokens[i + 1];
    let direction: "back" | "forward" | undefined;
    if (CLOSING_ONLY.test(token.text)) direction = previous ? "back" : next ? "forward" : undefined;
    else if (OPENING_ONLY.test(token.text)) direction = next ? "forward" : previous ? "back" : undefined;
    else if (EITHER_WAY.test(token.text)) {
      if (previous && next) direction = gapBetween(previous, token) <= gapBetween(token, next) ? "back" : "forward";
      else direction = previous ? "back" : next ? "forward" : undefined;
    }

    if (direction === "back" && previous) {
      previous.text += token.text;
      previous.bboxes.push(...token.bboxes);
    } else if (direction === "forward" && next) {
      tokens[i + 1] = {
        text: token.text + next.text,
        bboxes: [...token.bboxes, ...next.bboxes],
        pageIndex: next.pageIndex,
      };
    } else {
      out.push(token);
    }
  }
  return out;
}

/** Horizontal distance between two tokens on the page; infinite across lines. */
function gapBetween(left: ProtoToken, right: ProtoToken): number {
  const a = left.bboxes[left.bboxes.length - 1];
  const b = right.bboxes[0];
  if (!a || !b || left.pageIndex !== right.pageIndex) return Infinity;
  if (Math.abs(a.y - b.y) > Math.max(a.height, b.height)) return Infinity;
  return Math.abs(b.x - (a.x + a.width));
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

  const text = protoText(block);
  const last = text[text.length - 1];
  if (last === undefined || TERMINAL_PUNCTUATION.has(last)) return false;
  // A section head a point up from the body — 12 on 11 — with no sentence in it.
  if (bodyGlyphHeight > 0 && block.glyphHeight >= bodyGlyphHeight * 1.06) return true;
  // Numbered section heads ("II.", "3.1", "Chapter 4") are set at body size
  // often enough that the height test alone misses them.
  return isSectionNumber(block.tokens[0].text);
}

// MARK: Cross-page merge

/**
 * §4.6 — "last block on page *N* doesn't end in terminal punctuation **and**
 * first block on page *N+1* begins lowercase → merge into one `Block`."
 *
 * Without it every page break inserts a spurious pause and a chunk boundary
 * mid-sentence. Three extensions, each for a break the rule as written could
 * not see:
 *
 *  - **Columns.** A paragraph runs from the foot of one column to the head of
 *    the next as often as it runs over a page, and it did not used to be
 *    joined at all.
 *  - **The page's furniture.** Every page opens with its running head, so the
 *    block "before" the first paragraph of a page was the running head, not the
 *    paragraph it continues, and the merge almost never happened. The last
 *    main-stream block is what a block continues, whatever came between.
 *  - **Indentation.** In a document that indents its paragraphs, a first line
 *    set flush with the margin at the head of a column is a continuation, even
 *    when it begins with a capital because the sentence before it ended exactly
 *    at the foot of the last one.
 */
export function mergeAcrossPages(
  blocks: readonly ProtoBlock[],
  /**
   * Records `absorbed block id -> surviving block id` for every merge, because
   * a merge makes the absorbed block's id vanish from the result. Anything
   * still holding on to a block from before this pass — the footnote markers
   * lifted out of it, most of all — has to be able to follow it.
   */
  mergedInto?: Map<string, string>,
): ProtoBlock[] {
  const indents = documentIndents(blocks);
  const result: ProtoBlock[] = [];
  let lastMain = -1;
  for (const block of blocks) {
    const previous = lastMain >= 0 ? result[lastMain] : undefined;
    if (!previous || !continues(previous, block, indents)) {
      result.push(block);
      if (block.role === "body" || block.role === "heading" || block.role === "caption") lastMain = result.length - 1;
      continue;
    }

    // §4.6's hyphenation rule does not stop at the page break. A paragraph
    // broken mid-word across pages arrives here as "...governmental labora-"
    // and "tories and industry", and concatenating the token lists leaves two
    // spoken tokens where the page has one word: the reader says "labora",
    // takes the paragraph pause the block boundary earns, and then says
    // "tories". `tokenizeParagraph` joins these within a paragraph and cannot
    // reach across two of them, so the join belongs here. One spoken token,
    // both boxes, exactly as `SourceSpan` promises for a word broken over a
    // line.
    const last = previous.tokens[previous.tokens.length - 1];
    const first = block.tokens[0];
    if (last && first && isHyphenated(last.text) && /^\p{Ll}/u.test(first.text)) {
      last.text = last.text.slice(0, -1) + first.text;
      last.bboxes.push(...first.bboxes);
      previous.tokens.push(...block.tokens.slice(1));
    } else {
      previous.tokens.push(...block.tokens);
    }
    previous.lineCount += block.lineCount;
    previous.endsFull = block.endsFull;
    mergedInto?.set(block.id, previous.id);
  }
  return result;
}

/** Whether `block`, at the head of a column or page, carries on `previous`. */
function continues(previous: ProtoBlock, block: ProtoBlock, indents: boolean): boolean {
  if (previous.role !== "body" || block.role !== "body") return false;
  // Only across a break: the foot of one column or page and the head of the next.
  if (block.pageIndex < previous.pageIndex) return false;
  if (block.pageIndex === previous.pageIndex && block.columnIndex <= previous.columnIndex) return false;
  // Column to column, not a full-width abstract into the first column under it.
  const a = previous.columnWidth ?? extentOf(previous);
  const b = block.columnWidth ?? extentOf(block);
  if (a > 0 && b > 0 && Math.abs(a - b) > Math.max(a, b) * 0.25) return false;

  const firstCharacter = protoText(block)[0];
  if (firstCharacter === undefined) return false;
  // A line or two with no sentence end is a heading the size test missed, and
  // what follows it at the head of the next page is its first paragraph.
  const headingLike = previous.lineCount <= HEADING_MAX_LINES && previous.tokens.length <= HEADING_MAX_TOKENS;
  const startsLowercase = /\p{L}/u.test(firstCharacter) && firstCharacter.toLowerCase() === firstCharacter;
  // Positive evidence of a continuation: flush left, where paragraphs indent.
  const flush = indents && block.startsIndented === false;
  if (!endsSentence(protoText(previous))) return startsLowercase || (flush && !headingLike);
  return flush && previous.endsFull === true;
}

/** True when this document marks its paragraphs with a first-line indent. */
function documentIndents(blocks: readonly ProtoBlock[]): boolean {
  let indented = 0;
  let counted = 0;
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const before = blocks[i - 1];
    if (block.role !== "body" || before.role !== "body" || block.startsIndented === undefined) continue;
    // A paragraph that follows another in the same column: the one place an
    // indent means nothing but "new paragraph".
    if (before.pageIndex !== block.pageIndex || before.columnIndex !== block.columnIndex) continue;
    counted += 1;
    if (block.startsIndented) indented += 1;
  }
  return counted >= 3 && indented / counted >= 0.5;
}

/** How wide a block is set, from its own words' boxes on its first page. */
function extentOf(block: ProtoBlock): number {
  let left = Infinity;
  let right = -Infinity;
  for (const token of block.tokens) {
    if (token.pageIndex !== block.pageIndex) continue;
    for (const box of token.bboxes) {
      left = Math.min(left, box.x);
      right = Math.max(right, box.x + box.width);
    }
  }
  return right > left ? right - left : 0;
}

// MARK: Text that is not prose

/** Most tokens a figure label, a table cell or an axis tick runs to. */
const LABEL_TOKENS = 5;
/** Consecutive labels on a page before they are taken for a figure rather than a list. */
const LABEL_RUN = 3;

/**
 * Keeps the words inside figures, diagrams and tables out of the spoken stream.
 *
 * A PDF's diagrams are text: every box and arrow label in a flow chart, every
 * cell of a table, every tick on an axis is a text item, and each one that
 * stands alone on the page came out as a paragraph of its own — "Interpreting",
 * "hot", "loop/exit", "Number Boolean" — read aloud one after another, with a
 * paragraph's pause between each. They are recognizable by coming in runs: a
 * page with three or more body-sized blocks in a row of a few words each, none
 * of which ends a sentence, is a figure, not prose. A run of list items keeps
 * its voice if it is marked as a list.
 *
 * So is a block that is mostly not letters: text in a font whose glyphs have no
 * Unicode mapping comes out as `7<>;.?:2/>9<F`, which eSpeak would spell out.
 *
 * Both become furniture — visible in the reflow view, where a reader can still
 * see them, and silent.
 */
export function silenceFigureText(blocks: ProtoBlock[], bodyGlyphHeight: number): void {
  const isLabel = (block: ProtoBlock): boolean => {
    if (block.role !== "body" || block.tokens.length > LABEL_TOKENS) return false;
    if (bodyGlyphHeight > 0 && block.glyphHeight > bodyGlyphHeight * 1.05) return false;
    const text = protoText(block);
    if (endsSentence(text)) return false;
    return !/^([•·▪◦–—-]|\(?[\p{Nd}ivx]{1,3}[.)])/u.test(text);
  };

  for (let i = 0; i < blocks.length; ) {
    if (!isLabel(blocks[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < blocks.length && isLabel(blocks[j]) && blocks[j].pageIndex === blocks[i].pageIndex) j++;
    if (j - i >= LABEL_RUN) for (let k = i; k < j; k++) blocks[k].role = "runningHead";
    i = Math.max(j, i + 1);
  }

  for (const block of blocks) {
    if (block.role !== "body" && block.role !== "heading") continue;
    const text = protoText(block).replace(/\s+/gu, "");
    const letters = text.replace(/[^\p{L}]/gu, "").length;
    const digits = text.replace(/[^\p{Nd}]/gu, "").length;
    if (letters + digits === 0 || (text.length >= 5 && letters / text.length < 0.4)) block.role = "runningHead";
  }
}

/**
 * Publisher access statements — the page a database staples to the front of a
 * download, and the notice it repeats on every page after.
 *
 * None of it is the document. A JSTOR PDF opens with the article's citation
 * followed by several hundred words about what JSTOR is, who to contact, and
 * what the terms of use are, and the reader read every word of it aloud before
 * reaching the first sentence of the paper. §4.4's furniture test cannot see
 * this: it is a full-width body-sized paragraph in the middle of the page, not
 * a running head in the top or bottom 8%, and it appears once rather than
 * repeating across pages.
 *
 * So it is recognized by what it says. The phrases are the fixed legal wording
 * these services emit, long enough that no paper about scholarship, archives or
 * terms of use can collide with them by accident — the test is deliberately
 * narrower than "mentions JSTOR", because suppressing a paragraph the author
 * wrote is a worse failure than reading one they did not.
 */
const BOILERPLATE_PHRASES = [
  "is a not-for-profit service that helps scholars",
  "not-for-profit service that helps scholars, researchers, and students",
  "your use of the jstor archive indicates your acceptance",
  "terms & conditions of use, available at",
  "all use subject to",
  "this content downloaded from",
  "to digitize, preserve and extend access to",
  "range of content in a trusted digital archive",
  "for more information about jstor, please contact",
];

export function isPublisherBoilerplate(text: string): boolean {
  const flat = text.toLowerCase().replace(/\s+/gu, " ");
  return BOILERPLATE_PHRASES.some((phrase) => flat.includes(phrase));
}

export { maxX };
