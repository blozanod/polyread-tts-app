import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import { tokensOf, violations } from "../src/core/spanInvariant";
import { buildTimeline, StreamLayout } from "../src/synthesis/streamLayout";
import { extractDocument, surveyDocument } from "../src/extraction/documentExtractor";
import type { PdfDocumentProxy, PdfLoadingTask } from "../src/extraction/pdfTypes";
import { EspeakPhonemizer } from "../src/linguistics/espeakPhonemizer";
import { LinguisticsPipeline } from "../src/linguistics/pipeline";
import { defaultVocabulary, framed } from "../src/linguistics/vocabulary";
import { BUDGET } from "../src/linguistics/chunker";
import { DurationWeights, distributeFrames, estimateChunkFrames } from "../src/synthesis/durationEstimator";
import type { ChunkTiming } from "../src/core/types";

/**
 * §13's integration gates 1 and 2, on a document small enough to assert about.
 *
 * "**Integration gate 1:** A → B. Dump `[PhonemizedChunk]`… Verify column order,
 * footnote separation, hyphenation joins, cross-page merges, and that no chunk
 * exceeds 510 phonemes." and "**Integration gate 2:** B → C. Phase A over a full
 * document. Verify total duration is plausible and `[WordTiming]` is monotonic
 * and gap-free."
 *
 * The fixture is a hand-built two-page PDF carrying one of each thing §4 has a
 * rule for: a running head, a folio, a heading, a superscript footnote marker
 * with its small-type body, a word hyphenated across a line break, a §5
 * abbreviation, and a paragraph that runs off the bottom of page one and
 * continues in lowercase at the top of page two.
 */
const fixture = fileURLToPath(new URL("./fixtures/sample.pdf", import.meta.url));

async function open(): Promise<{ document: PdfDocumentProxy; close(): Promise<void> }> {
  const data = new Uint8Array(readFileSync(fixture));
  const task = pdfjs.getDocument({ data }) as unknown as PdfLoadingTask;
  return { document: await task.promise, close: () => task.destroy() };
}

describe("§13 gate 1 — extraction into chunks", () => {
  it("walks a real PDF from bytes to phonemized chunks", async () => {
    const { document, close } = await open();
    const decision = await surveyDocument(document, { allowOcr: false });
    // A born-digital page has a text layer worth using; §4.2 should say so.
    expect(decision.choice).toBe("embedded");

    const extraction = await extractDocument(document, "sample", decision);
    expect(extraction.title).toBe("Elite Settlements");
    expect(extraction.pageCount).toBe(2);
    // §5's invariant survives everything §4 did.
    expect(extraction.invariantViolations).toEqual([]);
    expect(violations(extraction.blocks)).toEqual([]);

    const roles = new Set(extraction.blocks.map((b) => b.role));
    // §4.4 — the repeating head and the bare folio are furniture, not speech.
    expect(roles.has("runningHead")).toBe(true);
    expect(roles.has("pageNumber")).toBe(true);
    // §4.6 — the large short line is a heading.
    expect(roles.has("heading")).toBe(true);
    // §4.5 — the small type at the foot is a footnote body, not body text.
    expect(roles.has("footnoteBody")).toBe(true);

    const spoken = extraction.blocks
      .filter((b) => b.role === "body" || b.role === "heading")
      .map((b) => b.spokenText)
      .join(" ");

    // §4.6 — the hyphen is dropped and the halves joined into one token.
    expect(spoken).toContain("institutional");
    expect(spoken).not.toContain("insti-");
    // §4.6 — the paragraph that ran off page one continues on page two.
    expect(spoken).toContain("continues without any terminal punctuation at all here onto the second page");
    // §4.4 — furniture never reaches the spoken stream.
    expect(spoken).not.toContain("World Politics");
    expect(spoken).not.toContain("417");

    const linguistics = new LinguisticsPipeline(new EspeakPhonemizer());
    const analysed = await linguistics.run(extraction.blocks);

    // §5's table ran.
    const normalized = analysed.blocks.map((b) => b.spokenText).join(" ");
    expect(normalized).toContain("for example");
    expect(normalized).toContain("pages 12 to 19");
    expect(normalized).toContain("compare Tocqueville");

    // §6.2 — no chunk over the budget, and the footnote body kept out of the
    // main stream but still chunked, per §4.5.
    expect(analysed.mainChunks.length).toBeGreaterThan(0);
    for (const chunk of analysed.mainChunks) expect(chunk.tokens.length).toBeLessThanOrEqual(BUDGET);
    expect(Object.keys(analysed.footnoteChunks).length).toBeGreaterThan(0);

    // Every phoneme the phonemizer produced is in the vocabulary. An unknown one
    // is dropped silently and shifts every duration after it.
    expect(analysed.unknownSymbols).toEqual({});

    // §10 — every token's reflow range slices its own text back out.
    for (const block of analysed.blocks) {
      const tokens = tokensOf(block.spokenText);
      expect(block.spans.length).toBe(tokens.length);
      block.spans.forEach((span, i) => {
        const { location, length } = span.reflowRange;
        expect(analysed.reflow.text.slice(location, location + length)).toBe(tokens[i]);
      });
    }

    // §4.5 — the marker survived into the reflow view, where §8.5's tap lives.
    expect(analysed.reflow.markers.length).toBeGreaterThan(0);
    expect(analysed.reflow.markers[0].footnoteBodyID).toBeDefined();

    await close();
  }, 120_000);
});

describe("§13 gate 2 — Phase A over the document", () => {
  it("produces a monotonic, gap-free timeline of a plausible length", async () => {
    const { document, close } = await open();
    const decision = await surveyDocument(document, { allowOcr: false });
    const extraction = await extractDocument(document, "sample", decision);
    const analysed = await new LinguisticsPipeline(new EspeakPhonemizer()).run(extraction.blocks);

    // No model here, so this is the estimated tier — which is exactly the path
    // that needs checking, because the exact one is the model's arithmetic.
    const weights = new DurationWeights(defaultVocabulary);
    const timings = new Map<string, ChunkTiming>();
    for (const chunk of [...analysed.mainChunks, ...Object.values(analysed.footnoteChunks).flat()]) {
      const tokens = framed(chunk.tokens);
      timings.set(chunk.id, {
        chunkID: chunk.id,
        frameDurations: distributeFrames(tokens, estimateChunkFrames(tokens, weights), weights),
        source: "estimated",
      });
    }

    const layout = new StreamLayout(analysed.mainChunks, timings, analysed.blocks);
    const words = buildTimeline(layout, timings, analysed.blocks);

    const spokenTokens = analysed.blocks
      .filter((b) => b.role === "body" || b.role === "heading" || b.role === "caption")
      .reduce((n, b) => n + tokensOf(b.spokenText).length, 0);
    expect(words.length).toBe(spokenTokens);

    for (let i = 1; i < words.length; i++) {
      expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start);
      expect(words[i].end).toBeGreaterThanOrEqual(words[i].start);
      // Gap-free: the next word starts no later than a paragraph pause after
      // this one ends.
      expect(words[i].start - words[i - 1].end).toBeLessThanOrEqual(0.5);
    }

    // Plausible: read English runs about 2.5 words a second.
    const perSecond = words.length / layout.duration;
    expect(perSecond).toBeGreaterThan(1);
    expect(perSecond).toBeLessThan(6);

    // §7.3's chunk offsets cover the whole stream with no holes.
    const offsets = layout.chunkFrameOffsets;
    expect(offsets.length).toBe(analysed.mainChunks.length + 1);
    expect(offsets[0]).toBe(0);
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBeGreaterThan(offsets[i - 1]);
    expect(offsets[offsets.length - 1]).toBe(layout.totalFrames);

    await close();
  }, 120_000);
});
