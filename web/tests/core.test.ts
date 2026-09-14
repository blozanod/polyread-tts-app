import { describe, expect, it } from "vitest";
import {
  FRAMES_PER_SECOND,
  SECONDS_PER_FRAME,
  framesFromSeconds,
  roundedFrames,
  samplesFromFrames,
  secondsFromFrames,
} from "../src/core/frameMath";
import { buildReflowDocument, insertionToken } from "../src/core/reflow";
import { RenderProgress } from "../src/core/sidecar";
import { holdsFor, tokensOf, violations } from "../src/core/spanInvariant";
import { Timeline } from "../src/core/timeline";
import { newID, textRange, type Block, type SourceSpan, type WordTiming } from "../src/core/types";
import { rect } from "../src/core/geometry";

function span(page = 0, box = rect(0, 0, 10, 10)): SourceSpan {
  return { pageIndex: page, bboxes: [box], reflowRange: textRange(0, 0) };
}

function block(text: string, role: Block["role"] = "body", spans?: SourceSpan[]): Block {
  const tokens = tokensOf(text);
  return {
    id: newID(),
    role,
    spokenText: text,
    spans: spans ?? tokens.map(() => span()),
    footnoteBodyIDs: [],
  };
}

describe("§3 frame arithmetic", () => {
  it("is 40 frames a second at 600 samples a frame", () => {
    expect(FRAMES_PER_SECOND).toBe(40);
    expect(SECONDS_PER_FRAME).toBeCloseTo(0.025, 10);
    expect(samplesFromFrames(40)).toBe(24_000);
  });

  it("never rounds a token down to zero frames", () => {
    // A zero-frame token would collapse a word to zero width on the timeline and
    // the highlight would skip straight past it.
    expect(roundedFrames(0)).toBe(1);
    expect(roundedFrames(0.2)).toBe(1);
    expect(roundedFrames(0.5)).toBe(1);
    expect(roundedFrames(2.4)).toBe(2);
    expect(roundedFrames(2.6)).toBe(3);
  });

  it("round-trips frames and seconds", () => {
    for (const frames of [0, 1, 40, 97, 4321]) {
      expect(framesFromSeconds(secondsFromFrames(frames))).toBe(frames);
    }
  });
});

describe("§8.3 timeline lookup", () => {
  const words: WordTiming[] = [];
  const blockA = newID();
  const blockB = newID();
  for (let i = 0; i < 200; i++) {
    words.push({
      start: i * 0.5,
      end: i * 0.5 + 0.4,
      span: span(),
      blockID: i < 120 ? blockA : blockB,
    });
  }
  const timeline = new Timeline(words);

  it("finds the same index forwards, backwards and by scrub", () => {
    for (let i = 0; i < words.length; i++) {
      expect(timeline.indexAt(i * 0.5 + 0.1)).toBe(i);
    }
    for (let i = words.length - 1; i >= 0; i--) {
      expect(timeline.indexAt(i * 0.5 + 0.1)).toBe(i);
    }
    for (const i of [180, 3, 97, 12, 199, 0]) {
      expect(timeline.indexAt(i * 0.5 + 0.2)).toBe(i);
    }
  });

  it("holds the highlight on the last word through an inter-chunk silence", () => {
    // 0.4 -> 0.5 is the gap after word 0; §5's paragraph pause lands in one of
    // these, and the highlight should rest rather than blink off.
    expect(timeline.indexAt(0.45)).toBe(0);
  });

  it("snaps a skip to a word boundary rather than mid-word", () => {
    const from = 10.3;
    const snapped = timeline.skip(from, 15);
    expect(words.some((w) => w.start === snapped)).toBe(true);
    expect(snapped).toBeGreaterThan(from);
  });

  it("takes previous-paragraph to the block before only within 1.5 s", () => {
    const blockBStart = words[120].start;
    // Just after the boundary: go back to the start of this block.
    expect(timeline.previousBlockStart(blockBStart + 4)).toBe(blockBStart);
    // Inside the first 1.5 s: go back to the previous block.
    expect(timeline.previousBlockStart(blockBStart + 0.5)).toBe(words[0].start);
  });

  it("reports an empty timeline rather than pretending", () => {
    const empty = new Timeline([]);
    expect(empty.isEmpty).toBe(true);
    expect(empty.indexAt(3)).toBe(-1);
    expect(empty.duration).toBe(0);
  });
});

describe("§7.3 render progress", () => {
  it("draws the edge at the contiguous run, not the furthest chunk", () => {
    const progress = new RenderProgress(new Set([0, 1, 2, 9]), 10, [0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 400]);
    expect(progress.contiguousChunkCount).toBe(3);
    expect(progress.framesRendered).toBe(120);
    expect(progress.renderedThrough).toBeCloseTo(3, 6);
    expect(progress.isComplete).toBe(false);
  });

  it("knows whether the audio under a timestamp is on disk", () => {
    const progress = new RenderProgress(new Set([0, 2]), 3, [0, 40, 80, 120]);
    expect(progress.isRendered(0.5)).toBe(true);
    expect(progress.isRendered(1.5)).toBe(false);
    expect(progress.isRendered(2.5)).toBe(true);
    expect(progress.chunkIndexAt(99)).toBe(-1);
  });
});

describe("§10 reflow layout", () => {
  it("gives every token a range that slices its own text back out", () => {
    const blocks = [block("A heading", "heading"), block("The first paragraph of the body.")];
    const { document, blocks: rebuilt } = buildReflowDocument(blocks);

    for (const rebuiltBlock of rebuilt) {
      const tokens = tokensOf(rebuiltBlock.spokenText);
      expect(rebuiltBlock.spans.length).toBe(tokens.length);
      rebuiltBlock.spans.forEach((s, i) => {
        const sliced = document.text.slice(s.reflowRange.location, s.reflowRange.location + s.reflowRange.length);
        expect(sliced).toBe(tokens[i]);
      });
    }
  });

  it("splices a footnote marker into the paragraph rather than after it", () => {
    // A superscript marker hugging the right edge of "second" should land after
    // that word, not at the end of the block.
    const body = block("first second third", "body", [
      span(0, rect(0, 100, 20, 10)),
      span(0, rect(30, 100, 30, 10)),
      span(0, rect(70, 100, 20, 10)),
    ]);
    const marker: Block = {
      id: newID(),
      role: "footnoteMarker",
      spokenText: "12",
      spans: [{ pageIndex: 0, bboxes: [rect(61, 106, 5, 6)], reflowRange: textRange(0, 0) }],
      footnoteBodyIDs: [],
    };

    expect(insertionToken(marker, body, 3)).toBe(1);

    const { document } = buildReflowDocument([body, marker]);
    expect(document.markers.length).toBe(1);
    const at = document.markers[0].range.location;
    expect(document.text.slice(0, at)).toBe("first second");
  });

  it("keeps the span invariant across the whole build", () => {
    const blocks = [block("Heading here", "heading"), block("Body text with several words in it.")];
    const { blocks: rebuilt } = buildReflowDocument(blocks);
    expect(violations(rebuilt)).toEqual([]);
    for (const rebuiltBlock of rebuilt) expect(holdsFor(rebuiltBlock)).toBe(true);
  });
});
