import { buildReflowDocument, type ReflowDocument } from "../core/reflow";
import { isSpoken, type Block, type PhonemizedChunk } from "../core/types";
import { BUDGET, Chunker } from "./chunker";
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
export class LinguisticsPipeline {
  private readonly chunker: Chunker;
  readonly phonemizer: Phonemizer;

  constructor(phonemizer: Phonemizer = new EspeakPhonemizer(), vocabulary: KokoroVocabulary = defaultVocabulary) {
    this.phonemizer = phonemizer;
    this.chunker = new Chunker(vocabulary);
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
    let done = 0;
    for (const block of spokenBlocks) {
      const result = await this.chunker.chunk(block, this.phonemizer);
      for (const [symbol, count] of Object.entries(result.unknownSymbols)) {
        unknown[symbol] = (unknown[symbol] ?? 0) + count;
      }
      if (block.role === "footnoteBody") footnoteChunks[block.id] = result.chunks;
      else mainChunks.push(...result.chunks);
      done += 1;
      onProgress?.(done, spokenBlocks.length);
    }

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
