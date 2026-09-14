import type { DocumentSidecar } from "../core/sidecar";

/**
 * §7.4 — "Int16 CAF per document — no encode latency, seekable, ~260 MB per 90
 * minutes — plus a JSON sidecar holding `[WordTiming]` and `[Block]`. Keyed by
 * PDF content hash so reopening a document is instant. LRU eviction of whole
 * documents against a size cap (default ~4 GB), with a user-visible storage
 * figure in settings."
 *
 * IndexedDB is the CAF's stand-in. There is no file to seek within, so audio is
 * stored one record per chunk — which is what §7.3's out-of-order rendering
 * wants anyway: "seek into unrendered territory" writes chunk 90 while chunks
 * 40-89 are still missing, and a record per chunk represents that hole
 * naturally instead of leaving a silent gap in a file.
 *
 * Samples are Int16 on the way in and Float32 on the way out, for the same
 * reason §7.4 chose Int16: half the bytes, no perceptible loss at 24 kHz, and
 * no encode latency in either direction.
 */
const DB_NAME = "polyread";
const DB_VERSION = 1;
const SIDECARS = "sidecars";
const AUDIO = "audio";
const ORIGINAL = "originals";

export interface LibraryEntry {
  contentHash: string;
  title: string;
  pageCount: number;
  duration: number;
  voiceName: string;
  timingSource: DocumentSidecar["timingSource"];
  createdAt: number;
  lastOpenedAt: number;
  audioBytes: number;
  renderedChunks: number;
  totalChunks: number;
  hasOriginal: boolean;
}

interface AudioRecord {
  key: string;
  contentHash: string;
  chunkIndex: number;
  samples: Int16Array;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SIDECARS)) {
        db.createObjectStore(SIDECARS, { keyPath: "contentHash" });
      }
      if (!db.objectStoreNames.contains(AUDIO)) {
        const store = db.createObjectStore(AUDIO, { keyPath: "key" });
        store.createIndex("contentHash", "contentHash", { unique: false });
      }
      if (!db.objectStoreNames.contains(ORIGINAL)) {
        db.createObjectStore(ORIGINAL, { keyPath: "contentHash" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const audioKey = (contentHash: string, chunkIndex: number): string =>
  `${contentHash}:${String(chunkIndex).padStart(6, "0")}`;

/**
 * The same scale in both directions, and a real rounding rather than the
 * truncation an `Int16Array` assignment would do on its own. Scaling by 32767
 * rather than 32768 on the way in gives up one code point at the negative
 * extreme and buys an exactly invertible pair: a sample survives the trip to
 * within half a quantization step instead of picking up a systematic gain error
 * that would differ between positive and negative halves of the waveform.
 */
const INT16_SCALE = 32767;

export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = Math.round(clamped * INT16_SCALE);
  }
  return out;
}

export function toFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / INT16_SCALE;
  return out;
}

export class DocumentStore {
  private db: IDBDatabase | undefined;

  private async database(): Promise<IDBDatabase> {
    if (!this.db) this.db = await open();
    return this.db;
  }

  async putSidecar(sidecar: DocumentSidecar, entry: Omit<LibraryEntry, "audioBytes">): Promise<void> {
    const db = await this.database();
    const transaction = db.transaction(SIDECARS, "readwrite");
    transaction.objectStore(SIDECARS).put({ ...entry, sidecar });
    await done(transaction);
  }

  async getSidecar(contentHash: string): Promise<DocumentSidecar | undefined> {
    const db = await this.database();
    const transaction = db.transaction(SIDECARS, "readonly");
    const record = await promisify<{ sidecar: DocumentSidecar } | undefined>(
      transaction.objectStore(SIDECARS).get(contentHash),
    );
    return record?.sidecar;
  }

  /**
   * An IndexedDB transaction deactivates as soon as control returns to the
   * event loop with no pending request, so `await`-ing anything in the middle of
   * one and then touching it again throws `TransactionInactiveError` — which is
   * exactly what a read-then-write looks like if written naturally. Every
   * multi-step operation in this file therefore finishes one transaction before
   * opening the next.
   */
  async touch(contentHash: string): Promise<void> {
    const db = await this.database();
    const read = db.transaction(SIDECARS, "readonly");
    const record = await promisify<Record<string, unknown> | undefined>(
      read.objectStore(SIDECARS).get(contentHash),
    );
    if (!record) return;
    record.lastOpenedAt = Date.now();
    const write = db.transaction(SIDECARS, "readwrite");
    write.objectStore(SIDECARS).put(record);
    await done(write);
  }

  async list(): Promise<LibraryEntry[]> {
    const db = await this.database();
    const read = db.transaction(SIDECARS, "readonly");
    const records = await promisify<Array<LibraryEntry & { sidecar: DocumentSidecar }>>(
      read.objectStore(SIDECARS).getAll() as IDBRequest<Array<LibraryEntry & { sidecar: DocumentSidecar }>>,
    );

    const entries: LibraryEntry[] = [];
    for (const record of records) {
      // One transaction per document: the loop awaits, so they cannot share one.
      const audioTx = db.transaction(AUDIO, "readonly");
      const audio = await promisify<AudioRecord[]>(
        audioTx.objectStore(AUDIO).index("contentHash").getAll(record.contentHash) as IDBRequest<AudioRecord[]>,
      );
      let bytes = 0;
      for (const chunk of audio) bytes += chunk.samples.byteLength;
      entries.push({
        contentHash: record.contentHash,
        title: record.title,
        pageCount: record.pageCount,
        duration: record.duration,
        voiceName: record.voiceName,
        timingSource: record.timingSource,
        createdAt: record.createdAt,
        lastOpenedAt: record.lastOpenedAt,
        audioBytes: bytes,
        renderedChunks: audio.length,
        totalChunks: record.totalChunks,
        hasOriginal: record.hasOriginal,
      });
    }
    return entries.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  async putAudio(contentHash: string, chunkIndex: number, samples: Float32Array): Promise<void> {
    const db = await this.database();
    const transaction = db.transaction(AUDIO, "readwrite");
    transaction.objectStore(AUDIO).put({
      key: audioKey(contentHash, chunkIndex),
      contentHash,
      chunkIndex,
      samples: toInt16(samples),
    } satisfies AudioRecord);
    await done(transaction);
  }

  async getAudio(contentHash: string, chunkIndex: number): Promise<Float32Array | undefined> {
    const db = await this.database();
    const transaction = db.transaction(AUDIO, "readonly");
    const record = await promisify<AudioRecord | undefined>(
      transaction.objectStore(AUDIO).get(audioKey(contentHash, chunkIndex)),
    );
    return record ? toFloat32(record.samples) : undefined;
  }

  async renderedChunkIndices(contentHash: string): Promise<number[]> {
    const db = await this.database();
    const transaction = db.transaction(AUDIO, "readonly");
    const keys = await promisify<IDBValidKey[]>(
      transaction.objectStore(AUDIO).index("contentHash").getAllKeys(contentHash),
    );
    return keys
      .map((key) => Number(String(key).split(":")[1]))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
  }

  /** The PDF itself, so the page view and a re-import work offline. */
  async putOriginal(contentHash: string, bytes: ArrayBuffer): Promise<void> {
    const db = await this.database();
    const transaction = db.transaction(ORIGINAL, "readwrite");
    transaction.objectStore(ORIGINAL).put({ contentHash, bytes });
    await done(transaction);
  }

  async getOriginal(contentHash: string): Promise<ArrayBuffer | undefined> {
    const db = await this.database();
    const transaction = db.transaction(ORIGINAL, "readonly");
    const record = await promisify<{ bytes: ArrayBuffer } | undefined>(
      transaction.objectStore(ORIGINAL).get(contentHash),
    );
    return record?.bytes;
  }

  async remove(contentHash: string): Promise<void> {
    await this.removeAudio(contentHash);
    const db = await this.database();
    const transaction = db.transaction([SIDECARS, ORIGINAL], "readwrite");
    transaction.objectStore(SIDECARS).delete(contentHash);
    transaction.objectStore(ORIGINAL).delete(contentHash);
    await done(transaction);
  }

  /** Drops only the rendered audio, keeping the timeline so a reopen is instant. */
  async removeAudio(contentHash: string): Promise<void> {
    const db = await this.database();
    const read = db.transaction(AUDIO, "readonly");
    const keys = await promisify<IDBValidKey[]>(
      read.objectStore(AUDIO).index("contentHash").getAllKeys(contentHash),
    );
    if (keys.length === 0) return;
    const write = db.transaction(AUDIO, "readwrite");
    const store = write.objectStore(AUDIO);
    for (const key of keys) store.delete(key);
    await done(write);
  }

  /**
   * §7.4's LRU. Evicts whole documents, oldest-opened first, until the total is
   * under the cap. `keep` is the document being read right now, which is never
   * a candidate however old it looks.
   */
  async evictToFit(capBytes: number, keep?: string): Promise<string[]> {
    const entries = await this.list();
    let total = entries.reduce((sum, e) => sum + e.audioBytes, 0);
    if (total <= capBytes) return [];

    const candidates = entries
      .filter((e) => e.contentHash !== keep)
      .sort((a, b) => a.lastOpenedAt - b.lastOpenedAt);

    const evicted: string[] = [];
    for (const entry of candidates) {
      if (total <= capBytes) break;
      await this.removeAudio(entry.contentHash);
      total -= entry.audioBytes;
      evicted.push(entry.contentHash);
    }
    return evicted;
  }

  async usage(): Promise<{ audioBytes: number; quotaBytes?: number }> {
    const entries = await this.list();
    const audioBytes = entries.reduce((sum, e) => sum + e.audioBytes, 0);
    try {
      const estimate = await navigator.storage?.estimate?.();
      return { audioBytes, quotaBytes: estimate?.quota };
    } catch {
      return { audioBytes };
    }
  }
}

/** §7.4 — "Keyed by PDF content hash so reopening a document is instant." */
export async function contentHash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
