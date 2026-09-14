/**
 * §3 — "one frame is 600 samples at 24 kHz, so 40 frames/sec, 0.025 s/frame."
 *
 * Kokoro's duration predictor emits frames, unrounded. Round to at least 1
 * *before* the gather and use the rounded values for timing, so the audio the
 * decoder emits and the timeline the scrubber reads agree exactly. Every
 * rounding in the codebase goes through `roundedFrames`, so there is one rule
 * rather than five.
 */
export const SAMPLE_RATE = 24_000;
export const SAMPLES_PER_FRAME = 600;
export const FRAMES_PER_SECOND = SAMPLE_RATE / SAMPLES_PER_FRAME; // 40
export const SECONDS_PER_FRAME = SAMPLES_PER_FRAME / SAMPLE_RATE; // 0.025

/**
 * The single rounding rule. `max(1, ...)` because a zero-frame token would
 * collapse a word to zero width on the timeline and the highlight would skip
 * straight past it.
 */
export function roundedFrames(raw: number): number {
  return Math.max(1, Math.round(raw));
}

export function roundedFramesAll(raw: ArrayLike<number>): number[] {
  const out = new Array<number>(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = roundedFrames(raw[i]);
  return out;
}

export const secondsFromFrames = (frames: number): number => frames * SECONDS_PER_FRAME;
export const framesFromSeconds = (seconds: number): number => Math.round(seconds * FRAMES_PER_SECOND);
export const samplesFromFrames = (frames: number): number => frames * SAMPLES_PER_FRAME;
export const secondsFromSamples = (samples: number): number => samples / SAMPLE_RATE;
export const samplesFromSeconds = (seconds: number): number => Math.round(seconds * SAMPLE_RATE);

/**
 * §5 / §4.6 — inter-chunk silence. Kokoro ignores inline markup, so paragraph
 * pauses are real silence written between rendered chunks.
 */
export const Pause = {
  /** §5: 300-500 ms */
  paragraph: 0.4,
  /** §4.6: 400 ms before and after a heading */
  heading: 0.4,
  /** a split block is one utterance */
  withinBlock: 0,
  frames: (interval: number): number => framesFromSeconds(interval),
} as const;
