/**
 * The runtime assets pdf.js 6 needs, and does not bundle.
 *
 * `wasmUrl` is the one that matters. pdf.js 6 decodes JBIG2 and JPEG 2000 in
 * WebAssembly loaded from that directory, and JBIG2 is how essentially every
 * library scan is encoded — JSTOR, course reserves, anything that came off a
 * book scanner. Leave it unset and pdf.js does not throw: it warns
 * `JBig2 failed to initialize` to the console, skips the image, and renders the
 * page with only its text layer on it. The page comes out blank.
 *
 * The other three are quieter. `standardFontDataUrl` is the Foxit substitutes
 * for the base-14 fonts, `cMapUrl` the character maps a CID-keyed font needs,
 * and `iccUrl` the colour profile for tagged CMYK images.
 *
 * All four are resolved against the *page*, not against whatever module is
 * asking. The worker's own `import.meta.url` points into `assets/`, one level
 * down, so resolving there would look for `assets/pdfjs/` and 404 — the same
 * trap `settings.ts` documents for the model URLs.
 */
export interface PdfAssetOptions {
  wasmUrl: string;
  cMapUrl: string;
  cMapPacked: true;
  standardFontDataUrl: string;
  iccUrl: string;
  /**
   * Decided here rather than left to pdf.js, because pdf.js cannot decide it
   * inside a worker.
   *
   * `getDocument` works out whether its own worker should fetch these files
   * with, in pdf.js 6.3:
   *
   *     cMapUrl && cMapPacked && standardFontDataUrl && wasmUrl &&
   *     isValidFetchUrl(cMapUrl, document.baseURI) && …
   *
   * — a bare `document`, guarded only by that `&&` chain. Pass all four URLs
   * and the chain reaches it; in a worker there is no `document` and
   * `getDocument` throws `ReferenceError: document is not defined` before it
   * has read a byte. Passing three or fewer short-circuits first, which is why
   * this never surfaced until the assets were wired up.
   *
   * The value it would have computed is `true` — every URL here is absolute and
   * same-origin — so saying so explicitly both skips the broken branch and
   * keeps the intended behaviour.
   */
  useWorkerFetch: true;
}

/** `base` must end in a slash and be absolute; `pdfAssetBase()` produces one. */
export function pdfAssetOptions(base: string): PdfAssetOptions {
  const root = base.endsWith("/") ? base : `${base}/`;
  return {
    wasmUrl: `${root}wasm/`,
    cMapUrl: `${root}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${root}standard_fonts/`,
    iccUrl: `${root}iccs/`,
    useWorkerFetch: true,
  };
}

/** Where `vite.config.ts`'s `pdfjsAssets` plugin puts them, relative to the page. */
export function pdfAssetBase(): string {
  if (typeof document === "undefined") return "pdfjs/";
  try {
    return new URL("pdfjs/", document.baseURI).href;
  } catch {
    return "pdfjs/";
  }
}
