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
export interface EngineSettings {
  modelUrl: string;
  durationModelUrl?: string;
  voicesBaseUrl: string;
  vocabUrl?: string;
  voiceID: string;
  device: "auto" | "webgpu" | "wasm";
  /** CPU threads for the WebAssembly backend; 0 leaves it to the engine. */
  threads: number;
  /** §7.3 — "Dismiss the loading bar when Phase A completes and ~60 s of audio exists." */
  initialAudioLead: number;
  /** §7.4 — LRU cap, in bytes. */
  cacheCapBytes: number;
}

export type WorkerRequest =
  | { type: "configure"; settings: EngineSettings }
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
   * §7.3's priming, which is *not* a stage: by the time it starts, Phase A has
   * finished and the reader is already usable — text, timeline, scrubber and
   * seek all work with no audio at all. Folding it back into `stage` would put
   * a loading bar over a working reader, and would leave the UI in a loading
   * state for any document too short to ever reach the lead target.
   */
  | { type: "priming"; seconds: number; target: number }
  | { type: "needsConfirmation"; decision: BackendDecision }
  | { type: "ready"; document: ImportedDocument; engine: EngineInfo }
  | { type: "rendered"; chunkIndex: number; renderedThrough: number; totalChunks: number }
  | { type: "timeline"; words: WordTiming[]; duration: number; chunkFrameOffsets: number[] }
  | { type: "renderComplete" }
  | { type: "library"; entries: unknown[] }
  | { type: "usage"; audioBytes: number; quotaBytes?: number }
  | { type: "benchmark"; report: string }
  | { type: "error"; message: string; kind?: string };
