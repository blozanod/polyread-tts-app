import { describe, expect, it } from "vitest";
import { rect } from "../src/core/geometry";
import type { TextRun } from "../src/core/types";
import {
  isHeading,
  isHyphenated,
  mergeAcrossPages,
  paragraphs,
  protoText,
  tokenizeParagraph,
  type ProtoBlock,
} from "../src/extraction/blockAssembler";
import { splitItemIntoRuns } from "../src/extraction/backends";
import {
  columnSplitX,
  footnoteBodyLineIndices,
  FurnitureClassifier,
  groupIntoLines,
  isBareNumber,
  isMarker,
  normalizedForm,
  orderRuns,
  type Line,
} from "../src/extraction/pageLayout";
import { decideBackend, isPronounceable, scoreRuns } from "../src/extraction/quality";

const PAGE = rect(0, 0, 612, 792);

function run(text: string, x: number, baseline: number, width = 40, height = 10): TextRun {
  return {
    text,
    bbox: rect(x, baseline - height * 0.2, width, height),
    glyphHeight: height,
    baseline,
    pageIndex: 0,
    columnIndex: 0,
    orderIndex: 0,
  };
}

function line(runs: TextRun[], columnIndex = 0): Line {
  return { runs, columnIndex, pageIndex: runs[0]?.pageIndex ?? 0 };
}

describe("§4.3 column detection", () => {
  it("finds the gutter of a two-column page and orders column-major", () => {
    const runs: TextRun[] = [];
    for (let i = 0; i < 20; i++) {
      runs.push(run(`left${i}`, 60 + (i % 3) * 50, 700 - i * 12));
      runs.push(run(`right${i}`, 340 + (i % 3) * 50, 700 - i * 12));
    }
    const split = columnSplitX(runs, PAGE);
    expect(split).toBeDefined();
    expect(split!).toBeGreaterThan(PAGE.width * 0.3);
    expect(split!).toBeLessThan(PAGE.width * 0.7);

    const ordered = orderRuns(runs, PAGE);
    const firstRight = ordered.findIndex((r) => r.text.startsWith("right"));
    const lastLeft = ordered.map((r) => r.text.startsWith("left")).lastIndexOf(true);
    // Every left-column run comes before every right-column one.
    expect(firstRight).toBeGreaterThan(lastLeft);
  });

  it("leaves a single-column page alone", () => {
    const runs: TextRun[] = [];
    for (let i = 0; i < 24; i++) runs.push(run(`w${i}`, 72 + (i % 6) * 70, 700 - Math.floor(i / 6) * 14));
    expect(columnSplitX(runs, PAGE)).toBeUndefined();
  });

  it("groups runs whose baselines agree within half a glyph into one line", () => {
    const runs = [run("a", 72, 700), run("b", 120, 700.4), run("c", 170, 686)];
    const lines = groupIntoLines(runs);
    expect(lines.length).toBe(2);
    expect(lines[0].runs.length).toBe(2);
  });
});

describe("§4.4 running heads and page numbers", () => {
  it("needs the band and a repeat, not the band alone", () => {
    const classifier = new FurnitureClassifier();
    const head = line([run("World Politics", 200, 770)]);
    const footnote = line([run("See Linz 1990 for the argument", 72, 60, 200, 8)]);

    // Five pages carrying the running head; the footnote appears on one of them,
    // which is 20% and under §4.4's 40% repeat threshold.
    for (let page = 0; page < 5; page++) {
      classifier.observe(page === 2 ? [head, footnote] : [head], PAGE, page);
    }

    expect(classifier.role(head, PAGE)).toBe("runningHead");
    // A footnote body also lives in the bottom band, and must not be furniture.
    expect(classifier.role(footnote, PAGE)).toBeUndefined();
  });

  it("calls a bare number a page number without needing a repeat", () => {
    const classifier = new FurnitureClassifier();
    const folio = line([run("417", 300, 30)]);
    classifier.observe([folio], PAGE, 0);
    expect(classifier.role(folio, PAGE)).toBe("pageNumber");
    expect(isBareNumber("[42]")).toBe(true);
    expect(isBareNumber("xiv")).toBe(true);
    expect(isBareNumber("Chapter")).toBe(false);
  });

  it("normalizes digits so a folio repeats across pages", () => {
    expect(normalizedForm("Chapter 4")).toBe("chapter #");
    expect(normalizedForm("Chapter 17")).toBe("chapter #");
  });
});

describe("§4.5 footnotes", () => {
  it("wants small, raised and numeric all three before calling it a marker", () => {
    const body = run("settlements", 72, 400, 80, 10);
    const marker = run("12", 152, 404, 5, 6);
    const l = line([body, marker]);
    expect(isMarker(marker, l)).toBe(true);
    // Same size as the body: a citation year, not a marker.
    expect(isMarker(run("1993", 152, 404, 20, 10), l)).toBe(false);
    // Small but on the baseline: a subscript or small caps, not a marker.
    expect(isMarker(run("12", 152, 400, 5, 6), l)).toBe(false);
  });

  it("keeps a typeset superscript on the line it annotates", () => {
    // A marker at 0.58x the body size raised 0.33x an em — what a real
    // typesetter produces — misses the plain baseline tolerance by a fraction of
    // a point. If it becomes a line of its own it is neither small nor raised
    // relative to that line, so `isMarker` reads it as body text and the
    // footnote number gets spoken mid-sentence.
    const body = run("settlements", 72, 645, 80, 11);
    const marker = run("1", 156, 648.6, 3, 6.4);
    const lines = groupIntoLines([body, marker]);
    expect(lines.length).toBe(1);
    expect(isMarker(marker, lines[0])).toBe(true);
  });

  it("does not weld two genuinely adjacent lines together", () => {
    // Single-spaced leading is about 1.2x the body size; two body lines that
    // close together must stay apart.
    const lines = groupIntoLines([run("first line", 72, 645, 80, 11), run("second line", 72, 632, 80, 11)]);
    expect(lines.length).toBe(2);
  });

  it("groups the apparatus upward from the page bottom and stops at body size", () => {
    const lines = [
      line([run("body text here", 72, 400, 200, 10)]),
      line([run("more body text", 72, 386, 200, 10)]),
      line([run("1. a note", 72, 90, 200, 8)]),
      line([run("continued", 72, 78, 200, 8)]),
    ];
    const indices = footnoteBodyLineIndices(lines, 10, PAGE);
    expect([...indices].sort()).toEqual([2, 3]);
  });
});

describe("§4.6 joining", () => {
  it("drops a line-final hyphen only when the next line is lowercase", () => {
    expect(isHyphenated("insti-")).toBe(true);
    expect(isHyphenated("-")).toBe(false);

    const joined = tokenizeParagraph([
      line([run("insti-", 72, 400)]),
      line([run("tutional", 72, 386)]),
    ]);
    expect(joined.tokens.map((t) => t.text)).toEqual(["institutional"]);
    // §4.6 — one spoken token, two bboxes.
    expect(joined.tokens[0].bboxes.length).toBe(2);

    // A real compound broken at its own hyphen keeps it: next line is a capital.
    const compound = tokenizeParagraph([
      line([run("nation-", 72, 400)]),
      line([run("State", 72, 386)]),
    ]);
    expect(compound.tokens.map((t) => t.text)).toEqual(["nation-", "State"]);
  });

  it("starts a paragraph on an indent even with no extra leading", () => {
    // The book-chapter case the Swift build added an indent test for: uniform
    // leading, and only the indent marks the break.
    const lines = [
      line([run("first line of one", 72, 400, 300, 10)]),
      line([run("second line of one", 72, 386, 300, 10)]),
      line([run("indented start", 82, 372, 300, 10)]),
      line([run("its second line", 72, 358, 300, 10)]),
    ];
    const result = paragraphs(lines);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(2);
  });

  it("merges a paragraph across a page break only when both halves agree", () => {
    const make = (text: string, pageIndex: number): ProtoBlock => ({
      id: `b${pageIndex}-${text}`,
      role: "body",
      tokens: text.split(" ").map((t) => ({ text: t, bboxes: [], pageIndex })),
      pageIndex,
      columnIndex: 0,
      glyphHeight: 10,
      lineCount: 1,
    });

    const merged = mergeAcrossPages([make("the argument runs", 0), make("through the case", 1)]);
    expect(merged.length).toBe(1);
    expect(protoText(merged[0])).toBe("the argument runs through the case");

    // Terminal punctuation on the first half: no merge.
    expect(mergeAcrossPages([make("the argument ends.", 0), make("through the case", 1)]).length).toBe(2);
    // Capital on the second half: no merge.
    expect(mergeAcrossPages([make("the argument runs", 0), make("Through the case", 1)]).length).toBe(2);
  });

  it("calls a short, large, unpunctuated line a heading", () => {
    const heading: ProtoBlock = {
      id: "h",
      role: "body",
      tokens: ["Elite", "Settlements"].map((t) => ({ text: t, bboxes: [], pageIndex: 0 })),
      pageIndex: 0,
      columnIndex: 0,
      glyphHeight: 14,
      lineCount: 1,
    };
    expect(isHeading(heading, 10)).toBe(true);

    // Same size as the body, but numbered: still a heading.
    const numbered: ProtoBlock = { ...heading, glyphHeight: 10, tokens: [
      { text: "II.", bboxes: [], pageIndex: 0 },
      { text: "Method", bboxes: [], pageIndex: 0 },
    ] };
    expect(isHeading(numbered, 10)).toBe(true);

    // A body-sized sentence is not.
    const body: ProtoBlock = { ...heading, glyphHeight: 10, lineCount: 4, tokens:
      "this is an ordinary sentence of body text that runs on.".split(" ").map((t) => ({ text: t, bboxes: [], pageIndex: 0 })) };
    expect(isHeading(body, 10)).toBe(false);
  });
});

describe("§4.2 quality scoring", () => {
  const areas = new Map([[0, 612 * 792]]);

  function runsFor(text: string): TextRun[] {
    return text.split(" ").map((word, i) => run(word, 72 + i, 700));
  }

  it("passes ordinary prose and fails mojibake", () => {
    const prose =
      "the argument of this chapter is that the consolidation of democracy in the region " +
      "depends on the choices that elites make in the first years after a transition and " +
      "on the institutions they build to contain their own disagreements with each other";
    const garbage = "ﬂþÿ qwxz bzzrt ﬁﬂ kkkk zzzz þþþ xnqz vbbb ﬁﬁﬁ wqqq zzxx nnqq bbvv ﬁﬂﬁ ttzz";

    const good = scoreRuns(runsFor(prose.repeat(3)), areas);
    const bad = scoreRuns(runsFor(garbage.repeat(6)), areas);

    expect(good.functionWordRatio).toBeGreaterThan(0.3);
    expect(bad.functionWordRatio).toBeLessThan(0.05);
    expect(decideBackend(good, undefined).choice).toBe("embedded");
    expect(decideBackend(bad, undefined).needsUserConfirmation).toBe(true);
  });

  it("does not punish proper nouns, which a spell checker would", () => {
    for (const name of ["Przeworski", "Tocqueville", "Huntington", "Linz", "Putnam"]) {
      expect(isPronounceable(name), name).toBe(true);
    }
    expect(isPronounceable("qwxzbzzrt")).toBe(false);
    expect(isPronounceable("bcdfg")).toBe(false);
  });

  it("keeps a good embedded layer when OCR scores no better", () => {
    const good = scoreRuns(runsFor("the of and to in a is that it for was as with be by on not".repeat(4)), areas);
    const worse = scoreRuns(runsFor("qq zz xx".repeat(40)), areas);
    expect(decideBackend(good, worse).choice).toBe("embedded");
  });
});

describe("pdf.js text items", () => {
  it("cuts an item at its spaces and keeps the baseline exact", () => {
    const runs = splitItemIntoRuns(
      { str: "the quick brown", transform: [10, 0, 0, 10, 72, 700], width: 60, height: 10, hasEOL: false },
      3,
    );
    expect(runs.map((r) => r.text)).toEqual(["the", "quick", "brown"]);
    // The baseline and glyph height come from the item itself, so the §4.5
    // marker test is exact even though the horizontal cut is proportional.
    for (const r of runs) {
      expect(r.baseline).toBe(700);
      expect(r.glyphHeight).toBe(10);
      expect(r.pageIndex).toBe(3);
    }
    expect(runs[0].bbox.x).toBeCloseTo(72, 6);
    expect(runs[2].bbox.x).toBeGreaterThan(runs[1].bbox.x);
  });

  it("ignores an item that is only whitespace", () => {
    expect(
      splitItemIntoRuns({ str: "   ", transform: [10, 0, 0, 10, 0, 0], width: 6, height: 10, hasEOL: true }, 0),
    ).toEqual([]);
  });
});
