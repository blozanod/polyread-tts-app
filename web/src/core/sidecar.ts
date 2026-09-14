import { secondsFromFrames, framesFromSeconds } from "./frameMath";
import type { ReflowDocument } from "./reflow";
import type { Block, ChunkTiming, PhonemizedChunk, WordTiming } from "./types";

/**
 * §7.4 — "a JSON sidecar holding `[WordTiming]` and `[Block]`. Keyed by PDF
 * content hash so reopening a document is instant."
 *
 * This is that sidecar plus the two things it would be silly to recompute: the
 * laid-out reflow text (§10) and the per-footnote timelines Phase A already
 * paid for (§4.5, §8.5).
 */
export const SIDECAR_VERSION = 4;

export interface DocumentSidecar {
  /**
   * Bumped whenever anything upstream of the cache changes meaning — a new
   * normalization rule, a different voice, a chunker fix. A mismatch forces a
   * re-import rather than replaying a stale timeline against fresh audio.
   */
  version: number;
  contentHash: string;
  title: string;
  pageCount: number;
  voiceName: string;
  /** "model" when a duration model produced the timings, "estimated" otherwise. */
  timingSource: ChunkTiming["source"];
  blocks: Block[];
  words: WordTiming[];
  /**
   * Phase A's inputs and outputs, kept so a document whose Phase B was
   * interrupted resumes rendering without paying for Phase A a second time.
   */
  mainChunks: PhonemizedChunk[];
  footnoteChunks: Record<string, PhonemizedChunk[]>;
  chunkTimings: ChunkTiming[];
  reflow: ReflowDocument;
  /**
   * Footnote bodies are not in the main stream, so they get their own
   * timelines, keyed by the footnote body block's id.
   */
  footnoteTimelines: Record<string, WordTiming[]>;
  /** Absolute frame offsets from Phase A; the last element is the total. */
  chunkFrameOffsets: number[];
  createdAt: number;
}

export function sidecarDuration(sidecar: DocumentSidecar): number {
  const last = sidecar.words[sidecar.words.length - 1];
  return last ? last.end : 0;
}

/**
 * How far Phase B has rendered. Persisted alongside the audio so a
 * half-rendered document resumes where it stopped instead of starting over
 * (§7.3).
 *
 * Chunks are tracked as a set rather than a high-water mark because §7.3
 * requires seeking into unrendered territory to work: that renders one chunk
 * out of order, and the stream has a hole in it until Phase B walks past.
 */
export class RenderProgress {
  renderedChunks: Set<number>;
  totalChunks: number;
  /**
   * Exact frame offsets, from Phase A. Index `i` is where chunk `i` starts; the
   * last element is the document's total frame count.
   */
  chunkFrameOffsets: number[];

  constructor(renderedChunks = new Set<number>(), totalChunks = 0, chunkFrameOffsets: number[] = []) {
    this.renderedChunks = renderedChunks;
    this.totalChunks = totalChunks;
    this.chunkFrameOffsets = chunkFrameOffsets;
  }

  get isComplete(): boolean {
    return this.totalChunks > 0 && this.renderedChunks.size === this.totalChunks;
  }

  /**
   * §7.3 — "Show the rendered-through edge on the scrubber permanently, like a
   * video preload bar." That edge is the end of the *contiguous* rendered run
   * from the start, not the furthest chunk rendered.
   */
  get contiguousChunkCount(): number {
    let count = 0;
    while (count < this.totalChunks && this.renderedChunks.has(count)) count++;
    return count;
  }

  get framesRendered(): number {
    const index = this.contiguousChunkCount;
    if (index >= this.chunkFrameOffsets.length) {
      return this.chunkFrameOffsets[this.chunkFrameOffsets.length - 1] ?? 0;
    }
    return this.chunkFrameOffsets[index];
  }

  get renderedThrough(): number {
    return secondsFromFrames(this.framesRendered);
  }

  /** Is the audio under this timestamp on disk? */
  isRendered(time: number): boolean {
    const index = this.chunkIndexAt(time);
    return index < 0 ? false : this.renderedChunks.has(index);
  }

  chunkIndexAt(time: number): number {
    const frame = framesFromSeconds(time);
    const offsets = this.chunkFrameOffsets;
    if (offsets.length <= 1) return -1;
    let lo = 0;
    let hi = offsets.length - 2;
    if (frame < offsets[0] || frame >= offsets[hi + 1]) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= frame) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}
