import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pdfAssetOptions } from "../src/extraction/pdfAssets";
import { newID, textRange, type Block, type PhonemizedChunk, type SourceSpan, type TextRun } from "../src/core/types";
import { rect } from "../src/core/geometry";
import { readingOrderCompare } from "../src/core/reflow";
import { groupIntoLines, lineBaseline, lineText, orderRuns } from "../src/extraction/pageLayout";
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
 * `onnxruntime-web` is 26 MB of WebAssembly and a few hundred kilobytes of
 * JavaScript, and it belongs entirely to the pipeline worker. A single *value*
 * imported from `kokoroEngine.ts` into anything the UI loads pulls the whole
 * runtime onto the main thread — silently, as a bigger first paint rather than
 * as an error.
 */
describe("main-thread bundle", () => {
  it("imports the engine into the UI for its types only", () => {
    const ui = join(here, "..", "src", "ui");
    for (const name of readdirSync(ui)) {
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      const source = readFileSync(join(ui, name), "utf8");
      for (const line of source.split("\n")) {
        if (!/from\s+["'][^"']*synthesis\/kokoroEngine["']/.test(line)) continue;
        expect(line, `${name}: ${line.trim()}`).toMatch(/^import type |\{\s*type /);
      }
    }
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
    const coordinator = new SynthesisCoordinator({
      initialAudioLead: 1,
      onAudio: () => undefined,
    });
    coordinator.attachEngine(engine);

    await coordinator.runPhaseA(chunks, {}, blocks, () => undefined);

    // Phase B starts on chunk 0; the starved playhead asks for the same one
    // before it has landed.
    const phaseB = coordinator.startPhaseB(() => undefined);
    await coordinator.renderOnDemand(0, () => undefined);
    await phaseB;

    expect(renders()).toBe(chunks.length);
  });

  /** An engine with §7.2's exact tier, so refinement has something to do. */
  function engineWithDurationModel(options: { failRenders?: number } = {}): {
    engine: KokoroEngine;
    durationCalls: () => number;
    renders: () => number;
  } {
    let durationCalls = 0;
    let renders = 0;
    const engine = {
      hasDurationModel: true,
      timingSource: "model" as const,
      durations: (chunk: PhonemizedChunk) => {
        durationCalls += 1;
        return Promise.resolve({
          chunkID: chunk.id,
          // Deliberately unlike the estimate, so a committed timing is visible.
          frameDurations: chunk.tokens.map(() => 7).concat([7, 7]),
          source: "model" as const,
        });
      },
      render: async (chunk: PhonemizedChunk) => {
        renders += 1;
        if (renders <= (options.failRenders ?? 0)) throw new Error("OrtRun failed");
        await new Promise((resolve) => setTimeout(resolve, 1));
        return {
          samples: new Float32Array(600 * 7 * (chunk.tokens.length + 2)),
          timing: {
            chunkID: chunk.id,
            frameDurations: chunk.tokens.map(() => 7).concat([7, 7]),
            source: "model" as const,
          },
        };
      },
    };
    return {
      engine: engine as unknown as KokoroEngine,
      durationCalls: () => durationCalls,
      renders: () => renders,
    };
  }

  it("opens the reader without waiting for the duration model", async () => {
    const blocks = Array.from({ length: 40 }, (_, i) => blockOf(`block ${i} one two three`));
    const chunks = blocks.map(chunkFor);
    const { engine, durationCalls } = engineWithDurationModel();
    const coordinator = new SynthesisCoordinator({
      initialAudioLead: 1,
      onAudio: () => undefined,
    });

    // §7.2 used to run the duration model over every chunk before anything
    // reached the screen, which on the CPU backend was minutes of loading bar.
    const phaseA = await coordinator.runPhaseA(chunks, {}, blocks, () => undefined);
    expect(durationCalls()).toBe(0);
    expect(phaseA.timingSource).toBe("estimated");
    expect(phaseA.words.length).toBe(blocks.length * 5);
    expect(phaseA.duration).toBeGreaterThan(0);

    // The exact pass then runs behind the reader and firms the timeline up.
    coordinator.attachEngine(engine);
    await coordinator.startPhaseB(() => undefined);
    expect(durationCalls()).toBeGreaterThan(0);
    expect(coordinator.timingSource).toBe("model");
  });

  it("keeps the exact duration pass ahead of the audio", async () => {
    const blocks = Array.from({ length: 12 }, (_, i) => blockOf(`block ${i} one two three`));
    const chunks = blocks.map(chunkFor);
    const { engine, durationCalls } = engineWithDurationModel();
    const coordinator = new SynthesisCoordinator({
      initialAudioLead: 1,
      onAudio: () => undefined,
    });
    await coordinator.runPhaseA(chunks, {}, blocks, () => undefined);
    coordinator.attachEngine(engine);

    let renderedSoFar = 0;
    const seen: Array<{ rendered: number; timed: number }> = [];
    await coordinator.startPhaseB((event) => {
      if (event.type !== "rendered") return;
      renderedSoFar += 1;
      seen.push({ rendered: renderedSoFar, timed: durationCalls() });
    });

    // Every chunk is timed before its audio is made, which is the whole point
    // of §7.2 — a correct scrubber and seek ahead of the buffer edge.
    for (const point of seen) expect(point.timed).toBeGreaterThanOrEqual(point.rendered);
    expect(durationCalls()).toBe(chunks.length);
  });

  it("survives one chunk the model chokes on, and stops after a run of them", async () => {
    const blocks = Array.from({ length: 6 }, (_, i) => blockOf(`block ${i} one two three`));
    const chunks = blocks.map(chunkFor);

    // One failure is a hole in the audio, not the end of the document. Phase B
    // used to abandon the whole document on the first `OrtRun` error, which is
    // how a GPU that could not compile one shader turned into a transport bar
    // waiting forever for a chunk nobody was still rendering.
    const single = engineWithDurationModel({ failRenders: 1 });
    const survivor = new SynthesisCoordinator({ initialAudioLead: 1, onAudio: () => undefined });
    await survivor.runPhaseA(chunks, {}, blocks, () => undefined);
    survivor.attachEngine(single.engine);
    let failures = 0;
    await survivor.startPhaseB((event) => {
      if (event.type === "failed") failures += 1;
    });
    expect(failures).toBe(0);
    expect(survivor.progress.renderedChunks.size).toBe(chunks.length - 1);

    const broken = engineWithDurationModel({ failRenders: 99 });
    const doomed = new SynthesisCoordinator({ initialAudioLead: 1, onAudio: () => undefined });
    await doomed.runPhaseA(chunks, {}, blocks, () => undefined);
    doomed.attachEngine(broken.engine);
    const messages: string[] = [];
    await doomed.startPhaseB((event) => {
      if (event.type === "failed") messages.push(event.message);
    });
    expect(messages.length).toBe(1);
    expect(broken.renders()).toBe(3);
  });

  it("re-anchors a reopened timeline to the audio already on disk", async () => {
    const blocks = Array.from({ length: 4 }, (_, i) => blockOf(`block ${i} one two three`));
    const chunks = blocks.map(chunkFor);
    const coordinator = new SynthesisCoordinator({ initialAudioLead: 1, onAudio: () => undefined });
    const phaseA = await coordinator.runPhaseA(chunks, {}, blocks, () => undefined);

    // Chunk 0's audio is on disk and is twice as long as Phase A guessed. The
    // sidecar used to replay the guess, so every later chunk played from the
    // wrong offset and the highlight drifted by the difference — for the whole
    // document, on every reopen.
    const guessed = phaseA.chunkFrameOffsets[1];
    coordinator.adoptRendered([0], new Map([[0, guessed * 2]]));

    const timeline = coordinator.snapshot();
    expect(timeline.chunkFrameOffsets[1]).toBeGreaterThan(guessed);
    expect(timeline.duration).toBeGreaterThan(phaseA.duration);
    // The words move with the offsets rather than staying on Phase A's guess.
    const firstOfSecondBlock = timeline.words.findIndex((w) => w.blockID === blocks[1].id);
    expect(timeline.words[firstOfSecondBlock].start).toBeGreaterThan(
      phaseA.words[firstOfSecondBlock].start,
    );
  });

  it("does not re-render a chunk that is already on disk", async () => {
    const blocks = [blockOf("one two three"), blockOf("four five six")];
    const chunks = blocks.map(chunkFor);
    const { engine, renders } = slowEngine();
    const coordinator = new SynthesisCoordinator({
      initialAudioLead: 1,
      onAudio: () => undefined,
    });
    coordinator.attachEngine(engine);

    await coordinator.runPhaseA(chunks, {}, blocks, () => undefined);
    coordinator.adoptRendered([0]);
    await coordinator.startPhaseB(() => undefined);

    expect(renders()).toBe(chunks.length - 1);
  });
});

/**
 * A JSTOR scan carries a per-word invisible text layer, and OCR gives every
 * word its own baseline. They disagree by a fraction of a point — invisible on
 * the page, and nowhere near enough to put a word on a different line.
 *
 * `groupIntoLines` walks a column in baseline order, so that is the order the
 * runs landed in a `Line`, and nothing put them back. `orderRuns` happened to
 * sort each line's runs by x on its way out, which hid it; but the extractor
 * calls `groupIntoLines` a second time, on those already-ordered runs, and the
 * second pass re-sorted them by baseline and threw the reading order away. What
 * reached the reader was every paragraph with its own words shuffled.
 *
 * It only ever showed on a scan. A born-digital page emits a whole line as one
 * text item, so `splitItemIntoRuns` copies one exact `transform[5]` onto every
 * word of the line, the baselines tie, the sort is stable, and the order
 * survives — which is why the cover page of the same PDF read perfectly and
 * every test here used exactly-equal baselines and passed.
 */
describe("per-word baselines (a scanned text layer)", () => {
  const PAGE_BOX = rect(0, 0, 612, 792);
  const SENTENCE = "Science is the summum bonum of our society and that therefore all";

  /** `wobble` of 0 is one text item per line; anything else is per-word. */
  function scannedPage(wobble: number): TextRun[] {
    const words = SENTENCE.split(" ");
    const runs: TextRun[] = [];
    let index = 0;
    for (let lineIndex = 0; index < words.length; lineIndex++) {
      let x = 72;
      const baseline = 700 - lineIndex * 12;
      for (let k = 0; k < 6 && index < words.length; k++, index++) {
        const text = words[index];
        const width = text.length * 5;
        // Deterministic, sub-point, and well inside the grouping tolerance.
        const noise = wobble * Math.sin(index * 2.399);
        runs.push({
          text,
          bbox: rect(x, baseline + noise - 2, width, 10),
          glyphHeight: 10,
          baseline: baseline + noise,
          pageIndex: 0,
          columnIndex: 0,
          orderIndex: 0,
        });
        x += width + 4;
      }
    }
    return runs;
  }

  it("keeps a line's words in reading order however their baselines tie", () => {
    for (const wobble of [0, 0.05, 0.25, 1]) {
      const lines = groupIntoLines(scannedPage(wobble));
      expect(lines.map(lineText).join(" ")).toBe(SENTENCE);
    }
  });

  it("survives the extractor's second pass over ordered runs", () => {
    for (const wobble of [0, 0.05, 0.25, 1]) {
      // orderRuns, then groupIntoLines again — what extractDocument does.
      const ordered = orderRuns(scannedPage(wobble), PAGE_BOX);
      const lines = groupIntoLines(ordered).sort((a, b) => lineBaseline(b) - lineBaseline(a));
      expect(lines.map(lineText).join(" ")).toBe(SENTENCE);
    }
  });

  /**
   * Both of these compared two positions through a tolerance and fell back to x
   * when they were close, which is not a transitive relation: a≈b and b≈c does
   * not give a≈c, so the comparator contradicts itself and the sort may return
   * anything. V8 switches from insertion sort to TimSort at 22 elements, so it
   * held on small inputs and came apart on a full page.
   */
  it("orders lines and markers with transitive comparators", () => {
    const spanAt = (y: number, x: number): SourceSpan => ({
      pageIndex: 0,
      bboxes: [rect(x, y, 6, 6)],
      reflowRange: textRange(0, 0),
    });
    // A chain that steps by less than the old tolerance at every step but
    // spans several lines end to end.
    const spans = Array.from({ length: 40 }, (_, i) => spanAt(700 - i * 2, 500 - i * 10));
    for (const a of spans) {
      for (const b of spans) {
        for (const c of spans) {
          const ab = Math.sign(readingOrderCompare(a, b));
          const bc = Math.sign(readingOrderCompare(b, c));
          if (ab < 0 && bc < 0) expect(Math.sign(readingOrderCompare(a, c))).toBeLessThan(0);
          if (ab === 0 && bc === 0) expect(Math.sign(readingOrderCompare(a, c))).toBe(0);
        }
      }
    }
  });
});
