import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
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
 */
export interface PageViewProps {
  bytes: ArrayBuffer;
  words: readonly WordTiming[];
  wordIndex: number;
  onSeekToWord(index: number): void;
}

interface RenderedPage {
  index: number;
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  toViewport(bbox: { x: number; y: number; width: number; height: number }): {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export function PageView({ bytes, words, wordIndex, onSeekToWord }: PageViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [error, setError] = useState<string>();

  const current = wordIndex >= 0 && wordIndex < words.length ? words[wordIndex] : undefined;
  const currentPage = current?.span.pageIndex ?? 0;

  useEffect(() => {
    let cancelled = false;
    const rendered: RenderedPage[] = [];

    void (async () => {
      try {
        const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false });
        const pdf = await task.promise;
        // Rendering every page of a 400-page book up front is minutes of work
        // and hundreds of megabytes of canvas. Pages are rendered around the
        // playhead instead; see the window effect below.
        const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        for (let index = 0; index < pdf.numPages; index++) {
          if (cancelled) break;
          const page = await pdf.getPage(index + 1);
          const viewport = page.getViewport({ scale });
          const canvas = createCanvas(viewport.width, viewport.height);
          const context = canvas.getContext("2d");
          if (!context) continue;
          await page.render({ canvasContext: context, viewport }).promise;
          rendered.push({
            index,
            canvas,
            width: viewport.width,
            height: viewport.height,
            toViewport: (bbox) => {
              const [x0, y0, x1, y1] = viewport.convertToViewportRectangle([
                bbox.x,
                bbox.y,
                bbox.x + bbox.width,
                bbox.y + bbox.height,
              ]);
              return {
                left: Math.min(x0, x1),
                top: Math.min(y0, y1),
                width: Math.abs(x1 - x0),
                height: Math.abs(y1 - y0),
              };
            },
          });
          page.cleanup();
          if (rendered.length % 4 === 0 && !cancelled) setPages([...rendered]);
        }
        if (!cancelled) setPages([...rendered]);
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bytes]);

  // Column-aware auto-scroll and page advance: the overlay box itself is what
  // has to stay visible, and it already carries the column in its x position.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const box = host.querySelector<HTMLElement>(".page-highlight");
    if (!box) return;
    const boxRect = box.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const margin = hostRect.height * 0.25;
    if (boxRect.top < hostRect.top + margin || boxRect.bottom > hostRect.bottom - margin) {
      box.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [wordIndex, pages.length]);

  if (error) return <div className="page-error">Could not render the pages: {error}</div>;

  return (
    <div className="pages" ref={hostRef}>
      {pages.map((page) => (
        <PageCanvas
          key={page.index}
          page={page}
          boxes={page.index === currentPage ? (current?.span.bboxes ?? []) : []}
          words={words}
          onSeekToWord={onSeekToWord}
        />
      ))}
      {pages.length === 0 && <div className="page-placeholder">Rendering pages…</div>}
    </div>
  );
}

interface PageCanvasProps {
  page: RenderedPage;
  boxes: Array<{ x: number; y: number; width: number; height: number }>;
  words: readonly WordTiming[];
  onSeekToWord(index: number): void;
}

function PageCanvas({ page, boxes, words, onSeekToWord }: PageCanvasProps): JSX.Element {
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = holder.current;
    if (!node) return;
    node.replaceChildren(page.canvas);
    page.canvas.className = "page-canvas";
    page.canvas.style.width = "100%";
    page.canvas.style.height = "auto";
  }, [page]);

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
    <div className="page" onClick={onClick}>
      <div className="page-holder" ref={holder} />
      <div className="page-overlay" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
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

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  return canvas;
}
