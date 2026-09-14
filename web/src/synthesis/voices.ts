import { PolyReadError } from "../core/errors";

/**
 * A Kokoro voice is a table of style vectors, not a single vector: 510 rows of
 * 256 float32, one row per phoneme count.
 *
 * §7.1 — "**Style row index = phoneme count excluding the two boundary
 * tokens.**" Which is also why §6.2 wants uniform chunk lengths: wildly varying
 * counts pick wildly varying style rows and the prosody wanders.
 *
 * The iOS build read these out of one packed `Voices.bin` (a 24-byte header,
 * then names, then every voice's table). The web distribution ships them as one
 * file per voice — 522,240 bytes each, raw little-endian float32, no header —
 * which is better here: a voice is fetched only when it is selected, and a
 * browser caches 510 KB without complaint. `voicesBin.ts` still reads the packed
 * format, for anyone who already has one.
 */
export const VOICE_ROWS = 510;
export const VOICE_DIMENSION = 256;
export const VOICE_BYTES = VOICE_ROWS * VOICE_DIMENSION * 4;

export class Voice {
  readonly name: string;
  private readonly styles: Float32Array;

  constructor(name: string, styles: Float32Array) {
    if (styles.length !== VOICE_ROWS * VOICE_DIMENSION) {
      throw new PolyReadError(
        "voicesFileMalformed",
        `${name} has ${styles.length} floats, expected ${VOICE_ROWS * VOICE_DIMENSION}`,
      );
    }
    this.name = name;
    this.styles = styles;
  }

  static fromBuffer(name: string, buffer: ArrayBuffer): Voice {
    if (buffer.byteLength < VOICE_BYTES) {
      throw new PolyReadError(
        "voicesFileMalformed",
        `${name} is ${buffer.byteLength} bytes, expected ${VOICE_BYTES}`,
      );
    }
    return new Voice(name, new Float32Array(buffer, 0, VOICE_ROWS * VOICE_DIMENSION));
  }

  /**
   * `phonemeCount` is the chunk's token count with the two boundary zeros
   * excluded. A chunk exactly at the 510 budget would index one past the last
   * row, hence the clamp — the same clamp kokoro-js applies.
   */
  style(phonemeCount: number): Float32Array {
    const row = Math.min(Math.max(0, phonemeCount), VOICE_ROWS - 1);
    const start = row * VOICE_DIMENSION;
    return this.styles.slice(start, start + VOICE_DIMENSION);
  }
}

/**
 * The voices published with the ONNX checkpoint, in the order the model card
 * grades them. `af_heart` is the default for the same reason the iOS build
 * hardcoded it: it is the only A-graded voice.
 */
export interface VoiceInfo {
  id: string;
  name: string;
  language: "en-us" | "en-gb";
  gender: "Female" | "Male";
  grade: string;
}

export const VOICES: readonly VoiceInfo[] = [
  { id: "af_heart", name: "Heart", language: "en-us", gender: "Female", grade: "A" },
  { id: "af_bella", name: "Bella", language: "en-us", gender: "Female", grade: "A-" },
  { id: "af_nicole", name: "Nicole", language: "en-us", gender: "Female", grade: "B-" },
  { id: "bf_emma", name: "Emma", language: "en-gb", gender: "Female", grade: "B-" },
  { id: "af_aoede", name: "Aoede", language: "en-us", gender: "Female", grade: "C+" },
  { id: "af_kore", name: "Kore", language: "en-us", gender: "Female", grade: "C+" },
  { id: "af_sarah", name: "Sarah", language: "en-us", gender: "Female", grade: "C+" },
  { id: "am_fenrir", name: "Fenrir", language: "en-us", gender: "Male", grade: "C+" },
  { id: "am_michael", name: "Michael", language: "en-us", gender: "Male", grade: "C+" },
  { id: "am_puck", name: "Puck", language: "en-us", gender: "Male", grade: "C+" },
  { id: "bm_fable", name: "Fable", language: "en-gb", gender: "Male", grade: "C" },
  { id: "bm_george", name: "George", language: "en-gb", gender: "Male", grade: "C" },
  { id: "bf_isabella", name: "Isabella", language: "en-gb", gender: "Female", grade: "C" },
  { id: "af_nova", name: "Nova", language: "en-us", gender: "Female", grade: "C" },
  { id: "af_sky", name: "Sky", language: "en-us", gender: "Female", grade: "C-" },
  { id: "am_echo", name: "Echo", language: "en-us", gender: "Male", grade: "D" },
  { id: "am_eric", name: "Eric", language: "en-us", gender: "Male", grade: "D" },
  { id: "am_liam", name: "Liam", language: "en-us", gender: "Male", grade: "D" },
  { id: "am_onyx", name: "Onyx", language: "en-us", gender: "Male", grade: "D" },
  { id: "bm_lewis", name: "Lewis", language: "en-gb", gender: "Male", grade: "D+" },
  { id: "bm_daniel", name: "Daniel", language: "en-gb", gender: "Male", grade: "D" },
  { id: "bf_alice", name: "Alice", language: "en-gb", gender: "Female", grade: "D" },
  { id: "bf_lily", name: "Lily", language: "en-gb", gender: "Female", grade: "D" },
];

export const DEFAULT_VOICE = "af_heart";

/** en-gb voices want eSpeak's "en" rather than "en-us" (§6.1's language flag). */
export function espeakLanguageFor(voiceID: string): "a" | "b" {
  return voiceID.startsWith("b") ? "b" : "a";
}

const cache = new Map<string, Promise<Voice>>();

export function loadVoice(voiceID: string, baseUrl: string): Promise<Voice> {
  const key = `${baseUrl}::${voiceID}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const url = `${baseUrl.replace(/\/$/, "")}/${voiceID}.bin`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new PolyReadError("modelMissing", `${voiceID}.bin (${response.status} from ${url})`);
      }
      const buffer = await response.arrayBuffer();
      // A static host with a single-page-app fallback answers a missing file
      // with index.html rather than a 404, so "not downloaded yet" arrives here
      // as a few hundred bytes of markup. Reporting that as a malformed voice
      // sends the reader looking for a corrupt file instead of a missing one.
      if (buffer.byteLength < VOICE_BYTES) {
        throw new PolyReadError(
          "modelMissing",
          `${voiceID}.bin — ${url} returned ${buffer.byteLength} bytes, not the expected ${VOICE_BYTES}`,
        );
      }
      return Voice.fromBuffer(voiceID, buffer);
    })().catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
  }
  return pending;
}
