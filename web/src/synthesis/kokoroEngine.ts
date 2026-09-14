import * as ort from "onnxruntime-web/webgpu";
import { PolyReadError } from "../core/errors";
import { roundedFramesAll, SAMPLES_PER_FRAME } from "../core/frameMath";
import type { ChunkTiming, PhonemizedChunk } from "../core/types";
import { framed, type KokoroVocabulary } from "../linguistics/vocabulary";
import {
  Calibration,
  distributeFrames,
  DurationWeights,
  estimateChunkFrames,
  snapBoundariesToEnergy,
} from "./durationEstimator";
import { loadVoice, type Voice } from "./voices";

/**
 * §7.1's model interface, in one place.
 *
 * ─── INTEGRATION POINT ──────────────────────────────────────────────────────
 * The Swift build drove Core ML through `MLDictionaryFeatureProvider` rather
 * than Xcode's generated classes so that a tensor name turning out to be
 * different was a one-line fix. Same idea here, one step further: nothing is
 * hardcoded at all. `resolveIO` reads the session's own input and output
 * metadata and matches by name, then by shape, so a re-export that renames
 * `input_ids` to `tokens` still loads. `describeInterfaces()` prints what the
 * files actually declare, and the benchmark screen shows it.
 * ────────────────────────────────────────────────────────────────────────────
 */
/**
 * ONNX Runtime's wasm backend defaults to one thread per logical core, and
 * starts them by spawning workers. This code already runs *inside* a worker, so
 * those are nested workers — and on some browser builds that hangs rather than
 * failing: the session never resolves, nothing is thrown, and the import stops
 * partway through loading the model with nothing in the console. It reproduces
 * at any thread count above one, on a machine with 16 GB free, so it is not a
 * memory problem to be tuned around.
 *
 * So the default here is one thread, which always works. It costs nothing on
 * the path most people are on: `device: "auto"` tries WebGPU first, and WebGPU
 * does not use wasm threads at all. Anyone who wants the multi-threaded CPU
 * backend can raise it in Settings, and `Session.checkForStall` puts it back to
 * one if it hangs.
 */
function configureRuntime(threads?: number): void {
  const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 2) : 2;
  ort.env.wasm.numThreads = Math.max(1, Math.min(threads ?? 1, cores));
  // Nothing here needs a proxy worker: this already *is* a worker.
  ort.env.wasm.proxy = false;
  ort.env.logLevel = "error";
}

const TOKEN_INPUT_NAMES = ["input_ids", "tokens", "phoneme_ids", "ids"];
const STYLE_INPUT_NAMES = ["style", "ref_s", "style_vector", "s"];
const SPEED_INPUT_NAMES = ["speed", "rate", "alpha"];
const WAVEFORM_OUTPUT_NAMES = ["waveform", "audio", "output", "wav"];
const DURATION_OUTPUT_NAMES = ["duration", "durations", "pred_dur", "d", "dur"];

export interface KokoroEngineConfig {
  /** The full model: phoneme ids in, waveform out. */
  modelUrl: string;
  /**
   * Optional duration-only subgraph, cut from the same file by
   * `scripts/make-duration-model.py`. Its presence is the difference between
   * §7.2's Phase A as specified and the estimated tier.
   */
  durationModelUrl?: string;
  /** Directory holding `<voice>.bin`. */
  voicesBaseUrl: string;
  voiceID: string;
  /** "auto" tries WebGPU and falls back to WASM. */
  device?: "auto" | "webgpu" | "wasm";
  /** WASM thread count. Omitted means four, or the core count if lower. */
  threads?: number;
}

export type LoadProgress = (label: string, loaded: number, total: number) => void;

interface SessionIO {
  tokens: string;
  style: string;
  speed?: string;
  tokensAreInt64: boolean;
}

export interface EngineInfo {
  device: string;
  timingSource: ChunkTiming["source"];
  modelInterface: string;
  voiceID: string;
}

export class KokoroEngine {
  private readonly model: ort.InferenceSession;
  private readonly modelIO: SessionIO;
  private readonly waveformOutput: string;
  private readonly durationModel?: ort.InferenceSession;
  private readonly durationIO?: SessionIO;
  private readonly durationOutput?: string;
  private readonly voice: Voice;
  private readonly vocabulary: KokoroVocabulary;
  private readonly weights: DurationWeights;
  readonly calibration = new Calibration();
  readonly device: string;
  /** Set when a chunk's rendered length disagreed with the duration model. */
  frameCountMismatches = 0;

  private constructor(init: {
    model: ort.InferenceSession;
    modelIO: SessionIO;
    waveformOutput: string;
    durationModel?: ort.InferenceSession;
    durationIO?: SessionIO;
    durationOutput?: string;
    voice: Voice;
    vocabulary: KokoroVocabulary;
    device: string;
  }) {
    this.model = init.model;
    this.modelIO = init.modelIO;
    this.waveformOutput = init.waveformOutput;
    this.durationModel = init.durationModel;
    this.durationIO = init.durationIO;
    this.durationOutput = init.durationOutput;
    this.voice = init.voice;
    this.vocabulary = init.vocabulary;
    this.weights = new DurationWeights(init.vocabulary);
    this.device = init.device;
  }

  static async load(
    config: KokoroEngineConfig,
    vocabulary: KokoroVocabulary,
    onProgress?: LoadProgress,
  ): Promise<KokoroEngine> {
    configureRuntime(config.threads);
    const wanted = config.device ?? "auto";
    const providers: ort.InferenceSession.ExecutionProviderConfig[][] =
      wanted === "wasm" ? [["wasm"]] : wanted === "webgpu" ? [["webgpu"]] : [["webgpu"], ["wasm"]];

    const [modelBytes, durationBytes, voice] = await Promise.all([
      fetchModel(config.modelUrl, "Kokoro model", onProgress),
      config.durationModelUrl
        ? fetchModel(config.durationModelUrl, "Duration model", onProgress).catch(() => undefined)
        : Promise.resolve(undefined),
      loadVoice(config.voiceID, config.voicesBaseUrl),
    ]);

    let model: ort.InferenceSession | undefined;
    let device = "";
    let lastError: unknown;
    // Compiling a few hundred megabytes of graph is the longest stretch of the
    // load with nothing to report, so it gets its own label.
    onProgress?.("Preparing the model", 0, 1);
    for (const executionProviders of providers) {
      try {
        model = await ort.InferenceSession.create(modelBytes, {
          executionProviders,
          graphOptimizationLevel: "all",
        });
        device = String(executionProviders[0]);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!model) {
      throw new PolyReadError("modelMissing", `no execution provider accepted the model: ${String(lastError)}`);
    }

    const modelIO = resolveInputs(model, config.modelUrl);
    const waveformOutput = resolveOutput(model, WAVEFORM_OUTPUT_NAMES, config.modelUrl, "waveform");

    let durationModel: ort.InferenceSession | undefined;
    let durationIO: SessionIO | undefined;
    let durationOutput: string | undefined;
    if (durationBytes) {
      try {
        durationModel = await ort.InferenceSession.create(durationBytes, {
          // The duration subgraph is small and runs once per chunk in Phase A.
          // WASM is both fast enough and free of GPU warm-up, which matters
          // because Phase A is the loading bar the user is watching.
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });
        durationIO = resolveInputs(durationModel, config.durationModelUrl ?? "duration model");
        durationOutput = resolveOutput(
          durationModel,
          DURATION_OUTPUT_NAMES,
          config.durationModelUrl ?? "duration model",
          "duration",
        );
      } catch {
        // A duration model that will not load is a downgrade, not a failure:
        // the estimated tier still works and says so.
        durationModel = undefined;
        durationIO = undefined;
        durationOutput = undefined;
      }
    }

    return new KokoroEngine({
      model,
      modelIO,
      waveformOutput,
      durationModel,
      durationIO,
      durationOutput,
      voice,
      vocabulary,
      device,
    });
  }

  get timingSource(): ChunkTiming["source"] {
    return this.durationModel ? "model" : "estimated";
  }

  get info(): EngineInfo {
    return {
      device: this.device,
      timingSource: this.timingSource,
      modelInterface: this.describeInterfaces(),
      voiceID: this.voice.name,
    };
  }

  describeInterfaces(): string {
    const lines: string[] = [];
    const describe = (session: ort.InferenceSession, label: string): void => {
      lines.push(label);
      session.inputMetadata.forEach((meta, i) => {
        lines.push(`  in  ${session.inputNames[i]}: ${describeMeta(meta)}`);
      });
      session.outputMetadata.forEach((meta, i) => {
        lines.push(`  out ${session.outputNames[i]}: ${describeMeta(meta)}`);
      });
    };
    describe(this.model, "Kokoro (waveform)");
    if (this.durationModel) describe(this.durationModel, "Kokoro (duration)");
    else lines.push("Duration model: not loaded — timings are estimated");
    return lines.join("\n");
  }

  // MARK: §7.2 Phase A

  /**
   * §7.2 — "run the duration pass on every chunk including footnote bodies,
   * keep **only** `ChunkTiming.frameDurations`."
   *
   * With a duration model this is exact and costs a fraction of a render. With
   * none, it is the phoneme-class estimate, refined per chunk as Phase B
   * commits real lengths.
   */
  async durations(chunk: PhonemizedChunk): Promise<ChunkTiming> {
    const tokens = framed(chunk.tokens);
    if (this.durationModel && this.durationIO && this.durationOutput) {
      const results = await this.durationModel.run(
        this.feeds(tokens, chunk.tokens.length, this.durationIO),
      );
      const raw = results[this.durationOutput];
      if (!raw) {
        throw new PolyReadError("modelShapeMismatch", `duration model returned no "${this.durationOutput}"`);
      }
      const values = toFloatArray(raw);
      if (values.length !== tokens.length) {
        throw new PolyReadError(
          "modelShapeMismatch",
          `duration has ${values.length} entries but the token sequence has ${tokens.length}`,
        );
      }
      // §3 — "round to at least 1 before the gather, and use the *rounded*
      // values for timing so audio and timeline agree exactly."
      return { chunkID: chunk.id, frameDurations: roundedFramesAll(values), source: "model" };
    }

    const total = estimateChunkFrames(tokens, this.weights, this.calibration);
    return {
      chunkID: chunk.id,
      frameDurations: distributeFrames(tokens, total, this.weights),
      source: "estimated",
    };
  }

  // MARK: §7.3 Phase B

  /** One full render. Returns 24 kHz mono float samples plus the chunk's timing. */
  async render(chunk: PhonemizedChunk, phaseATiming?: ChunkTiming): Promise<{
    samples: Float32Array;
    timing: ChunkTiming;
  }> {
    const tokens = framed(chunk.tokens);
    const results = await this.model.run(this.feeds(tokens, chunk.tokens.length, this.modelIO));
    const raw = results[this.waveformOutput];
    if (!raw) {
      throw new PolyReadError("modelShapeMismatch", `model returned no "${this.waveformOutput}"`);
    }
    const samples = toFloatArray(raw);
    const actualFrames = Math.floor(samples.length / SAMPLES_PER_FRAME);

    if (phaseATiming?.source === "model") {
      const predicted = phaseATiming.frameDurations.reduce((a, b) => a + b, 0);
      // A disagreement here means the duration subgraph and the full graph have
      // drifted apart, which would put the highlight permanently out by the
      // difference. Worth counting and surfacing rather than absorbing.
      if (Math.abs(predicted - actualFrames) > 1) this.frameCountMismatches += 1;
      return { samples, timing: phaseATiming };
    }

    // Estimated tier: the chunk's total is now exact, so only the division
    // inside it is a guess. Split by phoneme class, then let the audio itself
    // pull the word boundaries onto the quiet spots it actually has.
    let frameDurations = distributeFrames(tokens, actualFrames, this.weights);
    frameDurations = refineWordBoundaries(frameDurations, chunk, samples, actualFrames);

    const estimated = phaseATiming?.frameDurations.reduce((a, b) => a + b, 0) ?? 0;
    if (estimated > 0) this.calibration.observe(estimated / (this.calibration.scale || 1), actualFrames);

    return { samples, timing: { chunkID: chunk.id, frameDurations, source: "estimated" } };
  }

  private feeds(
    tokens: readonly number[],
    phonemeCount: number,
    io: SessionIO,
  ): Record<string, ort.Tensor> {
    const style = this.voice.style(phonemeCount);
    const feeds: Record<string, ort.Tensor> = {
      [io.tokens]: io.tokensAreInt64
        ? new ort.Tensor("int64", BigInt64Array.from(tokens, BigInt), [1, tokens.length])
        : new ort.Tensor("int32", Int32Array.from(tokens), [1, tokens.length]),
      [io.style]: new ort.Tensor("float32", style, [1, style.length]),
    };
    // §8.2 — "**Do not** follow the card's advice to divide durations by speed
    // at synthesis". Speed is a playback-time stretch, so the model always runs
    // at 1.0 and a speed change never invalidates a cached chunk.
    if (io.speed) feeds[io.speed] = new ort.Tensor("float32", Float32Array.from([1]), [1]);
    return feeds;
  }

  async dispose(): Promise<void> {
    await this.model.release?.();
    await this.durationModel?.release?.();
  }

  /** For the benchmark screen; exposed so §0.1's measurement has something to call. */
  get vocabularySource(): string {
    return this.vocabulary.source;
  }
}

/**
 * Re-cuts a chunk's per-token frames so its *word* boundaries sit on the quiet
 * spots the rendered audio actually has, keeping the chunk's total exact.
 */
function refineWordBoundaries(
  frameDurations: readonly number[],
  chunk: PhonemizedChunk,
  samples: Float32Array,
  totalFrames: number,
): number[] {
  const n = frameDurations.length;
  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + frameDurations[i];

  // Cut indices, in framed-token space, at every word edge. §7.1's boundary
  // token at each end is why these are offset by one.
  const cuts: number[] = [];
  for (const range of chunk.wordPhonemeRanges) {
    const start = Math.min(range.start + 1, n);
    const end = Math.min(range.end + 1, n);
    if (cuts[cuts.length - 1] !== start) cuts.push(start);
    if (cuts[cuts.length - 1] !== end) cuts.push(end);
  }
  if (cuts.length < 2) return [...frameDurations];

  const before = cuts.map((i) => prefix[i]);
  const after = snapBoundariesToEnergy(before, samples);

  // Rescale each inter-cut segment to its new length. Segments outside the cut
  // range (the leading and trailing boundary tokens) keep what they had.
  const out = [...frameDurations];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const lo = cuts[c];
    const hi = cuts[c + 1];
    if (hi <= lo) continue;
    const oldLength = before[c + 1] - before[c];
    const newLength = Math.max(hi - lo, after[c + 1] - after[c]);
    if (oldLength <= 0 || newLength === oldLength) continue;
    const segment = distributeSegment(frameDurations.slice(lo, hi), newLength);
    for (let i = 0; i < segment.length; i++) out[lo + i] = segment[i];
  }

  // The rescale can drift the total by a frame or two; the total is the one
  // thing that must not move, because it is the chunk's place in the timeline.
  let total = out.reduce((a, b) => a + b, 0);
  let cursor = out.length - 1;
  while (total > totalFrames && cursor >= 0) {
    if (out[cursor] > 1) {
      out[cursor] -= 1;
      total -= 1;
    } else {
      cursor -= 1;
    }
  }
  if (total < totalFrames && out.length > 0) out[out.length - 1] += totalFrames - total;
  return out;
}

function distributeSegment(frames: readonly number[], target: number): number[] {
  const sum = frames.reduce((a, b) => a + b, 0);
  if (sum <= 0 || frames.length === 0) return [...frames];
  const scale = target / sum;
  const out = frames.map((f) => Math.max(1, Math.round(f * scale)));
  let total = out.reduce((a, b) => a + b, 0);
  let cursor = 0;
  while (total > target && cursor < out.length * 32) {
    const i = cursor % out.length;
    if (out[i] > 1) {
      out[i] -= 1;
      total -= 1;
    }
    cursor += 1;
  }
  if (total < target) out[out.length - 1] += target - total;
  return out;
}

// MARK: - Session plumbing

function describeMeta(meta: ort.InferenceSession.ValueMetadata): string {
  if (!meta.isTensor) return "non-tensor";
  return `${meta.type} [${meta.shape.join(", ")}]`;
}

function resolveInputs(session: ort.InferenceSession, label: string): SessionIO {
  const names = session.inputNames;
  const find = (candidates: readonly string[]): string | undefined =>
    names.find((n) => candidates.includes(n.toLowerCase()));

  let tokens = find(TOKEN_INPUT_NAMES);
  let style = find(STYLE_INPUT_NAMES);
  const speed = find(SPEED_INPUT_NAMES);

  // Name matching failed; fall back to shape. The token input is the integer
  // one, the style input is the float one with a 256-wide last dimension.
  if (!tokens || !style) {
    session.inputMetadata.forEach((meta, i) => {
      if (!meta.isTensor) return;
      const name = names[i];
      if (!tokens && meta.type.startsWith("int")) tokens = name;
      if (!style && meta.type === "float32" && meta.shape[meta.shape.length - 1] === 256) style = name;
    });
  }
  if (!tokens || !style) {
    throw new PolyReadError(
      "modelShapeMismatch",
      `${label} declares inputs [${names.join(", ")}]; could not find the token and style inputs`,
    );
  }

  const tokenIndex = names.indexOf(tokens);
  const tokenMeta = session.inputMetadata[tokenIndex];
  const tokensAreInt64 = tokenMeta?.isTensor ? tokenMeta.type === "int64" : true;
  return { tokens, style, speed, tokensAreInt64 };
}

function resolveOutput(
  session: ort.InferenceSession,
  candidates: readonly string[],
  label: string,
  what: string,
): string {
  const match = session.outputNames.find((n) => candidates.includes(n.toLowerCase()));
  if (match) return match;
  if (session.outputNames.length === 1) return session.outputNames[0];
  throw new PolyReadError(
    "modelShapeMismatch",
    `${label} declares outputs [${session.outputNames.join(", ")}]; could not find the ${what} output`,
  );
}

function toFloatArray(tensor: ort.Tensor): Float32Array {
  const data = tensor.data;
  if (data instanceof Float32Array) return data;
  if (data instanceof Float64Array) return Float32Array.from(data);
  if (typeof data === "object" && data !== null && "length" in data) {
    return Float32Array.from(data as ArrayLike<number>, Number);
  }
  throw new PolyReadError("modelShapeMismatch", `unexpected tensor data type ${tensor.type}`);
}

async function fetchModel(url: string, label: string, onProgress?: LoadProgress): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new PolyReadError("modelMissing", `${label} (${response.status} from ${url})`);

  const total = Number(response.headers.get("content-length") ?? 0);
  if (!response.body || total === 0) {
    onProgress?.(label, 1, 1);
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onProgress?.(label, loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
