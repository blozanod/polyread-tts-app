/**
 * Phoneme symbol -> Kokoro token id.
 *
 * ## The table below is the checkpoint's own, copied rather than reconstructed
 *
 * Two earlier versions of this file *derived* the table: they enumerated
 * Kokoro v0.19's symbol string (`_pad + _punctuation + _letters +
 * _letters_ipa`) and took each symbol's position as its id. The Swift build did
 * it first and dropped an apostrophe; the web build put the apostrophe back and
 * still got the tail of the list wrong. The v0.19 string ends `↘`, `'`, U+0329, `'`, `ᵻ` —
 * an apostrophe, a combining vertical line, and a *second* apostrophe that
 * overwrites the first in the dict comprehension — so `ᵻ` is 177, not 175.
 *
 * That one id is most of why the voice sounded broken. eSpeak emits `ᵻ` for
 * the vowel of nearly every unstressed "-ed" and "-es" ("wanted", "churches",
 * "organizations"), and 175 is a slot v1.0 does not use: the embedding the
 * model was handed there was never trained, so every one of those endings came
 * out as a smear. An enumerated table also carries 60-odd ids the checkpoint
 * never assigned — `A` at 17 is v1.0's combining tilde, for instance — which
 * eSpeak happens not to emit, and which nothing should be able to reach.
 *
 * So the table is v1.0's `config.json` vocabulary verbatim: 114 symbols plus
 * the pad, with the gaps where v1.0 retired a symbol left as gaps. It is the
 * same map `onnx-community/Kokoro-82M-v1.0-ONNX`'s `tokenizer.json` carries, so
 * the built-in table and the downloaded one now agree, and
 * `assertVocabularyShape()` pins it id for id.
 */
const PAD = "$";
const V1_VOCABULARY: ReadonlyArray<readonly [string, number]> = [
  [";", 1], [":", 2], [",", 3], [".", 4], ["!", 5], ["?", 6], ["—", 9], ["…", 10],
  ['"', 11], ["(", 12], [")", 13], ["“", 14], ["”", 15], [" ", 16],
  ["\u0303", 17], ["ʣ", 18], ["ʥ", 19], ["ʦ", 20], ["ʨ", 21], ["ᵝ", 22], ["\uAB67", 23],
  ["A", 24], ["I", 25], ["O", 31], ["Q", 33], ["S", 35], ["T", 36], ["W", 39], ["Y", 41], ["ᵊ", 42],
  ["a", 43], ["b", 44], ["c", 45], ["d", 46], ["e", 47], ["f", 48], ["h", 50], ["i", 51],
  ["j", 52], ["k", 53], ["l", 54], ["m", 55], ["n", 56], ["o", 57], ["p", 58], ["q", 59],
  ["r", 60], ["s", 61], ["t", 62], ["u", 63], ["v", 64], ["w", 65], ["x", 66], ["y", 67], ["z", 68],
  ["ɑ", 69], ["ɐ", 70], ["ɒ", 71], ["æ", 72], ["β", 75], ["ɔ", 76], ["ɕ", 77], ["ç", 78],
  ["ɖ", 80], ["ð", 81], ["ʤ", 82], ["ə", 83], ["ɚ", 85], ["ɛ", 86], ["ɜ", 87], ["ɟ", 90],
  ["ɡ", 92], ["ɥ", 99], ["ɨ", 101], ["ɪ", 102], ["ʝ", 103], ["ɯ", 110], ["ɰ", 111], ["ŋ", 112],
  ["ɳ", 113], ["ɲ", 114], ["ɴ", 115], ["ø", 116], ["ɸ", 118], ["θ", 119], ["œ", 120], ["ɹ", 123],
  ["ɾ", 125], ["ɻ", 126], ["ʁ", 128], ["ɽ", 129], ["ʂ", 130], ["ʃ", 131], ["ʈ", 132], ["ʧ", 133],
  ["ʊ", 135], ["ʋ", 136], ["ʌ", 138], ["ɣ", 139], ["ɤ", 140], ["χ", 142], ["ʎ", 143], ["ʒ", 147],
  ["ʔ", 148], ["ˈ", 156], ["ˌ", 157], ["ː", 158], ["ʰ", 162], ["ʲ", 164], ["↓", 169], ["→", 171],
  ["↗", 172], ["↘", 173], ["ᵻ", 177],
];

/**
 * Symbols the text side emits that the checkpoint spells differently.
 *
 * `normalizeText` turns parentheses into guillemets so the punctuation splitter
 * keeps them out of eSpeak, exactly as kokoro-js does — but v1.0 has no
 * guillemets, only the parentheses themselves at 12 and 13, which misaki (the
 * G2P the checkpoint was trained on) passes straight through. Mapping them back
 * keeps a parenthetical sounding like one instead of silently dropping the
 * cue.
 */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ["«", "("],
  ["»", ")"],
]);

export interface VocabularyEncodeResult {
  tokens: number[];
  unknown: string[];
}

export class KokoroVocabulary {
  readonly symbolToID: ReadonlyMap<string, number>;
  readonly source: string;
  readonly isVerified: boolean;

  constructor(symbolToID: ReadonlyMap<string, number>, source: string, isVerified: boolean) {
    this.symbolToID = symbolToID;
    this.source = source;
    this.isVerified = isVerified;
  }

  /**
   * Encodes a phoneme string to token ids. Unknown symbols are dropped and
   * reported rather than silently mapped to the pad id — a pad in the middle of
   * a word would shift every duration after it.
   */
  encode(phonemes: string): VocabularyEncodeResult {
    const tokens: number[] = [];
    const unknown: string[] = [];
    // Iterate by code point, not code unit: every symbol here is BMP, but a
    // stray emoji out of a bad OCR layer should not split into two lone
    // surrogates that both miss the table.
    for (const symbol of phonemes) {
      const id = this.idOf(symbol);
      if (id === undefined) unknown.push(symbol);
      else tokens.push(id);
    }
    return { tokens, unknown };
  }

  contains(phonemes: string): boolean {
    for (const symbol of phonemes) {
      if (this.idOf(symbol) === undefined) return false;
    }
    return true;
  }

  private idOf(symbol: string): number | undefined {
    const id = this.symbolToID.get(symbol);
    if (id !== undefined) return id;
    const alias = ALIASES.get(symbol);
    return alias === undefined ? undefined : this.symbolToID.get(alias);
  }

  get spaceID(): number | undefined {
    return this.symbolToID.get(" ");
  }
}

function buildTable(): Map<string, number> {
  return new Map<string, number>([[PAD, 0], ...V1_VOCABULARY]);
}

export const defaultVocabulary = new KokoroVocabulary(
  buildTable(),
  "built-in (Kokoro-82M v1.0 config.json)",
  true,
);

/**
 * Prefers a vocabulary shipped next to the model over the built-in table.
 * Accepts either a flat `{"symbol": id}` map (what the upstream repo emits as
 * `kokoro_vocab.json`) or a HuggingFace `tokenizer.json`, whose ids live under
 * `model.vocab`. `npm run assets` fetches the latter, so a checkpoint that ever
 * moves an id is picked up without a code change.
 */
export async function loadVocabulary(url?: string): Promise<KokoroVocabulary> {
  if (!url) return defaultVocabulary;
  try {
    const response = await fetch(url);
    if (!response.ok) return defaultVocabulary;
    const decoded = (await response.json()) as Record<string, unknown> & {
      model?: { vocab?: Record<string, number> };
    };
    const flat: Record<string, unknown> = decoded.model?.vocab ?? decoded;
    const entries: Array<[string, number]> = [];
    for (const [symbol, id] of Object.entries(flat)) {
      if (typeof id === "number") entries.push([symbol, id]);
    }
    if (entries.length === 0) return defaultVocabulary;
    return new KokoroVocabulary(new Map(entries), url, true);
  } catch {
    return defaultVocabulary;
  }
}

/** §7.1 — "Token 0 at both ends." */
export function framed(tokens: readonly number[]): number[] {
  return [0, ...tokens, 0];
}

/**
 * The ids that are cheap to get wrong and expensive to notice. Called by the
 * test suite and by the benchmark screen.
 */
export function assertVocabularyShape(vocab: KokoroVocabulary = defaultVocabulary): string[] {
  const expected: Array<[string, number]> = [
    // One anchor per run of the table, so a symbol added or dropped anywhere
    // shows up as a shifted anchor downstream of it.
    ["$", 0],
    [";", 1],
    ["—", 9],
    ["(", 12],
    [" ", 16],
    ["A", 24],
    ["a", 43],
    ["z", 68],
    ["ɑ", 69],
    ["ɡ", 92],
    ["ɹ", 123],
    ["ˈ", 156],
    ["ˌ", 157],
    ["ː", 158],
    // The one that made every unstressed "-ed" and "-es" unintelligible.
    ["ᵻ", 177],
  ];
  const problems: string[] = [];
  for (const [symbol, id] of expected) {
    const actual = vocab.symbolToID.get(symbol);
    if (actual !== id) problems.push(`${JSON.stringify(symbol)} is ${actual}, expected ${id}`);
  }
  // Symbols v1.0 retired. An enumerated table assigns them, which is how the
  // old one gave ᵻ the wrong id without anything noticing.
  for (const retired of ["g", "'", "«", "»", "¡", "¿"]) {
    if (vocab.symbolToID.has(retired)) problems.push(`${JSON.stringify(retired)} is not in the v1.0 vocabulary`);
  }
  if (vocab.symbolToID.size !== 115) {
    problems.push(`vocabulary has ${vocab.symbolToID.size} symbols, expected 115`);
  }
  return problems;
}
