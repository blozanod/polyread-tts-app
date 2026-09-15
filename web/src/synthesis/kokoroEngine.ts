import * as ort from "onnxruntime-web/webgpu";
import { PolyReadError } from "../core/errors";
import { roundedFramesAll, SAMPLES_PER_FRAME } from "../core/frameMath";
import type { ChunkTiming, PhonemizedChunk } from "../core/types";
import { framed, type KokoroVocabulary } from "../linguistics/vocabulary";
import { COMPILE_LABEL } from "../workers/protocol";
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
 * True only where ONNX Runtime can actually run multi-threaded.
 *
 * Its wasm thread pool is built on `SharedArrayBuffer`, which a browser only
 * hands out to a cross-origin-isolated page — COOP and COEP response headers,
 * which the dev server and `electron/main.ts` both set precisely for this. Ask
 * for threads without isolation and the runtime spawns nested workers that
 * cannot share memory: on some builds that hangs rather than failing, the
 * session never resolves, and the import stops partway through the model load
 * with nothing in the console.
 *
 * So the thread count is gated on the one signal that actually predicts it
 * rather than being pinned to one everywhere. Pinning it to one was safe, but
 * it also meant the local server the desktop build exists to run — its entire
 * stated purpose is these two headers — bought nothing, and CPU synthesis ran
 * about four times slower than the machine could manage.
 */
function isCrossOriginIsolated(): boolean {
  const global = globalThis as { crossOriginIsolated?: boolean };
  return global.crossOriginIsolated === true && typeof SharedArrayBuffer !== "undefined";
}

/**
 * Cores minus one, capped at four. The cap is deliberate: past four threads
 * Kokoro's graph stops scaling and the extra workers just contend, and leaving
 * a core free keeps extraction and the highlight responsive while Phase B runs.
 */
export function defaultThreadCount(cores: number, isolated = isCrossOriginIsolated()): number {
  if (!isolated) return 1;
  return Math.max(1, Math.min(4, cores - 1));
}

function configureRuntime(threads?: number): void {
  const cores = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 2) : 2;
  ort.env.wasm.numThreads = Math.max(1, Math.min(threads ?? defaultThreadCount(cores), cores));
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

export interface LoadHooks {
  onProgress?: LoadProgress;
  /**
   * Awaited between fetching the model and compiling it.
   *
   * The fetch is network I/O and overlaps anything; the compile is one
   * uninterruptible call into WebAssembly that owns this thread for as long as
   * it takes. Whoever else is using the thread gets to say when that is a good
   * moment.
   */
  beforeCompile?: () => Promise<void>;
  /**
   * Called when a provider compiled the graph but could not run it, before the
   * next one is tried. Falling from WebGPU to WASM is roughly a tenfold
   * slowdown, which is worth saying out loud rather than discovering.
   */
  onProviderRejected?: (provider: string, reason: string) => void;
}

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
  private model: ort.InferenceSession;
  private modelIO: SessionIO;
  private waveformOutput: string;
  private durationModel?: ort.InferenceSession;
  private durationIO?: SessionIO;
  private durationOutput?: string;
  private readonly voice: Voice;
  private readonly vocabulary: KokoroVocabulary;
  private readonly weights: DurationWeights;
  private readonly config: KokoroEngineConfig;
  /** Set once the GPU has been abandoned, so the rebuild is attempted once. */
  private cpuFallback: Promise<boolean> | undefined;
  readonly calibration = new Calibration();
  device: string;
  /** Set when a chunk's rendered length disagreed with the duration model. */
  frameCountMismatches = 0;
  /** Called when a run failure forced the engine onto a different device. */
  onDeviceChange: ((device: string, reason: string) => void) | undefined;

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
    config: KokoroEngineConfig;
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
    this.config = init.config;
  }

  static async load(
    config: KokoroEngineConfig,
    vocabulary: KokoroVocabulary,
    hooks: LoadHooks = {},
  ): Promise<KokoroEngine> {
    const { onProgress, beforeCompile, onProviderRejected } = hooks;
    configureRuntime(config.threads);

    const [modelBytes, durationBytes, voice] = await Promise.all([
      fetchModel(config.modelUrl, "Kokoro model", onProgress),
      config.durationModelUrl
        ? fetchModel(config.durationModelUrl, "Duration model", onProgress).catch(() => undefined)
        : Promise.resolve(undefined),
      loadVoice(config.voiceID, config.voicesBaseUrl),
    ]);

    await beforeCompile?.();

    // Compiling a few hundred megabytes of graph is the longest stretch of the
    // load with nothing to report, so it gets its own label.
    onProgress?.(COMPILE_LABEL, 0, 1);
    const main = await createWaveformSession(
      modelBytes,
      providersFor(config.device),
      config,
      vocabulary,
      voice,
      onProviderRejected,
    );

    // The duration subgraph runs once per chunk and shares the acoustic model's
    // device. It used to be pinned to WASM on the grounds that it is small and
    // has no GPU warm-up — but "small" here is most of Kokoro's text encoder,
    // and single-threaded WASM turned §7.2 into several minutes of loading bar
    // on a machine whose GPU does the same pass in milliseconds.
    const duration = durationBytes
      ? await createDurationSession(durationBytes, main.device, config, vocabulary, voice)
      : undefined;

    return new KokoroEngine({
      model: main.session,
      modelIO: main.io,
      waveformOutput: main.output,
      durationModel: duration?.session,
      durationIO: duration?.io,
      durationOutput: duration?.output,
      voice,
      vocabulary,
      device: main.device,
      config,
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
      const results = await this.run("duration", tokens, chunk.tokens.length);
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

    return this.estimate(chunk);
  }

  /** True when §7.2's exact tier is available at all. */
  get hasDurationModel(): boolean {
    return this.durationModel !== undefined;
  }

  /**
   * The phoneme-class estimate on its own — no inference, no await that does
   * any work. Phase A opens the reader on these and refines them afterwards.
   */
  estimate(chunk: PhonemizedChunk): ChunkTiming {
    const tokens = framed(chunk.tokens);
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
    const results = await this.run("waveform", tokens, chunk.tokens.length);
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

  /**
   * One inference, with the GPU escape hatch.
   *
   * A WebGPU session that *creates* successfully can still fail on every run:
   * the shaders for individual operators are compiled lazily, per op and dtype,
   * so a driver that will not accept one of them surfaces as
   * `Failed to create a WebGPU compute pipeline` from `OrtRun` rather than from
   * session creation. `load` smoke-tests the graph for exactly this reason, but
   * a pipeline that only fails at some shapes would slip past it — and the way
   * that used to present was the worst available: Phase B died on its first
   * chunk, the transport sat on "rendering this passage" forever, and the
   * benchmark screen would not run at all. So a run failure on the GPU rebuilds
   * the session on the CPU and retries, once.
   */
  private async run(
    which: "waveform" | "duration",
    tokens: readonly number[],
    phonemeCount: number,
  ): Promise<ort.InferenceSession.OnnxValueMapType> {
    const session = (): { session: ort.InferenceSession; io: SessionIO } =>
      which === "duration" && this.durationModel && this.durationIO
        ? { session: this.durationModel, io: this.durationIO }
        : { session: this.model, io: this.modelIO };

    const first = session();
    try {
      return await first.session.run(buildFeeds(tokens, this.voice.style(phonemeCount), first.io));
    } catch (error) {
      // Only the acoustic model is worth moving the whole engine for. A duration
      // subgraph that will not run is §7.2's exact tier going away, which the
      // coordinator already treats as a downgrade to the estimate.
      if (which !== "waveform") throw error;
      if (!(await this.fallBackToCpu(error))) throw error;
      const retry = session();
      return await retry.session.run(buildFeeds(tokens, this.voice.style(phonemeCount), retry.io));
    }
  }

  /**
   * Rebuilds both sessions on the WASM backend after a GPU run failed. Returns
   * false when there is nothing left to fall back to, in which case the caller
   * rethrows the original error.
   */
  private fallBackToCpu(error: unknown): Promise<boolean> {
    if (this.device === "wasm") return Promise.resolve(false);
    if (this.cpuFallback) return this.cpuFallback;

    const reason = error instanceof Error ? error.message : String(error);
    this.cpuFallback = (async () => {
      const previous = { model: this.model, duration: this.durationModel };
      try {
        const modelBytes = await fetchModel(this.config.modelUrl, "Kokoro model");
        const main = await createWaveformSession(
          modelBytes,
          [["wasm"]],
          this.config,
          this.vocabulary,
          this.voice,
        );
        this.model = main.session;
        this.modelIO = main.io;
        this.waveformOutput = main.output;
        this.device = main.device;

        if (this.config.durationModelUrl && this.durationModel) {
          const durationBytes = await fetchModel(this.config.durationModelUrl, "Duration model").catch(
            () => undefined,
          );
          const duration = durationBytes
            ? await createDurationSession(durationBytes, "wasm", this.config, this.vocabulary, this.voice)
            : undefined;
          this.durationModel = duration?.session;
          this.durationIO = duration?.io;
          this.durationOutput = duration?.output;
        }
      } catch {
        return false;
      }
      await previous.model.release?.().catch(() => undefined);
      if (previous.duration !== this.durationModel) {
        await previous.duration?.release?.().catch(() => undefined);
      }
      this.onDeviceChange?.(this.device, reason);
      return true;
    })();

    return this.cpuFallback;
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

function providersFor(device: KokoroEngineConfig["device"]): ort.InferenceSession.ExecutionProviderConfig[][] {
  const wanted = device ?? "auto";
  if (wanted === "wasm") return [["wasm"]];
  if (wanted === "webgpu") return [["webgpu"]];
  return [["webgpu"], ["wasm"]];
}

interface ResolvedSession {
  session: ort.InferenceSession;
  io: SessionIO;
  output: string;
  device: string;
}

/**
 * Creates the acoustic session on the first provider that both compiles the
 * graph *and* runs it.
 *
 * The second half is the part that was missing. `InferenceSession.create`
 * succeeding means the graph parsed and the weights uploaded; it says nothing
 * about whether the driver will compile the shaders each operator needs, which
 * WebGPU only finds out at the first run. On the machine this was reported from
 * that first run came back with
 * `Failed to create a WebGPU compute pipeline: ShaderModule with 'Clip' label
 * is invalid` — after the app had already said "voice ready", so every symptom
 * landed minutes later and somewhere else. One throwaway inference here turns
 * that into a provider that is simply not chosen.
 */
async function createWaveformSession(
  bytes: Uint8Array,
  providers: ort.InferenceSession.ExecutionProviderConfig[][],
  config: KokoroEngineConfig,
  vocabulary: KokoroVocabulary,
  voice: Voice,
  onRejected?: (provider: string, reason: string) => void,
): Promise<ResolvedSession> {
  let lastError: unknown;
  for (const executionProviders of providers) {
    const name = String(executionProviders[0]);
    let session: ort.InferenceSession | undefined;
    try {
      session = await ort.InferenceSession.create(bytes, {
        executionProviders,
        graphOptimizationLevel: "all",
      });
      const io = resolveInputs(session, config.modelUrl);
      const output = resolveOutput(session, WAVEFORM_OUTPUT_NAMES, config.modelUrl, "waveform");
      await smokeTest(session, io, output, vocabulary, voice);
      return { session, io, output, device: name };
    } catch (error) {
      lastError = error;
      onRejected?.(name, error instanceof Error ? error.message : String(error));
      await session?.release?.().catch(() => undefined);
    }
  }
  throw new PolyReadError(
    "modelMissing",
    `no execution provider could run the model: ${String(lastError)}`,
  );
}

async function createDurationSession(
  bytes: Uint8Array,
  device: string,
  config: KokoroEngineConfig,
  vocabulary: KokoroVocabulary,
  voice: Voice,
): Promise<ResolvedSession | undefined> {
  const label = config.durationModelUrl ?? "duration model";
  // The acoustic model has already proven this device works; try it here, and
  // keep WASM as the backstop so a subgraph the GPU dislikes is a downgrade
  // rather than a lost tier.
  const providers: ort.InferenceSession.ExecutionProviderConfig[][] =
    device === "wasm" ? [["wasm"]] : [[device], ["wasm"]];

  for (const executionProviders of providers) {
    let session: ort.InferenceSession | undefined;
    try {
      session = await ort.InferenceSession.create(bytes, {
        executionProviders,
        graphOptimizationLevel: "all",
      });
      const io = resolveInputs(session, label);
      const output = resolveOutput(session, DURATION_OUTPUT_NAMES, label, "duration");
      await smokeTest(session, io, output, vocabulary, voice);
      return { session, io, output, device: String(executionProviders[0]) };
    } catch {
      await session?.release?.().catch(() => undefined);
    }
  }
  // A duration model that will not load is a downgrade, not a failure: the
  // estimated tier still works and says so.
  return undefined;
}

/** A handful of real phoneme ids, so the smoke run exercises the whole graph. */
function smokeTokens(vocabulary: KokoroVocabulary): number[] {
  const { tokens } = vocabulary.encode("hɐlˈoʊ");
  if (tokens.length > 0) return tokens;
  return [...vocabulary.symbolToID.values()].filter((id) => id > 0).slice(0, 4);
}

async function smokeTest(
  session: ort.InferenceSession,
  io: SessionIO,
  output: string,
  vocabulary: KokoroVocabulary,
  voice: Voice,
): Promise<void> {
  const ids = smokeTokens(vocabulary);
  const tokens = framed(ids);
  const results = await session.run(buildFeeds(tokens, voice.style(ids.length), io));
  if (!results[output]) {
    throw new PolyReadError("modelShapeMismatch", `model returned no "${output}"`);
  }
}

function buildFeeds(
  tokens: readonly number[],
  style: Float32Array,
  io: SessionIO,
): Record<string, ort.Tensor> {
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
