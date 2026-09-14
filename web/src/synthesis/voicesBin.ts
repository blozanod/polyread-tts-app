import { PolyReadError } from "../core/errors";
import { Voice, VOICE_DIMENSION, VOICE_ROWS } from "./voices";

/**
 * §7.1's packed format, kept for anyone who already has the iOS build's
 * `Voices.bin`: "24-byte header (magic `"AIOSVOX"` + version byte, count,
 * lengths=510, dimension=256, reserved), then `24·n` NUL-padded ASCII names,
 * then `count · 510 · 256` float32 LE."
 *
 * The web distribution uses one bare file per voice instead (see `voices.ts`),
 * so nothing in the app reaches for this unless a packed file is configured.
 */
const MAGIC = "AIOSVOX";
const HEADER_SIZE = 24;
const NAME_SIZE = 24;

export interface VoicesBinHeader {
  version: number;
  count: number;
  lengths: number;
  dimension: number;
}

export class VoicesBin {
  readonly header: VoicesBinHeader;
  readonly names: string[];
  private readonly styles: Float32Array;

  constructor(data: ArrayBuffer) {
    if (data.byteLength < HEADER_SIZE) {
      throw new PolyReadError(
        "voicesFileMalformed",
        `file is ${data.byteLength} bytes, shorter than the header`,
      );
    }
    const bytes = new Uint8Array(data);
    const view = new DataView(data);

    const magic = new TextDecoder().decode(bytes.subarray(0, 7));
    if (magic !== MAGIC) {
      throw new PolyReadError("voicesFileMalformed", `magic is "${magic}", expected "${MAGIC}"`);
    }

    const version = bytes[7];
    const count = view.getUint32(8, true);
    const lengths = view.getUint32(12, true);
    const dimension = view.getUint32(16, true);

    if (count <= 0 || lengths <= 0 || dimension <= 0) {
      throw new PolyReadError(
        "voicesFileMalformed",
        `count=${count} lengths=${lengths} dimension=${dimension}`,
      );
    }

    const namesSize = count * NAME_SIZE;
    const floatCount = count * lengths * dimension;
    const expected = HEADER_SIZE + namesSize + floatCount * 4;
    if (data.byteLength < expected) {
      throw new PolyReadError(
        "voicesFileMalformed",
        `file is ${data.byteLength} bytes, expected at least ${expected} for ${count} voices`,
      );
    }

    const names: string[] = [];
    const decoder = new TextDecoder();
    for (let i = 0; i < count; i++) {
      const start = HEADER_SIZE + i * NAME_SIZE;
      const slice = bytes.subarray(start, start + NAME_SIZE);
      let end = slice.indexOf(0);
      if (end < 0) end = slice.length;
      names.push(decoder.decode(slice.subarray(0, end)));
    }

    const floatStart = HEADER_SIZE + namesSize;
    // The file is little-endian and every platform this runs on is too, so the
    // view is already correct; there is nothing to byte-swap.
    this.styles = new Float32Array(data.slice(floatStart, floatStart + floatCount * 4));
    this.header = { version, count, lengths, dimension };
    this.names = names;
  }

  voice(name: string): Voice {
    const index = this.names.indexOf(name);
    if (index < 0) throw new PolyReadError("voiceNotFound", name);
    const { lengths, dimension } = this.header;
    if (lengths !== VOICE_ROWS || dimension !== VOICE_DIMENSION) {
      throw new PolyReadError(
        "voicesFileMalformed",
        `lengths=${lengths} dimension=${dimension}, expected ${VOICE_ROWS}x${VOICE_DIMENSION}`,
      );
    }
    const start = index * lengths * dimension;
    return new Voice(name, this.styles.slice(start, start + lengths * dimension));
  }
}
