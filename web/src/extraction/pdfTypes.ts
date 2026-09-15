/**
 * The slice of pdf.js this app uses, named locally.
 *
 * pdf.js ships its own types, but importing them drags `pdfjs-dist` into every
 * module that only wants to *talk about* a page — including the pure-logic ones
 * that the test suite runs under Node without a DOM. These four shapes are all
 * the extraction code touches.
 */
export interface PdfTextItem {
  str: string;
  /** [a, b, c, d, e, f]; (e, f) is the item origin on its baseline, user space. */
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
  fontName?: string;
}

export interface PdfTextContent {
  items: Array<PdfTextItem | { type: string }>;
}

export interface PdfViewport {
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): number[];
}

export interface PdfPageProxy {
  getViewport(params: { scale: number }): PdfViewport;
  getTextContent(params?: { includeMarkedContent?: boolean; disableNormalization?: boolean }): Promise<PdfTextContent>;
  /**
   * pdf.js 6 takes the canvas itself, and treats `canvasContext` as a
   * backwards-compatible alternative that requires `canvas` to be null.
   * Passing both is rejected.
   */
  render(params: {
    canvas: HTMLCanvasElement | null;
    canvasContext?: CanvasRenderingContext2D;
    viewport: PdfViewport;
  }): { promise: Promise<void> };
  view: number[];
  rotate: number;
  cleanup(): void;
}

export interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
  cleanup(keepLoadedFonts?: boolean): Promise<unknown>;
}

/**
 * pdf.js 6 moved `destroy` off the document and onto the loading task, which is
 * the thing that owns the worker. Releasing it matters here: a long session
 * imports several documents, and each one that is not torn down leaves a worker
 * and its copy of the file behind.
 */
export interface PdfLoadingTask {
  promise: Promise<PdfDocumentProxy>;
  destroy(): Promise<void>;
}

export function isTextItem(item: PdfTextItem | { type: string }): item is PdfTextItem {
  return typeof (item as PdfTextItem).str === "string";
}
