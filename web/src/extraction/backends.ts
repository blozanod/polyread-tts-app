import { rect, type Rect } from "../core/geometry";
import type { TextRun } from "../core/types";
import { isTextItem, type PdfPageProxy, type PdfTextItem } from "./pdfTypes";

/**
 * §4.1 — "Both backends emit `[TextRun]`. Everything downstream is
 * source-agnostic. Do not write two parallel versions of §4.2-4.6."
 *
 * The two backends here are the web's counterparts to PDFKit and Vision:
 * pdf.js's text layer for born-digital PDFs, and Tesseract for scans. Both land
 * in PDF user space with the origin bottom-left, which is the space §4.2-§4.6
 * were written against, so nothing downstream can tell them apart.
 */
export interface TextRunBackend {
  readonly name: string;
  runs(page: PdfPageProxy, pageIndex: number): Promise<TextRun[]>;
}

/** The page's crop box in user space. pdf.js exposes it as `page.view`. */
export function pageBoxOf(page: PdfPageProxy): Rect {
  const [x0, y0, x1, y1] = page.view;
  return rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
}

/**
 * pdf.js hands back a text item per show-text operator, which is a line, a
 * fragment, or a word depending on how the PDF was produced. §4.4 and §4.5
 * classify individual *words* — a footnote marker is one superscript glyph
 * beside a body-size word — so items have to be cut at their spaces.
 *
 * The cut is proportional to character count, which is exact for a monospaced
 * font and an approximation for everything else. It only ever moves a word box
 * horizontally within its own line, and the three things that read these boxes
 * are the column histogram (x-midpoints, ~10 pt bins), the marker test (which
 * reads `glyphHeight` and `baseline`, both taken from the item and therefore
 * exact), and the iPad-style page overlay (where a point or two of slack on a
 * highlight rectangle is invisible). A deviation, and a cheap one.
 */
export function splitItemIntoRuns(item: PdfTextItem, pageIndex: number): TextRun[] {
  const text = item.str;
  if (text.trim().length === 0) return [];

  const x = item.transform[4];
  const baseline = item.transform[5];
  const height = Math.abs(item.height) || Math.abs(item.transform[3]) || 1;
  const width = item.width;
  // Boxes are quoted from the baseline down by a nominal descender, so
  // `maxY` lands near the cap height and vertical-overlap tests behave.
  const descent = height * 0.2;

  const runs: TextRun[] = [];
  const perCharacter = text.length > 0 ? width / text.length : 0;
  let cursor = 0;
  for (const piece of text.split(/(\s+)/u)) {
    if (piece.length === 0) continue;
    if (/^\s+$/u.test(piece)) {
      cursor += piece.length;
      continue;
    }
    const left = x + cursor * perCharacter;
    runs.push({
      text: piece,
      bbox: rect(left, baseline - descent, piece.length * perCharacter, height),
      glyphHeight: height,
      baseline,
      pageIndex,
      columnIndex: 0,
      orderIndex: 0,
    });
    cursor += piece.length;
  }
  return runs;
}

export class PdfJsBackend implements TextRunBackend {
  readonly name = "pdf.js text layer";

  async runs(page: PdfPageProxy, pageIndex: number): Promise<TextRun[]> {
    const content = await page.getTextContent({ includeMarkedContent: false });
    const out: TextRun[] = [];
    for (const item of content.items) {
      if (!isTextItem(item)) continue;
      out.push(...splitItemIntoRuns(item, pageIndex));
    }
    return out;
  }
}

/**
 * §4.1's scanned path. Tesseract is an optional dependency: it is a ~15 MB
 * download that most documents never need, so it is imported the first time a
 * page actually scores badly enough to want it.
 */
export interface OcrProgress {
  (fraction: number): void;
}

interface TesseractWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface TesseractWorker {
  recognize(image: unknown): Promise<{ data: { words?: TesseractWord[]; confidence: number } }>;
  terminate(): Promise<void>;
}

export class OcrBackend implements TextRunBackend {
  readonly name = "Tesseract OCR";
  /** Rendering above the page's own resolution is what makes small type legible. */
  readonly scale: number;
  private worker: TesseractWorker | undefined;
  private meanConfidence = 0;
  private confidenceSamples = 0;

  constructor(scale = 2) {
    this.scale = scale;
  }

  /** 0-100, averaged over the pages recognized so far. §4.2 reads this. */
  get confidence(): number {
    return this.confidenceSamples === 0 ? 0 : this.meanConfidence / this.confidenceSamples;
  }

  private async ensureWorker(): Promise<TesseractWorker> {
    if (this.worker) return this.worker;
    const tesseract = (await import("tesseract.js")) as unknown as {
      createWorker(lang: string): Promise<TesseractWorker>;
    };
    this.worker = await tesseract.createWorker("eng");
    return this.worker;
  }

  async runs(page: PdfPageProxy, pageIndex: number): Promise<TextRun[]> {
    const worker = await this.ensureWorker();
    const viewport = page.getViewport({ scale: this.scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    if (!context) return [];
    // An OffscreenCanvas is not an HTMLCanvasElement, so this takes pdf.js's
    // context path — which is exactly what it is kept for, and requires
    // `canvas` to be null.
    await page.render({
      canvas: null,
      canvasContext: context as CanvasRenderingContext2D,
      viewport,
    }).promise;

    const { data } = await worker.recognize(canvas);
    this.meanConfidence += data.confidence;
    this.confidenceSamples += 1;

    const out: TextRun[] = [];
    for (const word of data.words ?? []) {
      const text = word.text.trim();
      if (text.length === 0) continue;
      // `convertToPdfPoint` inverts the whole viewport transform — scale, the
      // y-flip and the page's own /Rotate — so both backends land in the same
      // space without this file knowing anything about rotation.
      const [ax, ay] = viewport.convertToPdfPoint(word.bbox.x0, word.bbox.y0);
      const [bx, by] = viewport.convertToPdfPoint(word.bbox.x1, word.bbox.y1);
      const x = Math.min(ax, bx);
      const y = Math.min(ay, by);
      const width = Math.abs(bx - ax);
      const height = Math.abs(by - ay);
      out.push({
        text,
        bbox: rect(x, y, width, height),
        // OCR returns no font metadata, so `glyphHeight` comes from the box.
        // This is why §4.4 and §4.5 classify on geometry rather than font size.
        glyphHeight: height,
        baseline: y + height * 0.2,
        pageIndex,
        columnIndex: 0,
        orderIndex: 0,
      });
    }
    page.cleanup();
    return out;
  }

  async dispose(): Promise<void> {
    await this.worker?.terminate();
    this.worker = undefined;
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
