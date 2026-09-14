import { Pause, secondsFromFrames } from "../core/frameMath";
import {
  frameCount,
  type Block,
  type ChunkTiming,
  type PhonemizedChunk,
  type WordTiming,
} from "../core/types";

/**
 * Where every chunk sits in the source timeline, and how much silence precedes
 * it.
 *
 * Both phases read this. They have to: §5 says paragraph pauses are "real
 * silence inserted between rendered chunks", so if Phase A accounted for a
 * 400 ms gap that Phase B did not write, every word after it would highlight
 * early — and the bug would look like a timing bug, which §5 warns about
 * specifically.
 *
 * ## Why this is mutable, when the Swift one was not
 *
 * On iOS, Phase A knew every chunk's exact frame count before any audio
 * existed, so the layout was final the moment it was built. On the web that
 * holds only when a duration model is available (see `kokoroEngine.ts`).
 * Without one, Phase A's frame counts are estimates and the true count of a
 * chunk is not known until it has been rendered.
 *
 * `commit` is how the truth arrives. Because Phase B renders in document order,
 * committing chunk *k* only ever moves chunks *after* it — the part of the
 * timeline the playhead has not reached. The rendered prefix is always exact
 * and never shifts under a playing highlight.
 */
export interface StreamEntry {
  chunk: PhonemizedChunk;
  /** Silence written *before* this chunk, in frames. */
  leadingSilenceFrames: number;
  /** Absolute frame offset of this chunk's audio, silence excluded. */
  startFrame: number;
  frameCount: number;
  /** False while `frameCount` is still Phase A's estimate. */
  committed: boolean;
}

/**
 * §4.6 — headings get 400 ms of silence before and after; §5 — paragraphs get
 * 300-500 ms. Chunks *within* one block are one utterance and get none.
 */
export function silenceFramesBetween(previous: Block | undefined, next: Block): number {
  if (!previous) return 0;
  if (previous.id === next.id) return Pause.frames(Pause.withinBlock);
  if (previous.role === "heading" || next.role === "heading") return Pause.frames(Pause.heading);
  return Pause.frames(Pause.paragraph);
}

export class StreamLayout {
  readonly entries: StreamEntry[];
  private readonly blocksByID: Map<string, Block>;

  constructor(
    chunks: readonly PhonemizedChunk[],
    timings: ReadonlyMap<string, ChunkTiming>,
    blocks: readonly Block[],
  ) {
    this.blocksByID = new Map(blocks.map((b) => [b.id, b]));
    this.entries = [];
    let previousBlock: Block | undefined;
    for (const chunk of chunks) {
      const block = this.blocksByID.get(chunk.blockID);
      if (!block) continue;
      const timing = timings.get(chunk.id);
      this.entries.push({
        chunk,
        leadingSilenceFrames: silenceFramesBetween(previousBlock, block),
        startFrame: 0,
        frameCount: timing ? frameCount(timing) : 0,
        committed: timing?.source === "model",
      });
      previousBlock = block;
    }
    this.reflow();
  }

  /** Recomputes every `startFrame` from the current frame counts. */
  private reflow(): void {
    let cursor = 0;
    for (const entry of this.entries) {
      cursor += entry.leadingSilenceFrames;
      entry.startFrame = cursor;
      cursor += entry.frameCount;
    }
  }

  /**
   * Replaces chunk `index`'s frame count with the one its rendered audio
   * actually has. Returns true when that changed the layout, which is the
   * caller's cue to rebuild the timeline downstream of it.
   */
  commit(index: number, frames: number): boolean {
    const entry = this.entries[index];
    if (!entry) return false;
    const changed = entry.frameCount !== frames;
    entry.frameCount = frames;
    entry.committed = true;
    if (changed) this.reflow();
    return changed;
  }

  get totalFrames(): number {
    const last = this.entries[this.entries.length - 1];
    return last ? last.startFrame + last.frameCount : 0;
  }

  get duration(): number {
    return secondsFromFrames(this.totalFrames);
  }

  /** True once every chunk's frame count is the real one. */
  get isExact(): boolean {
    return this.entries.every((e) => e.committed);
  }

  /**
   * Index `i` is `entries[i].startFrame - entries[i].leadingSilenceFrames`; the
   * final element is `totalFrames`. This is what `RenderProgress` stores, so a
   * chunk's region covers the silence that introduces it.
   */
  get chunkFrameOffsets(): number[] {
    const offsets = this.entries.map((e) => e.startFrame - e.leadingSilenceFrames);
    offsets.push(this.totalFrames);
    return offsets;
  }
}

/**
 * Flattens per-chunk durations into the document-level timeline §3 calls "the
 * playback timeline".
 */
export const BOUNDARY_OFFSET = 1;

/**
 * `ChunkTiming.frameDurations` covers the *framed* token sequence — §7.1's
 * "Token 0 at both ends" — so it has two more entries than
 * `PhonemizedChunk.tokens`, and a word range `r` over the unframed tokens
 * corresponds to `frameDurations[r.start + 1 .. r.end + 1]`.
 */
export function buildTimeline(
  layout: StreamLayout,
  timings: ReadonlyMap<string, ChunkTiming>,
  blocks: readonly Block[],
): WordTiming[] {
  const blocksByID = new Map(blocks.map((b) => [b.id, b]));
  const words: WordTiming[] = [];

  for (const entry of layout.entries) {
    const timing = timings.get(entry.chunk.id);
    const block = blocksByID.get(entry.chunk.blockID);
    if (!timing || !block) continue;

    // Prefix sums so each word's bounds are two lookups, not a re-scan.
    const prefix = new Array<number>(timing.frameDurations.length + 1);
    prefix[0] = 0;
    for (let i = 0; i < timing.frameDurations.length; i++) {
      prefix[i + 1] = prefix[i] + timing.frameDurations[i];
    }

    for (let wordIndex = 0; wordIndex < entry.chunk.wordPhonemeRanges.length; wordIndex++) {
      const range = entry.chunk.wordPhonemeRanges[wordIndex];
      const spanIndex = entry.chunk.spanOffset + wordIndex;
      if (spanIndex >= block.spans.length) continue;

      const lower = Math.min(range.start + BOUNDARY_OFFSET, prefix.length - 1);
      const upper = Math.min(range.end + BOUNDARY_OFFSET, prefix.length - 1);
      const startFrame = entry.startFrame + prefix[lower];
      const endFrame = entry.startFrame + prefix[upper];

      words.push({
        start: secondsFromFrames(startFrame),
        end: secondsFromFrames(Math.max(endFrame, startFrame)),
        span: block.spans[spanIndex],
        blockID: block.id,
      });
    }
  }
  return words;
}
