import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// pdf.js ships two builds. The default one targets browsers newer than any
// currently shipping: version 6 calls `Map.prototype.getOrInsertComputed`, a
// proposal method that Chromium 141 still does not have, and page rendering
// throws `getOrInsertComputed is not a function` on a browser most people are
// actually running. The `legacy` build is the same library with the polyfills
// in — about 160 KB more, against the 26 MB of WebAssembly this app already
// loads, which is not a trade worth thinking about.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { pdfAssetBase, pdfAssetOptions } from "../extraction/pdfAssets";
import type { WordTiming } from "../core/types";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * §10 — "**Regular width (iPad): the rendered page.** A custom overlay layer
 * over `PDFView` drawing rects from `SourceSpan.bboxes`. **Not `PDFSelection`**
 * — scanned documents have no text layer to select, and a bbox-driven overlay
 * serves both backends identically. Needs column-aware auto-scroll and page
 * advance to keep the spoken word visible."
 *
 * The overlay is one absolutely-positioned div per box of the current word,
 * placed by the same viewport transform the canvas was rendered with — so it
 * lands correctly on a rotated page without this file knowing about rotation.
 * A hyphenated word has two boxes and lights both, which is what §4.6 promised
 * when it emitted two.
 *
 * ## Only the pages near the playhead are rasterized
 *
 * A library scan is one JBIG2 image per page at around 3900×6000 — 23 megapixels
 * of bilevel data that has to go through the WebAssembly codec before a single
 * pixel reaches a canvas. Eighteen of those up front is tens of seconds of
 * frozen tab and several hundred megabytes of canvas, for seventeen pages
 * nobody is looking at. So the geometry of every page is read at open (cheap —
 * it is the page dictionary, not the content stream), and only a window around
 * the current page is ever rendered. Everything outside it holds its exact
 * place with a sized placeholder, so the scrollbar never lies and nothing
 * jumps.
 */
export interface PageViewProps {
  bytes: ArrayBuffer;
  words: readonly WordTiming[];
  wordIndex: number;
  onSeekToWord(index: number): void;
}

/** Pages either side of a page of interest to keep rasterized. */
const WINDOW = 1;

/**
 * Most pages held as canvases at once.
 *
 * A canvas is the biggest thing this app keeps in memory — a page drawn for a
 * retina column is around 15 MB — so the resident set is bounded rather than
 * left to grow with however far someone scrolls.
 */
const MAX_RESIDENT = 6;

/** Widest a page is ever drawn, in CSS pixels. Mirrors `.pages` in styles.css. */
const MAX_PAGE_CSS_WIDTH = 760;

/**
 * Ceiling on a single page canvas, in device pixels. A 3× retina render of a
 * tabloid page is comfortably past what any of this buys back in legibility,
 * and canvases are the largest thing this app holds in memory.
 */
const MAX_CANVAS_PIXELS = 4.2e6;

/**
 * How much to oversample the page, given how wide it will actually be drawn.
 *
 * The old figure was `devicePixelRatio`, which assumed the canvas was displayed
 * at the PDF's own point size. It is not: a 468 pt page fills a 720 px column,
 * so rendering at 2× produced 936 px for a slot wanting 1440 and every scan
 * came out soft. This asks the layout how wide the page will be and renders for
 * that, then backs off if the result would be an absurd canvas.
 */
function scaleFor(basePoints: number, cssWidth: number, aspect: number): number {
  const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1));
  const target = Math.min(cssWidth || MAX_PAGE_CSS_WIDTH, MAX_PAGE_CSS_WIDTH);
  const wanted = Math.max(1, (target * dpr) / basePoints);
  const pixels = (basePoints * wanted) ** 2 * aspect;
  return pixels > MAX_CANVAS_PIXELS ? wanted * Math.sqrt(MAX_CANVAS_PIXELS / pixels) : wanted;
}

type PdfDocument = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

interface PageGeometry {
  index: number;
  width: number;
  height: number;
  toViewport(bbox: { x: number; y: number; width: number; height: number }): {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export function PageView({ bytes, words, wordIndex, onSeekToWord }: PageViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState<PageGeometry[]>([]);
  const [canvases, setCanvases] = useState<Map<number, HTMLCanvasElement>>(new Map());
  const [error, setError] = useState<string>();
  const pdfRef = useRef<PdfDocument>(undefined);
  const taskRef = useRef<{ destroy(): Promise<void> }>(undefined);
  /**
   * The rasterized pages, and the rasterizations still running, both keyed by
   * page index and both held in refs.
   *
   * A ref rather than state because the window effect re-runs every time the
   * playhead crosses a page, and it has to know what is already rendered and
   * what is already rendering *now* — not at the last commit. Reading that
   * through `setCanvases` gave the wrong answer twice over: a render in flight
   * when the window moved was abandoned by its own effect and skipped by the
   * next one, so that page stayed a placeholder for good. Sharing the promise
   * means whoever is still interested when it lands gets the canvas.
   */
  const canvasRef = useRef(new Map<number, HTMLCanvasElement>());
  const renderRef = useRef(new Map<number, Promise<HTMLCanvasElement | undefined>>());
  /** Page indices on screen, as a sorted list so it is cheap to compare. */
  const [visible, setVisible] = useState<readonly number[]>([]);

  const current = wordIndex >= 0 && wordIndex < words.length ? words[wordIndex] : undefined;
  const currentPage = current?.span.pageIndex ?? 0;

  // Pass 1: open the document and read every page's viewport. No content
  // stream is touched, so this is milliseconds even on a big scan.
  useEffect(() => {
    let cancelled = false;
    setGeometry([]);
    for (const canvas of canvasRef.current.values()) release(canvas);
    canvasRef.current = new Map();
    renderRef.current = new Map();
    setCanvases(canvasRef.current);

    void (async () => {
      try {
        const task = pdfjs.getDocument({
          data: new Uint8Array(bytes.slice(0)),
          ...pdfAssetOptions(pdfAssetBase()),
        });
        const pdf = await task.promise;
        if (cancelled) {
          void task.destroy();
          return;
        }
        taskRef.current = task;
        pdfRef.current = pdf;

        // How wide the column actually is, which is what the page is drawn at.
        const cssWidth = hostRef.current?.clientWidth ?? MAX_PAGE_CSS_WIDTH;
        const pages: PageGeometry[] = [];
        for (let index = 0; index < pdf.numPages; index++) {
          const page = await pdf.getPage(index + 1);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({
            scale: scaleFor(base.width, cssWidth, base.height / base.width),
          });
          pages.push({
            index,
            width: viewport.width,
            height: viewport.height,
            toViewport: (bbox) => {
              // pdf.js 6 dropped `convertToViewportRectangle`; the two corners
              // through `convertToViewportPoint` are what it did anyway, and
              // taking min/max of them survives the y-flip and page rotation.
              const [x0, y0] = viewport.convertToViewportPoint(bbox.x, bbox.y);
              const [x1, y1] = viewport.convertToViewportPoint(
                bbox.x + bbox.width,
                bbox.y + bbox.height,
              );
              return {
                left: Math.min(x0, x1),
                top: Math.min(y0, y1),
                width: Math.abs(x1 - x0),
                height: Math.abs(y1 - y0),
              };
            },
          });
          page.cleanup();
        }
        if (!cancelled) setGeometry(pages);
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      }
    })();

    return () => {
      cancelled = true;
      const task = taskRef.current;
      taskRef.current = undefined;
      pdfRef.current = undefined;
      void task?.destroy();
    };
  }, [bytes]);

  /**
   * Which pages are on screen.
   *
   * Rasterizing around the playhead alone was not enough: the playhead is on
   * page 9 and you have scrolled back to page 2 to check a footnote, and page 2
   * is a placeholder. What has to be drawn is what someone is looking at, which
   * is a question only the scroll position can answer. The margin renders a
   * screenful ahead so scrolling arrives at a drawn page rather than at a
   * placeholder that then fills in.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || geometry.length === 0) return;
    const seen = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.pageIndex);
          if (Number.isNaN(index)) continue;
          if (entry.isIntersecting) seen.add(index);
          else seen.delete(index);
        }
        const next = [...seen].sort((a, b) => a - b);
        setVisible((previous) =>
          previous.length === next.length && previous.every((v, i) => v === next[i]) ? previous : next,
        );
      },
      { rootMargin: "700px 0px" },
    );
    for (const frame of host.querySelectorAll("[data-page-index]")) observer.observe(frame);
    return () => observer.disconnect();
  }, [geometry.length]);

  // Pass 2: rasterize what matters, one page at a time so the tab stays
  // responsive, and drop what no longer does.
  const wanted = useMemo(() => {
    if (geometry.length === 0) return [];
    // In priority order, because the resident set is capped: the page carrying
    // the highlight first, then what is on screen, then their neighbours.
    const ordered: number[] = [currentPage];
    for (const index of visible) ordered.push(index);
    for (let d = 1; d <= WINDOW; d++) {
      ordered.push(currentPage - d, currentPage + d);
      for (const index of visible) ordered.push(index - d, index + d);
    }

    const chosen = new Set<number>();
    for (const index of ordered) {
      if (index < 0 || index >= geometry.length) continue;
      chosen.add(index);
      if (chosen.size >= MAX_RESIDENT) break;
    }
    return [...chosen].sort((a, b) => a - b);
  }, [currentPage, visible, geometry.length]);

  useEffect(() => {
    const pdf = pdfRef.current;
    if (!pdf || geometry.length === 0) return;
    let cancelled = false;
    const keep = new Set(wanted);

    // Drop what has fallen outside the window. Zeroing a canvas returns its
    // backing store now rather than whenever the collector gets to it, which
    // for a 23 MP scan is the difference between a steady tab and one that
    // swells as you read.
    let evicted = false;
    for (const [index, canvas] of canvasRef.current) {
      if (keep.has(index)) continue;
      release(canvas);
      canvasRef.current.delete(index);
      // Its render is dropped with it, so coming back rasterizes afresh
      // rather than resolving to the canvas just emptied.
      renderRef.current.delete(index);
      evicted = true;
    }
    if (evicted) setCanvases(new Map(canvasRef.current));

    void (async () => {
      for (const index of wanted) {
        if (cancelled) return;
        if (canvasRef.current.has(index)) continue;

        let render = renderRef.current.get(index);
        if (!render) {
          render = rasterize(pdf, geometry[index]);
          renderRef.current.set(index, render);
        }
        const canvas = await render;
        // Still wanted? The window can have moved while this was decoding.
        if (cancelled || !canvas || !keep.has(index)) continue;
        canvasRef.current.set(index, canvas);
        setCanvases(new Map(canvasRef.current));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wanted, geometry]);

  // Column-aware auto-scroll and page advance: the overlay box itself is what
  // has to stay visible, and it already carries the column in its x position.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // The highlight box when there is one; otherwise the page it would be on,
    // which is what exists while that page is still a placeholder.
    const box =
      host.querySelector<HTMLElement>(".page-highlight") ??
      host.querySelector<HTMLElement>(`[data-page-index="${currentPage}"]`);
    if (!box) return;
    const boxRect = box.getBoundingClientRect();
    const view = host.parentElement?.getBoundingClientRect() ?? host.getBoundingClientRect();
    const margin = view.height * 0.25;
    if (boxRect.top < view.top + margin || boxRect.bottom > view.bottom - margin) {
      box.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [wordIndex, currentPage, canvases]);

  const seek = useCallback(onSeekToWord, [onSeekToWord]);

  if (error) return <div className="page-error">Could not render the pages: {error}</div>;

  return (
    <div className="pages" ref={hostRef}>
      {geometry.map((page) => (
        <PageFrame
          key={page.index}
          page={page}
          canvas={canvases.get(page.index)}
          boxes={page.index === currentPage ? (current?.span.bboxes ?? []) : []}
          words={words}
          onSeekToWord={seek}
        />
      ))}
      {geometry.length === 0 && <div className="page-placeholder">Opening the document…</div>}
    </div>
  );
}

/** One page to a canvas, at the scale pass 1 measured. */
async function rasterize(
  pdf: PdfDocument,
  meta: PageGeometry,
): Promise<HTMLCanvasElement | undefined> {
  try {
    const page = await pdf.getPage(meta.index + 1);
    // Exactly the viewport pass 1 measured, so the overlay maths holds.
    const viewport = page.getViewport({ scale: meta.width / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    page.cleanup();
    return canvas;
  } catch {
    // One page failing to rasterize is a blank page, not a broken document;
    // the rest of the window still renders.
    return undefined;
  }
}

/** Hands a canvas's pixels back immediately instead of waiting for the GC. */
function release(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

interface PageFrameProps {
  page: PageGeometry;
  canvas: HTMLCanvasElement | undefined;
  boxes: Array<{ x: number; y: number; width: number; height: number }>;
  words: readonly WordTiming[];
  onSeekToWord(index: number): void;
}

function PageFrame({ page, canvas, boxes, words, onSeekToWord }: PageFrameProps) {
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = holder.current;
    if (!node) return;
    if (!canvas) {
      node.replaceChildren();
      return;
    }
    node.replaceChildren(canvas);
    canvas.className = "page-canvas";
    canvas.style.width = "100%";
    canvas.style.height = "auto";
  }, [canvas]);

  const onClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = page.width / rect.width;
    const x = (event.clientX - rect.left) * scale;
    const y = (event.clientY - rect.top) * scale;

    // Nearest word box on this page, by distance to its centre.
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < words.length; i++) {
      if (words[i].span.pageIndex !== page.index) continue;
      for (const bbox of words[i].span.bboxes) {
        const box = page.toViewport(bbox);
        const dx = x - (box.left + box.width / 2);
        const dy = y - (box.top + box.height / 2);
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = i;
        }
      }
    }
    if (best >= 0) onSeekToWord(best);
  };

  return (
    <div
      className={canvas ? "page" : "page page-pending"}
      data-page-index={page.index}
      onClick={onClick}
      style={{ aspectRatio: `${page.width} / ${page.height}` }}
    >
      <div className="page-holder" ref={holder} />
      <div className="page-number">{page.index + 1}</div>
      <div className="page-overlay">
        {boxes.map((bbox, i) => {
          const box = page.toViewport(bbox);
          return (
            <div
              key={i}
              className="page-highlight"
              style={{
                left: `${(box.left / page.width) * 100}%`,
                top: `${(box.top / page.height) * 100}%`,
                width: `${(box.width / page.width) * 100}%`,
                height: `${(box.height / page.height) * 100}%`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
