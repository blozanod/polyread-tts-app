import { buildReflowDocument, type ReflowDocument } from "../core/reflow";
import { isSpoken, type Block, type PhonemizedChunk } from "../core/types";
import { BUDGET, Chunker, OPENING_TARGET, TARGET, type ChunkResult } from "./chunker";
import { EspeakPhonemizer } from "./espeakPhonemizer";
import { normalize } from "./normalizer";
import type { Phonemizer } from "./phonemizer";
import { defaultVocabulary, type KokoroVocabulary } from "./vocabulary";

export interface LinguisticsOutput {
  blocks: Block[];
  reflow: ReflowDocument;
  /** Main stream, in document order — body, headings, captions. */
  mainChunks: PhonemizedChunk[];
  /**
   * §4.5 — footnote bodies are chunked and duration-run too, but kept out of the
   * main stream so a page of notes does not land mid-sentence.
   */
  footnoteChunks: Record<string, PhonemizedChunk[]>;
  unknownSymbols: Record<string, number>;
  phonemizerName: string;
  overBudgetChunks: number;
}

/** Runs the whole of Agent B over a document: §5 then §6. */
export interface LinguisticsOptions {
  /**
   * Blocks phonemized at once. One is right for a phonemizer on this thread;
   * a pool of workers wants enough in flight to keep every one of them busy.
   */
  concurrency?: number;
}

export class LinguisticsPipeline {
  private readonly chunker: Chunker;
  readonly phonemizer: Phonemizer;
  private readonly concurrency: number;

  constructor(
    phonemizer: Phonemizer = new EspeakPhonemizer(),
    vocabulary: KokoroVocabulary = defaultVocabulary,
    options: LinguisticsOptions = {},
  ) {
    this.phonemizer = phonemizer;
    this.chunker = new Chunker(vocabulary);
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  }

  async run(
    rawBlocks: readonly Block[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<LinguisticsOutput> {
    const normalized = normalize(rawBlocks);
    // Reflow ranges have to exist before Phase A mints WordTimings from these
    // spans, so the layout happens here rather than in the UI.
    const { document: reflow, blocks } = buildReflowDocument(normalized);

    const mainChunks: PhonemizedChunk[] = [];
    const footnoteChunks: Record<string, PhonemizedChunk[]> = {};
    const unknown: Record<string, number> = {};

    const spokenBlocks = blocks.filter((b) => isSpoken(b.role));
    // The first two blocks of the main stream — usually a title and the
    // paragraph under it — are what the listener waits on.
    const opening = new Set(spokenBlocks.filter((b) => b.role !== "footnoteBody").slice(0, 2).map((b) => b.id));
    // In flight several at a time, assembled in document order afterwards.
    const results = new Array<ChunkResult>(spokenBlocks.length);
    let next = 0;
    let done = 0;
    const lane = async (): Promise<void> => {
      while (next < spokenBlocks.length) {
        const index = next++;
        const block = spokenBlocks[index];
        results[index] = await this.chunker.chunk(
          block,
          this.phonemizer,
          opening.has(block.id) ? OPENING_TARGET : TARGET,
        );
        done += 1;
        onProgress?.(done, spokenBlocks.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, spokenBlocks.length) }, lane));

    spokenBlocks.forEach((block, index) => {
      const result = results[index];
      for (const [symbol, count] of Object.entries(result.unknownSymbols)) {
        unknown[symbol] = (unknown[symbol] ?? 0) + count;
      }
      if (block.role === "footnoteBody") footnoteChunks[block.id] = result.chunks;
      else mainChunks.push(...result.chunks);
    });

    let overBudgetChunks = 0;
    for (const chunk of [...mainChunks, ...Object.values(footnoteChunks).flat()]) {
      if (chunk.tokens.length > BUDGET) overBudgetChunks += 1;
    }

    return {
      blocks,
      reflow,
      mainChunks,
      footnoteChunks,
      unknownSymbols: unknown,
      phonemizerName: this.phonemizer.name,
      overBudgetChunks,
    };
  }
}
