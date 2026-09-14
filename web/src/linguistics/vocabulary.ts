/**
 * Phoneme symbol -> Kokoro token id.
 *
 * ## The table below is the real one, and that is a change
 *
 * The Swift build shipped a *reconstruction* of Kokoro's symbol list and said
 * so loudly, because there was no model in that container to check it against.
 * There is one reachable here: `kokoro-js` (Apache-2.0, the reference web
 * client for the same checkpoint) builds its ids from this exact symbol list,
 * and the list has one character the Swift reconstruction was missing — an
 * apostrophe, second-to-last in the IPA run, immediately before `ᵻ`.
 *
 * That omission was not cosmetic. It shifted `ᵻ` down by one and dropped `'`
 * entirely, and eSpeak emits `ᵻ` constantly (every unstressed "-es" and "-ed").
 * A vocabulary that is off by one does not throw; it synthesizes the wrong
 * phonemes confidently, and §5 warns that the symptom looks like a timing bug.
 *
 * `assertVocabularyShape()` pins the ids that are cheap to get wrong, so a
 * future edit to these strings fails a test instead of a listening session.
 */
const PAD = "$";
const PUNCTUATION = ';:,.!?¡¿—…"«»“” ';
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LETTERS_IPA =
  "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'ᵻ";

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
      const id = this.symbolToID.get(symbol);
      if (id === undefined) unknown.push(symbol);
      else tokens.push(id);
    }
    return { tokens, unknown };
  }

  contains(phonemes: string): boolean {
    for (const symbol of phonemes) {
      if (!this.symbolToID.has(symbol)) return false;
    }
    return true;
  }

  get spaceID(): number | undefined {
    return this.symbolToID.get(" ");
  }
}

function buildTable(): Map<string, number> {
  const symbols = [PAD, ...PUNCTUATION, ...LETTERS, ...LETTERS_IPA];
  const table = new Map<string, number>();
  // Upstream builds this as a Python dict comprehension over an index range, so
  // a repeated symbol keeps its *last* index. Nothing repeats today; matching
  // the rule anyway means a future symbol addition cannot silently diverge.
  for (let i = 0; i < symbols.length; i++) table.set(symbols[i], i);
  return table;
}

export const defaultVocabulary = new KokoroVocabulary(
  buildTable(),
  "built-in (matches kokoro-js / onnx-community Kokoro-82M-v1.0)",
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
    // Structural anchors: one per run of the symbol list, so a character added
    // or dropped anywhere shows up as a shifted anchor downstream of it.
    ["$", 0],
    [";", 1],
    [" ", 16],
    ["A", 17],
    ["z", 68],
    ["ɑ", 69],
    ["ˈ", 156],
    ["ˌ", 157],
    ["ː", 158],
    // The two the Swift reconstruction got wrong by omitting the apostrophe.
    ["'", 174],
    ["ᵻ", 175],
  ];
  const problems: string[] = [];
  for (const [symbol, id] of expected) {
    const actual = vocab.symbolToID.get(symbol);
    if (actual !== id) problems.push(`${JSON.stringify(symbol)} is ${actual}, expected ${id}`);
  }
  if (vocab.symbolToID.size !== 176) {
    problems.push(`vocabulary has ${vocab.symbolToID.size} symbols, expected 176`);
  }
  return problems;
}
