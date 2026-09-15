import { describe, expect, it } from "vitest";
import { tokensOf } from "../src/core/spanInvariant";
import { newID, textRange, type Block } from "../src/core/types";
import { BUDGET, Chunker, isSentenceEnd, splitChunks } from "../src/linguistics/chunker";
import {
  alignGroupsToTokens,
  alignTokens,
  allowedGroupRange,
  EspeakPhonemizer,
} from "../src/linguistics/espeakPhonemizer";
import { unencodableEntries, homographPhonemes } from "../src/linguistics/homographs";
import { normalizeText, postProcessPhonemes, splitOnPunctuation } from "../src/linguistics/kokoroText";
import { affixes, normalize } from "../src/linguistics/normalizer";
import { tagTokens } from "../src/linguistics/posTagger";
import { assertVocabularyShape, defaultVocabulary, framed } from "../src/linguistics/vocabulary";

function block(text: string): Block {
  return {
    id: newID(),
    role: "body",
    spokenText: text,
    spans: tokensOf(text).map(() => ({ pageIndex: 0, bboxes: [], reflowRange: textRange(0, 0) })),
    footnoteBodyIDs: [],
  };
}

describe("Kokoro vocabulary", () => {
  it("matches the ids the checkpoint was trained with", () => {
    // This is the check the Swift build could not run. The apostrophe it was
    // missing shifted every symbol after it, which synthesizes as fluent
    // nonsense rather than as an error.
    expect(assertVocabularyShape()).toEqual([]);
  });

  it("encodes every phoneme in the override tables", () => {
    expect(unencodableEntries(defaultVocabulary)).toEqual([]);
  });

  it("drops an unknown symbol and says so, rather than padding", () => {
    const { tokens, unknown } = defaultVocabulary.encode("hˈɛloʊ\u{1F600}");
    expect(unknown).toEqual(["\u{1F600}"]);
    expect(tokens.length).toBe(6);
  });

  it("frames a sequence with a zero at each end", () => {
    expect(framed([5, 6, 7])).toEqual([0, 5, 6, 7, 0]);
  });
});

describe("§5 normalization", () => {
  it("expands the table and keeps one span per resulting token", () => {
    const cases: Array<[string, string]> = [
      ["See (e.g., Putnam 1993).", "See (for example, Putnam 1993)."],
      ["cf. Linz", "compare Linz"],
      ["i.e. the elite", "that is the elite"],
      ["ibid., 44", "ibid, 44"],
      ["Linz et al. 1996", "Linz et al 1996"],
      ["pp. 12-19 cover it", "pages 12 to 19 cover it"],
    ];
    for (const [input, expected] of cases) {
      const out = normalize([block(input)])[0];
      expect(out.spokenText, input).toBe(expected);
      expect(out.spans.length, input).toBe(tokensOf(out.spokenText).length);
    }
  });

  it("points every token of an expansion at the source box it came from", () => {
    const source = block("See e.g. this");
    source.spans[1] = { pageIndex: 2, bboxes: [{ x: 1, y: 2, width: 3, height: 4 }], reflowRange: textRange(0, 0) };
    const out = normalize([source])[0];
    // "e.g." is one source token and two spoken tokens; both point at its box.
    expect(out.spokenText).toBe("See for example this");
    expect(out.spans[1].bboxes).toEqual(source.spans[1].bboxes);
    expect(out.spans[2].bboxes).toEqual(source.spans[1].bboxes);
    expect(out.spans[1].pageIndex).toBe(2);
  });

  it("keeps sentence punctuation and drops only the abbreviating period", () => {
    expect(affixes("(e.g.,")).toEqual({ leading: "(", core: "e.g", trailing: ".," });
    expect(normalize([block("(e.g., x)")])[0].spokenText).toBe("(for example, x)");
  });

  it("leaves in-text citations alone", () => {
    // §5 — "Do not strip them — `(Putnam 1993, 45)` is a sub-clause".
    const text = "the thesis (Putnam 1993, 45) holds";
    expect(normalize([block(text)])[0].spokenText).toBe(text);
  });

  it("does not touch a block that is not spoken", () => {
    const head: Block = { ...block("World Politics"), role: "runningHead" };
    expect(normalize([head])[0]).toBe(head);
  });
});

describe("§6.1 phonemizer", () => {
  const phonemizer = new EspeakPhonemizer();

  it("returns one group per token, whatever the token is", async () => {
    const cases = [
      "The record shows that Przeworski and Tocqueville disagreed.",
      "They record the vote (Putnam 1993, 45) for example.",
      "In 1993 the Assembly met; pages 12 to 19 cover it, compare Linz.",
      "( ) — punctuation only",
      "47.5% of $1,200 and/or 3-4 items",
      "institutionalization re-institutionalization",
    ];
    for (const text of cases) {
      const tokens = tokensOf(text);
      const words = await phonemizer.phonemize(tokens, []);
      expect(words.length, text).toBe(tokens.length);
      expect(words.map((w) => w.token), text).toEqual(tokens);
    }
  }, 60_000);

  it("resolves the homographs §6.1 names, from context", async () => {
    const pairs: Array<[string, number, string, number]> = [
      ["the record shows", 1, "they record the vote", 1],
      ["a sharp conflict arose", 2, "they conflict with each other", 1],
      ["the present moment", 1, "they present the case", 1],
    ];
    for (const [nounText, nounIndex, verbText, verbIndex] of pairs) {
      const noun = await phonemizer.phonemize(tokensOf(nounText), []);
      const verb = await phonemizer.phonemize(tokensOf(verbText), []);
      expect(noun[nounIndex].phonemes, nounText).not.toBe(verb[verbIndex].phonemes);
    }
  }, 60_000);

  it("emits only symbols the vocabulary knows", async () => {
    const text =
      "The comparative study of democratic consolidation requires attention to elite settlements, " +
      "which Przeworski and Linz described in 1993.";
    const words = await phonemizer.phonemize(tokensOf(text), []);
    const unknown = new Set<string>();
    for (const word of words) {
      for (const symbol of defaultVocabulary.encode(word.phonemes).unknown) unknown.add(symbol);
    }
    expect([...unknown]).toEqual([]);
  }, 60_000);
});

describe("word alignment", () => {
  it("lets a number take several groups and punctuation take none", () => {
    expect(allowedGroupRange("1993")).toMatchObject({ min: 1, max: 8 });
    expect(allowedGroupRange("(")).toMatchObject({ min: 0, max: 0 });
    expect(allowedGroupRange("nation-state")).toMatchObject({ min: 1, max: 4 });
    expect(allowedGroupRange("elite")).toMatchObject({ min: 1, max: 2 });
  });

  it("assigns the expanded groups of a number to the number", () => {
    const tokens = ["in", "1993", "the", "assembly"];
    const groups = ["ɪn", "nˈaɪntiːn", "hˈʌndɹɪd", "nˈaɪnti", "θɹˈiː", "ðə", "ɐsˈɛmbli"];
    const aligned = alignGroupsToTokens(tokens, groups);
    expect(aligned).toBeDefined();
    expect(aligned!.length).toBe(4);
    expect(aligned![0]).toBe("ɪn");
    expect(aligned![1]).toBe("nˈaɪntiːnhˈʌndɹɪdnˈaɪntiθɹˈiː");
    expect(aligned![3]).toBe("ɐsˈɛmbli");
  });

  it("gives a punctuation-only token an empty group", () => {
    const aligned = alignGroupsToTokens(["—", "elite"], ["ɪlˈiːt"]);
    expect(aligned).toEqual(["", "ɪlˈiːt"]);
  });

  it("refuses rather than inventing an alignment it cannot justify", () => {
    // Four ordinary words and twenty groups: no assignment respects the
    // structural ranges, so the caller must fall back to per-token.
    expect(alignGroupsToTokens(["a", "b", "c", "d"], Array.from({ length: 20 }, () => "x"))).toBeUndefined();
  });

  it("names the tokens eSpeak welded together instead of only refusing", () => {
    // eSpeak runs short function words into one group: "of the" comes back as
    // a single `ʌvðə`. Strictly there is no alignment, and the merge-aware pass
    // is what says *which* two tokens to redo rather than the whole paragraph.
    const tokens = ["the", "vote", "of", "the", "assembly"];
    const groups = ["ðə", "vˈoʊt", "ʌvðə", "ɐsˈɛmbli"];
    expect(alignGroupsToTokens(tokens, groups)).toBeUndefined();

    const loose = alignTokens(tokens, groups, { allowMerges: true });
    expect(loose).toBeDefined();
    expect(loose!.counts.reduce((a, b) => a + b, 0)).toBe(groups.length);
    expect(loose!.counts.filter((c) => c === 0).length).toBe(1);
  });

  it("refuses a table too large to be worth solving", () => {
    // A scan that came back without spaces can produce thousands of both, and
    // the table is (tokens x groups) doubles. Per-token phonemization is 1:1 by
    // construction, so it is the right answer here, not a consolation prize.
    const many = Array.from({ length: 3000 }, () => "word");
    expect(alignTokens(many, many.concat(many))).toBeUndefined();
  });
});

describe("§0.3 word grouping survives eSpeak's merges", () => {
  it("returns one non-empty phoneme string per token where words run together", async () => {
    const phonemizer = new EspeakPhonemizer();
    // "that the" and "of the" are the pair eSpeak merges most often, and this
    // sentence used to fall all the way back to per-token phonemization.
    const text = "The record shows that the record of the vote was recorded by a clerk.";
    const tokens = tokensOf(text);
    const words = await phonemizer.phonemize(tokens, []);

    expect(words.length).toBe(tokens.length);
    for (const word of words) {
      expect(word.phonemes.length, JSON.stringify(word.token)).toBeGreaterThan(0);
    }
    // The context-sensitive reading survives for the words around the merge:
    // the noun "record" is stressed on its first syllable, the verb on its
    // second, and both appear here.
    expect(words[1].phonemes).not.toBe(words[10].phonemes);
  }, 60_000);
});

describe("§6.2 chunking", () => {
  it("keeps every chunk inside the budget and every word in exactly one chunk", async () => {
    const phonemizer = new EspeakPhonemizer();
    const chunker = new Chunker();
    const sentence =
      "The comparative study of democratic consolidation requires sustained attention to elite settlements. ";
    const source = normalize([block(sentence.repeat(24).trim())])[0];
    const { chunks } = await chunker.chunk(source, phonemizer);

    expect(chunks.length).toBeGreaterThan(1);
    let words = 0;
    for (const chunk of chunks) {
      expect(chunk.tokens.length).toBeLessThanOrEqual(BUDGET);
      expect(chunk.spanOffset).toBe(words);
      words += chunk.wordPhonemeRanges.length;
    }
    expect(words).toBe(tokensOf(source.spokenText).length);
  }, 120_000);

  it("prefers a sentence end when one is inside the last quarter of the budget", () => {
    // 200 words, each 5 phonemes plus a separating space, so 1200 tokens: three
    // chunks at a target of 400 apiece, with a 100-token backoff window. A
    // sentence ending at word 60 sits 365 tokens in, inside that window.
    const build = (sentenceAt: number) => {
      const tokens: string[] = [];
      const ids: number[] = [];
      const ranges: Array<{ start: number; end: number }> = [];
      for (let i = 0; i < 200; i++) {
        tokens.push(i === sentenceAt ? "settlements." : `word${i}`);
        if (i > 0) ids.push(16);
        const start = ids.length;
        for (let p = 0; p < 5; p++) ids.push(70 + p);
        ranges.push({ start, end: ids.length });
      }
      return { tokens, ids, ranges };
    };

    const withSentence = build(60);
    const chunks = splitChunks("b", withSentence.ids, withSentence.ranges, withSentence.tokens);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].wordPhonemeRanges.length).toBe(61);

    // With no sentence end in range the split falls on a word boundary instead,
    // which is further in — so the backoff really did move it.
    const without = build(-1);
    const plain = splitChunks("b", without.ids, without.ranges, without.tokens);
    expect(plain[0].wordPhonemeRanges.length).toBeGreaterThan(61);

    // Every word still lands in exactly one chunk, in order.
    let seen = 0;
    for (const chunk of chunks) {
      expect(chunk.spanOffset).toBe(seen);
      seen += chunk.wordPhonemeRanges.length;
    }
    expect(seen).toBe(200);
  });

  it("knows an abbreviation from a sentence end", () => {
    expect(isSentenceEnd("Putnam.")).toBe(true);
    expect(isSentenceEnd("holds!")).toBe(true);
    expect(isSentenceEnd("case.”")).toBe(true);
    expect(isSentenceEnd("Vol.")).toBe(false);
    expect(isSentenceEnd("U.S.")).toBe(false);
    expect(isSentenceEnd("J.")).toBe(false);
    expect(isSentenceEnd("elite")).toBe(false);
  });

  it("cuts a single pathological token rather than losing the paragraph", () => {
    const ids = Array.from({ length: 900 }, (_, i) => 70 + (i % 40));
    const chunks = splitChunks("b", ids, [{ start: 0, end: 900 }], ["https://a-very-long-url"]);
    expect(chunks.length).toBe(1);
    expect(chunks[0].tokens.length).toBe(BUDGET);
    expect(chunks[0].wordPhonemeRanges[0].end).toBeLessThanOrEqual(BUDGET);
  });
});

describe("Kokoro text handling", () => {
  it("reads a four-digit year in pairs", () => {
    expect(normalizeText("in 1993 the")).toContain("19 93");
    expect(normalizeText("in 2005 the")).toContain("2005");
  });

  it("keeps punctuation out of the phonemizer and back in the stream", () => {
    const segments = splitOnPunctuation("elite settlements, and the rest.");
    expect(segments.filter((s) => s.isPunctuation).map((s) => s.text)).toEqual([", ", "."]);
  });

  it("maps eSpeak's inventory onto the one Kokoro was trained on", () => {
    // The substitutions are on the phoneme symbols, not on spelling: eSpeak
    // writes the English rhotic as `r` and the velar fricative as `x`, and
    // Kokoro was trained on `ɹ` and `k`. Anything left unmapped is dropped by
    // the vocabulary, which shortens the word and shifts every later duration.
    expect(postProcessPhonemes("rɛst")).toBe("ɹɛst");
    expect(postProcessPhonemes("æxs")).toBe("æks");
    expect(postProcessPhonemes("kʲuː")).toBe("kjuː");
    expect(postProcessPhonemes("ɬiː")).toBe("liː");
  });
});

describe("POS tagging for the override layer", () => {
  it("reads a determiner as making a noun and an infinitive as making a verb", () => {
    expect(tagTokens(["the", "record"])[1]).toBe("noun");
    expect(tagTokens(["to", "record"])[1]).toBe("verb");
    expect(tagTokens(["they", "record"])[1]).toBe("verb");
    expect(tagTokens(["of", "conflict"])[1]).toBe("noun");
  });

  it("falls through to the corpus-dominant noun when it cannot tell", () => {
    expect(homographPhonemes("conflict", "other")).toBe(homographPhonemes("conflict", "noun"));
    // "lead" is settled unconditionally; POS cannot help with it.
    expect(homographPhonemes("lead", "verb")).toBe("lˈid");
  });
});
