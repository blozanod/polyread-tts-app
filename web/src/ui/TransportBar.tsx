import { useCallback, useRef } from "react";

/**
 * §8.4 — "Play / pause. Skip ±15 s, snapped to the nearest `WordTiming`
 * boundary… Previous / next paragraph, using `Block` boundaries. Scrubber over
 * the `[WordTiming]` timeline, with the §7.3 buffer edge drawn on it."
 *
 * The buffer edge is drawn permanently, per §7.3: "Show the rendered-through
 * edge on the scrubber permanently, like a video preload bar. Most of the time
 * it sits pinned at the end." Seeking past it is allowed and triggers an
 * on-demand render, which is the rest of that paragraph.
 */
export interface TransportBarProps {
  time: number;
  duration: number;
  renderedThrough: number;
  playing: boolean;
  rate: number;
  /** False while the timeline's tail is still an estimate. */
  exact: boolean;
  onToggle(): void;
  onSkip(delta: number): void;
  onSeek(time: number): void;
  onPreviousBlock(): void;
  onNextBlock(): void;
  onRate(rate: number): void;
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

export function TransportBar(props: TransportBarProps): JSX.Element {
  const { time, duration, renderedThrough, playing, rate, exact } = props;
  const trackRef = useRef<HTMLDivElement>(null);

  const seekFromPoint = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || duration <= 0) return;
      const rect = track.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      props.onSeek(fraction * duration);
    },
    [duration, props],
  );

  // The last chunk's audio can run a few frames past the timeline's last word,
  // so the bar is clamped rather than allowed to overflow its track.
  const progress = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  const buffered = duration > 0 ? Math.min(100, (renderedThrough / duration) * 100) : 0;

  return (
    <div className="transport">
      <div
        className="scrubber"
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          seekFromPoint(event.clientX);
        }}
        onPointerMove={(event) => {
          if (event.buttons === 1) seekFromPoint(event.clientX);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") props.onSkip(-15);
          if (event.key === "ArrowRight") props.onSkip(15);
        }}
      >
        <div className="scrubber-track" />
        <div className="scrubber-buffered" style={{ width: `${buffered}%` }} />
        <div className="scrubber-played" style={{ width: `${progress}%` }} />
        <div className="scrubber-thumb" style={{ left: `${progress}%` }} />
      </div>

      <div className="transport-row">
        <span className="time" title={exact ? "Exact" : "Total is an estimate until rendering finishes"}>
          {formatTime(Math.min(time, duration || time))} / {exact ? "" : "~"}
          {formatTime(duration)}
        </span>

        <div className="controls">
          <button type="button" onClick={props.onPreviousBlock} title="Previous paragraph" aria-label="Previous paragraph">
            ⏮
          </button>
          <button type="button" onClick={() => props.onSkip(-15)} title="Back 15 seconds" aria-label="Back 15 seconds">
            −15
          </button>
          <button type="button" className="play" onClick={props.onToggle} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <button type="button" onClick={() => props.onSkip(15)} title="Forward 15 seconds" aria-label="Forward 15 seconds">
            +15
          </button>
          <button type="button" onClick={props.onNextBlock} title="Next paragraph" aria-label="Next paragraph">
            ⏭
          </button>
        </div>

        <label className="rate">
          <span className="sr-only">Speed</span>
          <select value={rate} onChange={(event) => props.onRate(Number(event.target.value))}>
            {RATES.map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}
