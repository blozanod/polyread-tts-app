import type { ReactElement, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { VOICES } from "../synthesis/voices";
import type { SessionState } from "./session";
import { DEFAULT_SETTINGS, type AppSettings } from "./settings";

/**
 * Settings, as a floating sheet over whatever you were doing.
 *
 * It used to be a third screen, which meant leaving the document to change the
 * speed of the document. It is a `<dialog>` now: Escape closes it, the backdrop
 * closes it, focus is trapped, and the reader is still there underneath.
 *
 * The other change is what is on top. Four things decide how this app sounds
 * and looks — voice, surface, theme, OCR — and everything else is plumbing:
 * execution provider, thread count, four URLs, a cache cap, a benchmark. The
 * plumbing is real and stays, but it is behind a disclosure, because a settings
 * panel that opens on `modelUrl` reads as somebody's build config rather than
 * an app.
 *
 * ## The §0 gate, such as it survives the port
 *
 * §0's three questions were about an iPhone: acoustic throughput, whether the
 * acoustic package would run CPU-only while backgrounded, and whether
 * MisakiSwift grouped phonemes per word. Two of those are gone — a browser tab
 * has no Metal-in-the-background problem, and eSpeak's grouping is settled by
 * `espeakPhonemizer.ts` and enforced by the chunker. §0.1 survives intact and
 * decides the same thing it always did: whether rendering outruns playback.
 * The two checks `docs/gate-0.md` added on its own account — vocabulary
 * agreement and override-table encodability — survive as well.
 */
export interface SettingsSheetProps {
  open: boolean;
  settings: AppSettings;
  state: SessionState;
  onChange(settings: AppSettings): void;
  onBenchmark(): void;
  onClose(): void;
}

export function SettingsSheet({
  open,
  settings,
  state,
  onChange,
  onBenchmark,
  onClose,
}: SettingsSheetProps): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);

  // `showModal` is what gives the backdrop, the focus trap and Escape; React
  // cannot express it as a prop, so it is driven here.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void =>
    onChange({ ...settings, [key]: value });

  const usedMB = (state.usage.audioBytes / 1024 ** 2).toFixed(0);
  const quotaMB = state.usage.quotaBytes
    ? (state.usage.quotaBytes / 1024 ** 2).toFixed(0)
    : undefined;

  return (
    <dialog
      className="sheet"
      ref={ref}
      onClose={onClose}
      // A click that lands on the dialog element itself landed on the
      // backdrop; anything inside a child stops before it gets here.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="sheet-head">
        <span className="sheet-title">Settings</span>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>

      <div className="sheet-body">
        <section className="field-group">
          <h3>Voice</h3>
          <div className="voice-grid">
            {VOICES.map((voice) => (
              <button
                key={voice.id}
                type="button"
                className="voice"
                aria-pressed={settings.voiceID === voice.id}
                onClick={() => set("voiceID", voice.id)}
              >
                <span className="voice-name">{voice.name}</span>
                <span className="voice-meta">
                  {voice.language === "en-us" ? "US" : "UK"} · {voice.gender.toLowerCase()} ·{" "}
                  {voice.grade}
                </span>
              </button>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 12 }}>
            A new voice applies to the next document you open; anything already rendered keeps the
            voice it was rendered with. <code>npm run assets</code> fetches the ten graded B or
            better — the rest need <code>--voices all</code> before they will load.
          </p>
        </section>

        <section className="field-group">
          <h3>Reading</h3>
          <label className="field">
            <span>Surface</span>
            <Segmented
              value={settings.surface}
              onChange={(value) => set("surface", value)}
              options={[
                { value: "auto", label: "Auto" },
                { value: "reflow", label: "Text" },
                { value: "page", label: "Pages" },
              ]}
            />
          </label>
          <label className="field">
            <span>Theme</span>
            <Segmented
              value={settings.theme}
              onChange={(value) => set("theme", value)}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.allowOcr}
              onChange={(event) => set("allowOcr", event.target.checked)}
            />
            <span className="switch-text">
              <strong>Recognize text in scanned PDFs</strong>
              Only used when a PDF has no usable text layer of its own. Downloads an OCR engine the
              first time it is needed.
            </span>
          </label>
        </section>

        <section className="field-group">
          <details className="advanced">
            <summary>Advanced</summary>

            <p className="storage-line">
              {usedMB} MB of rendered audio cached
              {quotaMB ? ` · browser allows about ${quotaMB} MB` : ""}
            </p>

            <label className="field">
              <span>Compute</span>
              <Segmented
                value={settings.device}
                onChange={(value) => set("device", value)}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "webgpu", label: "WebGPU" },
                  { value: "wasm", label: "CPU" },
                ]}
              />
            </label>
            <label className="field">
              <span>CPU threads</span>
              <input
                type="number"
                min={0}
                max={16}
                value={settings.threads}
                onChange={(event) => set("threads", Math.max(0, Number(event.target.value)))}
              />
            </label>
            <p className="hint">
              One thread always works. More is faster on the CPU backend but hangs on some browsers,
              because the engine starts its threads as workers and this already runs in one. If it
              hangs, PolyRead notices and retries on one thread. WebGPU ignores this entirely.
            </p>

            <label className="field">
              <span>Audio lead</span>
              <input
                type="number"
                min={5}
                max={600}
                value={settings.initialAudioLead}
                onChange={(event) => set("initialAudioLead", Number(event.target.value))}
              />
            </label>
            <p className="hint">
              Seconds of audio to render before the &ldquo;rendering ahead&rdquo; note goes away.
              Reading works before any of it exists; this only decides when PolyRead stops saying so.
            </p>

            <label className="field">
              <span>Cache limit (GB)</span>
              <input
                type="number"
                min={1}
                max={64}
                step={1}
                value={Math.round(settings.cacheCapBytes / 1024 ** 3)}
                onChange={(event) =>
                  set("cacheCapBytes", Math.max(1, Number(event.target.value)) * 1024 ** 3)
                }
              />
            </label>
            <p className="hint">
              Over the limit, whole documents are dropped oldest-opened first. Their timelines stay,
              so reopening one is instant and only the audio is rendered again.
            </p>

            <label className="field">
              <span>Model</span>
              <input value={settings.modelUrl} onChange={(event) => set("modelUrl", event.target.value)} />
            </label>
            <label className="field">
              <span>Duration model</span>
              <input
                value={settings.durationModelUrl ?? ""}
                placeholder="optional — exact word timings"
                onChange={(event) => set("durationModelUrl", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Voices folder</span>
              <input
                value={settings.voicesBaseUrl}
                onChange={(event) => set("voicesBaseUrl", event.target.value)}
              />
            </label>
            <p className="hint">
              Relative to this page, and filled by <code>npm run assets</code>. That is what keeps
              PolyRead local: after it has run once the app talks to nothing but its own origin.
            </p>

            <div className="status-actions">
              <button type="button" onClick={onBenchmark}>
                Run the benchmark
              </button>
              <button
                type="button"
                className="quiet"
                onClick={() => onChange({ ...DEFAULT_SETTINGS, rate: settings.rate })}
              >
                Reset to defaults
              </button>
            </div>

            <p className="hint" style={{ marginTop: 12 }}>
              The benchmark measures throughput on this machine, and checks that the phoneme
              vocabulary matches the model and that every override-table entry can be encoded in it.
              Both of those fail as fluent nonsense rather than as errors, which is why they are
              checked here.
            </p>

            {state.engine && (
              <p className="storage-line">
                {state.engine.device} · timings{" "}
                {state.engine.timingSource === "model" ? "exact" : "estimated"}
              </p>
            )}
            {state.benchmark && <pre className="report">{state.benchmark}</pre>}
          </details>
        </section>
      </div>
    </dialog>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange(value: T): void;
}): ReactElement {
  return (
    <span className="segmented">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}
