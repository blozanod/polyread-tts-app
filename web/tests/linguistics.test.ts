import { describe, expect, it } from "vitest";
import { tokensOf } from "../src/core/spanInvariant";
import { newID, textRange, type Block } from "../src/core/types";
import { BUDGET, Chunker, isSentenceEnd, MIN_CHUNK, splitChunks, TARGET } from "../src/linguistics/chunker";
import {
  alignContextual,
  divideGroup,
  EspeakPhonemizer,
  opensLike,
  passages,
} from "../src/linguistics/espeakPhonemizer";
import { unencodableEntries, homographPhonemes } from "../src/linguistics/homographs";
import { normalizeText, postProcessPhonemes, splitOnPunctuation } from "../src/linguistics/kokoroText";
import { affixes, normalize } from "../src/linguistics/normalizer";
import { tagTokens } from "../src/linguistics/posTagger";
import { LinguisticsPipeline } from "../src/linguistics/pipeline";
import { PhonemizerPool, poolSize, type PoolWorker } from "../src/linguistics/phonemizerPool";
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
  it("assigns the expanded groups of a number to the number", () => {
    const tokens = ["in", "1993", "the", "assembly"];
    const groups = ["ɪn", "nˈaɪntiːn", "nˈaɪndi", "θɹˈiː", "ðɪ", "ɐsˈɛmbli"];
    const aligned = alignContextual(tokens, groups);
    expect(aligned?.map((w) => w.phonemes)).toEqual(["ɪn", "nˈaɪntiːn nˈaɪndi θɹˈiː", "ðɪ", "ɐsˈɛmbli"]);
  });

  it("gives a punctuation-only token no phonemes and keeps the dash in the stream", () => {
    const aligned = alignContextual(["elite", "—", "mass"], ["ɪlˈiːt", "—", "mˈæs"]);
    expect(aligned?.map((w) => w.phonemes)).toEqual(["ɪlˈiːt", "—", "mˈæs"]);
    const bare = alignContextual(["—", "elite"], ["ɪlˈiːt"]);
    expect(bare?.map((w) => w.phonemes)).toEqual(["", "ɪlˈiːt"]);
  });

  it("divides a weld between the words that share it instead of re-reading them", () => {
    // eSpeak runs short function words into one group: "of the" is a single
    // `ʌvðə`. The old repair re-phonemized the pair in isolation — a stressed
    // citation "the" — and as often as not kept the weld as well, so the pair
    // was spoken twice. The group now stays exactly as eSpeak wrote it.
    const tokens = ["the", "vote", "of", "the", "assembly"];
    const groups = ["ðə", "vˈoʊt", "ʌvðə", "ɐsˈɛmbli"];
    const aligned = alignContextual(tokens, groups)!;
    expect(aligned.map((w) => w.phonemes)).toEqual(["ðə", "vˈoʊt", "ʌv", "ðə", "ɐsˈɛmbli"]);
    expect(aligned.map((w) => w.joined)).toEqual([false, false, false, true, false]);
  });

  it("puts the weld on the function words, not on the noun beside them", () => {
    // "of a coalition" comes back as `əvə kˌoʊəlˈɪʃən`. By length alone,
    // "of" + `əvə` and "a coalition" sharing a group is as good an answer.
    const aligned = alignContextual(["of", "a", "coalition"], ["əvə", "kˌoʊəlˈɪʃən"])!;
    expect(aligned.map((w) => w.phonemes)).toEqual(["əv", "ə", "kˌoʊəlˈɪʃən"]);
  });

  it("does not let a word be shifted onto its neighbour's sound", () => {
    // "(Putnam 1993, 45); pages 12 to 19" — when "45" took one group too few,
    // every word after it slid one place and still scored well on length.
    const tokens = ["45);", "pages", "12", "to", "19"];
    const groups = ["fˈoːɹɾi", "fˈaɪv»;", "pˈeɪdʒᵻz", "twˈɛlv", "tə", "nˈaɪntiːn"];
    const aligned = alignContextual(tokens, groups)!;
    expect(aligned.map((w) => w.phonemes)).toEqual(["fˈoːɹɾi fˈaɪv»;", "pˈeɪdʒᵻz", "twˈɛlv", "tə", "nˈaɪntiːn"]);
    expect(opensLike("pages", "fˈaɪv")).toBe(false);
    expect(opensLike("phase", "fˈeɪz")).toBe(true);
  });

  it("never changes a symbol when it divides a group", () => {
    for (const [group, tokens] of [
      ["ʌvðə", ["of", "the"]],
      ["ðætðə", ["that", "the"]],
      ["nˌɑːɾə", ["not", "a"]],
      ["ɪnwˌɪtʃ", ["in", "which"]],
      ["ə", ["a", "the", "of"]],
    ] as Array<[string, string[]]>) {
      const parts = divideGroup(group, tokens);
      expect(parts.length).toBe(tokens.length);
      expect(parts.join("")).toBe(group);
    }
    // A stress mark goes with the syllable after it, a length mark with the
    // vowel before it.
    expect(divideGroup("ɪnwˌɪtʃ", ["in", "which"])).toEqual(["ɪn", "wˌɪtʃ"]);
  });

  it("cuts long blocks into passages at sentence ends", () => {
    const tokens = Array.from({ length: 300 }, (_, i) => (i % 25 === 24 ? "end." : "word"));
    const cuts = passages(tokens, 120);
    expect(cuts[0][0]).toBe(0);
    expect(cuts[cuts.length - 1][1]).toBe(300);
    for (const [from, to] of cuts) {
      expect(to - from).toBeLessThanOrEqual(120);
      if (to < 300) expect(tokens[to - 1]).toBe("end.");
    }
  });
});

describe("§0.3 word grouping survives eSpeak's merges", () => {
  it("feeds the voice the contextual stream, not word-by-word readings", async () => {
    const phonemizer = new EspeakPhonemizer();
    // "that the" and "of the" are the pairs eSpeak merges most often, and this
    // sentence used to go through the per-token path.
    const text = "The record shows that the record of the vote was recorded by a clerk.";
    const tokens = tokensOf(text);
    const words = await phonemizer.phonemize(tokens, []);

    expect(words.length).toBe(tokens.length);
    expect(phonemizer.isolatedPassages).toBe(0);
    // The weak forms survive: "a" is a schwa, not the letter A, and "the" is
    // unstressed.
    expect(words[13].phonemes).not.toContain("eɪ");
    for (const index of [4, 7]) expect(words[index].phonemes).not.toMatch(/[ˈˌ]/u);
    // The noun "record" is stressed on its first syllable, the verb on its
    // second, and both appear here.
    expect(words[1].phonemes).not.toBe(words[10].phonemes);
    // No word was spoken twice.
    const stream = words.map((w) => (w.joined ? "" : " ") + w.phonemes).join("");
    expect(stream.match(/ðə/gu)?.length).toBe(3);
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

  /** `count` words of five phonemes each, a space between, sentence ends where asked. */
  const build = (count: number, sentenceEvery: number) => {
    const tokens: string[] = [];
    const ids: number[] = [];
    const ranges: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < count; i++) {
      tokens.push(sentenceEvery > 0 && i % sentenceEvery === sentenceEvery - 1 ? "settlements." : `word${i}`);
      if (i > 0) ids.push(16);
      const start = ids.length;
      for (let p = 0; p < 5; p++) ids.push(70 + p);
      ranges.push({ start, end: ids.length });
    }
    return { tokens, ids, ranges };
  };

  it("cuts only at sentence ends, and packs sentences up to the target", () => {
    // Sentences of 12 words, 71 tokens each: three fit under the target.
    const text = build(120, 12);
    const chunks = splitChunks("b", text.ids, text.ranges, text.tokens);
    expect(chunks.length).toBeGreaterThan(1);
    let seen = 0;
    for (const chunk of chunks) {
      expect(chunk.spanOffset).toBe(seen);
      seen += chunk.wordPhonemeRanges.length;
      expect(text.tokens[seen - 1]).toBe("settlements.");
      expect(chunk.tokens.length).toBeLessThanOrEqual(TARGET);
    }
    expect(seen).toBe(120);
  });

  it("keeps a paragraph of a sentence or two in one chunk", () => {
    const text = build(30, 15);
    expect(splitChunks("b", text.ids, text.ranges, text.tokens).length).toBe(1);
  });

  it("does not leave a short sentence on its own", () => {
    // Four sentences of 12 words, then one of 3: the last rides along.
    const tokens = [...build(48, 12).tokens, "it", "really", "was."];
    const text = build(51, 0);
    const chunks = splitChunks("b", text.ids, text.ranges, tokens);
    for (const chunk of chunks) expect(chunk.tokens.length).toBeGreaterThanOrEqual(MIN_CHUNK);
  });

  it("divides a sentence too long to render well, evenly and within the budget", () => {
    const text = build(200, 0);
    const chunks = splitChunks("b", text.ids, text.ranges, text.tokens);
    expect(chunks.length).toBeGreaterThan(1);
    const sizes = chunks.map((c) => c.tokens.length);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(BUDGET);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(80);
  });

  it("never separates two words eSpeak welded together", () => {
    const text = build(200, 0);
    // Every other word is welded to the one before it.
    const joined = text.tokens.map((_, i) => i % 2 === 1);
    const chunks = splitChunks("b", text.ids, text.ranges, text.tokens, joined);
    for (const chunk of chunks) expect(chunk.spanOffset % 2).toBe(0);
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

  it("encodes a weld without a space and a silent token without two", async () => {
    const chunker = new Chunker();
    const fake = {
      name: "fake",
      capabilities: { providesWordGrouping: true, resolvesHomographs: true, expandsNumbers: true },
      phonemize: async (tokens: readonly string[]) =>
        tokens.map((token) => ({
          token,
          phonemes: token === "—" ? "" : token === "the" ? "ðə" : "ʌv",
          joined: token === "the",
        })),
    };
    const { chunks } = await chunker.chunk(block("of the — of"), fake);
    const space = defaultVocabulary.spaceID!;
    const ids = chunks[0].tokens;
    // ʌv ðə ␠ ʌv — one space, between the weld and the last word.
    expect(ids.filter((id) => id === space).length).toBe(1);
    expect(chunks[0].wordPhonemeRanges[2].start).toBe(chunks[0].wordPhonemeRanges[2].end);
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

describe("eSpeak on a pool of workers", () => {
  /** A worker that runs the phonemizer in-process, or misbehaves on request. */
  function fakeWorker(behaviour: "ok" | "errors" | "dies" = "ok"): PoolWorker {
    const local = new EspeakPhonemizer();
    const worker: PoolWorker = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        setTimeout(async () => {
          if (behaviour === "dies") {
            worker.onerror?.({} as ErrorEvent);
            return;
          }
          if (behaviour === "errors") {
            worker.onmessage?.({ data: { id: message.id, error: "boom" } } as MessageEvent);
            return;
          }
          const words = await local.phonemize(message.tokens, []);
          worker.onmessage?.({ data: { id: message.id, words, isolatedPassages: 0 } } as MessageEvent);
        }, Math.random() * 5);
      },
      terminate() {},
    };
    return worker;
  }

  it("gives the same chunks as one thread, in document order", async () => {
    const blocks = Array.from({ length: 12 }, (_, i) =>
      block(`Paragraph ${i} of the record shows that the vote of the assembly was recorded.`),
    );
    const single = await new LinguisticsPipeline().run(blocks);
    const pool = new PhonemizerPool("a", 3, () => fakeWorker());
    const pooled = await new LinguisticsPipeline(pool, undefined, { concurrency: 6 }).run(blocks);
    pool.dispose();
    expect(pooled.mainChunks.map((c) => c.tokens)).toEqual(single.mainChunks.map((c) => c.tokens));
    expect(pooled.mainChunks.map((c) => c.blockID)).toEqual(single.mainChunks.map((c) => c.blockID));
  }, 60_000);

  it("redoes on this thread whatever a worker could not do", async () => {
    const tokens = tokensOf("the record of the vote");
    const expected = await new EspeakPhonemizer().phonemize(tokens, []);
    for (const behaviour of ["errors", "dies"] as const) {
      const pool = new PhonemizerPool("a", 2, () => fakeWorker(behaviour));
      expect(await pool.phonemize(tokens, [])).toEqual(expected);
      pool.dispose();
    }
  }, 60_000);

  it("sizes itself to leave a core free", () => {
    expect(poolSize(1)).toBe(1);
    expect(poolSize(4)).toBe(3);
    expect(poolSize(16)).toBe(4);
  });
});
