import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import { extractDocument, surveyDocument } from "../src/extraction/documentExtractor";
import type { PdfDocumentProxy, PdfLoadingTask } from "../src/extraction/pdfTypes";

/**
 * The layouts academic readings come in, typeset by
 * `scripts/make-layout-fixtures.py` so that the right reading of every page is
 * known exactly, and held to it paragraph for paragraph.
 *
 * Each of these reproduced a reported failure before the extractor was
 * rewritten: the two-column article was read straight across both columns
 * (2 of 28 paragraphs right), every line of a block quote was a paragraph of
 * its own, small caps and a period in another font split their words, the
 * scan's skew shuffled words between lines, and the simulated-bold headings
 * were read twice.
 */
const fixtures = fileURLToPath(new URL("./fixtures/layouts/", import.meta.url));

interface Expected {
  blocks: Array<["body" | "heading", string]>;
  notes: string[];
}

/** Word content only: the comparison is about what is read, not how it is punctuated. */
const words = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[‘’]/gu, "'")
    .replace(/[^\p{L}\p{Nd}' ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

async function extract(name: string) {
  const data = new Uint8Array(readFileSync(`${fixtures}${name}.pdf`));
  const task = pdfjs.getDocument({ data, verbosity: 0 }) as unknown as PdfLoadingTask;
  const document: PdfDocumentProxy = await task.promise;
  try {
    const decision = await surveyDocument(document, { allowOcr: false });
    return await extractDocument(document, name, decision);
  } finally {
    await task.destroy();
  }
}

describe("layouts", () => {
  for (const [name, notesAtLeast] of [
    ["chapter", 8],
    ["article", 5],
    ["scan", 8],
    ["bold", 8],
  ] as const) {
    it(`reads ${name}.pdf paragraph for paragraph`, async () => {
      const expected = JSON.parse(readFileSync(`${fixtures}${name}.expected.json`, "utf8")) as Expected;
      const result = await extract(name);
      const spoken = result.blocks.filter((b) => b.role === "body" || b.role === "heading");

      // Every paragraph, in order, each as one block — no fragments, no
      // paragraphs run together, nothing read twice.
      expect(spoken.map((b) => words(b.spokenText))).toEqual(expected.blocks.map(([, text]) => words(text)));
      // The headings are headings.
      expect(spoken.map((b) => b.role)).toEqual(expected.blocks.map(([role]) => role));

      const notes = new Set(result.blocks.filter((b) => b.role === "footnoteBody").map((b) => words(b.spokenText)));
      const found = expected.notes.filter((note) => notes.has(words(note))).length;
      expect(found).toBeGreaterThanOrEqual(notesAtLeast);
    });
  }
});
