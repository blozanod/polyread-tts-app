import { describe, expect, it } from "vitest";
import { secondsFromFrames } from "../src/core/frameMath";
import { tokensOf } from "../src/core/spanInvariant";
import { newID, textRange, type Block, type ChunkTiming, type PhonemizedChunk } from "../src/core/types";
import { defaultVocabulary } from "../src/linguistics/vocabulary";
import {
  Calibration,
  distributeFrames,
  DurationWeights,
  estimateChunkFrames,
  framesFromBoundaries,
  snapBoundariesToEnergy,
} from "../src/synthesis/durationEstimator";
import { buildTimeline, silenceFramesBetween, StreamLayout } from "../src/synthesis/streamLayout";
import { toFloat32, toInt16 } from "../src/synthesis/store";
import { Voice, VOICE_DIMENSION, VOICE_ROWS } from "../src/synthesis/voices";
import { VoicesBin } from "../src/synthesis/voicesBin";

function block(text: string, role: Block["role"] = "body"): Block {
  const tokens = tokensOf(text);
  return {
    id: newID(),
    role,
    spokenText: text,
    spans: tokens.map(() => ({ pageIndex: 0, bboxes: [], reflowRange: textRange(0, 0) })),
    footnoteBodyIDs: [],
  };
}

/** One chunk covering a whole block, five phonemes a word. */
function chunkFor(source: Block): { chunk: PhonemizedChunk; timing: ChunkTiming } {
  const words = tokensOf(source.spokenText);
  const tokens: number[] = [];
  const ranges = [];
  for (let i = 0; i < words.length; i++) {
    if (i > 0) tokens.push(16);
    const start = tokens.length;
    for (let p = 0; p < 5; p++) tokens.push(70 + p);
    ranges.push({ start, end: tokens.length });
  }
  const chunk: PhonemizedChunk = {
    id: newID(),
    blockID: source.id,
    tokens,
    wordPhonemeRanges: ranges,
    spanOffset: 0,
  };
  // The framed sequence is two longer than `tokens`; every entry gets 2 frames.
  return {
    chunk,
    timing: {
      chunkID: chunk.id,
      frameDurations: new Array(tokens.length + 2).fill(2),
      source: "model",
    },
  };
}

describe("§5 / §4.6 inter-chunk silence", () => {
  it("gives a heading 400 ms on each side and chunks inside a block none", () => {
    const body = block("one two", "body");
    const heading = block("A Heading", "heading");
    expect(silenceFramesBetween(undefined, body)).toBe(0);
    expect(silenceFramesBetween(body, body)).toBe(0);
    expect(silenceFramesBetween(body, heading)).toBe(16);
    expect(silenceFramesBetween(heading, body)).toBe(16);
    const other = block("another", "body");
    expect(silenceFramesBetween(body, other)).toBe(16);
  });
});

describe("§7.2 Phase A timeline", () => {
  const first = block("alpha beta gamma");
  const second = block("delta epsilon");
  const a = chunkFor(first);
  const b = chunkFor(second);
  const timings = new Map([
    [a.chunk.id, a.timing],
    [b.chunk.id, b.timing],
  ]);
  const layout = new StreamLayout([a.chunk, b.chunk], timings, [first, second]);

  it("accounts for the silence Phase B will write, not just the audio", () => {
    // Chunk A: 3 words -> 17 tokens -> 19 framed -> 38 frames.
    expect(layout.entries[0].startFrame).toBe(0);
    expect(layout.entries[0].frameCount).toBe(38);
    // §5's paragraph pause sits between them, and the offsets carry it.
    expect(layout.entries[1].leadingSilenceFrames).toBe(16);
    expect(layout.entries[1].startFrame).toBe(38 + 16);
    // Chunk B: 2 words -> 11 tokens -> 13 framed -> 26 frames.
    expect(layout.entries[1].frameCount).toBe(26);
    expect(layout.chunkFrameOffsets).toEqual([0, 38, 38 + 16 + 26]);
  });

  it("produces a monotonic, gap-free timeline with one entry per spoken word", () => {
    const words = buildTimeline(layout, timings, [first, second]);
    expect(words.length).toBe(5);
    for (let i = 1; i < words.length; i++) {
      expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start);
      expect(words[i].end).toBeGreaterThanOrEqual(words[i].start);
    }
    // The first word starts at the very beginning, past the boundary token.
    expect(words[0].start).toBeCloseTo(secondsFromFrames(2), 10);
    expect(words[3].blockID).toBe(second.id);
  });

  it("moves only the tail when an estimated chunk commits its real length", () => {
    // Without a duration model Phase A's frame counts are guesses, and a chunk's
    // true length only arrives when Phase B renders it.
    const guessed = new Map<string, ChunkTiming>([
      [a.chunk.id, { ...a.timing, source: "estimated" }],
      [b.chunk.id, { ...b.timing, source: "estimated" }],
    ]);
    const estimated = new StreamLayout([a.chunk, b.chunk], guessed, [first, second]);
    expect(estimated.isExact).toBe(false);

    const before = estimated.entries[1].startFrame;
    expect(estimated.commit(0, 50)).toBe(true);
    // The chunk that just committed has not moved — the playhead is in it.
    expect(estimated.entries[0].startFrame).toBe(0);
    // Only what is ahead of it does.
    expect(estimated.entries[1].startFrame).toBe(before + 12);

    // Committing the same value again changes nothing.
    expect(estimated.commit(0, 50)).toBe(false);
    expect(estimated.isExact).toBe(false);
    estimated.commit(1, 26);
    expect(estimated.isExact).toBe(true);
  });
});

describe("duration estimation", () => {
  const weights = new DurationWeights(defaultVocabulary);

  it("sums to exactly the total it was given, with no token at zero", () => {
    for (const total of [37, 100, 512, 4321]) {
      const tokens = [0, ...Array.from({ length: 120 }, (_, i) => 60 + (i % 90)), 0];
      const frames = distributeFrames(tokens, total, weights);
      expect(frames.length).toBe(tokens.length);
      expect(frames.reduce((x, y) => x + y, 0)).toBe(Math.max(tokens.length, total));
      expect(Math.min(...frames)).toBeGreaterThanOrEqual(1);
    }
  });

  it("gives a vowel more time than a plosive", () => {
    const vowel = defaultVocabulary.symbolToID.get("ɑ")!;
    const plosive = defaultVocabulary.symbolToID.get("t")!;
    expect(weights.weight(vowel)).toBeGreaterThan(weights.weight(plosive));
    // A full stop buys a real pause, which is what a chunk boundary sounds like.
    expect(weights.weight(defaultVocabulary.symbolToID.get(".")!)).toBeGreaterThan(weights.weight(vowel));
  });

  it("converges on the real rate once a chunk has been rendered", () => {
    const calibration = new Calibration();
    const tokens = Array.from({ length: 200 }, (_, i) => 69 + (i % 80));
    const before = estimateChunkFrames(tokens, weights, calibration);
    // The chunk turns out to be 30% longer than guessed.
    calibration.observe(before, Math.round(before * 1.3));
    const after = estimateChunkFrames(tokens, weights, calibration);
    expect(after).toBeGreaterThan(before);
    expect(after / before).toBeCloseTo(1.3, 1);
  });

  it("snaps a boundary onto a real pause and leaves it alone otherwise", () => {
    // 20 frames of audio: loud everywhere except a silent frame at 10.
    const samples = new Float32Array(20 * 600);
    samples.fill(0.5);
    samples.fill(0, 10 * 600, 11 * 600);

    // An estimate two frames off snaps onto the silence.
    expect(snapBoundariesToEnergy([12], samples)).toEqual([10]);
    // An estimate far away has nothing to snap to and stays put.
    expect(snapBoundariesToEnergy([3], samples)).toEqual([3]);
    // Boundaries stay monotonic.
    const many = snapBoundariesToEnergy([4, 12, 16], samples);
    for (let i = 1; i < many.length; i++) expect(many[i]).toBeGreaterThan(many[i - 1]);
  });

  it("turns boundaries back into durations that still sum to the total", () => {
    const frames = framesFromBoundaries([5, 11, 18], 30);
    expect(frames).toEqual([5, 6, 7, 12]);
    expect(frames.reduce((a, b) => a + b, 0)).toBe(30);
  });
});

describe("§7.1 voices", () => {
  function table(): Float32Array {
    const styles = new Float32Array(VOICE_ROWS * VOICE_DIMENSION);
    for (let row = 0; row < VOICE_ROWS; row++) styles[row * VOICE_DIMENSION] = row;
    return styles;
  }

  it("indexes the style row by phoneme count, clamped at the last row", () => {
    const voice = new Voice("af_test", table());
    expect(voice.style(0)[0]).toBe(0);
    expect(voice.style(137)[0]).toBe(137);
    // §6.2's budget is 510 phonemes, which would index one past the last row.
    expect(voice.style(510)[0]).toBe(VOICE_ROWS - 1);
    expect(voice.style(-3)[0]).toBe(0);
  });

  it("rejects a table that is not 510 x 256", () => {
    expect(() => new Voice("bad", new Float32Array(16))).toThrow(/malformed/i);
  });

  it("reads the packed Voices.bin the iOS build used", () => {
    const count = 2;
    const header = 24;
    const names = count * 24;
    const floats = count * VOICE_ROWS * VOICE_DIMENSION;
    const buffer = new ArrayBuffer(header + names + floats * 4);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    bytes.set(new TextEncoder().encode("AIOSVOX"), 0);
    bytes[7] = 1;
    view.setUint32(8, count, true);
    view.setUint32(12, VOICE_ROWS, true);
    view.setUint32(16, VOICE_DIMENSION, true);
    bytes.set(new TextEncoder().encode("af_heart"), header);
    bytes.set(new TextEncoder().encode("am_michael"), header + 24);
    const styles = new Float32Array(buffer, header + names, floats);
    styles[VOICE_ROWS * VOICE_DIMENSION] = 42; // first component of voice 1, row 0

    const bin = new VoicesBin(buffer);
    expect(bin.names).toEqual(["af_heart", "am_michael"]);
    expect(bin.header).toMatchObject({ count: 2, lengths: VOICE_ROWS, dimension: VOICE_DIMENSION });
    expect(bin.voice("am_michael").style(0)[0]).toBe(42);
    expect(() => bin.voice("nobody")).toThrow(/no voice named/i);
  });

  it("rejects a file with the wrong magic", () => {
    const buffer = new ArrayBuffer(64);
    new Uint8Array(buffer).set(new TextEncoder().encode("NOTVOX!"), 0);
    expect(() => new VoicesBin(buffer)).toThrow(/magic/);
  });
});

describe("§7.4 audio storage", () => {
  it("round-trips through Int16 within a quantization step", () => {
    const samples = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 20) * 0.9);
    const back = toFloat32(toInt16(samples));
    for (let i = 0; i < samples.length; i++) {
      expect(Math.abs(back[i] - samples[i])).toBeLessThan(1 / 32767);
    }
  });

  it("clamps rather than wrapping when the model overshoots", () => {
    const clipped = toInt16(Float32Array.from([1.4, -1.4]));
    expect(clipped[0]).toBe(32767);
    expect(clipped[1]).toBe(-32767);
  });
});

/**
 * `electron/main.ts` runs a local HTTP server for one reason: the COOP and COEP
 * headers that make the page cross-origin isolated, which is what lets ONNX
 * Runtime use more than one WASM thread. The engine was meanwhile pinning the
 * thread count to one everywhere, so that server bought nothing and CPU
 * synthesis ran about four times slower than the machine could manage.
 */
describe("wasm thread count", () => {
  it("stays at one thread where SharedArrayBuffer is not available", async () => {
    const { defaultThreadCount } = await import("../src/synthesis/kokoroEngine");
    expect(defaultThreadCount(8, false)).toBe(1);
    expect(defaultThreadCount(1, false)).toBe(1);
  });

  it("leaves a core free and caps at four where it is", async () => {
    const { defaultThreadCount } = await import("../src/synthesis/kokoroEngine");
    expect(defaultThreadCount(2, true)).toBe(1);
    expect(defaultThreadCount(4, true)).toBe(3);
    expect(defaultThreadCount(16, true)).toBe(4);
    expect(defaultThreadCount(1, true)).toBe(1);
  });
});

/**
 * `ShaderModule with 'Clip' label is invalid` is what a GPU without 16-bit
 * shader support says when it is handed an fp16 model: ONNX Runtime emits
 * `enable f16;` only when the device has `shader-f16`, then generates `f16`
 * WGSL anyway, so every shader it compiles is invalid and the error names
 * whichever one came first. Clip has nothing to do with it.
 *
 * ONNX Runtime picks the adapter with a bare `requestAdapter()`, which on a
 * laptop with two GPUs is usually the integrated one. Both halves of that are
 * worth pinning down.
 */
describe("WebGPU adapter selection", () => {
  const adapterWith = (features: string[], info?: Record<string, string>) => ({
    features: { has: (f: string) => features.includes(f) },
    info,
  });

  function gpuReturning(byPreference: Record<string, ReturnType<typeof adapterWith> | null>) {
    return {
      requestAdapter: (options?: { powerPreference?: string }) =>
        Promise.resolve(byPreference[options?.powerPreference ?? "default"] ?? null),
    };
  }

  it("prefers the discrete GPU when both can run the model", async () => {
    const { selectAdapter } = await import("../src/synthesis/kokoroEngine");
    const chosen = await selectAdapter(
      gpuReturning({
        "high-performance": adapterWith(["shader-f16"], { vendor: "nvidia", device: "RTX 3050" }),
        "low-power": adapterWith(["shader-f16"], { vendor: "intel", device: "Iris Xe" }),
      }) as never,
    );
    expect(chosen?.report.description).toContain("RTX 3050");
    expect(chosen?.report.powerPreference).toBe("high-performance");
    expect(chosen?.report.shaderF16).toBe(true);
  });

  it("takes the slower GPU over one that cannot run the model at all", async () => {
    const { selectAdapter } = await import("../src/synthesis/kokoroEngine");
    const chosen = await selectAdapter(
      gpuReturning({
        "high-performance": adapterWith([], { vendor: "nvidia", device: "RTX 3050" }),
        "low-power": adapterWith(["shader-f16"], { vendor: "intel", device: "Iris Xe" }),
      }) as never,
    );
    expect(chosen?.report.description).toContain("Iris Xe");
    expect(chosen?.report.shaderF16).toBe(true);
    expect(chosen?.report.hadChoice).toBe(true);
  });

  it("reports the shortfall when no adapter has 16-bit shaders", async () => {
    const { selectAdapter, explainRejection } = await import("../src/synthesis/kokoroEngine");
    const chosen = await selectAdapter(
      gpuReturning({
        "high-performance": adapterWith(["timestamp-query"], { vendor: "intel", device: "Iris Xe" }),
        "low-power": adapterWith(["timestamp-query"], { vendor: "intel", device: "Iris Xe" }),
      }) as never,
    );
    expect(chosen?.report.shaderF16).toBe(false);

    // The message has to carry the remedy, because the remedy is a different
    // model file rather than anything the person can change about their GPU.
    const explained = explainRejection(
      "webgpu",
      "Failed to create a WebGPU compute pipeline: ShaderModule with 'Clip' label is invalid",
      chosen?.report,
    );
    expect(explained).toContain("Iris Xe");
    expect(explained).toContain("16-bit");
    expect(explained).toContain("--dtype q8");
  });

  it("says nothing about f16 when the GPU has it and refused anyway", async () => {
    const { explainRejection } = await import("../src/synthesis/kokoroEngine");
    const explained = explainRejection("webgpu", "out of memory", {
      description: "nvidia RTX 3050",
      shaderF16: true,
      powerPreference: "high-performance",
      hadChoice: false,
    });
    expect(explained).toContain("out of memory");
    expect(explained).not.toContain("--dtype");
  });

  it("leaves the choice to the browser when there is no WebGPU at all", async () => {
    const { selectAdapter } = await import("../src/synthesis/kokoroEngine");
    expect(await selectAdapter(undefined)).toBeUndefined();
    expect(await selectAdapter(gpuReturning({}) as never)).toBeUndefined();
  });
});
