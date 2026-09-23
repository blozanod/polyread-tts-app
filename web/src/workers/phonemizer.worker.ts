/// <reference lib="webworker" />
import { EspeakPhonemizer, type EspeakLanguage } from "../linguistics/espeakPhonemizer";
import type { PhonemizeRequest, PhonemizeResponse } from "../linguistics/phonemizerPool";

/**
 * One member of the pipeline worker's eSpeak pool. See `phonemizerPool.ts` for
 * why there is a pool at all.
 */
const phonemizers = new Map<EspeakLanguage, EspeakPhonemizer>();

function post(response: PhonemizeResponse): void {
  (self as unknown as Worker).postMessage(response);
}

self.onmessage = async (event: MessageEvent<PhonemizeRequest>): Promise<void> => {
  const { id, tokens, language } = event.data;
  try {
    let phonemizer = phonemizers.get(language);
    if (!phonemizer) {
      phonemizer = new EspeakPhonemizer(language);
      phonemizers.set(language, phonemizer);
    }
    const before = phonemizer.isolatedPassages;
    const words = await phonemizer.phonemize(tokens, []);
    post({ id, words, isolatedPassages: phonemizer.isolatedPassages - before });
  } catch (error) {
    post({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
