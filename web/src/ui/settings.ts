import type { EngineSettings } from "../workers/protocol";
import { DEFAULT_VOICE } from "../synthesis/voices";

/**
 * Where the model files live, and the handful of things §7 left as settings.
 *
 * The defaults point at `public/models/`, which `npm run assets` fills. That is
 * what makes the desktop builds and a self-hosted copy work with no network at
 * all: the app fetches its own origin. Point `modelUrl` somewhere else — a CDN,
 * a LAN box — and nothing else changes.
 */
const KEY = "polyread.settings.v1";

export interface AppSettings extends EngineSettings {
  /** §8.2 — playback speed, applied as a time stretch. */
  rate: number;
  /** §10 — which surface the reader shows. "auto" follows the window width. */
  surface: "auto" | "reflow" | "page";
  /** §4.2 — whether a bad text layer may fall back to OCR. */
  allowOcr: boolean;
  theme: "system" | "light" | "dark";
}

export const DEFAULT_SETTINGS: AppSettings = {
  modelUrl: "models/kokoro.onnx",
  durationModelUrl: "models/kokoro-duration.onnx",
  gpuModelUrl: "models/kokoro-gpu.onnx",
  voicesBaseUrl: "models/voices",
  vocabUrl: "models/tokenizer.json",
  voiceID: DEFAULT_VOICE,
  device: "auto",
  threads: 0,
  initialAudioLead: 20,
  cacheCapBytes: 4 * 1024 ** 3,
  rate: 1,
  surface: "auto",
  allowOcr: true,
  theme: "system",
};

export function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(KEY);
    if (!stored) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(stored) as Partial<AppSettings> & { gpuFallbackModelUrl?: string };
    // Renamed when the full-precision model stopped being a fallback and
    // became the GPU's first choice; a path someone set by hand carries over.
    const { gpuFallbackModelUrl, ...rest } = parsed;
    if (gpuFallbackModelUrl !== undefined && rest.gpuModelUrl === undefined) rest.gpuModelUrl = gpuFallbackModelUrl;
    return { ...DEFAULT_SETTINGS, ...rest };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private browsing. The defaults are usable; losing the preference is not
    // worth failing an import over.
  }
}

/**
 * Resolves a model path against the *page*, not against whatever is doing the
 * fetching.
 *
 * The defaults are relative — "models/kokoro.onnx" — so that the same build
 * works from a domain root, from blozanod.me/PolyRead/, and from the local
 * server the desktop app runs. But the fetch happens inside the pipeline
 * worker, where a relative URL resolves against the worker's own script, which
 * lives in assets/. That would look for assets/models/kokoro.onnx and 404. So
 * the resolution happens here, on the main thread, before the settings cross
 * the thread boundary.
 */
function resolveAgainstPage(url: string): string {
  if (!url) return url;
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return url;
  }
}

export function engineSettingsOf(settings: AppSettings): EngineSettings {
  return {
    modelUrl: resolveAgainstPage(settings.modelUrl),
    durationModelUrl: settings.durationModelUrl ? resolveAgainstPage(settings.durationModelUrl) : undefined,
    gpuModelUrl: settings.gpuModelUrl ? resolveAgainstPage(settings.gpuModelUrl) : undefined,
    voicesBaseUrl: resolveAgainstPage(settings.voicesBaseUrl),
    vocabUrl: settings.vocabUrl ? resolveAgainstPage(settings.vocabUrl) : undefined,
    voiceID: settings.voiceID,
    device: settings.device,
    threads: settings.threads,
    initialAudioLead: settings.initialAudioLead,
    cacheCapBytes: settings.cacheCapBytes,
  };
}
