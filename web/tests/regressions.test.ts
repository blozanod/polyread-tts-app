import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pdfAssetOptions } from "../src/extraction/pdfAssets";
import { newID, textRange, type Block, type PhonemizedChunk } from "../src/core/types";
import { tokensOf } from "../src/core/spanInvariant";
import { SynthesisCoordinator } from "../src/synthesis/coordinator";
import type { KokoroEngine } from "../src/synthesis/kokoroEngine";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * pdf.js 6 decodes JBIG2 — every library scan — in WebAssembly fetched from
 * `wasmUrl`, and when that is not given it does not throw. It warns to the
 * console, skips the image, and returns a page carrying only its text layer.
 * The reader showed blank white paper and nothing anywhere said why.
 *
 * The three other asset roots have the same shape and the same failure mode, so
 * the contract worth pinning is that all four are handed over and are absolute.
 */
describe("pdf.js runtime assets", () => {
  it("names every asset root pdf.js loads at runtime", () => {
    const options = pdfAssetOptions("https://example.test/app/pdfjs/");
    expect(options).toEqual({
      wasmUrl: "https://example.test/app/pdfjs/wasm/",
      cMapUrl: "https://example.test/app/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "https://example.test/app/pdfjs/standard_fonts/",
      iccUrl: "https://example.test/app/pdfjs/iccs/",
      // pdf.js 6.3 reads a bare `document.baseURI` when it has to work this
      // out itself, and there is no `document` in the pipeline worker.
      useWorkerFetch: true,
    });
  });

  it("tolerates a base without its trailing slash", () => {
    expect(pdfAssetOptions("pdfjs").wasmUrl).toBe("pdfjs/wasm/");
  });

  it("points at directories that exist in the installed pdfjs-dist", () => {
    // The vite plugin copies these four out of the package. If a pdf.js upgrade
    // moves or renames one, the copy silently produces nothing and the app goes
    // back to rendering scans as blank paper — with no error anywhere.
    const root = join(here, "..", "node_modules", "pdfjs-dist");
    for (const directory of ["wasm", "cmaps", "standard_fonts", "iccs"]) {
      expect(readdirSync(join(root, directory)).length, directory).toBeGreaterThan(0);
    }
    // The JBIG2 codec by name: it is the one every library scan needs.
    expect(readFileSync(join(root, "wasm", "jbig2.wasm")).byteLength).toBeGreaterThan(0);
  });

  it("keeps the text layer of the sample PDF readable", async () => {
    // Without `standardFontDataUrl` the base-14 substitutes never load and
    // extracted text comes back clipped mid-word.
    const data = new Uint8Array(readFileSync(join(here, "fixtures", "sample.pdf")));
    const task = pdfjs.getDocument({
      data,
      ...pdfAssetOptions(new URL("../node_modules/pdfjs-dist/", import.meta.url).href),
    });
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    expect(content.items.length).toBeGreaterThan(0);
    await task.destroy();
  });
});

/**
 * Pressing play on a fresh document starves on chunk 0 at the same moment Phase
 * B is rendering chunk 0. Both paths used to call the engine, so the one chunk
 * the listener was actually waiting for was rendered twice.
 */
describe("§7.3 render scheduling", () => {
  function chunkFor(source: Block): PhonemizedChunk {
    const words = tokensOf(source.spokenText);
    const tokens: number[] = [];
    const wordPhonemeRanges = [];
    for (let i = 0; i < words.length; i++) {
      if (i > 0) tokens.push(16);
      const start = tokens.length;
      for (let p = 0; p < 5; p++) tokens.push(70 + p);
      wordPhonemeRanges.push({ start, end: tokens.length });
    }
    return { id: newID(), blockID: source.id, tokens, wordPhonemeRanges, spanOffset: 0 };
  }

  function blockOf(text: string): Block {
    return {
      id: newID(),
      role: "body",
      spokenText: text,
      spans: tokensOf(text).map(() => ({
        pageIndex: 0,
        bboxes: [],
        reflowRange: textRange(0, 0),
      })),
      footnoteBodyIDs: [],
    };
  }

  /** An engine whose renders take a turn to resolve, so they can overlap. */
  function slowEngine(): { engine: KokoroEngine; renders: () => number } {
    let renders = 0;
    const engine = {
      timingSource: "estimated" as const,
      durations: (chunk: PhonemizedChunk) =>
        Promise.resolve({
          chunkID: chunk.id,
          frameDurations: chunk.tokens.map(() => 2).concat([2, 2]),
          source: "estimated" as const,
        }),
      render: async (chunk: PhonemizedChunk) => {
        renders += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          samples: new Float32Array(2400),
          timing: {
            chunkID: chunk.id,
            frameDurations: chunk.tokens.map(() => 2).concat([2, 2]),
            source: "estimated" as const,
          },
        };
      },
    };
    return { engine: engine as unknown as KokoroEngine, renders: () => renders };
  }

  it("renders a chunk once when Phase B and an on-demand request collide", async () => {
    const blocks = [blockOf("one two three"), blockOf("four five six")];
    const chunks = blocks.map(chunkFor);
    const { engine, renders } = slowEngine();
    const coordinator = new SynthesisCoordinator(engine, {
      initialAudioLead: 1,
      onAudio: () => undefined,
    });

    await coordinator.runPhaseA(chunks, {}, blocks, () => undefined);

    // Phase B starts on chunk 0; the starved playhead asks for the same one
    // before it has landed.
    const phaseB = coordinator.startPhaseB(() => undefined);
    await coordinator.renderOnDemand(0, () => undefined);
    await phaseB;

    expect(renders()).toBe(chunks.length);
  });

  it("does not re-render a chunk that is already on disk", async () => {
    const blocks = [blockOf("one two three"), blockOf("four five six")];
    const chunks = blocks.map(chunkFor);
    const { engine, renders } = slowEngine();
    const coordinator = new SynthesisCoordinator(engine, {
      initialAudioLead: 1,
      onAudio: () => undefined,
    });

    await coordinator.runPhaseA(chunks, {}, blocks, () => undefined);
    coordinator.adoptRendered([0]);
    await coordinator.startPhaseB(() => undefined);

    expect(renders()).toBe(chunks.length - 1);
  });
});
