/// <reference lib="webworker" />
// pdf.js ships two builds. The default one targets browsers newer than any
// currently shipping: version 6 calls `Map.prototype.getOrInsertComputed`, a
// proposal method that Chromium 141 still does not have, and page rendering
// throws `getOrInsertComputed is not a function` on a browser most people are
// actually running. The `legacy` build is the same library with the polyfills
// in — about 160 KB more, against the 26 MB of WebAssembly this app already
// loads, which is not a trade worth thinking about.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

import { PolyReadError } from "../core/errors";
import { SIDECAR_VERSION, type DocumentSidecar } from "../core/sidecar";
import { extractDocument, surveyDocument } from "../extraction/documentExtractor";
import { pdfAssetOptions } from "../extraction/pdfAssets";
import type { PdfDocumentProxy, PdfLoadingTask } from "../extraction/pdfTypes";
import type { BackendDecision } from "../extraction/quality";
import { EspeakPhonemizer } from "../linguistics/espeakPhonemizer";
import { LinguisticsPipeline } from "../linguistics/pipeline";
import { assertVocabularyShape, loadVocabulary, type KokoroVocabulary } from "../linguistics/vocabulary";
import { unencodableEntries } from "../linguistics/homographs";
import { SynthesisCoordinator, type CoordinatorEvent } from "../synthesis/coordinator";
import { KokoroEngine } from "../synthesis/kokoroEngine";
import { contentHash, DocumentStore } from "../synthesis/store";
import { espeakLanguageFor } from "../synthesis/voices";
import type { EngineSettings, WorkerEvent, WorkerRequest } from "./protocol";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Mirrors `DEFAULT_SETTINGS.initialAudioLead`; used when configure has not landed. */
const DEFAULT_AUDIO_LEAD = 20;

const store = new DocumentStore();
let settings: EngineSettings | undefined;
let engine: KokoroEngine | undefined;
/** The in-flight `KokoroEngine.load`, so warming and importing share one load. */
let engineLoad: Promise<KokoroEngine> | undefined;
let coordinator: SynthesisCoordinator | undefined;
let confirmResolver: ((proceed: boolean) => void) | undefined;
let pdfAssetBase = "pdfjs/";

function post(event: WorkerEvent, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(event, transfer);
}

const emit = (event: CoordinatorEvent): void => {
  switch (event.type) {
    case "phaseA":
      post({ type: "stage", stage: "Timing the document", done: event.done, total: event.total });
      break;
    case "timeline":
      post({
        type: "timeline",
        words: event.words,
        duration: event.duration,
        chunkFrameOffsets: event.chunkFrameOffsets,
        footnoteTimelines: event.footnoteTimelines,
      });
      schedulePersist();
      break;
    case "priming":
      post({ type: "priming", seconds: event.seconds, target: event.target });
      break;
    case "rendered":
      post({
        type: "rendered",
        chunkIndex: event.chunkIndex,
        renderedThrough: event.renderedThrough,
        totalChunks: event.totalChunks,
      });
      schedulePersist();
      break;
    case "complete":
      post({ type: "renderComplete" });
      void persistProgress();
      break;
    case "failed":
      post({ type: "error", message: event.message });
      break;
  }
};

/**
 * Opening a document holds the model's compile back until the reader is up.
 *
 * Extraction, §6 and §7.2 all run on this thread, and so does
 * `InferenceSession.create` — which is one blocking call into WebAssembly that
 * does not yield for as long as it takes to compile Kokoro's graph. Starting it
 * early was supposed to overlap it with reading the PDF; what actually
 * overlapped was the *download*, and the compile then sat in front of
 * extraction with the thread to itself. Nothing before Phase B needs the model,
 * so the compile waits for a document that is on its way in, and the reader
 * opens while it runs afterwards.
 */
let readerOpen: Promise<void> = Promise.resolve();
let openReader: () => void = () => undefined;

/**
 * Holds the compile and returns the release. Every caller releases it in a
 * `finally`: a hold that is never released is a model that never compiles, so
 * an import that fails, or one the user cancels at the §4.2 confirmation, must
 * not be able to leave the gate shut.
 */
function holdCompileUntilReaderOpens(): () => void {
  const previous = openReader;
  let released = false;
  readerOpen = new Promise<void>((resolve) => {
    openReader = () => {
      released = true;
      resolve();
    };
  });
  previous();
  const release = openReader;
  return () => {
    if (!released) release();
  };
}

/**
 * Loads the voice model, once, and hands every caller the same load.
 *
 * The model is a few hundred megabytes to fetch and compile. The fetch starts
 * the moment the worker is configured — it is network I/O and genuinely
 * overlaps everything — and the compile takes the thread when nothing is
 * waiting for the screen.
 */
function ensureEngine(): Promise<KokoroEngine> {
  if (engine) return Promise.resolve(engine);
  if (engineLoad) return engineLoad;
  const configured = settings;
  if (!configured) {
    return Promise.reject(new PolyReadError("modelMissing", "the engine has not been configured"));
  }

  post({ type: "model", phase: "loading", label: "Loading the voice model", done: 0, total: 1 });
  engineLoad = (async () => {
    const vocabulary = await loadVocabulary(configured.vocabUrl);
    const loaded = await KokoroEngine.load(
      {
        modelUrl: configured.modelUrl,
        durationModelUrl: configured.durationModelUrl,
        voicesBaseUrl: configured.voicesBaseUrl,
        voiceID: configured.voiceID,
        device: configured.device,
        threads: configured.threads > 0 ? configured.threads : undefined,
      },
      vocabulary,
      {
        onProgress: (label, done, total) => post({ type: "model", phase: "loading", label, done, total }),
        beforeCompile: () => readerOpen,
        onProviderRejected: (provider, reason) =>
          post({
            type: "error",
            kind: "deviceFallback",
            message: `${provider} compiled the voice model but could not run it, so it is not being used: ${reason}`,
          }),
      },
    );
    engine = loaded;
    post({ type: "model", phase: "ready", label: loaded.device, done: 1, total: 1 });
    return loaded;
  })();

  engineLoad.catch((error: unknown) => {
    // Cleared so the next attempt is a real retry rather than the same
    // rejection handed out again.
    engineLoad = undefined;
    post({
      type: "model",
      phase: "failed",
      label: error instanceof Error ? error.message : String(error),
      done: 0,
      total: 1,
    });
  });

  return engineLoad;
}

/** Starts the load without making anyone wait for it, and without it throwing. */
function warmEngine(): void {
  if (!settings || engine || engineLoad) return;
  void ensureEngine().catch(() => {
    // `ensureEngine` has already reported it. A warm-up failing is not an
    // import failing; the import will surface it when it asks for the engine.
  });
}

interface OpenPdf {
  document: PdfDocumentProxy;
  close(): Promise<void>;
}

async function openPdf(bytes: ArrayBuffer): Promise<OpenPdf> {
  // pdf.js mutates the buffer it is handed, and the same bytes are hashed and
  // archived, so it gets a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes.slice(0)),
    ...pdfAssetOptions(pdfAssetBase),
  }) as unknown as PdfLoadingTask;
  const document = await task.promise;
  return { document, close: () => task.destroy() };
}

async function runImport(bytes: ArrayBuffer, fileName: string, allowOcr: boolean): Promise<void> {
  const releaseCompile = holdCompileUntilReaderOpens();
  try {
    await importDocument(bytes, fileName, allowOcr, releaseCompile);
  } finally {
    releaseCompile();
  }
}

async function importDocument(
  bytes: ArrayBuffer,
  fileName: string,
  allowOcr: boolean,
  releaseCompile: () => void,
): Promise<void> {
  // Whatever was rendering is not what the user is looking at any more, and it
  // is competing for the same thread as the import that replaced it.
  coordinator?.cancel();
  // Started before anything else and handed to Phase B, which is the first
  // thing that actually needs it. The reader opens without it.
  const engineReady = ensureEngine();
  // Nothing awaits this until Phase B; without a handler an early rejection is
  // an unhandled one.
  engineReady.catch(() => undefined);

  const hash = await contentHash(bytes);

  const cached = await store.getSidecar(hash);
  if (cached && cached.version === SIDECAR_VERSION && cached.voiceName === settings?.voiceID) {
    await resume(hash, cached, engineReady);
    return;
  }

  post({ type: "stage", stage: "Opening the PDF", done: 0, total: 1 });
  const { document, close } = await openPdf(bytes);
  let closed = false;
  const release = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await close();
  };

  post({ type: "stage", stage: "Checking the text layer", done: 0, total: 1 });
  let decision: BackendDecision = await surveyDocument(document, { allowOcr });
  if (decision.needsUserConfirmation) {
    post({ type: "needsConfirmation", decision });
    // Nothing is going to reach the screen until a person answers, so the
    // compile may as well have the thread.
    releaseCompile();
    const proceed = await new Promise<boolean>((resolve) => {
      confirmResolver = resolve;
    });
    if (!proceed) {
      await release();
      return;
    }
  }

  const extraction = await extractDocument(
    document,
    fileName.replace(/\.pdf$/i, ""),
    decision,
    (done, total, stage) => post({ type: "stage", stage, done, total }),
  );

  const language = espeakLanguageFor(settings?.voiceID ?? "af_heart");
  const linguistics = new LinguisticsPipeline(new EspeakPhonemizer(language));
  const analysed = await linguistics.run(extraction.blocks, (done, total) =>
    post({ type: "stage", stage: "Reading it out to itself", done, total }),
  );

  coordinator?.cancel();
  coordinator = newCoordinator(hash, await vocabularyForSettings());

  const phaseA = await coordinator.runPhaseA(
    analysed.mainChunks,
    analysed.footnoteChunks,
    analysed.blocks,
    emit,
  );

  current = {
    hash,
    coordinator,
    sidecar: {
      version: SIDECAR_VERSION,
      contentHash: hash,
      title: extraction.title,
      pageCount: extraction.pageCount,
      voiceName: settings?.voiceID ?? "af_heart",
      timingSource: phaseA.timingSource,
      blocks: analysed.blocks,
      words: phaseA.words,
      mainChunks: analysed.mainChunks,
      footnoteChunks: analysed.footnoteChunks,
      chunkTimings: coordinator.chunkTimings,
      reflow: analysed.reflow,
      footnoteTimelines: phaseA.footnoteTimelines,
      chunkFrameOffsets: phaseA.chunkFrameOffsets,
      createdAt: Date.now(),
    },
  };

  post({
    type: "ready",
    document: {
      contentHash: hash,
      title: extraction.title,
      pageCount: extraction.pageCount,
      blocks: analysed.blocks,
      reflow: analysed.reflow,
      words: phaseA.words,
      footnoteTimelines: phaseA.footnoteTimelines,
      chunkFrameOffsets: phaseA.chunkFrameOffsets,
      duration: phaseA.duration,
      timingSource: phaseA.timingSource,
      voiceID: settings?.voiceID ?? "af_heart",
      decision,
      diagnostics: diagnostics(extraction.invariantViolations, analysed),
    },
    engine: engine?.info,
  });

  await release();
  releaseCompile();

  // After the reader, not before it: writing a few megabytes of PDF and a
  // sidecar into IndexedDB is not something anyone should be watching a
  // loading bar for.
  await persist(current.sidecar, analysed.mainChunks.length, phaseA.duration);
  await store.putOriginal(hash, bytes);
  await store.evictToFit(settings?.cacheCapBytes ?? 4 * 1024 ** 3, hash);
  post({ type: "library", entries: await store.list() });

  await startSynthesis(coordinator, engineReady);
}

/**
 * The document currently open, kept so Phase B's real frame counts can be
 * written back.
 *
 * Without this the sidecar holds Phase A's numbers forever: reopening a
 * half-rendered document replayed estimates against audio whose true lengths
 * were already on disk, and every chunk after the first rendered one sat at the
 * wrong offset — §5's "the bug will look like a timing bug", exactly.
 */
let current: { hash: string; sidecar: DocumentSidecar; coordinator: SynthesisCoordinator } | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** How often the sidecar is rewritten while Phase B runs. */
const PERSIST_INTERVAL_MS = 20_000;

function newCoordinator(hash: string, vocabulary: KokoroVocabulary): SynthesisCoordinator {
  return new SynthesisCoordinator({
    initialAudioLead: settings?.initialAudioLead ?? DEFAULT_AUDIO_LEAD,
    vocabulary,
    onAudio: (chunkIndex, samples) => store.putAudio(hash, chunkIndex, samples),
  });
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persistProgress();
  }, PERSIST_INTERVAL_MS);
}

async function persistProgress(): Promise<void> {
  const open = current;
  // Paired with its own coordinator, not with whatever is current: an import
  // started while the last document was still rendering would otherwise write
  // one document's timings into the other's sidecar.
  if (!open || open.coordinator !== coordinator) return;
  const sidecar = open.sidecar;
  sidecar.chunkTimings = open.coordinator.chunkTimings;
  sidecar.chunkFrameOffsets = open.coordinator.progress.chunkFrameOffsets;
  sidecar.timingSource = open.coordinator.timingSource;
  try {
    await persist(sidecar, open.coordinator.totalChunks, open.coordinator.duration);
  } catch {
    // A cache that will not take a write is not a reason to stop rendering.
  }
}

/**
 * Hands the coordinator its engine once the model is up, then starts Phase B.
 *
 * Separated from the import so that everything before it — extraction, §6, and
 * §7.2's estimated timeline — has already reached the screen.
 */
async function startSynthesis(
  target: SynthesisCoordinator,
  engineReady: Promise<KokoroEngine>,
): Promise<void> {
  let kokoro: KokoroEngine;
  try {
    kokoro = await engineReady;
  } catch {
    // `ensureEngine` has already posted the failure, and the library explains
    // what to run. The reader still works; it just cannot speak.
    return;
  }
  if (coordinator !== target) return;
  kokoro.onDeviceChange = (device, reason) => {
    post({ type: "model", phase: "ready", label: device, done: 1, total: 1 });
    post({ type: "engine", info: kokoro.info });
    post({
      type: "error",
      message: `The GPU could not run the voice model, so it moved to the CPU: ${reason}`,
      kind: "deviceFallback",
    });
  };
  target.attachEngine(kokoro);
  post({ type: "engine", info: kokoro.info });
  await target.startPhaseB(emit);
}

async function resume(
  hash: string,
  sidecar: DocumentSidecar,
  engineReady: Promise<KokoroEngine> = ensureEngine(),
): Promise<void> {
  engineReady.catch(() => undefined);
  const releaseCompile = holdCompileUntilReaderOpens();
  try {
    await replaySidecar(hash, sidecar, engineReady, releaseCompile);
  } finally {
    releaseCompile();
  }
}

async function replaySidecar(
  hash: string,
  sidecar: DocumentSidecar,
  engineReady: Promise<KokoroEngine>,
  releaseCompile: () => void,
): Promise<void> {
  coordinator?.cancel();
  coordinator = newCoordinator(hash, await vocabularyForSettings());
  current = { hash, sidecar, coordinator };

  // Phase A's work is in the sidecar, so this replays it rather than paying for
  // it again — §7.4's "reopening a document is instant".
  const phaseA = await coordinator.runPhaseA(
    sidecar.mainChunks,
    sidecar.footnoteChunks,
    sidecar.blocks,
    emit,
    sidecar.chunkTimings,
  );
  // The real lengths of what is already on disk, so the replayed timeline lines
  // up with the audio it is describing rather than with Phase A's guess at it.
  const rendered = await store.renderedChunks(hash);
  coordinator.adoptRendered(
    rendered.map((chunk) => chunk.index),
    new Map(rendered.map((chunk) => [chunk.index, chunk.frames])),
  );
  await store.touch(hash);

  // After `adoptRendered`, not from Phase A's return value: adopting moves the
  // layout to the real lengths of the audio on disk, and posting Phase A's
  // words alongside the moved offsets would put the highlight and the audio in
  // different places from the first frame.
  const timeline = coordinator.snapshot();

  post({
    type: "ready",
    document: {
      contentHash: hash,
      title: sidecar.title,
      pageCount: sidecar.pageCount,
      blocks: sidecar.blocks,
      reflow: sidecar.reflow,
      words: timeline.words,
      footnoteTimelines: phaseA.footnoteTimelines,
      chunkFrameOffsets: timeline.chunkFrameOffsets,
      duration: timeline.duration,
      timingSource: phaseA.timingSource,
      voiceID: sidecar.voiceName,
      diagnostics: [],
    },
    engine: engine?.info,
  });

  for (const chunk of rendered) {
    post({
      type: "rendered",
      chunkIndex: chunk.index,
      renderedThrough: coordinator.progress.renderedThrough,
      totalChunks: coordinator.progress.totalChunks,
    });
  }
  releaseCompile();
  await startSynthesis(coordinator, engineReady);
}

/** The vocabulary Phase A's estimates index into; cached across documents. */
let vocabularyPromise: Promise<KokoroVocabulary> | undefined;
function vocabularyForSettings(): Promise<KokoroVocabulary> {
  if (!vocabularyPromise) vocabularyPromise = loadVocabulary(settings?.vocabUrl);
  return vocabularyPromise;
}

async function persist(sidecar: DocumentSidecar, totalChunks: number, duration: number): Promise<void> {
  await store.putSidecar(sidecar, {
    contentHash: sidecar.contentHash,
    title: sidecar.title,
    pageCount: sidecar.pageCount,
    duration,
    voiceName: sidecar.voiceName,
    timingSource: sidecar.timingSource,
    createdAt: sidecar.createdAt,
    lastOpenedAt: Date.now(),
    renderedChunks: 0,
    totalChunks,
    hasOriginal: true,
  });
}

function diagnostics(
  invariantViolations: string[],
  analysed: { unknownSymbols: Record<string, number>; overBudgetChunks: number; phonemizerName: string },
): string[] {
  const out: string[] = [];
  for (const violation of invariantViolations) out.push(`span invariant: ${violation}`);
  const unknown = Object.entries(analysed.unknownSymbols).sort((a, b) => b[1] - a[1]);
  if (unknown.length > 0) {
    const shown = unknown.slice(0, 8).map(([s, n]) => `${JSON.stringify(s)}x${n}`).join(" ");
    out.push(`phonemes the vocabulary does not know: ${shown}`);
  }
  if (analysed.overBudgetChunks > 0) {
    out.push(`${analysed.overBudgetChunks} chunk(s) exceeded the 510-phoneme budget`);
  }
  return out;
}

/**
 * The §0 gate, such as it survives the port. §0.2 and §0.3 were iOS questions —
 * Metal in the background, and whether MisakiSwift grouped phonemes per word —
 * and neither exists here. §0.1 does, and so do the two checks `docs/gate-0.md`
 * added on its own account: that the vocabulary matches the model, and that
 * every entry in the override tables can be encoded in it.
 */
async function benchmark(): Promise<string> {
  const lines: string[] = [];
  const vocabulary = await loadVocabulary(settings?.vocabUrl);
  lines.push(`Vocabulary: ${vocabulary.source} (${vocabulary.symbolToID.size} symbols)`);
  const shape = assertVocabularyShape(vocabulary);
  lines.push(shape.length === 0 ? "  ids: as expected" : `  ids: ${shape.join("; ")}`);
  const unencodable = unencodableEntries(vocabulary);
  lines.push(
    unencodable.length === 0
      ? "  override tables: every phoneme encodes"
      : `  override tables: ${unencodable.length} entries do not encode — ${unencodable.slice(0, 5).join(", ")}`,
  );

  const phonemizer = new EspeakPhonemizer();
  // Already through §5, as the pipeline would have it by this point — so the
  // report shows what the model is really fed rather than what "pp." does raw.
  const probe = "The record shows that Przeworski recorded a conflict in 1993, pages 12 to 19.";
  const tokens = probe.split(/\s+/);
  const words = await phonemizer.phonemize(tokens, []);
  lines.push("");
  lines.push(`Phonemizer: ${phonemizer.name}`);
  lines.push(`  §0.3 word grouping: ${words.length === tokens.length ? "one group per token" : "BROKEN"}`);
  lines.push(`  probe: ${words.map((w) => w.phonemes).join(" ")}`);

  const kokoro = await ensureEngine();
  lines.push("");
  lines.push(kokoro.describeInterfaces());
  lines.push("");
  lines.push(`Device: ${kokoro.device}`);
  lines.push(
    kokoro.timingSource === "model"
      ? "Timings: exact, from the duration model (§7.2 as specified)"
      : "Timings: estimated — build a duration model for exact word timings (see scripts/make-duration-model.py)",
  );

  // §0.1 — "synthesize 60 s of audio, report the realtime multiple per device."
  // Measured on chunks near the §6.2 budget, not on a short utterance, which
  // would flatter the number.
  const vocab = vocabulary;
  const filler = await phonemizer.phonemize(
    "The comparative study of democratic consolidation requires sustained attention to elite settlements and to the institutional arrangements that follow from them."
      .split(/\s+/),
    [],
  );
  const ids: number[] = [];
  const spaceID = vocab.spaceID;
  while (ids.length < 480) {
    for (const word of filler) {
      if (ids.length > 0 && spaceID !== undefined) ids.push(spaceID);
      ids.push(...vocab.encode(word.phonemes).tokens);
      if (ids.length >= 480) break;
    }
  }
  const chunkTokens = ids.slice(0, 480);
  const chunk = {
    id: "benchmark",
    blockID: "benchmark",
    tokens: chunkTokens,
    wordPhonemeRanges: [{ start: 0, end: chunkTokens.length }],
    spanOffset: 0,
  };

  // The warm-up absorbs first-prediction compilation, and on WebGPU it is also
  // where a driver that cannot compile one of Kokoro's shaders declares itself.
  post({ type: "stage", stage: "Benchmark: warming up", done: 0, total: 1 });
  await kokoro.render(chunk);

  // §0.1 asks for 60 s of audio. On the CPU backend that can be several minutes
  // of wall clock, during which nothing reached the UI — long enough for the
  // stall watchdog to restart the worker underneath it, which is why the
  // benchmark appeared not to run at all. So it is bounded by elapsed time as
  // well as by audio, and reports which bound it hit.
  const BUDGET_SECONDS = 30;
  let renderedSeconds = 0;
  const started = performance.now();
  let passes = 0;
  let elapsed = 0;
  while (renderedSeconds < 60 && passes < 24) {
    const { samples } = await kokoro.render(chunk);
    renderedSeconds += samples.length / 24000;
    passes += 1;
    elapsed = (performance.now() - started) / 1000;
    post({
      type: "stage",
      stage: `Benchmark: ${renderedSeconds.toFixed(0)} s of audio rendered`,
      done: Math.min(renderedSeconds, 60),
      total: 60,
    });
    if (elapsed >= BUDGET_SECONDS) break;
  }
  if (elapsed <= 0) elapsed = (performance.now() - started) / 1000;
  lines.push("");
  lines.push(`Device in use: ${kokoro.device}`);
  lines.push(`§0.1 throughput: ${renderedSeconds.toFixed(1)} s of audio in ${elapsed.toFixed(1)} s`);
  lines.push(`  realtime multiple: ${(renderedSeconds / elapsed).toFixed(1)}x`);
  if (renderedSeconds < 60) {
    lines.push(`  stopped at ${BUDGET_SECONDS} s of wall clock rather than the full 60 s of audio.`);
  }
  if (renderedSeconds / elapsed < 2) {
    lines.push("  below 2x: rendering will not outrun playback, and §7.3's argument inverts.");
  }
  return lines.join("\n");
}

self.onmessage = async (event: MessageEvent<WorkerRequest>): Promise<void> => {
  const message = event.data;
  try {
    switch (message.type) {
      case "configure": {
        const changed =
          settings?.modelUrl !== message.settings.modelUrl ||
          settings?.durationModelUrl !== message.settings.durationModelUrl ||
          settings?.voiceID !== message.settings.voiceID ||
          settings?.device !== message.settings.device ||
          settings?.threads !== message.settings.threads;
        const vocabChanged = settings?.vocabUrl !== message.settings.vocabUrl;
        settings = message.settings;
        pdfAssetBase = message.pdfAssetBase;
        if (vocabChanged) vocabularyPromise = undefined;
        if (changed && engine) {
          await engine.dispose();
          engine = undefined;
          engineLoad = undefined;
        }
        // The app is unusable without the model, so the wait for it starts now
        // rather than when a document is dropped. It is the same fetch either
        // way; doing it here is the difference between the reader opening with
        // audio behind it and opening onto silence.
        warmEngine();
        break;
      }
      case "import":
        await runImport(message.bytes, message.fileName, message.allowOcr);
        break;
      case "confirmLowConfidence":
        confirmResolver?.(message.proceed);
        confirmResolver = undefined;
        break;
      case "open": {
        const sidecar = await store.getSidecar(message.contentHash);
        if (!sidecar) throw new PolyReadError("extractionProducedNothing", "no cached timeline");
        // `runImport` has always checked this; opening from the library did
        // not, so a sidecar written by an older pipeline was replayed against
        // whatever the current one would have produced.
        if (sidecar.version !== SIDECAR_VERSION) {
          throw new PolyReadError(
            "extractionProducedNothing",
            "that document was prepared by an older version — open the PDF again",
          );
        }
        await resume(message.contentHash, sidecar);
        break;
      }
      case "renderNow":
        await coordinator?.renderOnDemand(message.chunkIndex, emit);
        break;
      case "list":
        post({ type: "library", entries: await store.list() });
        break;
      case "forget":
        await store.remove(message.contentHash);
        post({ type: "library", entries: await store.list() });
        break;
      case "usage": {
        const usage = await store.usage();
        post({ type: "usage", ...usage });
        break;
      }
      case "benchmark":
        post({ type: "benchmark", report: await benchmark() });
        break;
      case "cancel":
        coordinator?.cancel();
        coordinator = undefined;
        current = undefined;
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = undefined;
        break;
    }
  } catch (error) {
    const polyread = error instanceof PolyReadError ? error : undefined;
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      kind: polyread?.kind,
    });
  }
};

