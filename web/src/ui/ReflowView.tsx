import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ReflowDocument, ReflowParagraph } from "../core/reflow";
import type { WordTiming } from "../core/types";

/**
 * §10 — "**Compact width (iPhone): reflowed text.** A `UITextView`/TextKit view
 * built from the normalized `[Block]` list — not from `page.string`. Its
 * character ranges are `SourceSpan.reflowRange`. Highlight = a background
 * attribute on the current word's range, auto-scrolled to stay on screen. This
 * is the primary surface; build it first."
 *
 * ## Why only one paragraph is split into spans
 *
 * A 40-page article is 15,000 words. Fifteen thousand `<span>`s is a DOM the
 * browser re-lays-out on every scroll, and the highlight is the one thing in
 * this app that must not stutter. Only the paragraph being spoken is split;
 * every other paragraph is a single text node. Clicks still land on a word
 * anywhere, because `caretRangeFromPoint` gives a character offset and
 * `reflowRange` is exactly what turns a character offset back into a word.
 */
export interface ReflowViewProps {
  reflow: ReflowDocument;
  words: readonly WordTiming[];
  wordIndex: number;
  onSeekToWord(index: number): void;
  onFootnote(blockID: string): void;
}

export function ReflowView({ reflow, words, wordIndex, onSeekToWord, onFootnote }: ReflowViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLSpanElement>(null);

  const current = wordIndex >= 0 && wordIndex < words.length ? words[wordIndex] : undefined;
  const currentBlockID = current?.blockID;

  /** Character offset -> word index, for click-to-seek. */
  const wordAtOffset = useMemo(() => {
    const sorted = words
      .map((word, index) => ({ index, start: word.span.reflowRange.location }))
      .sort((a, b) => a.start - b.start);
    return (offset: number): number => {
      if (sorted.length === 0) return -1;
      let lo = 0;
      let hi = sorted.length - 1;
      if (offset < sorted[0].start) return sorted[0].index;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (sorted[mid].start <= offset) lo = mid;
        else hi = mid - 1;
      }
      return sorted[lo].index;
    };
  }, [words]);

  /** The words of the block being spoken, so only it needs splitting. */
  const currentWords = useMemo(() => {
    if (!currentBlockID) return [];
    const out: Array<{ index: number; word: WordTiming }> = [];
    for (let i = 0; i < words.length; i++) {
      if (words[i].blockID === currentBlockID) out.push({ index: i, word: words[i] });
    }
    return out;
  }, [words, currentBlockID]);

  // §10 — "auto-scrolled to stay on screen".
  useLayoutEffect(() => {
    const node = highlightRef.current;
    const container = containerRef.current;
    if (!node || !container) return;
    const nodeBox = node.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    const margin = box.height * 0.25;
    if (nodeBox.top < box.top + margin || nodeBox.bottom > box.bottom - margin) {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [wordIndex]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement;
      const marker = target.closest<HTMLElement>("[data-footnote]");
      if (marker?.dataset.footnote) {
        onFootnote(marker.dataset.footnote);
        return;
      }
      const paragraph = target.closest<HTMLElement>("[data-location]");
      if (!paragraph) return;
      const location = Number(paragraph.dataset.location ?? "0");
      const offset = caretOffsetWithin(paragraph, event.clientX, event.clientY);
      if (offset < 0) return;
      const index = wordAtOffset(location + offset);
      if (index >= 0) onSeekToWord(index);
    };
    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
  }, [wordAtOffset, onSeekToWord]);

  return (
    <div className="reflow" ref={containerRef}>
      {reflow.paragraphs.map((paragraph) => (
        <Paragraph
          key={paragraph.blockID}
          paragraph={paragraph}
          text={reflow.text}
          markers={reflow.markers}
          isCurrent={paragraph.blockID === currentBlockID}
          currentWords={paragraph.blockID === currentBlockID ? currentWords : undefined}
          wordIndex={wordIndex}
          highlightRef={highlightRef}
        />
      ))}
    </div>
  );
}

interface ParagraphProps {
  paragraph: ReflowParagraph;
  text: string;
  markers: ReflowDocument["markers"];
  isCurrent: boolean;
  currentWords?: Array<{ index: number; word: WordTiming }>;
  wordIndex: number;
  highlightRef: React.RefObject<HTMLSpanElement>;
}

function Paragraph({
  paragraph,
  text,
  markers,
  isCurrent,
  currentWords,
  wordIndex,
  highlightRef,
}: ParagraphProps): JSX.Element {
  const { location, length } = paragraph.range;
  const body = text.slice(location, location + length);
  const className = `para para-${paragraph.role}${isCurrent ? " para-current" : ""}`;

  if (!isCurrent || !currentWords || currentWords.length === 0) {
    // §4.5 — markers stay "visible and tappable in the reflow view"; they are
    // the affordance for §8.5, so they get a node even in a plain paragraph.
    const inside = markers.filter(
      (m) => m.range.location >= location && m.range.location < location + length,
    );
    if (inside.length === 0) {
      return (
        <p className={className} data-location={location}>
          {body}
        </p>
      );
    }
    const parts: JSX.Element[] = [];
    let cursor = location;
    inside.forEach((marker, i) => {
      if (marker.range.location > cursor) {
        parts.push(<span key={`t${i}`}>{text.slice(cursor, marker.range.location)}</span>);
      }
      parts.push(
        <sup key={`m${i}`} className="marker" data-footnote={marker.footnoteBodyID ?? ""}>
          {marker.label}
        </sup>,
      );
      cursor = marker.range.location + marker.range.length;
    });
    if (cursor < location + length) parts.push(<span key="tail">{text.slice(cursor, location + length)}</span>);
    return (
      <p className={className} data-location={location}>
        {parts}
      </p>
    );
  }

  // The spoken paragraph, split at word boundaries.
  const parts: JSX.Element[] = [];
  let cursor = location;
  for (const { index, word } of currentWords) {
    const { location: start, length: wordLength } = word.span.reflowRange;
    if (start < cursor || start + wordLength > location + length) continue;
    if (start > cursor) parts.push(<span key={`g${start}`}>{text.slice(cursor, start)}</span>);
    const isHighlighted = index === wordIndex;
    parts.push(
      <span
        key={`w${start}`}
        className={isHighlighted ? "word word-current" : "word"}
        ref={isHighlighted ? highlightRef : undefined}
      >
        {text.slice(start, start + wordLength)}
      </span>,
    );
    cursor = start + wordLength;
  }
  if (cursor < location + length) parts.push(<span key="tail">{text.slice(cursor, location + length)}</span>);

  return (
    <p className={className} data-location={location}>
      {parts}
    </p>
  );
}

/** Character offset of a point inside `element`, or -1. */
function caretOffsetWithin(element: HTMLElement, clientX: number, clientY: number): number {
  const range = caretRangeFromPoint(clientX, clientY);
  if (!range || !element.contains(range.startContainer)) return -1;
  const measure = document.createRange();
  measure.selectNodeContents(element);
  measure.setEnd(range.startContainer, range.startOffset);
  return measure.toString().length;
}

function caretRangeFromPoint(x: number, y: number): Range | undefined {
  const legacy = document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null };
  if (typeof legacy.caretRangeFromPoint === "function") {
    return legacy.caretRangeFromPoint(x, y) ?? undefined;
  }
  const standard = document as Document & {
    caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
  };
  const position = standard.caretPositionFromPoint?.(x, y);
  if (!position) return undefined;
  const range = document.createRange();
  range.setStart(position.offsetNode, position.offset);
  return range;
}
