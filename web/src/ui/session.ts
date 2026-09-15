import { PolyReadError } from "../core/errors";
import { Timeline } from "../core/timeline";
import type { WordTiming } from "../core/types";
import { samplesFromSeconds } from "../core/frameMath";
import { AudioEngine } from "../playback/audioEngine";
import { installMediaSession, updateNowPlaying } from "../playback/mediaSession";
import { DocumentStore } from "../synthesis/store";
import type { LibraryEntry } from "../synthesis/store";
import type { EngineInfo } from "../synthesis/kokoroEngine";
import type { BackendDecision } from "../extraction/quality";
import { COMPILE_LABEL } from "../workers/protocol";
import type { ImportedDocument, WorkerEvent, WorkerRequest } from "../workers/protocol";
import type { EngineSettings } from "../workers/protocol";
import { pdfAssetBase } from "../extraction/pdfAssets";
import { engineSettingsOf, type AppSettings } from "./settings";

/**
 * `DocumentSession`'s counterpart: the one place the worker, the audio graph and
 * the two highlight surfaces meet.
 *
 * §10 — "Both surfaces read the same `WordTiming` stream. The current word index
 * is one piece of state; the two views are renderers of it." That sentence is
 * the design of this file. The word index is computed once per display refresh
 * from the engine's source-timeline position and published; nothing else in the
 * UI owns a clock.
 */
export type SessionStatus =
  | { kind: "idle" }
  | { kind: "working"; stage: string; done: number; total: number }
  | { kind: "confirm"; decision: BackendDecision }
  | { kind: "ready" }
  | { kind: "error"; message: string; detail?: string };

export interface SessionState {
  status: SessionStatus;
  document?: ImportedDocument;
  engine?: EngineInfo;
  library: LibraryEntry[];
  usage: { audioBytes: number; quotaBytes?: number };
  /** §8.3 — the current word, and the only piece of playback state the views read. */
  wordIndex: number;
  time: number;
  duration: number;
  playing: boolean;
  rate: number;
  /** §7.3 — "Show the rendered-through edge on the scrubber permanently." */
  renderedThrough: number;
  renderComplete: boolean;
  /** §7.3 — how much audio exists against the lead the reader wants. */
  priming?: { seconds: number; target: number };
  /** The voice model's own progress, which runs alongside `status`. */
  model: ModelStatus;
  /**
   * Set while playback is parked on audio that does not exist yet. The transport
   * says so and resumes itself; previously the worklet read the hole as silence
   * and the clock ran on through a document nobody could hear.
   */
  waitingForAudio: boolean;
  benchmark?: string;
  diagnostics: string[];
  /**
   * Why synthesis is not on the GPU, when it could have been.
   *
   * Its own field rather than one of `diagnostics` because it is the
   * difference between faster than realtime and not, and it has a fix the
   * person can act on — so it belongs where they will see it rather than
   * behind "n import notes".
   */
  deviceNotice?: string;
}

export type ModelStatus =
  | { kind: "idle" }
  | { kind: "loading"; label: string; done: number; total: number }
  | { kind: "ready"; device: string }
  | { kind: "failed"; message: string };

const EMPTY: SessionState = {
  status: { kind: "idle" },
  library: [],
  usage: { audioBytes: 0 },
  wordIndex: -1,
  time: 0,
  duration: 0,
  playing: false,
  rate: 1,
  renderedThrough: 0,
  renderComplete: false,
  model: { kind: "idle" },
  waitingForAudio: false,
  diagnostics: [],
};

export class Session {
  private worker: Worker | undefined;
  private readonly audio = new AudioEngine();
  private readonly store = new DocumentStore();
  private readonly listeners = new Set<(state: SessionState) => void>();
  private state: SessionState = EMPTY;
  private timeline = new Timeline([]);
  private chunkStartSamples: number[] = [];
  private rendered = new Set<number>();
  private frame = 0;
  private settings: AppSettings;
  private uninstallMedia: (() => void) | undefined;
  private pendingOnDemand = -1;
  /** The last import or open, kept so a stalled worker can be retried. */
  private lastRequest: WorkerRequest | undefined;
  private lastEventAt = Date.now();
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private threadOverride: number | undefined;
  /** Set when starvation paused playback, so the chunk landing can resume it. */
  private resumeWhenRendered = -1;
  /**
   * Notes about the engine itself — a rejected execution provider, a fall back
   * to the CPU. Kept apart from the import's own diagnostics because they
   * happen before there is a document and would otherwise be replaced by the
   * `ready` that follows them.
   */
  private engineNotes: string[] = [];

  constructor(settings: AppSettings) {
    this.settings = settings;
    this.state = { ...EMPTY, rate: settings.rate };
  }

  // MARK: Lifecycle

  start(): void {
    this.spawnWorker();
    this.send({ type: "list" });
    this.send({ type: "usage" });

    this.audio.setProvider((index) => this.store.getAudio(this.state.document?.contentHash ?? "", index));
    this.audio.onState = (engineState) => {
      if (engineState.playing !== this.state.playing) this.patch({ playing: engineState.playing });
    };
    // §7.3 — seeking or playing into unrendered territory renders that chunk on
    // demand rather than refusing to go there.
    this.audio.onEnded = () => {
      this.patch({ playing: false, time: this.state.duration, wordIndex: this.timeline.words.length - 1 });
    };
    // Reaching unrendered audio used to be inaudible in the worst way: the
    // worklet reads a hole as silence, so the clock kept running and the
    // document played out in perfect quiet. Park the playhead instead, say why,
    // render that chunk, and start again where we stopped.
    this.audio.onStarved = (time) => {
      const index = this.chunkIndexAt(time);
      if (index < 0 || this.rendered.has(index)) return;
      if (this.state.playing) {
        this.audio.pause();
        void this.audio.seek(this.timeline.snapped(time));
        this.resumeWhenRendered = index;
        this.patch({ playing: false, waitingForAudio: true });
      }
      if (index === this.pendingOnDemand) return;
      this.pendingOnDemand = index;
      this.send({ type: "renderNow", chunkIndex: index });
    };

    this.uninstallMedia = installMediaSession({
      play: () => void this.play(),
      pause: () => this.pause(),
      skip: (delta) => void this.skip(delta),
      seek: (time) => void this.seek(time),
      previousBlock: () => void this.seek(this.timeline.previousBlockStart(this.state.time)),
      nextBlock: () => void this.seek(this.timeline.nextBlockStart(this.state.time)),
    });

    this.tick();
    this.watchdog = setInterval(() => this.checkForStall(), 5_000);
  }

  private spawnWorker(): void {
    this.worker?.terminate();
    this.worker = new Worker(new URL("../workers/pipeline.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      this.lastEventAt = Date.now();
      this.handle(event.data);
    };
    this.worker.onerror = (event) => this.reportWorkerFailure(event.message);
    this.worker.onmessageerror = () =>
      this.patch({ status: { kind: "error", message: "The pipeline sent something unreadable." } });
    this.lastEventAt = Date.now();
    this.send({ type: "configure", settings: this.currentEngineSettings(), pdfAssetBase: pdfAssetBase() });
  }

  private currentEngineSettings(): EngineSettings {
    const settings = engineSettingsOf(this.settings);
    return this.threadOverride === undefined ? settings : { ...settings, threads: this.threadOverride };
  }

  /**
   * ONNX Runtime's multi-threaded wasm backend can take the whole worker down
   * rather than throwing — no error event, no message, the import simply stops
   * partway through loading the model. It happens where the shared memory it
   * reserves for its thread pool cannot be allocated, which varies by machine
   * and by how much else is open.
   *
   * There is no way to catch that from here, so it is detected instead: if the
   * worker has been silent for a minute while it was supposed to be working,
   * restart it pinned to a single thread and retry the import. One thread is
   * several times slower and always available, which is the right trade for the
   * second attempt.
   */
  private checkForStall(): void {
    // Either something is being imported, or the model is loading on its own —
    // the warm-up now starts when the app does, so a hang there happens with no
    // import in flight at all and would otherwise never be noticed.
    const working = this.state.status.kind === "working";
    const loading = this.state.model.kind === "loading";
    if (!working && !loading) return;
    // Every worker message refreshes this, model download progress included, so
    // a load that is merely slow does not trip it. Only a silent one does.
    if (Date.now() - this.lastEventAt < this.stallTimeout()) return;

    if (this.threadOverride === 1) {
      this.reportWorkerFailure("The model would not load.");
      return;
    }
    this.threadOverride = 1;
    if (working) {
      this.patch({
        status: {
          kind: "working",
          stage: "The model stalled — retrying on a single thread",
          done: 0,
          total: 1,
        },
      });
    }
    this.patch({
      model: { kind: "loading", label: "Stalled — retrying on a single thread", done: 0, total: 1 },
    });
    const request = this.lastRequest;
    this.spawnWorker();
    // `spawnWorker` re-sends configure, which re-warms the engine; an import
    // that was in flight has to be asked for again.
    if (request) this.send(request);
  }

  /**
   * How long silence is allowed to last before the worker is presumed hung.
   *
   * Compiling Kokoro's graph is one blocking call into WebAssembly: no
   * messages come out of the worker for its whole duration, and on a modest
   * machine that is well over a minute. The watchdog read that as the hang it
   * was written for and restarted the worker mid-compile — which threw the
   * compile away, started it again, and on a machine slow enough to trip it
   * once was guaranteed to trip it twice. So the compile gets its own budget.
   */
  private stallTimeout(): number {
    const model = this.state.model;
    const compiling = model.kind === "loading" && model.label === COMPILE_LABEL;
    return compiling ? 15 * 60_000 : 60_000;
  }

  private reportWorkerFailure(message: string): void {
    const duringImport = this.lastRequest !== undefined;
    this.lastRequest = undefined;
    const text = message || "The pipeline stopped unexpectedly.";
    this.patch({ model: { kind: "failed", message: text } });
    // An error card only where it is news. With nothing being imported, the
    // model chip and the library's own explanation of the missing model are
    // already saying this, and a second card over the top of them is noise.
    if (!duringImport) return;
    this.patch({
      status: {
        kind: "error",
        message: text,
        detail:
          "This is usually the model being too large for the memory available. " +
          "A smaller one — npm run assets -- --dtype q8f16 — should get past it.",
      },
    });
  }

  async stop(): Promise<void> {
    cancelAnimationFrame(this.frame);
    if (this.watchdog) clearInterval(this.watchdog);
    this.uninstallMedia?.();
    this.worker?.postMessage({ type: "cancel" } satisfies WorkerRequest);
    this.worker?.terminate();
    this.worker = undefined;
    await this.audio.dispose();
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private patch(partial: Partial<SessionState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }

  private send(request: WorkerRequest, transfer: Transferable[] = []): void {
    this.worker?.postMessage(request, transfer);
  }

  // MARK: Worker events

  private handle(event: WorkerEvent): void {
    switch (event.type) {
      case "stage":
        this.patch({ status: { kind: "working", stage: event.stage, done: event.done, total: event.total } });
        break;

      case "model":
        // Reported on its own track: it overlaps extraction, and it starts
        // before there is any document for `status` to be about.
        this.patch({
          model:
            event.phase === "ready"
              ? { kind: "ready", device: event.label }
              : event.phase === "failed"
                ? { kind: "failed", message: event.label }
                : { kind: "loading", label: event.label, done: event.done, total: event.total },
          // A model that is never going to arrive is not a chunk still being
          // rendered, and the transport should stop saying it is.
          ...(event.phase === "failed" ? { waitingForAudio: false } : {}),
        });
        if (event.phase === "failed") this.resumeWhenRendered = -1;
        break;

      case "priming":
        this.patch({ priming: { seconds: event.seconds, target: event.target } });
        break;

      case "needsConfirmation":
        this.patch({ status: { kind: "confirm", decision: event.decision } });
        break;

      case "engine":
        this.patch({ engine: event.info });
        break;

      case "ready": {
        this.lastRequest = undefined;
        this.timeline = new Timeline(event.document.words);
        this.rendered = new Set();
        this.applyOffsets(event.document.chunkFrameOffsets);
        this.patch({
          status: { kind: "ready" },
          document: event.document,
          engine: event.engine ?? this.state.engine,
          duration: event.document.duration,
          diagnostics: [...this.engineNotes, ...event.document.diagnostics],
          renderedThrough: 0,
          renderComplete: false,
          priming: undefined,
          waitingForAudio: false,
          wordIndex: 0,
          time: 0,
        });
        this.send({ type: "list" });
        break;
      }

      case "rendered":
        this.rendered.add(event.chunkIndex);
        if (this.pendingOnDemand === event.chunkIndex) this.pendingOnDemand = -1;
        void this.audio.chunkRendered(event.chunkIndex);
        this.patch({ renderedThrough: event.renderedThrough });
        if (this.resumeWhenRendered === event.chunkIndex) {
          this.resumeWhenRendered = -1;
          this.patch({ waitingForAudio: false });
          void this.play();
        }
        break;

      case "timeline": {
        // The estimated tier moves the tail of the timeline as real chunk
        // lengths arrive. The rendered prefix never moves, so the playhead and
        // the highlight stay put; only what is ahead of them firms up.
        this.timeline = new Timeline(event.words);
        this.applyOffsets(event.chunkFrameOffsets);
        this.patch({
          duration: event.duration,
          document: this.state.document
            ? {
                ...this.state.document,
                words: event.words,
                duration: event.duration,
                footnoteTimelines:
                  event.footnoteTimelines ?? this.state.document.footnoteTimelines,
              }
            : undefined,
        });
        break;
      }

      case "renderComplete":
        this.patch({ renderComplete: true, priming: undefined });
        // The library's "n% rendered" was a snapshot taken when the document
        // opened; it is now wrong by definition.
        this.send({ type: "list" });
        break;

      case "library":
        this.patch({ library: event.entries as LibraryEntry[] });
        this.send({ type: "usage" });
        break;

      case "usage":
        this.patch({ usage: { audioBytes: event.audioBytes, quotaBytes: event.quotaBytes } });
        break;

      case "benchmark":
        this.patch({ benchmark: event.report, status: { kind: "ready" } });
        break;

      case "error": {
        // Playback parks itself on a chunk being rendered and waits for the
        // `rendered` event to start it again. When the render is what failed,
        // that event never comes: the transport sat on "playback resumes on its
        // own" for as long as anyone was willing to watch it.
        // A device fallback is news, not a dead end — the engine has already
        // rebuilt itself elsewhere, the chunk that tripped it is being retried,
        // and playback still resumes when it lands. It belongs in the notes
        // beside the import, not under a "something went wrong" heading over a
        // reader that is working.
        // A move from one GPU configuration to another is the ladder working:
        // it belongs in the import notes and nowhere else. Only landing on the
        // CPU raises the banner, because only that changes what the app is.
        if (event.kind === "deviceFallback" || event.kind === "deviceChange") {
          if (!this.engineNotes.includes(event.message)) this.engineNotes.push(event.message);
          this.patch({
            deviceNotice: event.kind === "deviceFallback" ? event.message : this.state.deviceNotice,
            diagnostics: [...this.engineNotes, ...(this.state.document?.diagnostics ?? [])],
          });
          break;
        }
        this.pendingOnDemand = -1;
        this.resumeWhenRendered = -1;
        this.patch({
          waitingForAudio: false,
          status: {
            kind: "error",
            message: event.message,
            detail: event.kind === "modelMissing" ? 'Run "npm run assets" to fetch the model files.' : undefined,
          },
        });
        break;
      }
    }
  }

  private applyOffsets(chunkFrameOffsets: readonly number[]): void {
    this.chunkStartSamples = chunkFrameOffsets.map((frames) => frames * 600);
    this.audio.setLayout(this.chunkStartSamples, this.rendered);
  }

  private chunkIndexAt(time: number): number {
    const sample = samplesFromSeconds(time);
    const starts = this.chunkStartSamples;
    if (starts.length < 2 || sample < starts[0] || sample >= starts[starts.length - 1]) return -1;
    let lo = 0;
    let hi = starts.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= sample) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // MARK: §8.3 — the highlight clock

  private tick = (): void => {
    this.frame = requestAnimationFrame(this.tick);
    // Gated on having a document, not on the status: Phase B keeps reporting
    // progress long after the reader opened, and the highlight has to keep
    // moving through all of it.
    if (!this.state.document) return;

    const time = this.audio.currentState.time;
    const index = this.timeline.indexAt(time);
    if (index !== this.state.wordIndex || Math.abs(time - this.state.time) > 0.02) {
      this.patch({ wordIndex: index, time });
      updateNowPlaying({
        title: this.state.document?.title ?? "PolyRead",
        pageCount: this.state.document?.pageCount ?? 0,
        duration: this.state.duration,
        position: time,
        rate: this.state.rate,
        playing: this.state.playing,
      });
    }
  };

  // MARK: Commands

  async importFile(file: File): Promise<void> {
    const bytes = await file.arrayBuffer();
    this.patch({ status: { kind: "working", stage: "Reading the file", done: 0, total: 1 }, benchmark: undefined });
    // Deliberately not transferred: a detached buffer cannot be re-sent, and the
    // stall watchdog above needs to be able to retry the same import. A PDF is a
    // few megabytes, so the copy is cheaper than losing the retry.
    this.lastRequest = { type: "import", bytes, fileName: file.name, allowOcr: this.settings.allowOcr };
    this.lastEventAt = Date.now();
    this.send(this.lastRequest);
  }

  confirmLowConfidence(proceed: boolean): void {
    this.patch({ status: { kind: "working", stage: proceed ? "Recognizing text" : "Cancelled", done: 0, total: 1 } });
    this.send({ type: "confirmLowConfidence", proceed });
    if (!proceed) this.patch({ status: { kind: "idle" } });
  }

  open(contentHash: string): void {
    this.patch({ status: { kind: "working", stage: "Opening", done: 0, total: 1 } });
    this.lastRequest = { type: "open", contentHash };
    this.lastEventAt = Date.now();
    this.send(this.lastRequest);
  }

  forget(contentHash: string): void {
    this.send({ type: "forget", contentHash });
  }

  runBenchmark(): void {
    this.patch({ status: { kind: "working", stage: "Running the benchmark", done: 0, total: 1 } });
    this.lastEventAt = Date.now();
    this.send({ type: "benchmark" });
  }

  async play(): Promise<void> {
    try {
      this.audio.setRate(this.state.rate);
      await this.audio.play();
    } catch (error) {
      const polyread = PolyReadError.from(error);
      this.patch({ status: { kind: "error", message: polyread.message } });
    }
  }

  pause(): void {
    this.resumeWhenRendered = -1;
    this.audio.pause();
    this.patch({ waitingForAudio: false });
  }

  async toggle(): Promise<void> {
    if (this.state.playing) this.pause();
    else await this.play();
  }

  /** §8.4 — snapped to a word boundary, never a raw audio seek. */
  async skip(delta: number): Promise<void> {
    await this.seek(this.timeline.skip(this.state.time, delta));
  }

  async seek(time: number): Promise<void> {
    this.resumeWhenRendered = -1;
    if (this.state.waitingForAudio) this.patch({ waitingForAudio: false });
    const snapped = this.timeline.snapped(time);
    await this.audio.seek(snapped);
    const index = this.timeline.indexAt(snapped);
    this.patch({ time: snapped, wordIndex: index });

    // §7.3 — do not disable seeking ahead of the buffer edge; render what is
    // under the playhead instead.
    const chunkIndex = this.chunkIndexAt(snapped);
    if (chunkIndex >= 0 && !this.rendered.has(chunkIndex) && chunkIndex !== this.pendingOnDemand) {
      this.pendingOnDemand = chunkIndex;
      this.send({ type: "renderNow", chunkIndex });
    }
  }

  async seekToWord(index: number): Promise<void> {
    await this.seek(this.timeline.startOfWord(index));
  }

  async previousBlock(): Promise<void> {
    await this.seek(this.timeline.previousBlockStart(this.state.time));
  }

  async nextBlock(): Promise<void> {
    await this.seek(this.timeline.nextBlockStart(this.state.time));
  }

  setRate(rate: number): void {
    this.audio.setRate(rate);
    this.settings = { ...this.settings, rate };
    this.patch({ rate });
  }

  updateSettings(settings: AppSettings): void {
    const wasRate = this.settings.rate;
    // An explicit choice in Settings supersedes whatever the watchdog decided.
    if (settings.threads !== this.settings.threads) this.threadOverride = undefined;
    this.settings = settings;
    this.send({ type: "configure", settings: this.currentEngineSettings(), pdfAssetBase: pdfAssetBase() });
    if (settings.rate !== wasRate) this.setRate(settings.rate);
  }

  get words(): readonly WordTiming[] {
    return this.timeline.words;
  }

  originalBytes(contentHash: string): Promise<ArrayBuffer | undefined> {
    return this.store.getOriginal(contentHash);
  }
}
