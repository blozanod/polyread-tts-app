import workletUrl from "./stretchProcessor.js?url";
import { PolyReadError } from "../core/errors";
import { SAMPLE_RATE, samplesFromSeconds, secondsFromSamples } from "../core/frameMath";

/**
 * §8.1's graph, on the web. One `AudioWorkletNode` running `stretchProcessor.js`
 * into the destination, plus the bookkeeping that keeps a bounded window of
 * rendered audio inside it.
 *
 * The worklet owns the playhead. This class owns *which audio the worklet has* —
 * §7.3's "play to the edge and stop there" is implemented by simply not giving
 * it anything past the edge.
 */
export interface AudioChunk {
  index: number;
  /** Absolute sample offset in the source timeline. */
  startSample: number;
  samples: Float32Array;
}

export interface EngineState {
  /** Source-timeline position, in seconds. The value §8.3 indexes with. */
  time: number;
  playing: boolean;
  /** True when the playhead has reached audio that has not been rendered. */
  starved: boolean;
}

export type ChunkProvider = (index: number) => Promise<Float32Array | undefined>;

/** How much audio the worklet holds around the playhead. */
const WINDOW_AHEAD_SECONDS = 150;
const WINDOW_BEHIND_SECONDS = 20;

export class AudioEngine {
  private context: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private gain: GainNode | undefined;
  private readonly delivered = new Set<number>();
  private chunkStarts: number[] = [];
  private available = new Set<number>();
  private provider: ChunkProvider | undefined;
  private feeding = false;

  private state: EngineState = { time: 0, playing: false, starved: false };
  onState: ((state: EngineState) => void) | undefined;
  /** Fired when playback reaches unrendered audio, so §7.3 can render on demand. */
  onStarved: ((time: number) => void) | undefined;
  onEnded: (() => void) | undefined;
  private endOfStreamTime = Infinity;
  private endOfStreamSamples: number | undefined;

  get currentState(): EngineState {
    return this.state;
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? 0;
  }

  async prepare(): Promise<void> {
    if (this.context) {
      if (this.context.state === "suspended") await this.context.resume();
      return;
    }
    // Asking for 24 kHz means the worklet's resampler is a no-op on the
    // platforms that honour it, which is most of them. Where it is refused the
    // worklet interpolates instead; nothing else in the app notices.
    let context: AudioContext;
    try {
      context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "playback" });
    } catch {
      context = new AudioContext({ latencyHint: "playback" });
    }
    if (!context.audioWorklet) {
      await context.close();
      throw new PolyReadError("audioUnavailable", "this browser has no AudioWorklet");
    }
    await context.audioWorklet.addModule(workletUrl);

    const node = new AudioWorkletNode(context, "polyread-stretch", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const gain = context.createGain();
    node.connect(gain).connect(context.destination);

    node.port.onmessage = (event: MessageEvent) => {
      const message = event.data as { type: string; sourcePosition: number; starved: boolean };
      if (message.type === "ended") {
        this.state = {
          time: Math.min(secondsFromSamples(message.sourcePosition), this.endOfStreamTime),
          playing: false,
          starved: false,
        };
        this.onState?.(this.state);
        this.onEnded?.();
        return;
      }
      if (message.type !== "position") return;
      const time = secondsFromSamples(message.sourcePosition);
      const wasStarved = this.state.starved;
      this.state = { ...this.state, time, starved: message.starved };
      this.onState?.(this.state);
      if (message.starved && !wasStarved) this.onStarved?.(time);
      void this.feedWindow(time);
    };

    this.context = context;
    this.node = node;
    this.gain = gain;
    // The layout usually arrives before there is anything to tell: Phase A
    // finishes while the reader is still being looked at, and the audio graph is
    // not built until the first play. Replay it now, or the worklet never learns
    // where the document ends and runs on through silence past the duration.
    if (this.endOfStreamSamples !== undefined) {
      node.port.postMessage({ type: "endOfStream", sample: this.endOfStreamSamples });
    }
    if (context.state === "suspended") await context.resume();
  }

  /**
   * Tells the engine where every chunk starts and which ones exist. Called after
   * Phase A, and again whenever the estimated tier commits a real frame count
   * and the offsets move.
   */
  setLayout(chunkStartSamples: readonly number[], rendered: Iterable<number>): void {
    const previous = this.chunkStarts;
    this.chunkStarts = [...chunkStartSamples];
    this.available = new Set(rendered);

    // If an offset moved, what the worklet holds is at the wrong place. Only the
    // *unplayed* tail can have moved (Phase B renders in order), so this is rare
    // and cheap: drop the window and let it refill.
    const moved = previous.some((value, index) => this.chunkStarts[index] !== value);
    if (moved) {
      this.delivered.clear();
      this.node?.port.postMessage({ type: "clear" });
      void this.feedWindow(this.state.time);
    }
    const total = this.chunkStarts[this.chunkStarts.length - 1];
    if (total !== undefined) {
      this.endOfStreamSamples = total;
      this.endOfStreamTime = secondsFromSamples(total);
      this.node?.port.postMessage({ type: "endOfStream", sample: total });
    }
  }

  setProvider(provider: ChunkProvider): void {
    this.provider = provider;
  }

  /** Announces a newly rendered chunk; it reaches the worklet if it is in range. */
  async chunkRendered(index: number): Promise<void> {
    this.available.add(index);
    await this.feedWindow(this.state.time);
  }

  private async feedWindow(time: number): Promise<void> {
    if (this.feeding || !this.provider || !this.node) return;
    this.feeding = true;
    try {
      const centre = samplesFromSeconds(time);
      const ahead = centre + samplesFromSeconds(WINDOW_AHEAD_SECONDS);
      const behind = centre - samplesFromSeconds(WINDOW_BEHIND_SECONDS);

      for (let index = 0; index + 1 < this.chunkStarts.length; index++) {
        const start = this.chunkStarts[index];
        const end = this.chunkStarts[index + 1];
        if (end < behind || start > ahead) {
          this.delivered.delete(index);
          continue;
        }
        if (this.delivered.has(index) || !this.available.has(index)) continue;
        const samples = await this.provider(index);
        if (!samples) continue;
        this.delivered.add(index);
        // The chunk's own audio starts after whatever silence introduces it; the
        // gap is left as the zeros the worklet reads from a hole, which is
        // exactly §5's "real silence inserted between rendered chunks".
        const audioStart = end - samples.length;
        const buffer = samples.buffer.slice(
          samples.byteOffset,
          samples.byteOffset + samples.byteLength,
        );
        this.node.port.postMessage({ type: "audio", start: audioStart, samples: buffer }, [buffer]);
      }
      this.node.port.postMessage({ type: "evictBefore", sample: behind });
    } finally {
      this.feeding = false;
    }
  }

  async play(): Promise<void> {
    await this.prepare();
    // Pressing play at the end starts over, as every audio player does.
    if (this.state.time >= this.endOfStreamTime - 0.05) await this.seek(0);
    await this.feedWindow(this.state.time);
    this.node?.port.postMessage({ type: "play" });
    this.state = { ...this.state, playing: true };
    this.onState?.(this.state);
  }

  pause(): void {
    this.node?.port.postMessage({ type: "pause" });
    this.state = { ...this.state, playing: false };
    this.onState?.(this.state);
  }

  async seek(time: number): Promise<void> {
    await this.prepare();
    this.state = { ...this.state, time, starved: false };
    this.delivered.clear();
    this.node?.port.postMessage({ type: "clear" });
    this.node?.port.postMessage({ type: "seek", sample: samplesFromSeconds(time) });
    await this.feedWindow(time);
    this.onState?.(this.state);
  }

  /** §8.2 — a time stretch, so the source timeline and the cache are untouched. */
  setRate(rate: number): void {
    this.node?.port.postMessage({ type: "rate", value: rate });
  }

  setVolume(volume: number): void {
    if (this.gain) this.gain.gain.value = volume;
  }

  async dispose(): Promise<void> {
    this.node?.port.postMessage({ type: "pause" });
    this.node?.disconnect();
    this.gain?.disconnect();
    await this.context?.close();
    this.context = undefined;
    this.node = undefined;
    this.gain = undefined;
    this.delivered.clear();
  }
}
