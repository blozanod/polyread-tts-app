import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageView } from "./PageView";
import { ReflowView } from "./ReflowView";
import { SettingsPanel } from "./SettingsPanel";
import { formatTime, TransportBar } from "./TransportBar";
import { desktopBridge } from "./desktop";
import { Session, type SessionState } from "./session";
import { loadSettings, saveSettings, type AppSettings } from "./settings";

type Screen = "library" | "reader" | "settings";

export function App(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const sessionRef = useRef<Session>();
  if (!sessionRef.current) sessionRef.current = new Session(settings);
  const session = sessionRef.current;

  const [state, setState] = useState<SessionState>();
  const [screen, setScreen] = useState<Screen>("library");
  const [original, setOriginal] = useState<ArrayBuffer>();

  useEffect(() => {
    session.start();
    const unsubscribe = session.subscribe(setState);
    return () => {
      unsubscribe();
      void session.stop();
    };
  }, [session]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  const applySettings = useCallback(
    (next: AppSettings) => {
      setSettings(next);
      saveSettings(next);
      session.updateSettings(next);
    },
    [session],
  );

  // §10's "size class selects the listening surface", as a media query.
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 900px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 900px)");
    const listener = (event: MediaQueryListEvent): void => setWide(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  const surface = settings.surface === "auto" ? (wide ? "page" : "reflow") : settings.surface;

  // Opening a document takes you to it — but only once, when it becomes the
  // current document. Keying this on the status instead would bounce you
  // straight back here every time you tried to return to the library.
  const shown = useRef<string>();
  useEffect(() => {
    const hash = state?.document?.contentHash;
    if (state?.status.kind === "ready" && hash && shown.current !== hash) {
      shown.current = hash;
      setScreen("reader");
    }
  }, [state?.status.kind, state?.document?.contentHash]);

  // The page surface needs the PDF itself; the reflow surface never does.
  useEffect(() => {
    const hash = state?.document?.contentHash;
    if (!hash || surface !== "page") {
      setOriginal(undefined);
      return;
    }
    let cancelled = false;
    void session.originalBytes(hash).then((bytes) => {
      if (!cancelled) setOriginal(bytes);
    });
    return () => {
      cancelled = true;
    };
  }, [session, state?.document?.contentHash, surface]);

  // "Open with PolyRead" from the Finder, Explorer or a file manager.
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    return bridge.onOpenFile(({ name, bytes }) => {
      void session.importFile(new File([bytes], name, { type: "application/pdf" }));
    });
  }, [session]);

  // §8.4 from the keyboard, which is what a desktop build is for.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      switch (event.key) {
        case " ":
          event.preventDefault();
          void session.toggle();
          break;
        case "ArrowLeft":
          void session.skip(-15);
          break;
        case "ArrowRight":
          void session.skip(15);
          break;
        case "ArrowUp":
          void session.previousBlock();
          break;
        case "ArrowDown":
          void session.nextBlock();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session]);

  if (!state) return <div className="boot">Starting…</div>;

  return (
    <div className="app">
      <header className="chrome">
        <button
          type="button"
          className="brand"
          onClick={() => setScreen("library")}
          title="Library"
        >
          PolyRead
        </button>
        {state.document && screen !== "reader" && (
          <button type="button" className="ghost" onClick={() => setScreen("reader")}>
            Back to {state.document.title}
          </button>
        )}
        <div className="spacer" />
        {state.document && <span className="doc-title">{state.document.title}</span>}
        <button type="button" className="ghost" onClick={() => setScreen("settings")}>
          Settings
        </button>
      </header>

      <StatusBanner state={state} session={session} />

      <main className={`screen screen-${screen}`}>
        {screen === "library" && (
          <Library state={state} session={session} onOpen={() => setScreen("reader")} />
        )}

        {screen === "settings" && (
          <SettingsPanel
            settings={settings}
            state={state}
            onChange={applySettings}
            onBenchmark={() => session.runBenchmark()}
          />
        )}

        {screen === "reader" && state.document && (
          <>
            <div className="surface">
              {surface === "reflow" || !original ? (
                <ReflowView
                  reflow={state.document.reflow}
                  words={state.document.words}
                  wordIndex={state.wordIndex}
                  onSeekToWord={(index) => void session.seekToWord(index)}
                  onFootnote={() => {
                    /* §8.5 interjection is not wired yet; the marker is inert. */
                  }}
                />
              ) : (
                <PageView
                  bytes={original}
                  words={state.document.words}
                  wordIndex={state.wordIndex}
                  onSeekToWord={(index) => void session.seekToWord(index)}
                />
              )}
            </div>
            {state.priming && !state.renderComplete && (
              <div className="priming">
                Rendering ahead — {Math.round(state.priming.seconds)}s of {Math.round(state.priming.target)}s
                buffered. You can start reading; playback stops at the edge.
              </div>
            )}
            <TransportBar
              time={state.time}
              duration={state.duration}
              renderedThrough={state.renderedThrough}
              playing={state.playing}
              rate={state.rate}
              exact={state.renderComplete || state.document.timingSource === "model"}
              onToggle={() => void session.toggle()}
              onSkip={(delta) => void session.skip(delta)}
              onSeek={(time) => void session.seek(time)}
              onPreviousBlock={() => void session.previousBlock()}
              onNextBlock={() => void session.nextBlock()}
              onRate={(rate) => session.setRate(rate)}
            />
          </>
        )}
      </main>
    </div>
  );
}

function StatusBanner({ state, session }: { state: SessionState; session: Session }): JSX.Element | null {
  const { status } = state;

  if (status.kind === "working") {
    const percent = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
    return (
      <div className="banner banner-working">
        <div className="bar">
          <div className="bar-fill" style={{ width: `${percent}%` }} />
        </div>
        <span>
          {status.stage}
          {status.total > 1 ? ` — ${status.done} of ${status.total}` : "…"}
        </span>
      </div>
    );
  }

  if (status.kind === "confirm") {
    // §4.2 — "If OCR also scores badly, surface it in the import flow and let
    // the user decide whether to continue — do not silently synthesize
    // nonsense, and do not refuse outright."
    const { embeddedQuality, ocrQuality } = status.decision;
    return (
      <div className="banner banner-warn">
        <p>
          Neither the embedded text layer nor recognition produced convincing English. Function-word
          rate was {(embeddedQuality.functionWordRatio * 100).toFixed(0)}% embedded
          {ocrQuality ? `, ${(ocrQuality.functionWordRatio * 100).toFixed(0)}% recognized` : ""} — a
          clean page is 35–50%. It will probably read as nonsense.
        </p>
        <div className="banner-actions">
          <button type="button" onClick={() => session.confirmLowConfidence(true)}>
            Continue anyway
          </button>
          <button type="button" className="ghost" onClick={() => session.confirmLowConfidence(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (status.kind === "error") {
    return (
      <div className="banner banner-error">
        <p>{status.message}</p>
        {status.detail && <p className="detail">{status.detail}</p>}
      </div>
    );
  }

  if (state.diagnostics.length > 0 && status.kind === "ready") {
    return (
      <details className="banner banner-info">
        <summary>{state.diagnostics.length} import note(s)</summary>
        <ul>
          {state.diagnostics.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </details>
    );
  }

  return null;
}

function Library({
  state,
  session,
  onOpen,
}: {
  state: SessionState;
  session: Session;
  onOpen: () => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const openFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (!file) return;
      void session.importFile(file);
      // Straight to the reader, where the progress bar has context. The effect
      // above only fires on a *new* document, so reopening the one you were
      // just reading would otherwise leave you sitting in the library.
      onOpen();
    },
    [session, onOpen],
  );

  const totalMB = useMemo(() => (state.usage.audioBytes / 1024 ** 2).toFixed(0), [state.usage.audioBytes]);

  return (
    <div className="library">
      <div
        className={dragging ? "dropzone dropzone-active" : "dropzone"}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          openFiles(event.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(event) => openFiles(event.target.files)}
        />
        <strong>Drop a PDF here</strong>
        <span>or click to choose one. Nothing leaves this machine.</span>
      </div>

      {state.library.length > 0 && (
        <>
          <h2>
            Recent <span className="muted">· {totalMB} MB of audio cached</span>
          </h2>
          <ul className="documents">
            {state.library.map((entry) => (
              <li key={entry.contentHash}>
                <button
                  type="button"
                  className="doc"
                  onClick={() => {
                    session.open(entry.contentHash);
                    onOpen();
                  }}
                >
                  <span className="doc-name">{entry.title}</span>
                  <span className="doc-meta">
                    {entry.pageCount} pages · {formatTime(entry.duration)} ·{" "}
                    {entry.totalChunks > 0
                      ? `${Math.round((entry.renderedChunks / entry.totalChunks) * 100)}% rendered`
                      : "not rendered"}
                    {entry.timingSource === "estimated" ? " · estimated timings" : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => session.forget(entry.contentHash)}
                  title="Remove from the library and delete its cached audio"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
