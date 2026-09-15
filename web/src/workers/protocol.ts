import type { ReflowDocument } from "../core/reflow";
import type { Block, ChunkTiming, WordTiming } from "../core/types";
import type { BackendDecision } from "../extraction/quality";
import type { EngineInfo } from "../synthesis/kokoroEngine";

/**
 * The seam between the UI and the pipeline.
 *
 * §12 partitioned the Swift build into four agents that "meet only at the §3
 * types". The web has one more boundary than that, and it is a thread: Phase B
 * runs for minutes and a WASM inference pass does not yield, so anything sharing
 * a thread with it gets a stuttering highlight. Extraction, linguistics and
 * synthesis therefore live in a worker, and the UI thread keeps only the audio
 * graph and the two highlight surfaces.
 *
 * Everything crossing this boundary is structured-cloneable, which the §3 types
 * already are.
 */
/**
 * The label the model's graph compile reports under.
 *
 * It lives here, with the rest of the worker's vocabulary, because both sides
 * read it: the engine reports it and `Session.checkForStall` keys its watchdog
 * budget off it. Written out twice, a rename on one side would quietly restore
 * the bug where a slow compile got the worker restarted from under itself. It
 * must also stay out of `kokoroEngine.ts`, which the UI can only import types
 * from — a value import there pulls all of ONNX Runtime onto the main thread.
 */
export const COMPILE_LABEL = "Preparing the model";

export interface EngineSettings {
  modelUrl: string;
  durationModelUrl?: string;
  /**
   * A model the GPU is known to be able to run, tried before the CPU is.
   *
   * `npm run assets -- --gpu-fallback` puts one here. Nothing breaks without
   * it — the path simply 404s and the ladder moves on — so it stays pointed at
   * the file whether or not anyone has fetched it.
   */
  gpuFallbackModelUrl?: string;
  voicesBaseUrl: string;
  vocabUrl?: string;
  voiceID: string;
  /**
   * Which processor synthesis may use.
   *
   * `"auto"` is every GPU this machine has and then the CPU; `"webgpu"` is the
   * GPU or an error; `"wasm"` is the CPU by choice.
   */
  device: "auto" | "webgpu" | "wasm";
  /** CPU threads for the WebAssembly backend; 0 leaves it to the engine. */
  threads: number;
  /**
   * §7.3 — "Dismiss the loading bar when Phase A completes and ~60 s of audio
   * exists." The default is 20 s rather than 60: the reader is fully usable
   * before any of it exists, so the lead only decides when the "rendering
   * ahead" note goes away, and 60 s of it was a minute of being told to wait
   * for something that had already happened.
   */
  initialAudioLead: number;
  /** §7.4 — LRU cap, in bytes. */
  cacheCapBytes: number;
}

export type WorkerRequest =
  /**
   * `pdfAssetBase` is an absolute URL, resolved against the page before it is
   * sent. It cannot be resolved on this side of the boundary: a relative URL
   * inside the worker resolves against the worker script in `assets/`, one
   * directory too deep. See `extraction/pdfAssets.ts`.
   */
  | { type: "configure"; settings: EngineSettings; pdfAssetBase: string }
  | { type: "import"; bytes: ArrayBuffer; fileName: string; allowOcr: boolean }
  | { type: "confirmLowConfidence"; proceed: boolean }
  | { type: "open"; contentHash: string }
  | { type: "renderNow"; chunkIndex: number }
  | { type: "list" }
  | { type: "forget"; contentHash: string }
  | { type: "usage" }
  | { type: "benchmark" }
  | { type: "cancel" };

export interface ImportedDocument {
  contentHash: string;
  title: string;
  pageCount: number;
  blocks: Block[];
  reflow: ReflowDocument;
  words: WordTiming[];
  footnoteTimelines: Record<string, WordTiming[]>;
  chunkFrameOffsets: number[];
  duration: number;
  timingSource: ChunkTiming["source"];
  voiceID: string;
  decision?: BackendDecision;
  diagnostics: string[];
}

export type WorkerEvent =
  | { type: "stage"; stage: string; done: number; total: number }
  /**
   * The voice model, loading in parallel with extraction. It is reported
   * separately from `stage` because the two overlap: the document is being
   * read while the model is still downloading, and collapsing them into one
   * bar would make each look stalled while the other ran.
   */
  | { type: "model"; phase: "loading" | "ready" | "failed"; label: string; done: number; total: number }
  /**
   * §7.3's priming, which is *not* a stage: by the time it starts, Phase A has
   * finished and the reader is already usable — text, timeline, scrubber and
   * seek all work with no audio at all. Folding it back into `stage` would put
   * a loading bar over a working reader, and would leave the UI in a loading
   * state for any document too short to ever reach the lead target.
   */
  | { type: "priming"; seconds: number; target: number }
  | { type: "needsConfirmation"; decision: BackendDecision }
  /**
   * The reader, as soon as there is one. `engine` is absent when the voice
   * model is still loading: §7.2's timeline needs no model, so the document
   * opens on the estimated tier and `engine` follows on its own event rather
   * than holding the reader shut behind a graph compile.
   */
  | { type: "ready"; document: ImportedDocument; engine?: EngineInfo }
  | { type: "engine"; info: EngineInfo }
  | { type: "rendered"; chunkIndex: number; renderedThrough: number; totalChunks: number }
  | {
      type: "timeline";
      words: WordTiming[];
      duration: number;
      chunkFrameOffsets: number[];
      footnoteTimelines?: Record<string, WordTiming[]>;
    }
  | { type: "renderComplete" }
  | { type: "library"; entries: unknown[] }
  | { type: "usage"; audioBytes: number; quotaBytes?: number }
  | { type: "benchmark"; report: string }
  | { type: "error"; message: string; kind?: string };
