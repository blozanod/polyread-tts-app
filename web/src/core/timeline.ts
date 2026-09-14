import type { WordTiming } from "./types";

/**
 * §8.3 — the lookup structure behind both highlight surfaces.
 *
 * "Binary-search `[WordTiming]`, but cache the last index and search outward
 * from it — playback is monotonic except on seek."
 *
 * Read from a requestAnimationFrame callback at screen refresh, so nothing in
 * here allocates or awaits.
 */
export interface BlockStart {
  blockID: string;
  wordIndex: number;
}

export class Timeline {
  readonly words: readonly WordTiming[];
  /** §8.4 — paragraph transport. First word index of each block, in order. */
  readonly blockStarts: readonly BlockStart[];
  private cursor = 0;

  constructor(words: readonly WordTiming[]) {
    this.words = words;
    const starts: BlockStart[] = [];
    let lastBlock: string | undefined;
    for (let i = 0; i < words.length; i++) {
      if (words[i].blockID !== lastBlock) {
        starts.push({ blockID: words[i].blockID, wordIndex: i });
        lastBlock = words[i].blockID;
      }
    }
    this.blockStarts = starts;
  }

  get isEmpty(): boolean {
    return this.words.length === 0;
  }

  /** Exact total duration — §7.2's headline Phase A deliverable. */
  get duration(): number {
    return this.words.length === 0 ? 0 : this.words[this.words.length - 1].end;
  }

  /**
   * Current word index for a source-timeline position.
   *
   * Returns -1 only for an empty timeline; a position inside an inter-chunk
   * silence resolves to the word that silence follows, so the highlight rests
   * on the last spoken word through a paragraph pause rather than blinking off.
   */
  indexAt(time: number): number {
    const words = this.words;
    if (words.length === 0) return -1;
    if (time <= words[0].start) {
      this.cursor = 0;
      return 0;
    }
    if (time >= words[words.length - 1].start) {
      this.cursor = words.length - 1;
      return this.cursor;
    }

    // Monotonic fast path: playback almost always advances by 0 or 1 words
    // between display refreshes.
    if (this.contains(this.cursor, time)) return this.cursor;
    if (this.contains(this.cursor + 1, time)) {
      this.cursor += 1;
      return this.cursor;
    }

    // Gallop outward from the cursor, then a bounded binary search. On a scrub
    // this degrades to a plain binary search over the whole array.
    let lo = 0;
    let hi = words.length - 1;
    if (time > words[this.cursor].start) {
      lo = this.cursor;
      let step = 1;
      while (lo + step < words.length && words[lo + step].start <= time) {
        lo += step;
        step <<= 1;
      }
      hi = Math.min(words.length - 1, lo + step);
    } else {
      hi = this.cursor;
      let step = 1;
      while (hi - step >= 0 && words[hi - step].start > time) {
        hi -= step;
        step <<= 1;
      }
      lo = Math.max(0, hi - step);
    }

    // Last index whose start <= time.
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (words[mid].start <= time) lo = mid;
      else hi = mid - 1;
    }
    this.cursor = lo;
    return lo;
  }

  private contains(index: number, time: number): boolean {
    const words = this.words;
    if (index < 0 || index >= words.length) return false;
    const start = words[index].start;
    const nextStart = index + 1 < words.length ? words[index + 1].start : Infinity;
    return time >= start && time < nextStart;
  }

  /**
   * §8.4 — "Skip +/-15 s, snapped to the nearest `WordTiming` boundary — never a
   * raw audio seek, or you land mid-word."
   */
  snapped(time: number): number {
    const i = this.indexAt(time);
    return i < 0 ? 0 : this.words[i].start;
  }

  skip(from: number, delta: number): number {
    return this.snapped(Math.max(0, Math.min(this.duration, from + delta)));
  }

  startOfWord(index: number): number {
    if (index < 0 || index >= this.words.length) return 0;
    return this.words[index].start;
  }

  /**
   * §8.4 — previous / next paragraph, using `Block` boundaries.
   *
   * "Previous" within the first 1.5 s of a block goes to the block before it,
   * and past that restarts the current one — the behaviour every audio player
   * has trained people to expect from a back button.
   */
  previousBlockStart(from: number): number {
    const current = this.currentBlockStartIndex(from);
    if (current < 0) return 0;
    const currentStart = this.words[this.blockStarts[current].wordIndex].start;
    if (from - currentStart > 1.5 || current === 0) return currentStart;
    return this.words[this.blockStarts[current - 1].wordIndex].start;
  }

  nextBlockStart(from: number): number {
    const current = this.currentBlockStartIndex(from);
    if (current < 0 || current + 1 >= this.blockStarts.length) return this.duration;
    return this.words[this.blockStarts[current + 1].wordIndex].start;
  }

  blockIDAt(time: number): string | undefined {
    const i = this.indexAt(time);
    return i < 0 ? undefined : this.words[i].blockID;
  }

  private currentBlockStartIndex(time: number): number {
    const wordIndex = this.indexAt(time);
    if (wordIndex < 0 || this.blockStarts.length === 0) return -1;
    let lo = 0;
    let hi = this.blockStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.blockStarts[mid].wordIndex <= wordIndex) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}
