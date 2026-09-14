import { secondsFromFrames } from "../core/frameMath";
import { RenderProgress } from "../core/sidecar";
import {
  frameCount,
  type Block,
  type ChunkTiming,
  type PhonemizedChunk,
  type WordTiming,
} from "../core/types";
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
  | { type: "timeline"; words: WordTiming[]; duration: number; chunkFrameOffsets: number[] }
  | { type: "complete" }
  | { type: "failed"; message: string };

export class SynthesisCoordinator {
  private readonly engine: KokoroEngine;
  private readonly config: CoordinatorConfig;
  private readonly timings = new Map<string, ChunkTiming>();
  private layout: StreamLayout | undefined;
  private blocks: Block[] = [];
  private cancelled = false;
  private renderingPromise: Promise<void> | undefined;
  readonly progress = new RenderProgress();

  constructor(engine: KokoroEngine, config: CoordinatorConfig) {
    this.engine = engine;
    this.config = config;
  }

  get timingSource(): ChunkTiming["source"] {
    return this.engine.timingSource;
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

    const footnoteFlat = Object.values(footnoteChunks).flat();
    const all = [...mainChunks, ...footnoteFlat];
    const total = all.length;

    if (restored) {
      for (const timing of restored) this.timings.set(timing.chunkID, timing);
    }

    let done = 0;
    for (const chunk of all) {
      if (this.cancelled) break;
      if (!this.timings.has(chunk.id)) {
        this.timings.set(chunk.id, await this.engine.durations(chunk));
      }
      done += 1;
      if (done % 4 === 0 || done === total) emit({ type: "phaseA", done, total });
      // Yield so the worker stays responsive to a cancel from the UI.
      if (done % 8 === 0) await Promise.resolve();
    }

    const layout = new StreamLayout(mainChunks, this.timings, blocks);
    this.layout = layout;
    const words = buildTimeline(layout, this.timings, blocks);

    // §4.5 — footnote bodies get their own timelines so §8.5 can interject
    // without the main timeline position moving.
    const footnoteTimelines: Record<string, WordTiming[]> = {};
    for (const [blockID, chunks] of Object.entries(footnoteChunks)) {
      const noteLayout = new StreamLayout(chunks, this.timings, blocks);
      footnoteTimelines[blockID] = buildTimeline(noteLayout, this.timings, blocks);
    }

    this.progress.totalChunks = mainChunks.length;
    this.progress.chunkFrameOffsets = layout.chunkFrameOffsets;

    return {
      words,
      footnoteTimelines,
      duration: layout.duration,
      chunkFrameOffsets: layout.chunkFrameOffsets,
      timingSource: this.engine.timingSource,
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
    if (!layout) return;
    let primed = false;

    try {
      for (let index = 0; index < layout.entries.length; index++) {
        if (this.cancelled) return;
        if (this.progress.renderedChunks.has(index)) continue;
        await this.renderChunk(index, emit);

        if (!primed) {
          const lead = this.progress.renderedThrough;
          if (lead >= this.config.initialAudioLead || this.progress.isComplete) {
            primed = true;
          } else {
            emit({ type: "priming", seconds: lead, target: this.config.initialAudioLead });
          }
        }
      }
      if (!this.cancelled) emit({ type: "complete" });
    } catch (error) {
      if (!this.cancelled) emit({ type: "failed", message: String(error) });
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
    await this.renderChunk(chunkIndex, emit);
  }

  private async renderChunk(index: number, emit: (event: CoordinatorEvent) => void): Promise<void> {
    const layout = this.layout;
    if (!layout) return;
    const entry = layout.entries[index];
    const phaseATiming = this.timings.get(entry.chunk.id);

    const { samples, timing } = await this.engine.render(entry.chunk, phaseATiming);
    if (this.cancelled) return;

    this.timings.set(entry.chunk.id, timing);
    await this.config.onAudio(index, samples);
    this.progress.renderedChunks.add(index);

    // The true frame count lands here. On the exact tier it equals what Phase A
    // predicted and `commit` is a no-op; on the estimated tier it moves every
    // chunk after this one, which is why the timeline is re-emitted.
    const moved = layout.commit(index, frameCount(timing));
    this.progress.chunkFrameOffsets = layout.chunkFrameOffsets;

    emit({
      type: "rendered",
      chunkIndex: index,
      renderedThrough: this.progress.renderedThrough,
      totalChunks: this.progress.totalChunks,
    });

    if (moved) {
      emit({
        type: "timeline",
        words: buildTimeline(layout, this.timings, this.blocks),
        duration: layout.duration,
        chunkFrameOffsets: layout.chunkFrameOffsets,
      });
    }
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

  cancel(): void {
    this.cancelled = true;
  }
}
