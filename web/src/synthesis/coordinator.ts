import { secondsFromFrames } from "../core/frameMath";
import { RenderProgress } from "../core/sidecar";
import {
  frameCount,
  type Block,
  type ChunkTiming,
  type PhonemizedChunk,
  type WordTiming,
} from "../core/types";
import { defaultVocabulary, framed, type KokoroVocabulary } from "../linguistics/vocabulary";
import { Calibration, distributeFrames, DurationWeights, estimateChunkFrames } from "./durationEstimator";
import type { KokoroEngine } from "./kokoroEngine";
import { buildTimeline, StreamLayout } from "./streamLayout";

/**
 * Agent C's scheduler — §7.2 Phase A, §7.3 Phase B, and the on-demand render
 * that makes seeking ahead of the buffer edge work.
 */
export interface CoordinatorConfig {
  /** §7.3 — "Dismiss the loading bar when Phase A completes and ~60 s of audio exists." */
  initialAudioLead: number;
  /** Where rendered audio goes. */
  onAudio(chunkIndex: number, samples: Float32Array): Promise<void> | void;
  /** Phase A's estimates are arithmetic over token ids; they need this, not a model. */
  vocabulary?: KokoroVocabulary;
}

export interface PhaseAResult {
  words: WordTiming[];
  footnoteTimelines: Record<string, WordTiming[]>;
  duration: number;
  chunkFrameOffsets: number[];
  timingSource: ChunkTiming["source"];
}

export type CoordinatorEvent =
  | { type: "phaseA"; done: number; total: number }
  | { type: "priming"; seconds: number; target: number }
  | { type: "rendered"; chunkIndex: number; renderedThrough: number; totalChunks: number }
  | {
      type: "timeline";
      words: WordTiming[];
      duration: number;
      chunkFrameOffsets: number[];
      /** Only when a footnote body's own timing moved; §8.5 reads these. */
      footnoteTimelines?: Record<string, WordTiming[]>;
    }
  | { type: "complete" }
  | { type: "failed"; message: string };

/**
 * How far ahead of the render cursor the exact duration pass runs.
 *
 * §7.2's duration pass is cheap next to a full acoustic pass, but it is not
 * free, and running it over the whole document before the reader opens is what
 * put a five-minute loading bar in front of a document the user could already
 * have been reading. Staying a few chunks ahead of Phase B costs nothing
 * noticeable and keeps every chunk exact well before its audio is wanted.
 */
const EXACT_TIMING_LOOKAHEAD = 8;

/** Rebuilding and posting the whole timeline on every chunk is the expensive part. */
const TIMELINE_EMIT_INTERVAL_MS = 400;

/** Consecutive render failures before Phase B gives up on the document. */
const RENDER_FAILURE_LIMIT = 3;

export class SynthesisCoordinator {
  /**
   * Set once the voice model has finished loading — which is deliberately
   * *after* the reader opens.
   *
   * Compiling Kokoro's graph is a single blocking call inside this worker, so
   * "start the download early and let it overlap extraction" only ever
   * overlapped the download; the compile still had the thread to itself while
   * the user watched a loading bar. Phase A needs nothing from the model, so it
   * no longer waits for one: the document opens on the estimated timeline and
   * the engine arrives when it arrives.
   */
  private engine: KokoroEngine | undefined;
  private readonly config: CoordinatorConfig;
  private readonly weights: DurationWeights;
  private readonly calibration = new Calibration();
  private readonly timings = new Map<string, ChunkTiming>();
  private layout: StreamLayout | undefined;
  private blocks: Block[] = [];
  private cancelled = false;
  private renderingPromise: Promise<void> | undefined;
  /**
   * Renders in flight, by chunk index.
   *
   * Phase B and an on-demand render routinely want the same chunk: pressing
   * play on a fresh document starves on chunk 0 at the same moment Phase B is
   * already rendering it. Without this they both run, and the duplicate costs a
   * full acoustic pass on the one chunk the listener is actually waiting for.
   */
  private readonly inFlight = new Map<number, Promise<void>>();
  /** Chunks still owed §7.2's exact duration pass, in the order it runs them. */
  private exactQueue: PhonemizedChunk[] = [];
  private exactCursor = 0;
  private readonly mainIndexByChunkID = new Map<string, number>();
  private readonly footnoteBlockByChunkID = new Map<string, string>();
  private footnoteChunks: Record<string, readonly PhonemizedChunk[]> = {};
  private footnotesDirty = false;
  private timelineDirty = false;
  private lastTimelineEmit = 0;
  readonly progress = new RenderProgress();

  constructor(config: CoordinatorConfig) {
    this.config = config;
    this.weights = new DurationWeights(config.vocabulary ?? defaultVocabulary);
  }

  /** Hands the coordinator its engine; Phase B cannot start before this. */
  attachEngine(engine: KokoroEngine): void {
    this.engine = engine;
  }

  /**
   * Chunks asked for before the engine arrived.
   *
   * Now that the reader opens during the model load, play can be pressed
   * before there is anything to render with. Dropping those requests would
   * leave the transport parked on "playback resumes on its own" waiting for a
   * chunk nobody ever started.
   */
  private readonly deferredOnDemand = new Set<number>();

  /** Phase A's timing for one chunk, with no model and no inference. */
  private estimate(chunk: PhonemizedChunk): ChunkTiming {
    const tokens = framed(chunk.tokens);
    const total = estimateChunkFrames(tokens, this.weights, this.calibration);
    return {
      chunkID: chunk.id,
      frameDurations: distributeFrames(tokens, total, this.weights),
      source: "estimated",
    };
  }

  /**
   * What the timings *currently* are, not what the engine could produce.
   *
   * Phase A opens the reader on estimates even when a duration model exists
   * (see `runPhaseA`), so asking the engine would claim an exactness the
   * timeline does not have yet.
   */
  get timingSource(): ChunkTiming["source"] {
    if (!this.engine?.hasDurationModel) return "estimated";
    return this.exactCursor >= this.exactQueue.length ? "model" : "estimated";
  }

  get chunkTimings(): ChunkTiming[] {
    return [...this.timings.values()];
  }

  /**
   * §7.2 — "G2P the whole document, run the duration pass on every chunk
   * including footnote bodies, keep **only** `ChunkTiming.frameDurations`."
   *
   * The output is "the complete `[WordTiming]` for the document: exact total
   * duration, working scrubber, complete highlight map, correct seek — **with
   * no audio generated**." That sentence holds exactly when a duration model is
   * loaded. Without one the shape is the same and the numbers are estimates
   * that Phase B replaces chunk by chunk.
   */
  async runPhaseA(
    mainChunks: readonly PhonemizedChunk[],
    footnoteChunks: Readonly<Record<string, PhonemizedChunk[]>>,
    blocks: readonly Block[],
    emit: (event: CoordinatorEvent) => void,
    restored?: readonly ChunkTiming[],
  ): Promise<PhaseAResult> {
    this.blocks = [...blocks];
    this.footnoteChunks = footnoteChunks;

    mainChunks.forEach((chunk, index) => this.mainIndexByChunkID.set(chunk.id, index));
    for (const [blockID, chunks] of Object.entries(footnoteChunks)) {
      for (const chunk of chunks) this.footnoteBlockByChunkID.set(chunk.id, blockID);
    }

    const all = [...mainChunks, ...Object.values(footnoteChunks).flat()];
    const total = all.length;

    if (restored) {
      for (const timing of restored) this.timings.set(timing.chunkID, timing);
    }

    // The estimate is arithmetic over the token ids — no inference, no await
    // that does any work — so this is the whole of Phase A as far as the reader
    // is concerned, and it takes milliseconds rather than minutes.
    const owed: PhonemizedChunk[] = [];
    let done = 0;
    for (const chunk of all) {
      if (this.cancelled) break;
      const existing = this.timings.get(chunk.id);
      if (!existing) this.timings.set(chunk.id, this.estimate(chunk));
      if (existing?.source !== "model") owed.push(chunk);
      done += 1;
      if (done % 64 === 0 || done === total) emit({ type: "phaseA", done, total });
      // Yield so the worker stays responsive to a cancel from the UI.
      if (done % 256 === 0) await Promise.resolve();
    }
    this.exactQueue = owed;
    this.exactCursor = 0;

    const layout = new StreamLayout(mainChunks, this.timings, blocks);
    this.layout = layout;
    const words = buildTimeline(layout, this.timings, blocks);

    this.progress.totalChunks = mainChunks.length;
    this.progress.chunkFrameOffsets = layout.chunkFrameOffsets;

    return {
      words,
      footnoteTimelines: this.buildFootnoteTimelines(),
      duration: layout.duration,
      chunkFrameOffsets: layout.chunkFrameOffsets,
      timingSource: this.timingSource,
    };
  }

  /**
   * §4.5 — footnote bodies get their own timelines so §8.5 can interject
   * without the main timeline position moving.
   */
  private buildFootnoteTimelines(): Record<string, WordTiming[]> {
    const out: Record<string, WordTiming[]> = {};
    for (const [blockID, chunks] of Object.entries(this.footnoteChunks)) {
      const noteLayout = new StreamLayout(chunks, this.timings, this.blocks);
      out[blockID] = buildTimeline(noteLayout, this.timings, this.blocks);
    }
    return out;
  }

  /**
   * §7.2's duration pass, run behind the reader instead of in front of it.
   *
   * The spec has Phase A produce exact timings before anything else happens,
   * and on iOS that was most of a second. In the browser the duration subgraph
   * is most of Kokoro's text encoder, and on the CPU backend a document's worth
   * of it is minutes — minutes during which the spec's own justification for
   * Phase A ("working scrubber, complete highlight map, correct seek, with no
   * audio generated") is exactly what the user does not have, because the
   * reader has not opened. So the estimates open the reader and this walks the
   * same chunks afterwards, staying ahead of Phase B, replacing each estimate
   * with the exact answer as it arrives.
   */
  private async refineTimings(budget: number, emit: (event: CoordinatorEvent) => void): Promise<void> {
    const engine = this.engine;
    if (!engine?.hasDurationModel) return;
    for (let taken = 0; taken < budget && this.exactCursor < this.exactQueue.length; taken++) {
      if (this.cancelled) return;
      const chunk = this.exactQueue[this.exactCursor];
      this.exactCursor += 1;

      // Phase B may have rendered it already, in which case its timing comes
      // from real audio and the duration model has nothing to add.
      const index = this.mainIndexByChunkID.get(chunk.id);
      if (index !== undefined && this.progress.renderedChunks.has(index)) continue;

      let timing: ChunkTiming;
      try {
        timing = await engine.durations(chunk);
      } catch {
        // An exact timing that will not compute is a downgrade to the estimate
        // already in place, not a reason to fail the document.
        continue;
      }
      if (this.cancelled) return;
      this.applyTiming(chunk, timing);
    }
    this.flushTimeline(emit);
  }

  /** Installs a chunk's timing and marks whatever it moved as needing a rebuild. */
  private applyTiming(chunk: PhonemizedChunk, timing: ChunkTiming): void {
    this.timings.set(chunk.id, timing);
    const index = this.mainIndexByChunkID.get(chunk.id);
    if (index !== undefined) {
      if (this.layout?.commit(index, frameCount(timing))) this.timelineDirty = true;
      return;
    }
    if (this.footnoteBlockByChunkID.has(chunk.id)) this.footnotesDirty = true;
  }

  /**
   * Rebuilds and posts the timeline, at most every `TIMELINE_EMIT_INTERVAL_MS`.
   *
   * Every committed chunk moves the tail of an estimated timeline, and both the
   * rebuild and the structured clone of the whole `[WordTiming]` array are
   * proportional to the document. Doing that per chunk put an O(chunks x words)
   * cost on the worker and a layout reset on the audio graph for each one.
   */
  private flushTimeline(emit: (event: CoordinatorEvent) => void, force = false): void {
    if (!this.timelineDirty && !this.footnotesDirty) return;
    const now = Date.now();
    if (!force && now - this.lastTimelineEmit < TIMELINE_EMIT_INTERVAL_MS) return;
    const layout = this.layout;
    if (!layout) return;

    this.lastTimelineEmit = now;
    const footnotes = this.footnotesDirty ? this.buildFootnoteTimelines() : undefined;
    this.timelineDirty = false;
    this.footnotesDirty = false;

    emit({
      type: "timeline",
      words: buildTimeline(layout, this.timings, this.blocks),
      duration: layout.duration,
      chunkFrameOffsets: layout.chunkFrameOffsets,
      footnoteTimelines: footnotes,
    });
  }

  /**
   * The timeline as it currently stands, including anything committed since
   * Phase A returned.
   *
   * `runPhaseA`'s own result is a snapshot taken before `adoptRendered` has
   * re-anchored the layout to the audio already on disk, so reopening a
   * half-rendered document has to ask again rather than post the two together.
   */
  snapshot(): { words: WordTiming[]; duration: number; chunkFrameOffsets: number[] } {
    const layout = this.layout;
    if (!layout) return { words: [], duration: 0, chunkFrameOffsets: [] };
    return {
      words: buildTimeline(layout, this.timings, this.blocks),
      duration: layout.duration,
      chunkFrameOffsets: layout.chunkFrameOffsets,
    };
  }

  /** Marks chunks already on disk from a previous session as rendered. */
  adoptRendered(indices: readonly number[], frameCounts?: ReadonlyMap<number, number>): void {
    for (const index of indices) {
      this.progress.renderedChunks.add(index);
      const frames = frameCounts?.get(index);
      if (frames !== undefined) this.layout?.commit(index, frames);
    }
    if (this.layout) this.progress.chunkFrameOffsets = this.layout.chunkFrameOffsets;
  }

  /**
   * §7.3 — the renderer, in document order, never throttled.
   *
   * The loading bar is dismissed as soon as `initialAudioLead` seconds exist,
   * which is what `priming` reports; everything after that runs behind the
   * reader.
   */
  startPhaseB(emit: (event: CoordinatorEvent) => void): Promise<void> {
    if (!this.renderingPromise) this.renderingPromise = this.renderLoop(emit);
    return this.renderingPromise;
  }

  private async renderLoop(emit: (event: CoordinatorEvent) => void): Promise<void> {
    const layout = this.layout;
    if (!layout || !this.engine) return;
    let primed = false;
    let consecutiveFailures = 0;

    // Whatever was asked for while the model was still loading comes first: it
    // is where somebody is sitting waiting for sound.
    for (const index of [...this.deferredOnDemand].sort((a, b) => a - b)) {
      this.deferredOnDemand.delete(index);
      if (this.cancelled) return;
      if (this.progress.renderedChunks.has(index)) continue;
      try {
        await this.renderChunk(index, emit);
      } catch {
        // The document-order pass below will reach it again and report properly.
      }
    }

    for (let index = 0; index < layout.entries.length; index++) {
      if (this.cancelled) return;
      // Keep §7.2's exact pass a few chunks in front of the audio, so a chunk's
      // word timings firm up before anyone can reach it.
      await this.refineUpTo(index + EXACT_TIMING_LOOKAHEAD, emit);
      if (this.cancelled) return;
      if (this.progress.renderedChunks.has(index)) continue;

      try {
        await this.renderChunk(index, emit);
        consecutiveFailures = 0;
      } catch (error) {
        if (this.cancelled) return;
        consecutiveFailures += 1;
        // One chunk the model chokes on is a hole in the audio, not the end of
        // the document — the reader keeps working and Phase B keeps going. A
        // run of them is the engine itself being broken, and carrying on would
        // mean hundreds of identical failures before anyone was told.
        if (consecutiveFailures >= RENDER_FAILURE_LIMIT) {
          emit({ type: "failed", message: String(error) });
          return;
        }
        continue;
      }
      if (this.cancelled) return;

      if (!primed) {
        const lead = this.progress.renderedThrough;
        if (lead >= this.config.initialAudioLead || this.progress.isComplete) {
          primed = true;
        } else {
          emit({ type: "priming", seconds: lead, target: this.config.initialAudioLead });
        }
      }
    }

    // Whatever the lookahead did not reach — the footnote bodies, and any main
    // chunk Phase B skipped because it was already on disk.
    await this.refineUpTo(Number.POSITIVE_INFINITY, emit);
    if (this.cancelled) return;
    this.flushTimeline(emit, true);
    emit({ type: "complete" });
  }

  /**
   * Runs the exact duration pass until the queue's cursor has passed every main
   * chunk below `mainIndex`. Footnote chunks sit at the end of the queue, so
   * they are only reached by the unbounded call after Phase B finishes.
   */
  private async refineUpTo(mainIndex: number, emit: (event: CoordinatorEvent) => void): Promise<void> {
    if (!this.engine?.hasDurationModel) return;
    while (this.exactCursor < this.exactQueue.length) {
      if (this.cancelled) return;
      const next = this.exactQueue[this.exactCursor];
      const index = this.mainIndexByChunkID.get(next.id);
      if (index !== undefined && index >= mainIndex) break;
      if (index === undefined && mainIndex !== Number.POSITIVE_INFINITY) break;
      await this.refineTimings(1, emit);
    }
  }

  /**
   * §7.3 — "**Seek into unrendered territory** is supported: Phase A already
   * knows the word index at every timestamp, so render that chunk on demand
   * (~one acoustic pass) and start there. Do not disable seeking ahead of the
   * buffer edge."
   */
  async renderOnDemand(chunkIndex: number, emit: (event: CoordinatorEvent) => void): Promise<void> {
    if (!this.layout || chunkIndex < 0 || chunkIndex >= this.layout.entries.length) return;
    if (this.progress.renderedChunks.has(chunkIndex)) return;
    if (!this.engine) {
      this.deferredOnDemand.add(chunkIndex);
      return;
    }
    await this.renderChunk(chunkIndex, emit);
  }

  /** True while `chunkIndex` is being rendered by either path. */
  isRendering(chunkIndex: number): boolean {
    return this.inFlight.has(chunkIndex);
  }

  private renderChunk(index: number, emit: (event: CoordinatorEvent) => void): Promise<void> {
    const existing = this.inFlight.get(index);
    if (existing) return existing;
    const work = this.renderChunkOnce(index, emit).finally(() => this.inFlight.delete(index));
    this.inFlight.set(index, work);
    return work;
  }

  private async renderChunkOnce(index: number, emit: (event: CoordinatorEvent) => void): Promise<void> {
    const layout = this.layout;
    if (!layout) return;
    const entry = layout.entries[index];
    const engine = this.engine;
    if (!entry || !engine) return;
    const phaseATiming = this.timings.get(entry.chunk.id);

    const { samples, timing } = await engine.render(entry.chunk, phaseATiming);
    if (this.cancelled) return;

    this.timings.set(entry.chunk.id, timing);
    await this.config.onAudio(index, samples);
    this.progress.renderedChunks.add(index);

    // The true frame count lands here. On the exact tier it equals what Phase A
    // predicted and `commit` is a no-op; on the estimated tier it moves every
    // chunk after this one, which is why the timeline is re-emitted.
    if (layout.commit(index, frameCount(timing))) this.timelineDirty = true;
    this.progress.chunkFrameOffsets = layout.chunkFrameOffsets;

    emit({
      type: "rendered",
      chunkIndex: index,
      renderedThrough: this.progress.renderedThrough,
      totalChunks: this.progress.totalChunks,
    });

    this.flushTimeline(emit, this.progress.isComplete);
  }

  /** Where chunk `index`'s audio starts in the source timeline, in seconds. */
  chunkStartTime(index: number): number {
    const entry = this.layout?.entries[index];
    return entry ? secondsFromFrames(entry.startFrame - entry.leadingSilenceFrames) : 0;
  }

  chunkFrameSpan(index: number): { start: number; frames: number; silence: number } | undefined {
    const entry = this.layout?.entries[index];
    if (!entry) return undefined;
    return {
      start: entry.startFrame - entry.leadingSilenceFrames,
      frames: entry.frameCount,
      silence: entry.leadingSilenceFrames,
    };
  }

  get totalChunks(): number {
    return this.layout?.entries.length ?? 0;
  }

  /** The document's total length as the timeline currently has it. */
  get duration(): number {
    return this.layout?.duration ?? 0;
  }

  cancel(): void {
    this.cancelled = true;
  }
}
