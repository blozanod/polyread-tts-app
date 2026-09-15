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
import type { PdfDocumentProxy, PdfLoadingTask } from "../extraction/pdfTypes";
import type { BackendDecision } from "../extraction/quality";
import { EspeakPhonemizer } from "../linguistics/espeakPhonemizer";
import { LinguisticsPipeline } from "../linguistics/pipeline";
import { assertVocabularyShape, loadVocabulary } from "../linguistics/vocabulary";
import { unencodableEntries } from "../linguistics/homographs";
import { SynthesisCoordinator, type CoordinatorEvent } from "../synthesis/coordinator";
import { KokoroEngine } from "../synthesis/kokoroEngine";
import { contentHash, DocumentStore } from "../synthesis/store";
import { espeakLanguageFor } from "../synthesis/voices";
import type { EngineSettings, WorkerEvent, WorkerRequest } from "./protocol";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const store = new DocumentStore();
let settings: EngineSettings | undefined;
let engine: KokoroEngine | undefined;
let coordinator: SynthesisCoordinator | undefined;
let confirmResolver: ((proceed: boolean) => void) | undefined;

function post(event: WorkerEvent, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(event, transfer);
}

const emit = (event: CoordinatorEvent): void => {
  switch (event.type) {
    case "phaseA":
      post({ type: "stage", stage: "Timing the document", done: event.done, total: event.total });
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
      break;
    case "timeline":
      post({
        type: "timeline",
        words: event.words,
        duration: event.duration,
        chunkFrameOffsets: event.chunkFrameOffsets,
      });
      break;
    case "complete":
      post({ type: "renderComplete" });
      break;
    case "failed":
      post({ type: "error", message: event.message });
      break;
  }
};

async function ensureEngine(): Promise<KokoroEngine> {
  if (engine) return engine;
  if (!settings) throw new PolyReadError("modelMissing", "the engine has not been configured");
  const vocabulary = await loadVocabulary(settings.vocabUrl);
  post({ type: "stage", stage: "Loading the voice model", done: 0, total: 1 });
  engine = await KokoroEngine.load(
    {
      modelUrl: settings.modelUrl,
      durationModelUrl: settings.durationModelUrl,
      voicesBaseUrl: settings.voicesBaseUrl,
      voiceID: settings.voiceID,
      device: settings.device,
      threads: settings.threads > 0 ? settings.threads : undefined,
    },
    vocabulary,
    (label, loaded, total) => post({ type: "stage", stage: label, done: loaded, total }),
  );
  return engine;
}

interface OpenPdf {
  document: PdfDocumentProxy;
  close(): Promise<void>;
}

async function openPdf(bytes: ArrayBuffer): Promise<OpenPdf> {
  // pdf.js mutates the buffer it is handed, and the same bytes are hashed and
  // archived, so it gets a copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }) as unknown as PdfLoadingTask;
  const document = await task.promise;
  return { document, close: () => task.destroy() };
}

async function runImport(bytes: ArrayBuffer, fileName: string, allowOcr: boolean): Promise<void> {
  const hash = await contentHash(bytes);

  const cached = await store.getSidecar(hash);
  if (cached && cached.version === SIDECAR_VERSION && cached.voiceName === settings?.voiceID) {
    await resume(hash, cached);
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

  const kokoro = await ensureEngine();
  coordinator?.cancel();
  coordinator = new SynthesisCoordinator(kokoro, {
    initialAudioLead: settings?.initialAudioLead ?? 60,
    onAudio: (chunkIndex, samples) => store.putAudio(hash, chunkIndex, samples),
  });

  const phaseA = await coordinator.runPhaseA(
    analysed.mainChunks,
    analysed.footnoteChunks,
    analysed.blocks,
    emit,
  );

  const sidecar: DocumentSidecar = {
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
  };

  await persist(sidecar, analysed.mainChunks.length, phaseA.duration);
  await store.putOriginal(hash, bytes);
  await store.evictToFit(settings?.cacheCapBytes ?? 4 * 1024 ** 3, hash);

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
    engine: kokoro.info,
  });

  await release();
  void coordinator.startPhaseB(emit);
}

async function resume(hash: string, sidecar: DocumentSidecar): Promise<void> {
  const kokoro = await ensureEngine();
  coordinator?.cancel();
  coordinator = new SynthesisCoordinator(kokoro, {
    initialAudioLead: settings?.initialAudioLead ?? 60,
    onAudio: (chunkIndex, samples) => store.putAudio(hash, chunkIndex, samples),
  });

  // Phase A's work is in the sidecar, so this replays it rather than paying for
  // it again — §7.4's "reopening a document is instant".
  const phaseA = await coordinator.runPhaseA(
    sidecar.mainChunks,
    sidecar.footnoteChunks,
    sidecar.blocks,
    emit,
    sidecar.chunkTimings,
  );
  const rendered = await store.renderedChunkIndices(hash);
  coordinator.adoptRendered(rendered);
  await store.touch(hash);

  post({
    type: "ready",
    document: {
      contentHash: hash,
      title: sidecar.title,
      pageCount: sidecar.pageCount,
      blocks: sidecar.blocks,
      reflow: sidecar.reflow,
      words: phaseA.words,
      footnoteTimelines: phaseA.footnoteTimelines,
      chunkFrameOffsets: phaseA.chunkFrameOffsets,
      duration: phaseA.duration,
      timingSource: sidecar.timingSource,
      voiceID: sidecar.voiceName,
      diagnostics: [],
    },
    engine: kokoro.info,
  });

  for (const index of rendered) {
    post({
      type: "rendered",
      chunkIndex: index,
      renderedThrough: coordinator.progress.renderedThrough,
      totalChunks: coordinator.progress.totalChunks,
    });
  }
  void coordinator.startPhaseB(emit);
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
  const chunk = {
    id: "benchmark",
    blockID: "benchmark",
    tokens: ids.slice(0, 480),
    wordPhonemeRanges: [{ start: 0, end: ids.length }],
    spanOffset: 0,
  };

  await kokoro.render(chunk); // warm-up, to absorb first-prediction compilation
  let renderedSeconds = 0;
  const started = performance.now();
  let passes = 0;
  while (renderedSeconds < 60 && passes < 24) {
    const { samples } = await kokoro.render(chunk);
    renderedSeconds += samples.length / 24000;
    passes += 1;
  }
  const elapsed = (performance.now() - started) / 1000;
  lines.push("");
  lines.push(`§0.1 throughput: ${renderedSeconds.toFixed(1)} s of audio in ${elapsed.toFixed(1)} s`);
  lines.push(`  realtime multiple: ${(renderedSeconds / elapsed).toFixed(1)}x`);
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
        settings = message.settings;
        if (changed && engine) {
          await engine.dispose();
          engine = undefined;
        }
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

