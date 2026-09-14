/**
 * Kokoro's own text preprocessing and phoneme post-processing.
 *
 * Ported from `kokoro-js` (Apache-2.0), which is the reference web client for
 * the same checkpoint this app runs. It is reproduced rather than imported
 * because kokoro-js only exposes it behind a full model load, and because the
 * two halves have to straddle our own tokenization: `normalizeText` runs on the
 * text we hand eSpeak, `postProcessPhonemes` runs on what comes back, and the
 * word-alignment pass in `espeakPhonemizer.ts` sits between them.
 *
 * Getting either half wrong is quiet rather than loud. Kokoro was trained on
 * misaki's phoneme inventory; eSpeak's differs in a handful of symbols, and an
 * unmapped one is dropped by the vocabulary rather than flagged, which shortens
 * the word and shifts every duration after it.
 */

function splitNum(match: string): string {
  if (match.includes(".")) return match;
  if (match.includes(":")) {
    const [h, m] = match.split(":").map(Number);
    if (m === 0) return `${h} o'clock`;
    return m < 10 ? `${h} oh ${m}` : `${h} ${m}`;
  }
  const year = parseInt(match.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return match;
  const left = match.slice(0, 2);
  const right = parseInt(match.slice(2, 4), 10);
  const suffix = match.endsWith("s") ? "s" : "";
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

function flipMoney(match: string): string {
  const unit = match[0] === "$" ? "dollar" : "pound";
  if (Number.isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${unit}s`;
  if (!match.includes(".")) {
    const plural = match.slice(1) === "1" ? "" : "s";
    return `${match.slice(1)} ${unit}${plural}`;
  }
  const [whole, fraction] = match.slice(1).split(".");
  const cents = parseInt(fraction.padEnd(2, "0"), 10);
  const centName = match[0] === "$" ? (cents === 1 ? "cent" : "cents") : cents === 1 ? "penny" : "pence";
  return `${whole} ${unit}${whole === "1" ? "" : "s"} and ${cents} ${centName}`;
}

function pointNum(match: string): string {
  const [whole, fraction] = match.split(".");
  return `${whole} point ${fraction.split("").join(" ")}`;
}

export function normalizeText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, "“")
    .replace(/»/g, "”")
    .replace(/[“”]/g, '"')
    .replace(/\(/g, "«")
    .replace(/\)/g, "»")
    .replace(/、/g, ", ")
    .replace(/。/g, ". ")
    .replace(/！/g, "! ")
    .replace(/，/g, ", ")
    .replace(/：/g, ": ")
    .replace(/；/g, "; ")
    .replace(/？/g, "? ")
    .replace(/[^\S \n]/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/(?<=\n) +(?=\n)/g, "")
    .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
    .replace(/\betc\.(?! [A-Z])/gi, "etc")
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(
      /[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi,
      flipMoney,
    )
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, " to ")
    .replace(/(?<=\d)S/g, " S")
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, "s")
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, "-"))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
    .trim();
}

/** The punctuation Kokoro keeps verbatim, rather than sending through eSpeak. */
const PUNCTUATION = ';:,.!?¡¿—…"«»“”';
const PUNCTUATION_PATTERN = new RegExp(
  `(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]+\\s*)+`,
  "g",
);

export interface TextSegment {
  /** true when this segment is punctuation, which passes through unphonemized */
  isPunctuation: boolean;
  text: string;
}

export function splitOnPunctuation(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(PUNCTUATION_PATTERN)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (cursor < index) segments.push({ isPunctuation: false, text: text.slice(cursor, index) });
    if (value.length > 0) segments.push({ isPunctuation: true, text: value });
    cursor = index + value.length;
  }
  if (cursor < text.length) segments.push({ isPunctuation: false, text: text.slice(cursor) });
  return segments;
}

/**
 * eSpeak's inventory -> misaki's, which is what Kokoro was trained on. `ɹ` for
 * `r` and `k` for `x` are the two that matter most in English; the rest are
 * rarer but equally silent when wrong.
 */
export function postProcessPhonemes(phonemes: string, language: "a" | "b" = "a"): string {
  let out = phonemes
    .replace(/kəkˈoːɹoʊ/g, "kˈoʊkəɹoʊ")
    .replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z");
  if (language === "a") out = out.replace(/(?<=nˈaɪn)ti(?!ː)/g, "di");
  return out.trim();
}
