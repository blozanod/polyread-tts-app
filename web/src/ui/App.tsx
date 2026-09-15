import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageView } from "./PageView";
import { ReflowView } from "./ReflowView";
import { SettingsSheet } from "./SettingsPanel";
import { formatTime, TransportBar } from "./TransportBar";
import { desktopBridge } from "./desktop";
import { Session, type SessionState } from "./session";
import { loadSettings, saveSettings, type AppSettings } from "./settings";

/**
 * The shell.
 *
 * There are two places to be — the library and a document — and settings
 * floats over whichever you are in rather than being a third. Everything that
 * is not the document (the header, the status card, the transport) is chrome
 * that either sits above the reading area or floats over it, so the page you
 * are reading is the only thing that ever holds the middle of the screen.
 */
type Screen = "library" | "reader";

export function App() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const sessionRef = useRef<Session | undefined>(undefined);
  if (!sessionRef.current) sessionRef.current = new Session(settings);
  const session = sessionRef.current;

  const [state, setState] = useState<SessionState>();
  const [screen, setScreen] = useState<Screen>("library");
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const shown = useRef<string | undefined>(undefined);
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
      if (settingsOpen) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }
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
  }, [session, settingsOpen]);

  if (!state) return <div className="boot">Starting</div>;

  return (
    <div className="app">
      <header className="site-header">
        <div className="brand">
          <span className="brand-square brand-square--red" />
          <span className="brand-square brand-square--teal" />
          <span className="brand-square brand-square--gold" />
          <a className="brand-link" href="https://blozanod.me/">
            blozanod.me
          </a>
          <span className="brand-sep">/</span>
          <button type="button" className="brand-here" onClick={() => setScreen("library")}>
            PolyRead
          </button>
        </div>

        <div className="header-right">
          <ModelChip state={state} />
          {screen === "reader" && (
            <button type="button" onClick={() => setScreen("library")}>
              Library
            </button>
          )}
          <button type="button" className="solid" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      <div className="color-bar" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>

      <main className="screen">
        {screen === "library" ? (
          <div className="scroll">
            <div className="shell">
              <Hero />
              <VoiceNotice state={state} onSettings={() => setSettingsOpen(true)} />
              <Library state={state} session={session} onOpen={() => setScreen("reader")} />
              <footer className="site-footer">
                <span className="site-footer-name">Bernardo Lozano · PolyRead</span>
                <div className="site-footer-links">
                  <a href="https://blozanod.me/">Portfolio</a>
                  <a
                    href="https://github.com/blozanod/polyread-tts-app"
                    target="_blank"
                    rel="noopener"
                  >
                    Source
                  </a>
                </div>
              </footer>
            </div>
          </div>
        ) : (
          <Reader
            state={state}
            session={session}
            surface={surface}
            original={original}
            onLibrary={() => setScreen("library")}
          />
        )}

        <StatusCard state={state} session={session} onSettings={() => setSettingsOpen(true)} />
      </main>

      <SettingsSheet
        open={settingsOpen}
        settings={settings}
        state={state}
        onChange={applySettings}
        onBenchmark={() => session.runBenchmark()}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

function Hero(): ReactElement {
  return (
    <section className="hero">
      <h1 className="hero-name">
        Poly
        <br />
        Read
      </h1>
      <div className="hero-copy">
        <p className="hero-blurb">
          A subpage of blozanod.me. Drop in an academic PDF and it reads the thing aloud, word by
          word, with the word being spoken lit on the page. The text extraction and the speech
          synthesis both run in this tab — nothing is uploaded.
        </p>
        <div className="hero-badge">
          <span className="hero-badge-dot" />
          <span className="mono-label">Runs on your machine</span>
        </div>
      </div>
    </section>
  );
}

/**
 * The one state worth explaining at length, because it is the state in which
 * nothing works and the reason is not on screen anywhere: the model files were
 * never fetched. A chip in the corner saying "no voice" is a diagnosis, not an
 * answer, so the library says what to run.
 */
function VoiceNotice({
  state,
  onSettings,
}: {
  state: SessionState;
  onSettings: () => void;
}): ReactElement | null {
  if (state.model.kind !== "failed") return null;
  return (
    <div className="notice">
      <div className="notice-head">No voice model</div>
      <p className="notice-body">
        PolyRead can open a PDF and lay it out without one, but it cannot say any of it aloud. The
        model is a one-off download that lives next to the app, not a service it calls:
      </p>
      <pre className="notice-code">npm run assets</pre>
      <p className="notice-body">
        About 330 MB. On a machine with less memory to spare,{" "}
        <code>npm run assets -- --dtype q8</code> is a quarter of that and noticeably faster on a
        CPU. Settings has the paths it looks in.
      </p>
      <div className="status-actions">
        <button type="button" onClick={onSettings}>
          Open settings
        </button>
      </div>
      <p className="notice-detail">{state.model.message}</p>
    </div>
  );
}

function ModelChip({ state }: { state: SessionState }): ReactElement | null {
  const { model } = state;
  if (model.kind === "idle") return null;

  if (model.kind === "loading") {
    const percent = model.total > 1 ? Math.round((model.done / model.total) * 100) : undefined;
    return (
      <span className="model-chip model-chip--loading" title={model.label}>
        <span className="dot" />
        {percent === undefined ? "Voice loading" : `Voice ${percent}%`}
      </span>
    );
  }

  if (model.kind === "failed") {
    return (
      <span className="model-chip model-chip--failed" title={model.message}>
        <span className="dot" />
        No voice
      </span>
    );
  }

  return (
    <span className="model-chip model-chip--ready" title={`Running on ${model.device}`}>
      <span className="dot" />
      Voice ready
    </span>
  );
}

function Reader({
  state,
  session,
  surface,
  original,
  onLibrary,
}: {
  state: SessionState;
  session: Session;
  surface: "page" | "reflow";
  original: ArrayBuffer | undefined;
  onLibrary: () => void;
}): ReactElement {
  const document = state.document;
  if (!document) {
    // Opening a document brings you here before there is one — the import runs
    // for a while and the progress belongs next to where the document will be,
    // not back in the library. Which of the two this is depends entirely on
    // whether the pipeline is still working.
    const working = state.status.kind === "working" || state.status.kind === "confirm";
    return (
      <div className="reader-empty">
        {working ? (
          <>
            <span className="reader-empty-title">Preparing the document</span>
            <span className="mono-label reader-empty-note">
              Extracting the text, then reading it to itself
            </span>
          </>
        ) : (
          <>
            <span className="reader-empty-title">Nothing open</span>
            <button type="button" onClick={onLibrary}>
              Back to the library
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="reader">
      <div className="reader-bar">
        <span className="reader-title">{document.title}</span>
        <span className="reader-meta">
          {document.pageCount} pages · {formatTime(state.duration)}
          {document.timingSource === "estimated" && !state.renderComplete ? " (est.)" : ""}
        </span>
      </div>

      <div className="surface">
        {surface === "reflow" || !original ? (
          <ReflowView
            reflow={document.reflow}
            words={document.words}
            wordIndex={state.wordIndex}
            onSeekToWord={(index) => void session.seekToWord(index)}
            onFootnote={() => {
              /* §8.5 interjection is not wired yet; the marker is inert. */
            }}
          />
        ) : (
          <PageView
            bytes={original}
            words={document.words}
            wordIndex={state.wordIndex}
            onSeekToWord={(index) => void session.seekToWord(index)}
          />
        )}
      </div>

      <TransportBar
        time={state.time}
        duration={state.duration}
        renderedThrough={state.renderedThrough}
        playing={state.playing}
        rate={state.rate}
        exact={state.renderComplete || document.timingSource === "model"}
        note={transportNote(state)}
        onToggle={() => void session.toggle()}
        onSkip={(delta) => void session.skip(delta)}
        onSeek={(time) => void session.seek(time)}
        onPreviousBlock={() => void session.previousBlock()}
        onNextBlock={() => void session.nextBlock()}
        onRate={(rate) => session.setRate(rate)}
      />
    </div>
  );
}

/**
 * One line, inside the transport, for whatever playback is waiting on.
 *
 * All three cases used to be invisible: the reader would sit in silence with
 * the clock running and nothing on screen to say the audio for that second had
 * not been made yet.
 */
function transportNote(state: SessionState): string | undefined {
  if (state.model.kind === "failed") return "No voice model — playback is unavailable";
  // The reader now opens while the model is still loading, so this has to come
  // before the waiting-for-audio note: "playback resumes on its own" is true
  // either way, but it is not what someone wants to read for the minute the
  // model takes.
  if (state.model.kind === "loading") return "Loading the voice model — playback starts when it lands";
  if (state.waitingForAudio) return "Rendering this passage — playback resumes on its own";
  if (state.priming && !state.renderComplete) {
    return `Rendering ahead — ${Math.round(state.priming.seconds)}s of ${Math.round(state.priming.target)}s ready`;
  }
  return undefined;
}

function StatusCard({
  state,
  session,
  onSettings,
}: {
  state: SessionState;
  session: Session;
  onSettings: () => void;
}): ReactElement | null {
  const [dismissed, setDismissed] = useState<string>();
  const { status } = state;

  // A new message is a new thing to say, so dismissing one does not silence
  // the next.
  const key = `${status.kind}:${status.kind === "error" ? status.message : ""}`;

  if (status.kind === "working") {
    const known = status.total > 1;
    const percent = known ? Math.round((status.done / status.total) * 100) : 0;
    return (
      <div className="status status--working" role="status">
        <div className="status-head">
          <span>{status.stage}</span>
          {known && (
            <span className="status-count">
              {status.done} / {status.total}
            </span>
          )}
        </div>
        <div className="status-bar">
          <div
            className={known ? "status-bar-fill" : "status-bar-fill status-bar-fill--indeterminate"}
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    );
  }

  if (status.kind === "confirm") {
    // §4.2 — "If OCR also scores badly, surface it in the import flow and let
    // the user decide whether to continue — do not silently synthesize
    // nonsense, and do not refuse outright."
    const { embeddedQuality, ocrQuality } = status.decision;
    return (
      <div className="status status--warn" role="alertdialog">
        <div className="status-head">
          <span>The text layer looks unreadable</span>
        </div>
        <p className="status-body">
          Neither the embedded text nor recognition produced convincing English. Function-word rate
          was {(embeddedQuality.functionWordRatio * 100).toFixed(0)}% embedded
          {ocrQuality ? `, ${(ocrQuality.functionWordRatio * 100).toFixed(0)}% recognized` : ""} — a
          clean page is 35–50%. It will probably read as nonsense.
        </p>
        <div className="status-actions">
          <button type="button" className="solid" onClick={() => session.confirmLowConfidence(true)}>
            Continue anyway
          </button>
          <button type="button" onClick={() => session.confirmLowConfidence(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (status.kind === "error" && dismissed !== key) {
    const missing = /model|voices|tokenizer/i.test(status.message);
    return (
      <div className="status status--error" role="alert">
        <div className="status-head">
          <span>{missing ? "The voice model is not here" : "Something went wrong"}</span>
        </div>
        <p className="status-body">{status.message}</p>
        {status.detail && <p className="status-body">{status.detail}</p>}
        <div className="status-actions">
          {missing && (
            <button type="button" onClick={onSettings}>
              Where it looks
            </button>
          )}
          <button type="button" className="quiet" onClick={() => setDismissed(key)}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (state.diagnostics.length > 0 && status.kind === "ready" && dismissed !== `notes:${key}`) {
    return (
      <div className="status status--warn">
        <div className="status-head">
          <span>{state.diagnostics.length} import note(s)</span>
          <button type="button" className="quiet" onClick={() => setDismissed(`notes:${key}`)}>
            Hide
          </button>
        </div>
        <ul className="status-notes">
          {state.diagnostics.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>
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
}): ReactElement {
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

  const totalMB = useMemo(
    () => (state.usage.audioBytes / 1024 ** 2).toFixed(0),
    [state.usage.audioBytes],
  );

  return (
    <>
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
        <span className="dropzone-title">Drop a PDF here</span>
        <span className="dropzone-note">or click to choose one</span>
      </div>

      {state.library.length > 0 && (
        <>
          <div className="section-head library-head">
            <span className="section-title">Library</span>
            <span className="section-note">
              {state.library.length} document{state.library.length === 1 ? "" : "s"} · {totalMB} MB
              cached
            </span>
          </div>

          <ul className="documents">
            {state.library.map((entry, index) => (
              <li key={entry.contentHash}>
                <div className="doc-index">{String(index + 1).padStart(2, "0")}</div>
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
                    <span>{entry.pageCount} pages</span>
                    <span>{formatTime(entry.duration)}</span>
                    <span>
                      {entry.totalChunks > 0
                        ? `${Math.round((entry.renderedChunks / entry.totalChunks) * 100)}% rendered`
                        : "not rendered"}
                    </span>
                    {entry.timingSource === "estimated" && <span>estimated timings</span>}
                  </span>
                </button>
                <div className="doc-actions">
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => session.forget(entry.contentHash)}
                    title="Remove from the library and delete its cached audio"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
