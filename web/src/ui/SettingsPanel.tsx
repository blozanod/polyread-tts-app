import { VOICES } from "../synthesis/voices";
import type { SessionState } from "./session";
import { DEFAULT_SETTINGS, type AppSettings } from "./settings";

/**
 * Settings, plus the web's version of the §0 gate.
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
export interface SettingsPanelProps {
  settings: AppSettings;
  state: SessionState;
  onChange(settings: AppSettings): void;
  onBenchmark(): void;
}

export function SettingsPanel({ settings, state, onChange, onBenchmark }: SettingsPanelProps) {
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void =>
    onChange({ ...settings, [key]: value });

  const usedMB = (state.usage.audioBytes / 1024 ** 2).toFixed(0);
  const quotaMB = state.usage.quotaBytes ? (state.usage.quotaBytes / 1024 ** 2).toFixed(0) : undefined;

  return (
    <div className="settings">
      <section>
        <h2>Voice</h2>
        <label>
          <span>Voice</span>
          <select value={settings.voiceID} onChange={(event) => set("voiceID", event.target.value)}>
            {VOICES.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name} — {voice.language === "en-us" ? "American" : "British"} {voice.gender.toLowerCase()} (
                {voice.grade})
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          Changing the voice re-runs the pipeline for the next document you open; documents already
          rendered keep the voice they were rendered with.
        </p>
      </section>

      <section>
        <h2>Reading</h2>
        <label>
          <span>Surface</span>
          <select
            value={settings.surface}
            onChange={(event) => set("surface", event.target.value as AppSettings["surface"])}
          >
            <option value="auto">Automatic — reflowed text on a narrow window, pages on a wide one</option>
            <option value="reflow">Reflowed text</option>
            <option value="page">Rendered pages</option>
          </select>
        </label>
        <label>
          <span>Theme</span>
          <select
            value={settings.theme}
            onChange={(event) => set("theme", event.target.value as AppSettings["theme"])}
          >
            <option value="system">Follow the system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.allowOcr}
            onChange={(event) => set("allowOcr", event.target.checked)}
          />
          <span>Recognize text in scanned PDFs (downloads an OCR engine the first time)</span>
        </label>
      </section>

      <section>
        <h2>Engine</h2>
        <label>
          <span>Compute</span>
          <select
            value={settings.device}
            onChange={(event) => set("device", event.target.value as AppSettings["device"])}
          >
            <option value="auto">Automatic — WebGPU if available</option>
            <option value="webgpu">WebGPU</option>
            <option value="wasm">CPU (WebAssembly)</option>
          </select>
        </label>
        <label>
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
          One thread, which always works. More is faster on the CPU backend but hangs on some
          browsers, because the engine starts its threads as workers and this already runs in one.
          If it hangs, PolyRead notices and retries on one thread. WebGPU ignores this entirely.
        </p>
        <label>
          <span>Model</span>
          <input value={settings.modelUrl} onChange={(event) => set("modelUrl", event.target.value)} />
        </label>
        <label>
          <span>Duration model</span>
          <input
            value={settings.durationModelUrl ?? ""}
            placeholder="optional — exact word timings"
            onChange={(event) => set("durationModelUrl", event.target.value)}
          />
        </label>
        <label>
          <span>Voices folder</span>
          <input value={settings.voicesBaseUrl} onChange={(event) => set("voicesBaseUrl", event.target.value)} />
        </label>
        <label>
          <span>Audio before the reader opens</span>
          <input
            type="number"
            min={10}
            max={600}
            value={settings.initialAudioLead}
            onChange={(event) => set("initialAudioLead", Number(event.target.value))}
          />
        </label>
        <button type="button" className="ghost" onClick={() => onChange({ ...DEFAULT_SETTINGS, rate: settings.rate })}>
          Reset to defaults
        </button>
      </section>

      <section>
        <h2>Storage</h2>
        <p>
          {usedMB} MB of rendered audio cached{quotaMB ? ` · the browser allows about ${quotaMB} MB` : ""}.
        </p>
        <label>
          <span>Cache limit (GB)</span>
          <input
            type="number"
            min={1}
            max={64}
            step={1}
            value={Math.round(settings.cacheCapBytes / 1024 ** 3)}
            onChange={(event) => set("cacheCapBytes", Math.max(1, Number(event.target.value)) * 1024 ** 3)}
          />
        </label>
        <p className="hint">
          When the cache is over the limit, whole documents are dropped oldest-opened first. Their
          timelines stay, so reopening one is instant and only the audio is rendered again.
        </p>
      </section>

      <section>
        <h2>Benchmark</h2>
        <p className="hint">
          Measures throughput on this machine, and checks that the phoneme vocabulary matches the
          model and that every override-table entry can be encoded in it. Both of those fail as
          fluent nonsense rather than as errors, which is why they are checked here.
        </p>
        <button type="button" onClick={onBenchmark}>
          Run it
        </button>
        {state.engine && (
          <p className="hint">
            Currently: {state.engine.device}, timings{" "}
            {state.engine.timingSource === "model" ? "exact" : "estimated"}.
          </p>
        )}
        {state.benchmark && <pre className="report">{state.benchmark}</pre>}
      </section>
    </div>
  );
}
