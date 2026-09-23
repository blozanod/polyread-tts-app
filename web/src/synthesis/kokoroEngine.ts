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
import { acquireDevice, probeAdapters, type AdapterReport, type GpuCandidate } from "./gpu";
import { loadVoice, type Voice } from "./voices";

export type { AdapterReport, GpuClass } from "./gpu";

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
  /** The full model: phoneme ids in, waveform out. Half precision; what the CPU runs. */
  modelUrl: string;
  /**
   * Optional duration-only subgraph, cut from the same file by
   * `scripts/make-duration-model.py`. Its presence is the difference between
   * §7.2's Phase A as specified and the estimated tier.
   */
  durationModelUrl?: string;
  /**
   * The model the GPU runs first: full precision.
   *
   * kokoro-js, the reference web client for this checkpoint, says it plainly:
   * on WebGPU, use fp32. At half precision the vocoder's phase arithmetic
   * loses enough to be heard — a metallic, smeared voice — and some drivers
   * will not run an fp16 graph at all. The CPU has neither problem, and on the
   * CPU an fp16 file is the fastest of the lot, so `modelUrl` stays fp16 for
   * the CPU and for a GPU that will not take this one. `npm run assets` fetches
   * both. A 404 here is not an error: it is simply one fewer rung.
   */
  gpuModelUrl?: string;
  /** Directory holding `<voice>.bin`. */
  voicesBaseUrl: string;
  voiceID: string;
  /**
   * Which processor synthesis is allowed to use.
   *
   * - `"auto"` — every GPU this machine has, in the order most likely to work,
   *   and only then the CPU. The default.
   * - `"webgpu"` — the GPU or nothing. A machine that cannot run the model on a
   *   GPU reports that instead of quietly running ten times slower.
   * - `"wasm"` — the CPU, by choice.
   */
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
   * Called when one rung of the ladder was refused, before the next is tried.
   *
   * Most of these are not worth reporting on their own — a driver refusing one
   * of four GPU configurations is a detail — but the last one before the CPU
   * is, because falling from a GPU to WASM is roughly a tenfold slowdown and
   * worth saying out loud rather than discovering.
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
  /** `"webgpu"` or `"wasm"`, as ONNX Runtime names them. */
  device: string;
  /** The same thing in words: which GPU, at which precision, or why not. */
  deviceDetail: string;
  timingSource: ChunkTiming["source"];
  modelInterface: string;
  voiceID: string;
  adapter?: AdapterReport;
  /** Every rung tried, in order, and what became of it. For Settings. */
  attempts: string[];
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
  /**
   * Every way of running this model that is still untried, in order, and where
   * in it we currently are.
   *
   * A run failure moves down the ladder rather than straight to the CPU: the
   * next GPU, the same GPU with the graph fusions the driver choked on turned
   * off, a model file the GPU is known to accept — and the CPU only once all
   * of that is exhausted.
   */
  private plan: readonly Attempt[];
  private planIndex: number;
  /** In-flight rebuild, so a burst of failed chunks does not start four of them. */
  private recovery: Promise<boolean> | undefined;
  /** Set by the device's `lost` promise; the next run rebuilds before trying. */
  private deviceLost: string | undefined;
  private gpuDevice: GPUDevice | undefined;
  readonly adapter: AdapterReport | undefined;
  readonly calibration = new Calibration();
  /** Every rung tried so far, in order, and what became of it. */
  readonly attempts: string[];
  device: string;
  /** Which GPU, at which precision — or why not. */
  deviceDetail: string;
  /** Set when a chunk's rendered length disagreed with the duration model. */
  frameCountMismatches = 0;
  /**
   * Called when a run failure moved the engine down the ladder.
   *
   * `detail` is the new rung as `deviceDetail` spells it — which GPU, at which
   * precision — so a caller can say "moved to the integrated GPU" rather than
   * the much less useful "moved to webgpu".
   */
  onDeviceChange: ((detail: string, reason: string) => void) | undefined;

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
    deviceDetail: string;
    config: KokoroEngineConfig;
    adapter?: AdapterReport;
    gpuDevice?: GPUDevice;
    plan: readonly Attempt[];
    planIndex: number;
    attempts: string[];
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
    this.deviceDetail = init.deviceDetail;
    this.config = init.config;
    this.adapter = init.adapter;
    this.gpuDevice = init.gpuDevice;
    this.plan = init.plan;
    this.planIndex = init.planIndex;
    this.attempts = init.attempts;
  }

  /**
   * Loads the voice model onto the best thing that will actually run it.
   *
   * The order is fixed and it is the point of this class: every GPU this
   * machine will hand out, then the best of them with the graph fusions a
   * driver may have choked on turned off, then a model file a GPU is known to
   * accept — and the CPU only when all of that has been refused. Each rung is
   * proven by running the graph, not merely by compiling it, because WebGPU
   * compiles a shader the first time an operator runs and not before.
   */
  static async load(
    config: KokoroEngineConfig,
    vocabulary: KokoroVocabulary,
    hooks: LoadHooks = {},
  ): Promise<KokoroEngine> {
    const { onProgress, beforeCompile, onProviderRejected } = hooks;
    configureRuntime(config.threads);

    // Only the file the first rung will load is downloaded up front: a machine
    // whose GPU runs the full-precision model never needs the half-precision
    // one, and a machine with no GPU never needs the full-precision one — a
    // few hundred megabytes either way, on every first visit.
    const files = modelFiles(config, onProgress);
    const first = planAttempts(config, await probeAdapters(gpuOf())).find((a) => files.exists(a.model));
    const [, durationBytes, voice] = await Promise.all([
      first ? files.bytes(first.model) : Promise.resolve(undefined),
      config.durationModelUrl
        ? fetchModel(config.durationModelUrl, "Duration model", onProgress).catch(() => undefined)
        : Promise.resolve(undefined),
      loadVoice(config.voiceID, config.voicesBaseUrl),
    ]);

    await beforeCompile?.();

    // Probed again rather than trusted from before the download: an adapter
    // handed over minutes earlier — across a few hundred megabytes — may have
    // gone stale, and on a laptop the answer can change while the download
    // runs.
    const plan = planAttempts(config, await probeAdapters(gpuOf()));

    // Compiling a few hundred megabytes of graph is the longest stretch of the
    // load with nothing to report, so it gets its own label.
    onProgress?.(COMPILE_LABEL, 0, 1);

    const context = attemptContext(config, vocabulary, voice, files);
    const walked = await walkPlan(plan, 0, context, onProviderRejected);
    const main = walked.live;

    // The duration subgraph runs once per chunk and shares the acoustic model's
    // device. It used to be pinned to WASM on the grounds that it is small and
    // has no GPU warm-up — but "small" here is most of Kokoro's text encoder,
    // and single-threaded WASM turned §7.2 into several minutes of loading bar
    // on a machine whose GPU does the same pass in milliseconds.
    const duration = durationBytes
      ? await createDurationSession(durationBytes, main, config, vocabulary, voice)
      : undefined;

    const engine = new KokoroEngine({
      model: main.session,
      modelIO: main.io,
      waveformOutput: main.output,
      durationModel: duration?.session,
      durationIO: duration?.io,
      durationOutput: duration?.output,
      voice,
      vocabulary,
      device: main.provider,
      deviceDetail: main.detail,
      config,
      adapter: main.adapter,
      gpuDevice: main.gpuDevice,
      plan,
      planIndex: walked.index,
      attempts: walked.log,
    });
    main.onLost = (message) => engine.noteDeviceLost(message);
    return engine;
  }

  get timingSource(): ChunkTiming["source"] {
    return this.durationModel ? "model" : "estimated";
  }

  get info(): EngineInfo {
    return {
      device: this.device,
      deviceDetail: this.deviceDetail,
      timingSource: this.timingSource,
      modelInterface: this.describeInterfaces(),
      voiceID: this.voice.name,
      adapter: this.adapter,
      attempts: [...this.attempts],
    };
  }

  /**
   * Called from the device's `lost` promise and its uncaptured-error handler.
   *
   * A lost device does not fail the next run cleanly — it fails every one of
   * them — so the flag is checked before running rather than after, and the
   * engine moves down the ladder on its own.
   */
  private noteDeviceLost(message: string): void {
    if (this.device !== "webgpu") return;
    this.deviceLost ??= message;
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
   * One inference, with the ladder underneath it.
   *
   * A WebGPU session that *creates* successfully can still fail on every run:
   * the shaders for individual operators are compiled lazily, per op and dtype,
   * so a driver that will not accept one of them surfaces as
   * `Failed to create a WebGPU compute pipeline` from `OrtRun` rather than from
   * session creation. `load` smoke-tests the graph for exactly this reason, but
   * a pipeline that only fails at some shapes would slip past it — and the way
   * that used to present was the worst available: Phase B died on its first
   * chunk, the transport sat on "rendering this passage" forever, and the
   * benchmark screen would not run at all.
   *
   * So a run failure descends one rung and retries. What it does *not* do any
   * more is jump straight to the CPU: another GPU, the same GPU without the
   * fused kernel it disliked, and a model file a GPU will accept all come
   * first.
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

    // A device reported lost fails every run on it, so rebuild before trying
    // rather than after failing.
    if (this.deviceLost !== undefined && which === "waveform") {
      const reason = this.deviceLost;
      this.deviceLost = undefined;
      await this.descend(reason);
    }

    const first = session();
    try {
      return await first.session.run(buildFeeds(tokens, this.voice.style(phonemeCount), first.io));
    } catch (error) {
      // Only the acoustic model is worth moving the whole engine for. A duration
      // subgraph that will not run is §7.2's exact tier going away, which the
      // coordinator already treats as a downgrade to the estimate.
      if (which !== "waveform") throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (!(await this.descend(reason))) throw error;
      const retry = session();
      return await retry.session.run(buildFeeds(tokens, this.voice.style(phonemeCount), retry.io));
    }
  }

  /**
   * Rebuilds both sessions on the next rung of the ladder.
   *
   * Returns false when there is no next rung, in which case the caller rethrows
   * the original error. One rebuild runs at a time: a Phase B that fails four
   * chunks in a row before the first rebuild lands would otherwise start four
   * of them and fetch the model four times.
   */
  private descend(reason: string): Promise<boolean> {
    if (this.recovery) return this.recovery;
    if (this.planIndex + 1 >= this.plan.length) return Promise.resolve(false);

    const rebuild = (async () => {
      const previous = { model: this.model, duration: this.durationModel, gpu: this.gpuDevice };
      try {
        const context = attemptContext(this.config, this.vocabulary, this.voice, modelFiles(this.config));
        const walked = await walkPlan(this.plan, this.planIndex + 1, context);
        const main = walked.live;

        this.model = main.session;
        this.modelIO = main.io;
        this.waveformOutput = main.output;
        this.device = main.provider;
        this.deviceDetail = main.detail;
        this.gpuDevice = main.gpuDevice;
        this.planIndex = walked.index;
        this.attempts.push(...walked.log);
        main.onLost = (message) => this.noteDeviceLost(message);

        if (this.config.durationModelUrl && this.durationModel) {
          const durationBytes = await fetchModel(this.config.durationModelUrl, "Duration model").catch(
            () => undefined,
          );
          const duration = durationBytes
            ? await createDurationSession(durationBytes, main, this.config, this.vocabulary, this.voice)
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
      // Destroying the old device returns its VRAM now rather than at the next
      // garbage collection, which matters when the reason for descending was
      // that the GPU ran out of it.
      if (previous.gpu && previous.gpu !== this.gpuDevice) previous.gpu.destroy?.();

      this.onDeviceChange?.(this.deviceDetail, reason);
      return true;
    })();

    // Cleared only once the rebuild has finished swapping the sessions in, not
    // partway through it: a chunk that failed while the old session was still
    // being released would otherwise start a second rebuild on top of the first.
    this.recovery = rebuild.finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }

  async dispose(): Promise<void> {
    await this.model.release?.();
    await this.durationModel?.release?.();
    // The sessions hold the device; releasing them without destroying it leaves
    // the GPU allocation alive until collection, and a reader reopened a few
    // times would accumulate them.
    this.gpuDevice?.destroy?.();
    this.gpuDevice = undefined;
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

/**
 * One way of running the model: which provider, which GPU, which model file.
 *
 * The ladder is a list of these. Each is a complete, self-contained answer to
 * "how should this run" — nothing about a rung depends on the one before it —
 * so descending after a failure is just moving an index.
 */
export interface Attempt {
  provider: "webgpu" | "wasm";
  /** How this rung reads in Settings and in the log. */
  label: string;
  /** Absent on the CPU rung. */
  candidate?: GpuCandidate;
  /**
   * `"all"` is the fast path. `"disabled"` exists because ORT's fusions are
   * where its WebGPU shader generation is thinnest: a driver that refuses one
   * fused kernel — the reported `ShaderModule with 'Clip' label is invalid` is
   * one — will usually run the same graph unfused, which is still a GPU and
   * still several times a CPU.
   */
  optimization: "all" | "disabled";
  /** Which model file this rung loads: `gpu` is full precision, `primary` half. */
  model: "primary" | "gpu";
}

/** `navigator.gpu`, where there is one. Workers have it; Node does not. */
function gpuOf(): GPU | undefined {
  return (globalThis.navigator as { gpu?: GPU } | undefined)?.gpu;
}

function describeCandidate(candidate: GpuCandidate): string {
  const { report } = candidate;
  const klass = report.klass === "unknown" ? "" : `${report.klass}, `;
  return `${report.description} (${klass}${report.powerPreference})`;
}

/**
 * The ladder, in the order it is climbed down.
 *
 * Every GPU first, best first, each with the full-precision model before the
 * half-precision one; then the best GPU with fusions off; and the CPU last,
 * and only if it is allowed at all. `device: "webgpu"` removes the CPU rung
 * entirely, which is the difference between "prefer the GPU" and "the GPU or
 * tell me why not".
 */
export function planAttempts(config: KokoroEngineConfig, candidates: readonly GpuCandidate[]): Attempt[] {
  const wanted = config.device ?? "auto";
  const attempts: Attempt[] = [];
  const models: Array<Attempt["model"]> = config.gpuModelUrl ? ["gpu", "primary"] : ["primary"];
  const describeModel = (model: Attempt["model"]) =>
    config.gpuModelUrl ? (model === "gpu" ? ", full precision" : ", half precision") : "";

  if (wanted !== "wasm") {
    for (const candidate of candidates) {
      for (const model of models) {
        attempts.push({
          provider: "webgpu",
          candidate,
          optimization: "all",
          model,
          label: `GPU — ${describeCandidate(candidate)}${describeModel(model)}`,
        });
      }
    }
    const best = candidates[0];
    if (best) {
      for (const model of models) {
        attempts.push({
          provider: "webgpu",
          candidate: best,
          optimization: "disabled",
          model,
          label: `GPU — ${describeCandidate(best)}${describeModel(model)}, graph fusions off`,
        });
      }
    }
  }

  if (wanted !== "webgpu") {
    attempts.push({ provider: "wasm", optimization: "all", model: "primary", label: "CPU" });
  }
  return attempts;
}

/**
 * Turns a rejection into something that names the cause.
 *
 * `Failed to create a WebGPU compute pipeline: ShaderModule with 'Clip' label
 * is invalid` is a true statement about a shader and a useless one about the
 * problem. When the device running the model has no `shader-f16`, the cause is
 * that the model is float16 and the driver cannot do 16-bit shader arithmetic —
 * every shader would have failed, and Clip is simply the first one compiled.
 * That has a fix, and the fix is a different model file rather than a different
 * GPU.
 */
export function explainRejection(
  provider: string,
  reason: string,
  adapter: AdapterReport | undefined,
): string {
  if (provider !== "webgpu") return `${provider}: ${reason}`;
  if (!adapter) return `webgpu: ${reason}`;
  if (!adapter.shaderF16) {
    return (
      `${adapter.description} cannot do 16-bit shader arithmetic, so it cannot run an fp16 model. ` +
      "The full-precision one, kokoro-gpu.onnx, keeps it on the GPU: " +
      '"npm run assets" fetches it (310 MB) and leaves it where the engine will find it. ' +
      `The underlying error was: ${reason}`
    );
  }
  return `${adapter.description} refused the model: ${reason}`;
}

/** What one rung produced, once it was proven by an actual inference. */
interface LiveSession {
  session: ort.InferenceSession;
  io: SessionIO;
  output: string;
  provider: "webgpu" | "wasm";
  /** Which GPU, at which precision — or why not. Shown in Settings. */
  detail: string;
  adapter?: AdapterReport;
  gpuDevice?: GPUDevice;
  /**
   * Reassigned by the engine once it exists, so a device lost after the load
   * reaches the thing that can rebuild on it.
   */
  onLost?: (message: string) => void;
}

/**
 * Everything a rung needs that is not the rung itself: the model files (each
 * fetched at most once, however many rungs use it), the voice, and the
 * vocabulary the smoke test encodes with.
 */
interface AttemptContext {
  config: KokoroEngineConfig;
  vocabulary: KokoroVocabulary;
  voice: Voice;
  bytes(which: Attempt["model"]): Promise<Uint8Array | undefined>;
}

interface ModelFiles {
  /** Whether a rung for this file is worth considering at all. */
  exists(which: Attempt["model"]): boolean;
  bytes(which: Attempt["model"]): Promise<Uint8Array | undefined>;
}

function modelFiles(config: KokoroEngineConfig, onProgress?: LoadProgress): ModelFiles {
  const cache = new Map<Attempt["model"], Promise<Uint8Array | undefined>>();
  const urlOf = (which: Attempt["model"]) => (which === "primary" ? config.modelUrl : config.gpuModelUrl);
  const missing = new Set<Attempt["model"]>();
  return {
    exists: (which) => urlOf(which) !== undefined && !missing.has(which),
    bytes(which) {
      const existing = cache.get(which);
      if (existing) return existing;
      const url = urlOf(which);
      // A missing full-precision model is a rung that is not there, not a
      // failure: an install may have skipped it.
      const fetched = url
        ? fetchModel(url, "Kokoro model", onProgress).catch(() => {
            missing.add(which);
            return undefined;
          })
        : Promise.resolve(undefined);
      cache.set(which, fetched);
      return fetched;
    },
  };
}

function attemptContext(
  config: KokoroEngineConfig,
  vocabulary: KokoroVocabulary,
  voice: Voice,
  files: ModelFiles,
): AttemptContext {
  return { config, vocabulary, voice, bytes: (which) => files.bytes(which) };
}

/**
 * Climbs down the ladder from `from` until something both compiles *and* runs.
 *
 * The second half is the part that was missing. `InferenceSession.create`
 * succeeding means the graph parsed and the weights uploaded; it says nothing
 * about whether the driver will compile the shaders each operator needs, which
 * WebGPU only finds out at the first run. On the machine this was reported from
 * that first run came back with
 * `Failed to create a WebGPU compute pipeline: ShaderModule with 'Clip' label
 * is invalid` — after the app had already said "voice ready", so every symptom
 * landed minutes later and somewhere else. One throwaway inference here turns
 * that into a rung that is simply not chosen.
 */
async function walkPlan(
  plan: readonly Attempt[],
  from: number,
  context: AttemptContext,
  onRejected?: (provider: string, reason: string) => void,
): Promise<{ live: LiveSession; index: number; log: string[] }> {
  const log: string[] = [];
  let lastError: unknown;
  /**
   * Why the GPU was given up on, held until the CPU rung is actually reached.
   *
   * Reporting it from "the last GPU rung" instead would miss the ordinary case:
   * the last GPU rungs may be for a model file this install skipped, and a
   * rung that is skipped rather than tried throws nothing to report — so the
   * app would land on the CPU in silence, which is the one outcome this whole
   * file exists to make impossible to miss.
   */
  let gpuGaveUp: string | undefined;

  for (let index = Math.max(0, from); index < plan.length; index++) {
    const attempt = plan[index];
    if (attempt.provider === "wasm" && gpuGaveUp) {
      onRejected?.("webgpu", gpuGaveUp);
      gpuGaveUp = undefined;
    }
    let session: ort.InferenceSession | undefined;
    let acquired: Awaited<ReturnType<typeof acquireDevice>>;
    try {
      const bytes = await context.bytes(attempt.model);
      if (!bytes) {
        log.push(`${attempt.label}: no model file`);
        continue;
      }

      // The device is created here, by us, with the features the model needs —
      // which is the only way to choose either. See `gpu.ts`.
      if (attempt.provider === "webgpu") {
        const live: LiveSession = {} as LiveSession;
        acquired = await acquireDevice(gpuOf(), attempt.candidate!, (message) => live.onLost?.(message));
        if (!acquired) {
          log.push(`${attempt.label}: no device`);
          gpuGaveUp ??= `${attempt.candidate!.report.description} would not give out a device.`;
          continue;
        }
        session = await ort.InferenceSession.create(bytes, {
          executionProviders: [{ name: "webgpu", device: acquired.device }],
          graphOptimizationLevel: attempt.optimization,
        });
        const io = resolveInputs(session, context.config.modelUrl);
        const output = resolveOutput(session, WAVEFORM_OUTPUT_NAMES, context.config.modelUrl, "waveform");
        await smokeTest(session, io, output, context.vocabulary, context.voice);

        Object.assign(live, {
          session,
          io,
          output,
          provider: "webgpu" as const,
          detail: `${attempt.label}${acquired.features.length ? ` · ${acquired.features.join(", ")}` : ""}${
            acquired.maxBufferMB ? ` · ${acquired.maxBufferMB} MB buffers` : ""
          }`,
          adapter: acquired.report,
          gpuDevice: acquired.device,
        });
        log.push(`${attempt.label}: running`);
        return { live, index, log };
      }

      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: attempt.optimization,
      });
      const io = resolveInputs(session, context.config.modelUrl);
      const output = resolveOutput(session, WAVEFORM_OUTPUT_NAMES, context.config.modelUrl, "waveform");
      await smokeTest(session, io, output, context.vocabulary, context.voice);
      log.push(`${attempt.label}: running`);
      return {
        live: {
          session,
          io,
          output,
          provider: "wasm",
          detail: `CPU · ${ort.env.wasm.numThreads ?? 1} thread(s)`,
        },
        index,
        log,
      };
    } catch (error) {
      lastError = error;
      const reason = error instanceof Error ? error.message : String(error);
      log.push(`${attempt.label}: ${reason}`);
      // The most recent GPU failure is the one worth quoting: the ladder tries
      // the best hardware first, so the last thing it said before giving up is
      // the most specific answer available.
      if (attempt.provider === "webgpu") {
        gpuGaveUp = explainRejection("webgpu", reason, acquired?.report ?? attempt.candidate?.report);
      } else {
        onRejected?.(attempt.provider, explainRejection(attempt.provider, reason, undefined));
      }
      await session?.release?.().catch(() => undefined);
      acquired?.device.destroy?.();
    }
  }

  const why = gpuGaveUp ?? (lastError === undefined ? "the model file could not be fetched" : String(lastError));
  throw new PolyReadError(
    "modelMissing",
    plan.some((attempt) => attempt.provider === "wasm")
      ? `no execution provider could run the model: ${why}`
      : `Settings requires the GPU, and no GPU on this machine would run the model. ${why} ` +
        "Set Compute to GPU first to allow the CPU.",
  );
}

/**
 * The duration subgraph, on the same device the acoustic model settled on.
 *
 * It shares the device object rather than creating a second one: two devices on
 * one adapter is two copies of every allocation, and ORT would have to upload
 * the style vectors to both.
 */
async function createDurationSession(
  bytes: Uint8Array,
  main: LiveSession,
  config: KokoroEngineConfig,
  vocabulary: KokoroVocabulary,
  voice: Voice,
): Promise<{ session: ort.InferenceSession; io: SessionIO; output: string } | undefined> {
  const label = config.durationModelUrl ?? "duration model";
  // The acoustic model has already proven this device works; try it here, and
  // keep WASM as the backstop so a subgraph the GPU dislikes is a downgrade
  // rather than a lost tier.
  const providers: ort.InferenceSession.ExecutionProviderConfig[][] =
    main.provider === "webgpu" && main.gpuDevice
      ? [[{ name: "webgpu", device: main.gpuDevice }], ["wasm"]]
      : [["wasm"]];

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
      return { session, io, output };
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
