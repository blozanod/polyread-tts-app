import { EspeakPhonemizer, type EspeakLanguage } from "./espeakPhonemizer";
import type { POSTag } from "./homographs";
import type { Phonemizer, PhonemizerCapabilities, PhonemizedWord } from "./phonemizer";

/**
 * eSpeak on several threads.
 *
 * The `phonemizer` package is eSpeak compiled to plain JavaScript rather than
 * WebAssembly, and it produces its phonemes by running the synthesizer — audio
 * and all — and reading back the trace. That is about a millisecond a word, all
 * of it on the pipeline worker's one thread, and all of it before the reader
 * can open: a fifteen-page article spent a quarter of a minute on "Reading it
 * out to itself" while the rest of the machine sat idle.
 *
 * Nothing in eSpeak's work on one paragraph depends on another, so paragraphs
 * are handed to a few workers of their own and phonemized side by side. The
 * results are identical to the single-threaded path — each worker runs exactly
 * `EspeakPhonemizer` — and anything that goes wrong in a worker is redone here
 * rather than lost.
 */
export interface PhonemizeRequest {
  id: number;
  tokens: string[];
  language: EspeakLanguage;
}

export type PhonemizeResponse =
  | { id: number; words: PhonemizedWord[]; isolatedPassages: number }
  | { id: number; error: string };

/** What the pool needs of a worker; a real `Worker` is one. */
export interface PoolWorker {
  postMessage(message: PhonemizeRequest): void;
  onmessage: ((event: MessageEvent<PhonemizeResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

interface Pending {
  tokens: readonly string[];
  resolve(words: PhonemizedWord[]): void;
  reject(error: unknown): void;
  member: Member;
}

interface Member {
  worker: PoolWorker;
  inFlight: number;
  alive: boolean;
}

/** Workers the pool starts: every core but one, at most four. */
export function poolSize(cores: number): number {
  return Math.max(1, Math.min(4, cores - 1));
}

export class PhonemizerPool implements Phonemizer {
  readonly name: string;
  readonly capabilities: PhonemizerCapabilities = {
    providesWordGrouping: true,
    resolvesHomographs: true,
    expandsNumbers: true,
  };
  /** Passages any member fell back to per-token phonemization for. */
  isolatedPassages = 0;

  private readonly language: EspeakLanguage;
  private readonly members: Member[];
  private readonly pending = new Map<number, Pending>();
  private nextID = 0;
  /** The same work on this thread, for whatever a worker could not do. */
  private local: EspeakPhonemizer | undefined;

  constructor(language: EspeakLanguage, size: number, spawn: () => PoolWorker) {
    this.language = language;
    this.members = Array.from({ length: Math.max(1, size) }, () => {
      const member: Member = { worker: spawn(), inFlight: 0, alive: true };
      member.worker.onmessage = (event) => this.settle(event.data);
      member.worker.onerror = () => this.lose(member);
      return member;
    });
    this.name = `eSpeak-NG, ${this.members.length} workers`;
  }

  get size(): number {
    return this.members.length;
  }

  phonemize(tokens: readonly string[], posTags: readonly POSTag[]): Promise<PhonemizedWord[]> {
    const member = this.members
      .filter((m) => m.alive)
      .reduce<Member | undefined>((best, m) => (!best || m.inFlight < best.inFlight ? m : best), undefined);
    if (!member) return this.fallback(tokens, posTags);

    const id = this.nextID++;
    return new Promise<PhonemizedWord[]>((resolve, reject) => {
      this.pending.set(id, { tokens, resolve, reject, member });
      member.inFlight += 1;
      member.worker.postMessage({ id, tokens: [...tokens], language: this.language });
    });
  }

  dispose(): void {
    for (const member of this.members) {
      member.alive = false;
      member.worker.terminate();
    }
    // Anything still owed is finished here rather than left hanging.
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      this.fallback(pending.tokens, []).then(pending.resolve, pending.reject);
    }
  }

  private settle(response: PhonemizeResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.member.inFlight -= 1;
    if ("error" in response) {
      this.fallback(pending.tokens, []).then(pending.resolve, pending.reject);
      return;
    }
    this.isolatedPassages += response.isolatedPassages;
    pending.resolve(response.words);
  }

  /** A worker that died takes nothing with it: what it owed is redone here. */
  private lose(member: Member): void {
    member.alive = false;
    member.worker.terminate();
    for (const [id, pending] of this.pending) {
      if (pending.member !== member) continue;
      this.pending.delete(id);
      this.fallback(pending.tokens, []).then(pending.resolve, pending.reject);
    }
  }

  private async fallback(tokens: readonly string[], posTags: readonly POSTag[]): Promise<PhonemizedWord[]> {
    this.local ??= new EspeakPhonemizer(this.language);
    const before = this.local.isolatedPassages;
    const words = await this.local.phonemize(tokens, posTags);
    this.isolatedPassages += this.local.isolatedPassages - before;
    return words;
  }
}
