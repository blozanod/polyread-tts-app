import { maxX, maxY, midY, minX, minY, type Rect } from "./geometry";
import { checkBlocks, tokensOf } from "./spanInvariant";
import { isInMainStream, textRange, type Block, type BlockRole, type SourceSpan, type TextRange } from "./types";

/**
 * §10 — the primary reading surface is "built from the normalized `[Block]`
 * list — not from `page.string`. Its character ranges are
 * `SourceSpan.reflowRange`."
 *
 * So `reflowRange` cannot be filled in during extraction: nobody knows a
 * token's character offset until the whole document has been laid out as one
 * string. This builder does that layout and hands back blocks whose spans carry
 * real ranges. It runs once, after normalization and before Phase A, so every
 * `WordTiming` minted downstream already points at the right characters.
 */
export interface ReflowParagraph {
  blockID: string;
  role: BlockRole;
  range: TextRange;
}

/**
 * §4.5 — markers are "kept visible and tappable in the reflow view — this is
 * the affordance for §8.5."
 */
export interface ReflowMarker {
  range: TextRange;
  label: string;
  footnoteBodyID?: string;
}

export interface ReflowDocument {
  text: string;
  paragraphs: ReflowParagraph[];
  markers: ReflowMarker[];
}

export function paragraphFor(doc: ReflowDocument, blockID: string): ReflowParagraph | undefined {
  return doc.paragraphs.find((p) => p.blockID === blockID);
}

export function markerAt(doc: ReflowDocument, characterIndex: number): ReflowMarker | undefined {
  return doc.markers.find(
    (m) => characterIndex >= m.range.location && characterIndex < m.range.location + m.range.length,
  );
}

export interface ReflowBuildResult {
  document: ReflowDocument;
  blocks: Block[];
}

/**
 * Lays `blocks` out as one string and returns them with `reflowRange` filled in.
 *
 * `.footnoteMarker` blocks do not become paragraphs of their own — a marker
 * belongs *inside* a sentence, and promoting it to a paragraph would shred the
 * paragraph it interrupts. Each one is spliced into the preceding spoken
 * paragraph at the token it follows, located geometrically (see insertionToken).
 */
export function buildReflowDocument(blocks: readonly Block[]): ReflowBuildResult {
  let text = "";
  const paragraphs: ReflowParagraph[] = [];
  const markers: ReflowMarker[] = [];
  const rebuilt: Block[] = [];

  // Markers are attached to the paragraph they follow, so they have to be
  // pulled out of the stream and grouped before any laying out happens.
  const pendingMarkers = new Map<number, Block[]>();
  const carriers: Block[] = [];
  for (const block of blocks) {
    if (block.role === "footnoteMarker") {
      let target = -1;
      for (let i = carriers.length - 1; i >= 0; i--) {
        if (isInMainStream(carriers[i].role)) {
          target = i;
          break;
        }
      }
      if (target < 0) target = Math.max(0, carriers.length - 1);
      const list = pendingMarkers.get(target);
      if (list) list.push(block);
      else pendingMarkers.set(target, [block]);
    } else {
      carriers.push(block);
    }
  }

  const emitMarker = (marker: Block, fallbackPage: number): void => {
    const markerStart = text.length;
    const label = marker.spokenText.trim();
    text += label;
    const range = textRange(markerStart, text.length - markerStart);
    markers.push({ range, label, footnoteBodyID: marker.footnoteBodyIDs[0] });
    // The marker block keeps its own identity, with a reflow range that now
    // points at real characters, so §8.5 can find it.
    rebuilt.push({
      id: marker.id,
      role: "footnoteMarker",
      spokenText: marker.spokenText,
      spans: [
        {
          pageIndex: marker.spans[0]?.pageIndex ?? fallbackPage,
          bboxes: marker.spans[0]?.bboxes ?? [],
          reflowRange: range,
        },
      ],
      footnoteBodyIDs: marker.footnoteBodyIDs,
    });
  };

  for (let carrierIndex = 0; carrierIndex < carriers.length; carrierIndex++) {
    const block = carriers[carrierIndex];
    if (text.length > 0) text += "\n\n";
    const paragraphStart = text.length;

    const tokens = tokensOf(block.spokenText);
    const attached = [...(pendingMarkers.get(carrierIndex) ?? [])].sort((a, b) =>
      readingOrderCompare(a.spans[0], b.spans[0]),
    );

    // For each token index, which markers sit immediately after it.
    const markersAfterToken = new Map<number, Block[]>();
    for (const marker of attached) {
      const slot = insertionToken(marker, block, tokens.length);
      const list = markersAfterToken.get(slot);
      if (list) list.push(marker);
      else markersAfterToken.set(slot, [marker]);
    }

    const newSpans: SourceSpan[] = [];

    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
      if (tokenIndex > 0) text += " ";
      const tokenStart = text.length;
      text += tokens[tokenIndex];

      const old = block.spans[tokenIndex];
      newSpans.push({
        pageIndex: old.pageIndex,
        bboxes: old.bboxes,
        reflowRange: textRange(tokenStart, text.length - tokenStart),
      });

      for (const marker of markersAfterToken.get(tokenIndex) ?? []) {
        emitMarker(marker, old.pageIndex);
      }
    }

    // A marker whose slot fell past the last token (or an empty paragraph).
    for (const marker of markersAfterToken.get(tokens.length) ?? []) {
      emitMarker(marker, block.spans[0]?.pageIndex ?? 0);
    }

    paragraphs.push({
      blockID: block.id,
      role: block.role,
      range: textRange(paragraphStart, text.length - paragraphStart),
    });
    rebuilt.push({
      id: block.id,
      role: block.role,
      spokenText: block.spokenText,
      spans: newSpans,
      footnoteBodyIDs: block.footnoteBodyIDs,
    });
  }

  checkBlocks(rebuilt, "buildReflowDocument");
  return { document: { text, paragraphs, markers }, blocks: rebuilt };
}

/**
 * Which token does this marker sit after?
 *
 * A superscript marker hugs the right edge of the word it annotates, raised but
 * still vertically overlapping that word's box. So: among tokens on the same
 * page whose box overlaps the marker vertically and ends at or before the
 * marker starts, take the rightmost. Falling through to "end of paragraph" is
 * the safe failure — the marker stays visible and tappable, just late.
 */
export function insertionToken(marker: Block, block: Block, tokenCount: number): number {
  const markerSpan = marker.spans[0];
  const markerBox: Rect | undefined = markerSpan?.bboxes[0];
  if (!markerSpan || !markerBox || tokenCount === 0) return tokenCount;

  let best = -1;
  let bestMaxX = -Infinity;

  for (let i = 0; i < block.spans.length; i++) {
    const span = block.spans[i];
    if (span.pageIndex !== markerSpan.pageIndex) continue;
    const box = span.bboxes[span.bboxes.length - 1];
    if (!box) continue;
    const verticallyOverlaps = maxY(box) > minY(markerBox) && minY(box) < maxY(markerBox);
    if (!verticallyOverlaps) continue;
    const tolerance = Math.max(1, markerBox.width);
    if (maxX(box) > minX(markerBox) + tolerance) continue;
    if (maxX(box) > bestMaxX) {
      bestMaxX = maxX(box);
      best = i;
    }
  }
  return best >= 0 ? best : tokenCount;
}

/**
 * Half a body line. Markers whose midpoints land in the same band of this size
 * are treated as being on the same line of type.
 */
const MARKER_LINE_BAND = 4;

/**
 * Two markers in document order: down the page, then across it.
 *
 * "Same line" is decided by snapping each midpoint to a fixed band rather than
 * by comparing the two midpoints through a tolerance. The tolerance form reads
 * more naturally and is not a valid ordering: markers a and b can be within
 * tolerance, b and c within tolerance, and a and c not, so the comparator
 * contradicts itself and `Array.prototype.sort` may return anything at all.
 *
 * The band has to be a constant rather than anything derived from the pair —
 * an average of the two heights is still pair-dependent, and brings the same
 * problem back. A fixed grid can put two markers a tenth of a point apart in
 * different bands if they straddle an edge, which costs an ordering swap
 * between two markers of one paragraph; that is the smaller failure, and a
 * bounded one.
 */
export function readingOrderCompare(a: SourceSpan | undefined, b: SourceSpan | undefined): number {
  if (!a || !b) return 0;
  if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
  const ab = a.bboxes[0];
  const bb = b.bboxes[0];
  if (!ab || !bb) return 0;
  // PDF user space: origin bottom-left, so later on the page means lower y.
  const byLine =
    Math.floor(midY(bb) / MARKER_LINE_BAND) - Math.floor(midY(ab) / MARKER_LINE_BAND);
  if (byLine !== 0) return byLine;
  return minX(ab) - minX(bb);
}
