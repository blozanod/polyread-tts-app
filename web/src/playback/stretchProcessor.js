/**
 * PolyRead's playback graph, as one AudioWorklet.
 *
 * §8.1 asked for `AVAudioPlayerNode -> AVAudioUnitTimePitch -> mainMixer`, and
 * §8.2 for speed as a time stretch rather than a resample. The Web Audio API has
 * no time-pitch unit: `AudioBufferSourceNode.playbackRate` resamples, which
 * shifts the pitch, and every third-party stretcher reports position in *output*
 * time. §8.3 is emphatic that the highlight must read the *source* timeline —
 * "That is the *source* timeline, pre-time-stretch, so `[WordTiming]` indexes
 * directly and needs **no** rate rescaling. This deletes v1 §5's rescaling
 * workaround along with the drift class of bugs it was patching."
 *
 * So the stretcher is written here, where `sourcePosition` is a state variable
 * rather than something inferred afterwards. It is WSOLA: overlap-add with a
 * cross-correlation search for the splice point, which is what keeps a voice
 * from sounding warbly at 1.5x.
 *
 * Three other things fall out of owning this:
 *
 *  - **Sparse audio.** §7.3 wants seeking into unrendered territory to work, so
 *    the source is a set of segments with holes, not a buffer. A read that lands
 *    in a hole returns silence and reports starvation, which is how "play to the
 *    rendered edge and stop there" is implemented.
 *  - **Bounded memory.** A 90-minute document is 518 MB of float32. The worklet
 *    holds a window around the playhead and the main thread keeps it fed, so
 *    memory is flat whatever the document's length.
 *  - **Rate conversion.** Kokoro emits 24 kHz; the output device is usually
 *    48 kHz and is not always willing to be told otherwise. The stretcher works
 *    in source samples throughout and interpolates once, on the way out.
 */

const SOURCE_RATE = 24000;

// ~43 ms at 24 kHz. Long enough for the correlation search to lock on, short
// enough that a splice is not audible as an echo.
const WINDOW = 1024;
const OVERLAP = WINDOW >> 1;
const SEARCH = 256;
const SEARCH_STRIDE = 4;

function hann(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

/** The rendered audio the worklet currently holds: sorted, possibly with holes. */
class SourceWindow {
  constructor() {
    this.segments = [];
  }

  add(start, data) {
    const segment = { start, end: start + data.length, data };
    let lo = 0;
    let hi = this.segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.segments[mid].start < start) lo = mid + 1;
      else hi = mid;
    }
    if (this.segments[lo] && this.segments[lo].start === start) this.segments[lo] = segment;
    else this.segments.splice(lo, 0, segment);
  }

  evictBefore(sample) {
    let drop = 0;
    while (drop < this.segments.length && this.segments[drop].end <= sample) drop++;
    if (drop > 0) this.segments.splice(0, drop);
  }

  clear() {
    this.segments = [];
  }

  /**
   * Copies `length` samples starting at `start` into `out`, zero-filling holes.
   * Returns how many of them were real.
   */
  read(start, length, out) {
    out.fill(0, 0, length);
    let covered = 0;
    let index = 0;
    // Segments are few (a listening window is tens of chunks), so a scan beats
    // a binary search plus the bookkeeping to keep it correct across holes.
    while (index < this.segments.length && this.segments[index].end <= start) index++;
    const limit = start + length;
    for (; index < this.segments.length; index++) {
      const segment = this.segments[index];
      if (segment.start >= limit) break;
      const from = Math.max(start, segment.start);
      const to = Math.min(limit, segment.end);
      if (to > from) {
        out.set(segment.data.subarray(from - segment.start, to - segment.start), from - start);
        covered += to - from;
      }
    }
    return covered;
  }
}

class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.window = new SourceWindow();
    this.hann = hann(WINDOW);
    // One interpolation, on the way out. `sampleRate` is the worklet global.
    this.outputRatio = SOURCE_RATE / sampleRate;

    this.playing = false;
    this.rate = 1;
    /** Position in the *source* timeline, in samples. The one §8.3 reads. */
    this.sourcePosition = 0;
    /** Where the next analysis frame is read from, in source samples. */
    this.analysisPosition = 0;
    /** Where the previous frame ended, for the correlation template. */
    this.previousTail = 0;

    /** The stretched stream, at 24 kHz, before output resampling. */
    this.pending = new Float32Array(WINDOW * 8);
    this.readCursor = 0; // fractional, into `pending`
    this.writePos = 0; // where the next analysis frame lands
    this.writtenEnd = 0; // highest index written
    this.finalEnd = 0; // everything below this has both overlap contributions
    this.firstHop = true;

    this.frameBuffer = new Float32Array(WINDOW);
    this.templateBuffer = new Float32Array(OVERLAP);
    this.searchBuffer = new Float32Array(WINDOW + SEARCH * 2);

    this.starved = false;
    this.reportCountdown = 0;
    /** Nothing beyond this sample will ever exist; stop rather than starve. */
    this.endOfStream = Number.POSITIVE_INFINITY;

    this.port.onmessage = (event) => this.handle(event.data);
  }

  handle(message) {
    switch (message.type) {
      case "audio":
        // `samples` arrives as a transferred ArrayBuffer, so this costs nothing.
        this.window.add(message.start, new Float32Array(message.samples));
        break;
      case "evictBefore":
        this.window.evictBefore(message.sample);
        break;
      case "clear":
        this.window.clear();
        break;
      case "play":
        this.playing = true;
        break;
      case "pause":
        this.playing = false;
        break;
      case "rate":
        this.rate = Math.max(0.25, Math.min(4, message.value));
        break;
      case "seek":
        this.seekTo(Math.max(0, message.sample));
        break;
      case "endOfStream":
        this.endOfStream = message.sample;
        break;
      default:
        break;
    }
  }

  seekTo(sample) {
    this.sourcePosition = sample;
    this.analysisPosition = sample;
    this.previousTail = sample;
    this.pending.fill(0);
    this.readCursor = 0;
    this.writePos = 0;
    this.writtenEnd = 0;
    this.finalEnd = 0;
    this.firstHop = true;
    this.starved = false;
  }

  /** Cross-correlation search for the splice that continues the last hop best. */
  findOffset() {
    const template = this.templateBuffer;
    if (this.window.read(this.previousTail, OVERLAP, template) === 0) return 0;

    const searchStart = this.analysisPosition - SEARCH;
    const searchLength = WINDOW + SEARCH * 2;
    const region = this.searchBuffer;
    this.window.read(searchStart, searchLength, region);

    let bestOffset = 0;
    let bestScore = -Infinity;
    for (let offset = -SEARCH; offset <= SEARCH; offset += SEARCH_STRIDE) {
      const base = offset + SEARCH;
      if (base < 0 || base + OVERLAP > searchLength) continue;
      let dot = 0;
      let energy = 1e-9;
      // Every fourth sample: the correlation surface of speech is smooth at this
      // scale and the full sum costs four times as much for no audible gain.
      for (let i = 0; i < OVERLAP; i += SEARCH_STRIDE) {
        const v = region[base + i];
        dot += v * template[i];
        energy += v * v;
      }
      const score = dot / Math.sqrt(energy);
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    return bestOffset;
  }

  compact() {
    const shift = Math.floor(this.readCursor) - OVERLAP;
    if (shift <= 0) return;
    this.pending.copyWithin(0, shift, this.writtenEnd);
    this.pending.fill(0, Math.max(0, this.writtenEnd - shift));
    this.readCursor -= shift;
    this.writePos -= shift;
    this.writtenEnd -= shift;
    this.finalEnd -= shift;
  }

  /** Produces one hop (OVERLAP finished samples) into `pending`. */
  produceHop() {
    if (this.writePos + WINDOW > this.pending.length) this.compact();
    if (this.writePos + WINDOW > this.pending.length) {
      // Still no room: the reader has stalled. Drop the backlog rather than
      // grow without bound.
      this.seekTo(this.sourcePosition);
      return;
    }

    const offset = this.rate === 1 ? 0 : this.findOffset();
    const readAt = Math.max(0, this.analysisPosition + offset);
    const covered = this.window.read(readAt, WINDOW, this.frameBuffer);
    this.starved = covered < WINDOW * 0.5 && readAt < this.endOfStream;

    const base = this.writePos;
    if (this.firstHop) {
      // Opening frame: full gain through the first half, so a seek starts on a
      // clean sample rather than fading in from nothing.
      for (let i = 0; i < WINDOW; i++) {
        this.pending[base + i] = this.frameBuffer[i] * (i < OVERLAP ? 1 : this.hann[i]);
      }
      this.firstHop = false;
    } else {
      for (let i = 0; i < WINDOW; i++) {
        const at = base + i;
        const value = this.frameBuffer[i] * this.hann[i];
        if (at < this.writtenEnd) this.pending[at] += value;
        else this.pending[at] = value;
      }
    }

    this.writtenEnd = Math.max(this.writtenEnd, base + WINDOW);
    this.finalEnd = base + OVERLAP;
    this.writePos = base + OVERLAP;

    this.previousTail = readAt + OVERLAP;
    // The whole point: analysis advances by rate, synthesis by one hop.
    this.analysisPosition += Math.round(OVERLAP * this.rate);
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const channel = output[0];
    if (!channel) return true;

    if (!this.playing) {
      for (const c of output) c.fill(0);
      return true;
    }

    // The end of the document is a stop, not a starve. Without this the
    // position keeps climbing through silence and the scrubber reads past the
    // duration — which at 1.5x is a five-second overshoot within a few seconds.
    if (this.sourcePosition >= this.endOfStream) {
      this.playing = false;
      this.sourcePosition = this.endOfStream;
      for (const c of output) c.fill(0);
      this.port.postMessage({ type: "ended", sourcePosition: this.sourcePosition });
      return true;
    }

    const needed = channel.length * this.outputRatio;
    let guard = 0;
    while (this.finalEnd - this.readCursor < needed + 2 && guard < 64) {
      this.produceHop();
      guard += 1;
      if (this.starved) break;
    }

    const consumedStart = this.readCursor;
    for (let i = 0; i < channel.length; i++) {
      const position = this.readCursor;
      const index = Math.floor(position);
      if (index + 1 >= this.finalEnd) {
        channel.fill(0, i);
        break;
      }
      const t = position - index;
      channel[i] = this.pending[index] * (1 - t) + this.pending[index + 1] * t;
      this.readCursor = position + this.outputRatio;
    }
    for (let c = 1; c < output.length; c++) output[c].set(channel);

    // §8.3 — the position advances in *source* samples, so a rate change never
    // needs the timeline rescaled. One output hop of stretched audio corresponds
    // to `rate` source samples per synthesis sample.
    this.sourcePosition += (this.readCursor - consumedStart) * this.rate;

    this.reportCountdown -= 1;
    if (this.reportCountdown <= 0) {
      this.reportCountdown = 4; // finer than a display refresh at any buffer size
      this.port.postMessage({
        type: "position",
        sourcePosition: this.sourcePosition,
        starved: this.starved,
        analysisPosition: this.analysisPosition,
      });
    }
    return true;
  }
}

registerProcessor("polyread-stretch", StretchProcessor);
