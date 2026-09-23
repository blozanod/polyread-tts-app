import { describe, expect, it } from "vitest";
import { rect } from "../src/core/geometry";
import type { TextRun } from "../src/core/types";
import {
  attachPunctuation,
  isHeading,
  isHyphenated,
  mergeAcrossPages,
  paragraphs,
  protoText,
  silenceFigureText,
  tokenizeParagraph,
  type ProtoBlock,
} from "../src/extraction/blockAssembler";
import { assembleWords, cleanWord } from "../src/extraction/words";
import {
  columnSplitX,
  footnoteBodyLineIndices,
  FurnitureClassifier,
  groupIntoLines,
  isBareNumber,
  isMarker,
  layoutPage,
  lineText,
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

/** A line of type: `words` set from `x` with ordinary word spacing. */
function typeLine(words: string[], x: number, baseline: number, height = 10, pageIndex = 0): TextRun[] {
  const out: TextRun[] = [];
  let cursor = x;
  for (const word of words) {
    const width = word.length * height * 0.5;
    out.push({ ...run(word, cursor, baseline, width, height), pageIndex });
    cursor += width + height * 0.3;
  }
  return out;
}

const WORDS = "the comparative study of democratic consolidation requires attention to elites".split(" ");
/** About 200 pt of type at 10 pt: one line of a journal column. */
const COLUMN_WORDS = "the study of elite pacts has long been".split(" ");

describe("§4.3 column detection", () => {
  /** Two justified columns of `lines` lines, 20 pt apart, with a title across both. */
  function twoColumnPage(lines: number): TextRun[] {
    const runs: TextRun[] = [...typeLine(["A", "Title", "Across", "Both", "Columns"], 250, 740, 14)];
    for (let i = 0; i < lines; i++) {
      runs.push(...typeLine(COLUMN_WORDS.map((w) => `${w}L`), 72, 700 - i * 12));
      runs.push(...typeLine(COLUMN_WORDS.map((w) => `${w}R`), 320, 700 - i * 12));
    }
    return runs;
  }

  it("finds the gutter of a two-column page and orders column-major", () => {
    const runs = twoColumnPage(20);
    const split = columnSplitX(runs, PAGE);
    expect(split).toBeDefined();
    expect(split!).toBeGreaterThan(290);
    expect(split!).toBeLessThan(320);

    const ordered = orderRuns(runs, PAGE);
    const firstRight = ordered.findIndex((r) => r.text.includes("R"));
    const lastLeft = ordered.map((r) => r.text.includes("L")).lastIndexOf(true);
    // The title first, then every left-column run before every right-column one.
    expect(ordered[0].text).toBe("A");
    expect(firstRight).toBeGreaterThan(lastLeft);
  });

  it("finds a gutter a quarter of an inch wide", () => {
    // The old test wanted 15% of the page empty. A journal's gutter is 4%.
    const line = typeLine(COLUMN_WORDS, 72, 0);
    const width = line[line.length - 1].bbox.x + line[line.length - 1].bbox.width - 72;
    const runs: TextRun[] = [];
    for (let i = 0; i < 20; i++) {
      runs.push(...typeLine(COLUMN_WORDS, 72, 700 - i * 12));
      runs.push(...typeLine(COLUMN_WORDS, 72 + width + 18, 700 - i * 12));
    }
    expect(columnSplitX(runs, PAGE)).toBeDefined();
  });

  it("leaves a single-column page alone", () => {
    const runs: TextRun[] = [];
    for (let i = 0; i < 24; i++) runs.push(...typeLine([...WORDS, ...WORDS.slice(0, 4)], 72, 700 - i * 14));
    expect(columnSplitX(runs, PAGE)).toBeUndefined();
  });

  it("reads a table row by row rather than as columns", () => {
    const runs: TextRun[] = [];
    for (let i = 0; i < 12; i++) {
      for (let c = 0; c < 5; c++) runs.push(run(`r${i}c${c}`, 72 + c * 90, 700 - i * 14, 30));
    }
    expect(columnSplitX(runs, PAGE)).toBeUndefined();
  });

  it("keeps the short last line of a full-width abstract with the abstract", () => {
    const runs: TextRun[] = [];
    for (let i = 0; i < 4; i++) runs.push(...typeLine([...WORDS, ...WORDS.slice(0, 5)], 100, 700 - i * 12, 9));
    runs.push(...typeLine(["abstract", "ends", "here."], 100, 652, 9));
    for (let i = 0; i < 20; i++) {
      runs.push(...typeLine(COLUMN_WORDS, 72, 620 - i * 12));
      runs.push(...typeLine(COLUMN_WORDS, 320, 620 - i * 12));
    }
    const lines = layoutPage(runs, PAGE);
    const tail = lines.findIndex((l) => lineText(l) === "abstract ends here.");
    expect(tail).toBe(4);
  });

  it("groups runs whose baselines agree within half a glyph into one line", () => {
    const runs = [run("a", 72, 700), run("b", 120, 700.4), run("c", 170, 686)];
    const lines = groupIntoLines(runs);
    expect(lines.length).toBe(2);
    expect(lines[0].runs.length).toBe(2);
  });

  it("follows a scan's skew along a line instead of breaking it", () => {
    // 0.5 degrees: the baseline falls four points across the measure.
    const runs = typeLine([...WORDS, ...WORDS.slice(0, 6)], 72, 700).map((r) => {
      const drop = (r.bbox.x - 72) * Math.tan((0.5 * Math.PI) / 180);
      return { ...r, baseline: r.baseline - drop, bbox: { ...r.bbox, y: r.bbox.y - drop } };
    });
    runs.push(...typeLine(WORDS, 72, 686));
    const lines = groupIntoLines(runs);
    expect(lines.length).toBe(2);
    expect(lineText(lines[0])).toBe([...WORDS, ...WORDS.slice(0, 6)].join(" "));
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
      line([run("second line of one.", 72, 386, 200, 10)]),
      line([run("indented start", 90, 372, 282, 10)]),
      line([run("its second line", 72, 358, 300, 10)]),
    ];
    const result = paragraphs(lines);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(2);
  });

  it("keeps a block quote in one piece, and ends it where the margin returns", () => {
    // Every line of a quotation is set in from the margin. The old rule called
    // each of them an indent, and a four-line quote became four paragraphs.
    const lines = [
      line([run("body text that introduces the quotation, as follows:", 72, 500, 300, 10)]),
      line([run("the quoted passage begins here and runs", 102, 484, 240, 10)]),
      line([run("on across several lines of its own without", 102, 472, 240, 10)]),
      line([run("any break between them at all, ending here.", 102, 460, 200, 10)]),
      line([run("and the paragraph resumes at the margin", 72, 444, 300, 10)]),
      line([run("before it ends.", 72, 432, 100, 10)]),
    ];
    const result = paragraphs(lines);
    expect(result.map((p) => p.length)).toEqual([1, 3, 2]);
  });

  it("keeps a centred two-line title in one piece", () => {
    const lines = [
      line([run("Sequencing and the State: Bureaucratic", 90, 700, 430, 17)]),
      line([run("Autonomy Compared", 230, 679, 150, 17)]),
      line([run("the body starts here and runs to the full measure", 72, 640, 468, 10)]),
      line([run("of the column for several lines of ordinary text", 72, 628, 468, 10)]),
      line([run("before it ends.", 72, 616, 90, 10)]),
    ];
    const result = paragraphs(lines);
    expect(result[0].length).toBe(2);
  });

  it("does not call a skewed margin an indent", () => {
    // Each line starts a little further right, as on a scan rotated half a
    // degree; none of them is indented.
    const lines = Array.from({ length: 12 }, (_, i) =>
      line([run(`line ${i} of one long paragraph`, 72 + i * 0.9, 700 - i * 12, 300, 10)]),
    );
    expect(paragraphs(lines).length).toBe(1);
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
    // The next page's running head sits between the two halves in the block
    // list; it used to stop every merge.
    const head: ProtoBlock = { ...make("World Politics", 1), role: "runningHead" };
    expect(mergeAcrossPages([make("the argument runs", 0), head, make("through the case", 1)]).length).toBe(2);
  });

  it("carries a paragraph from the foot of one column to the head of the next", () => {
    const make = (text: string, columnIndex: number, extra: Partial<ProtoBlock> = {}): ProtoBlock => ({
      id: `c${columnIndex}-${text}`,
      role: "body",
      tokens: text.split(" ").map((t) => ({ text: t, bboxes: [], pageIndex: 0 })),
      pageIndex: 0,
      columnIndex,
      glyphHeight: 10,
      lineCount: 3,
      columnWidth: 225,
      ...extra,
    });
    const merged = mergeAcrossPages([make("the argument runs across the", 1), make("gutter and on", 2)]);
    expect(merged.length).toBe(1);

    // A document that indents its paragraphs: a flush first line at the head
    // of a column continues the paragraph even after a full stop.
    const indented = (id: string) => make(`${id} A paragraph.`, 1, { startsIndented: true, endsFull: false });
    const blocks = [indented("a"), indented("b"), indented("c"), indented("d")];
    blocks.push(make("It ended at the foot.", 1, { startsIndented: true, endsFull: true }));
    blocks.push(make("And went on at the head.", 2, { startsIndented: false }));
    expect(mergeAcrossPages(blocks).length).toBe(5);

    // Not from a full-width abstract into the column beneath it.
    const abstract = make("an abstract that runs on", 0, { columnWidth: 412 });
    expect(mergeAcrossPages([abstract, make("into the column", 1)]).length).toBe(2);
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
  const item = (str: string, x: number, width: number, extra: Partial<{ y: number; size: number; hasEOL: boolean }> = {}) => ({
    str,
    transform: [extra.size ?? 10, 0, 0, extra.size ?? 10, x, extra.y ?? 700],
    width,
    height: extra.size ?? 10,
    hasEOL: extra.hasEOL ?? false,
  });

  it("cuts an item at its spaces and keeps the baseline exact", () => {
    const runs = assembleWords([item("the quick brown", 72, 60)], 3);
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
    expect(assembleWords([item("   ", 0, 6, { hasEOL: true })], 0)).toEqual([]);
  });

  it("joins a word that changes font part of the way through", () => {
    // Small caps: a full-size capital, then reduced capitals, no space between.
    expect(assembleWords([item("Western E", 72, 45), item("UROPE", 117, 30, { size: 7.8 })], 0).map((r) => r.text)).toEqual([
      "Western",
      "EUROPE",
    ]);
    // An italic word whose period is set in roman.
    expect(assembleWords([item("resist arbitrary rule", 72, 100), item(".", 172, 2.5)], 0).map((r) => r.text)).toEqual([
      "resist",
      "arbitrary",
      "rule.",
    ]);
    // But never across a visible space, and never onto a raised marker.
    expect(assembleWords([item("state", 72, 25), item("power", 100, 25)], 0).length).toBe(2);
    expect(assembleWords([item("state.", 72, 28), item("12", 100, 6, { y: 704, size: 6 })], 0).length).toBe(2);
  });

  it("puts a TeX accent back on its letter", () => {
    // pdf.js hands the accent back at the end of one item and the letter it
    // sits on at the start of the next, drawn a few points back under it.
    const runs = assembleWords([item("a na¨", 54, 18.4), item("ıve implementation", 69.6, 80)], 0);
    expect(runs.map((r) => r.text)).toEqual(["a", "naïve", "implementation"]);
    expect(cleanWord("signiﬁcant")).toBe("significant");
    expect(cleanWord("elec\u00ADtion")).toBe("election");
    expect(cleanWord("elec\u00AD")).toBe("elec-");
  });

  it("drops text struck twice for a bold effect", () => {
    const runs = assembleWords([item("3.", 72, 10), item("3.", 72.3, 10), item("Reform", 86, 30), item("Reform", 86.3, 30)], 0);
    expect(runs.map((r) => r.text)).toEqual(["3.", "Reform"]);
  });

  it("leaves rotated text out of the reading", () => {
    const stamp = { str: "Downloaded from", transform: [0, 8, -8, 0, 20, 300], width: 60, height: 8, hasEOL: false };
    expect(assembleWords([stamp, item("body", 72, 20)], 0).map((r) => r.text)).toEqual(["body"]);
  });
});

describe("text that is not prose", () => {
  const proto = (text: string, extra: Partial<ProtoBlock> = {}): ProtoBlock => ({
    id: text,
    role: "body",
    tokens: text.split(" ").map((t) => ({ text: t, bboxes: [], pageIndex: 0 })),
    pageIndex: 0,
    columnIndex: 0,
    glyphHeight: 10,
    lineCount: 1,
    ...extra,
  });

  it("silences a figure's labels and keeps a list and a heading", () => {
    const blocks = [
      proto("A sentence of prose that ends properly."),
      proto("Interpreting"),
      proto("loop/exit Native"),
      proto("hot"),
      proto("Record Enter"),
      proto("Another sentence of prose."),
      proto("• first item"),
      proto("• second item"),
      proto("• third item"),
      proto("Evidence from Britain"),
    ];
    silenceFigureText(blocks, 10);
    expect(blocks.map((b) => b.role)).toEqual([
      "body",
      "runningHead",
      "runningHead",
      "runningHead",
      "runningHead",
      "body",
      "body",
      "body",
      "body",
      "body",
    ]);
  });

  it("silences a font with no Unicode mapping", () => {
    const blocks = [proto("7<>;.?:2/>9<F.A897#3*4$56#"), proto('%#"')];
    silenceFigureText(blocks, 10);
    expect(blocks.every((b) => b.role === "runningHead")).toBe(true);
  });

  it("folds loose punctuation into the words it belongs to", () => {
    const at = (text: string, x: number) => ({ text, bboxes: [rect(x, 700, text.length * 5, 10)], pageIndex: 0 });
    const tokens = attachPunctuation([at("“", 72), at("The", 78), at("state", 96), at("”", 122), at(",", 126), at("he", 134), at("said", 146)]);
    expect(tokens.map((t) => t.text)).toEqual(["“The", "state”,", "he", "said"]);
    expect(tokens[1].bboxes.length).toBe(3);
  });
});
