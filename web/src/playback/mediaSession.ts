/**
 * §9 — background audio and the lock screen.
 *
 * "`MPNowPlayingInfoCenter`: title from the PDF's document title or filename,
 * duration from Phase A, elapsed time from §8.3. […] Lock screen and AirPods
 * controls are the actual point of the app."
 *
 * The Media Session API is the same surface: it puts the title and artwork on
 * the lock screen and the notification shade, and it is what receives a
 * headphone's play/pause and an AirPods double-tap. In Electron it also claims
 * the keyboard's media keys.
 */
export interface NowPlaying {
  title: string;
  pageCount: number;
  duration: number;
  position: number;
  rate: number;
  playing: boolean;
  artwork?: string;
}

export interface MediaCommands {
  play(): void;
  pause(): void;
  skip(delta: number): void;
  seek(time: number): void;
  previousBlock(): void;
  nextBlock(): void;
}

export function installMediaSession(commands: MediaCommands): () => void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return () => {};
  const session = navigator.mediaSession;

  const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
    ["play", () => commands.play()],
    ["pause", () => commands.pause()],
    // §8.4 — "Skip ±15 s, snapped to the nearest `WordTiming` boundary".
    ["seekforward", (details) => commands.skip(details.seekOffset ?? 15)],
    ["seekbackward", (details) => commands.skip(-(details.seekOffset ?? 15))],
    ["previoustrack", () => commands.previousBlock()],
    ["nexttrack", () => commands.nextBlock()],
    [
      "seekto",
      (details) => {
        if (typeof details.seekTime === "number") commands.seek(details.seekTime);
      },
    ],
  ];

  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // Not every browser implements every action; the ones it does still work.
    }
  }

  return () => {
    for (const [action] of handlers) {
      try {
        session.setActionHandler(action, null);
      } catch {
        // Nothing to undo if it was never installed.
      }
    }
  };
}

export function updateNowPlaying(info: NowPlaying): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const session = navigator.mediaSession;

  session.metadata = new MediaMetadata({
    title: info.title,
    artist: "PolyRead",
    album: `${info.pageCount} page${info.pageCount === 1 ? "" : "s"}`,
    artwork: info.artwork ? [{ src: info.artwork, sizes: "512x512", type: "image/png" }] : [],
  });
  session.playbackState = info.playing ? "playing" : "paused";

  try {
    // Duration can be an estimate on the no-duration-model tier; the lock screen
    // scrubber still wants a number, and it firms up as Phase B commits.
    session.setPositionState({
      duration: Math.max(info.duration, info.position),
      position: Math.min(info.position, Math.max(info.duration, info.position)),
      playbackRate: info.rate,
    });
  } catch {
    // Safari throws on a position past the duration during a re-layout.
  }
}
