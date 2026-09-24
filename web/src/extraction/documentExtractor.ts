import { PolyReadError } from "../core/errors";
import { maxX, median, minX, type Rect } from "../core/geometry";
import { checkBlocks, violations } from "../core/spanInvariant";
import { newID, type Block, type TextRun } from "../core/types";
import {
  analyzeColumn,
  isHeading,
  silenceFigureText,
  isPublisherBoilerplate,
  materialize,
  mergeAcrossPages,
  protoText,
  tokenizeParagraph,
  type ProtoBlock,
} from "./blockAssembler";
import { OcrBackend, PdfJsBackend, pageBoxOf, type TextRunBackend } from "./backends";
import {
  footnoteBodyLineIndices,
  FurnitureClassifier,
  layoutPage,
  leadingLabel,
  lineBBox,
  lineBaseline,
  lineGlyphHeight,
  type Line,
} from "./pageLayout";
import type { PdfDocumentProxy } from "./pdfTypes";
import {
  decideBackend,
  pageArea,
  sampleIndices,
  scoreRuns,
  type BackendDecision,
} from "./quality";

export interface ExtractionResult {
  blocks: Block[];
  decision: BackendDecision;
  title: string;
  pageCount: number;
  /** Non-fatal §5 invariant breaks, for the import diagnostics panel. */
  invariantViolations: string[];
}

export type ExtractionProgress = (pagesDone: number, pagesTotal: number, label: string) => void;

/**
 * §4.2 — scores both backends and reports which it would use, without doing the
 * full extraction. The import flow calls this first so it can stop and ask
 * before spending a minute on OCR that will produce nonsense.
 */
export async function surveyDocument(
  document: PdfDocumentProxy,
  options: { allowOcr?: boolean } = {},
): Promise<BackendDecision> {
  if (document.numPages === 0) throw new PolyReadError("noPages");
  const indices = sampleIndices(document.numPages);
  const areas = new Map<number, number>();
  const embeddedRuns = [];

  const embedded = new PdfJsBackend();
  for (const index of indices) {
    const page = await document.getPage(index + 1);
    areas.set(index, pageArea(pageBoxOf(page)));
    embeddedRuns.push(...(await embedded.runs(page, index)));
    page.cleanup();
  }
  const embeddedQuality = scoreRuns(embeddedRuns, areas);

  const first = decideBackend(embeddedQuality, undefined);
  if (first.choice === "embedded" || options.allowOcr === false) return first;

  const ocr = new OcrBackend();
  const ocrRuns = [];
  try {
    for (const index of indices) {
      const page = await document.getPage(index + 1);
      ocrRuns.push(...(await ocr.runs(page, index)));
    }
  } catch {
    // Tesseract is optional; if it is not installed, say so through the
    // decision rather than failing the import.
    await ocr.dispose();
    return decideBackend(embeddedQuality, undefined);
  }
  await ocr.dispose();
  return decideBackend(embeddedQuality, scoreRuns(ocrRuns, areas));
}

/** Agent A — §4. PDF in, `[Block]` out, source-agnostic from §4.2 onward. */
export async function extractDocument(
  document: PdfDocumentProxy,
  fallbackTitle: string,
  decision: BackendDecision,
  onProgress?: ExtractionProgress,
): Promise<ExtractionResult> {
  const pageCount = document.numPages;
  if (pageCount === 0) throw new PolyReadError("noPages");

  const ocr = decision.choice === "embedded" ? undefined : new OcrBackend();
  const backend: TextRunBackend = ocr ?? new PdfJsBackend();
  const label = ocr ? "Recognizing text" : "Reading text";

  try {
    // Pass 1 — runs and lines per page, plus the cross-page statistics §4.4
    // needs before it can call anything a running head.
    const pageLines: Line[][] = [];
    const pageBoxes: Rect[] = [];
    const furniture = new FurnitureClassifier();
    const allGlyphHeights: number[] = [];

    for (let index = 0; index < pageCount; index++) {
      const page = await document.getPage(index + 1);
      const box = pageBoxOf(page);
      pageBoxes.push(box);
      let raw: TextRun[] = [];
      try {
        raw = await backend.runs(page, index);
      } catch {
        raw = [];
      }
      const lines = layoutPage(raw, box);
      pageLines.push(lines);
      furniture.observe(lines, box, index);
      for (const line of lines) allGlyphHeights.push(lineGlyphHeight(line));
      page.cleanup();
      onProgress?.(index + 1, pageCount * 2, label);
    }

    // The document's body glyph height. Taken across the whole document, not per
    // page, so a page that is *entirely* footnotes does not redefine what body
    // size means.
    const bodyGlyphHeight = median(allGlyphHeights);

    // Pass 2 — classify, tokenize, assemble.
    let proto: ProtoBlock[] = [];
    const footnoteBodies: ProtoBlock[] = [];
    const markerBlocks: Array<{ marker: ProtoBlock; hostID: string | undefined; label: string }> = [];

    for (let index = 0; index < pageCount; index++) {
      const lines = pageLines[index];
      const box = pageBoxes[index];
      onProgress?.(pageCount + index + 1, pageCount * 2, "Finding paragraphs");
      if (lines.length === 0) continue;

      // §4.4 furniture, §4.5 footnote bodies, everything else is main text.
      const furnitureLines: Array<{ line: Line; role: ReturnType<FurnitureClassifier["role"]> }> = [];
      const candidateLines: Line[] = [];
      for (const line of lines) {
        const role = furniture.role(line, box);
        if (role) furnitureLines.push({ line, role });
        else candidateLines.push(line);
      }

      const bodyIndices = footnoteBodyLineIndices(candidateLines, bodyGlyphHeight, box);
      const mainLines = candidateLines.filter((_, i) => !bodyIndices.has(i));
      const noteLines = candidateLines.filter((_, i) => bodyIndices.has(i));

      // Page furniture is excluded from speech but kept for the reflow view.
      for (const { line, role } of furnitureLines) {
        if (!role) continue;
        proto.push({
          id: newID(),
          role,
          tokens: line.runs.map((r) => ({ text: r.text, bboxes: [r.bbox], pageIndex: r.pageIndex })),
          pageIndex: index,
          columnIndex: line.columnIndex,
          glyphHeight: lineGlyphHeight(line),
          lineCount: 1,
        });
      }

      // Main text, per column so a paragraph never straddles the gutter.
      for (const column of [...new Set(mainLines.map((l) => l.columnIndex))].sort((a, b) => a - b)) {
        const columnLines = mainLines.filter((l) => l.columnIndex === column);
        const shape = analyzeColumn(columnLines);
        const columnWidth =
          Math.max(...columnLines.map((l) => maxX(lineBBox(l)))) - Math.min(...columnLines.map((l) => minX(lineBBox(l))));
        for (let p = 0; p < shape.paragraphs.length; p++) {
          const paragraph = shape.paragraphs[p];
          const { tokens, markers } = tokenizeParagraph(paragraph);
          if (tokens.length === 0 && markers.length === 0) continue;

          const block: ProtoBlock = {
            id: newID(),
            role: "body",
            tokens,
            pageIndex: index,
            columnIndex: column,
            glyphHeight: median(paragraph.map(lineGlyphHeight)),
            lineCount: paragraph.length,
            startsIndented: shape.startsIndented[p],
            endsFull: shape.endsFull[p],
            columnWidth,
          };
          if (isHeading(block, bodyGlyphHeight)) block.role = "heading";
          // A database's own front matter is furniture, whatever size it is set
          // in. `runningHead` is the furniture role that keeps a block visible
          // in the reflow view and out of the spoken stream, which is exactly
          // what this wants.
          if (isPublisherBoilerplate(protoText(block))) block.role = "runningHead";
          if (tokens.length > 0) proto.push(block);

          // By id rather than by position: `mergeAcrossPages` below drops every
          // block it absorbs, so an index taken here points at a different
          // paragraph afterwards — the further into the document, the further
          // out. A paragraph carrying no tokens of its own was never pushed, so
          // its markers hang off the last block that was.
          const hostID = tokens.length > 0 ? block.id : proto[proto.length - 1]?.id;
          for (const marker of markers) {
            markerBlocks.push({
              marker: {
                id: newID(),
                role: "footnoteMarker",
                tokens: [marker],
                pageIndex: index,
                columnIndex: column,
                glyphHeight: 0,
                lineCount: 1,
              },
              hostID,
              label: marker.text,
            });
          }
        }
      }

      // §4.5 footnote bodies — one block per note, split on the leading label.
      for (const column of [...new Set(noteLines.map((l) => l.columnIndex))].sort((a, b) => a - b)) {
        const columnLines = noteLines
          .filter((l) => l.columnIndex === column)
          .sort((a, b) => lineBaseline(b) - lineBaseline(a));
        let current: Line[] = [];
        let currentLabel: string | undefined;

        const flush = (): void => {
          if (current.length === 0) return;
          const { tokens } = tokenizeParagraph(current, true);
          if (tokens.length === 0) {
            current = [];
            return;
          }
          footnoteBodies.push({
            id: newID(),
            role: "footnoteBody",
            tokens,
            pageIndex: index,
            columnIndex: column,
            glyphHeight: median(current.map(lineGlyphHeight)),
            lineCount: current.length,
            label: currentLabel,
          });
          current = [];
        };

        for (const line of columnLines) {
          const label = leadingLabel(line);
          if (label && current.length > 0) {
            flush();
            currentLabel = label;
          } else if (current.length === 0) {
            currentLabel = label;
          }
          current.push(line);
        }
        flush();
      }
    }

    // §4.6 cross-page paragraph merge. Runs over main-stream blocks only —
    // footnote bodies were pulled out above and never straddle a page.
    const mergedInto = new Map<string, string>();
    silenceFigureText(proto, bodyGlyphHeight);
    proto = mergeAcrossPages(proto, mergedInto);
    /** Follows a block id through however many merges absorbed it. */
    const survivingID = (id: string | undefined): string | undefined => {
      let current = id;
      const seen = new Set<string>();
      while (current !== undefined && mergedInto.has(current) && !seen.has(current)) {
        seen.add(current);
        current = mergedInto.get(current);
      }
      return current;
    };

    // Pair each marker with the footnote body it points at: same page, same
    // label. Falls back to the k-th note on the page when labels are symbols
    // rather than numbers, which is the convention §8.5's tap relies on.
    const bodiesByPage = new Map<number, ProtoBlock[]>();
    for (const body of footnoteBodies) {
      const list = bodiesByPage.get(body.pageIndex);
      if (list) list.push(body);
      else bodiesByPage.set(body.pageIndex, [body]);
    }

    const footnoteIDsByHost = new Map<string, string[]>();
    const markersByHost = new Map<string, Array<{ marker: ProtoBlock; bodyID?: string }>>();
    const markerOrdinal = new Map<number, number>();
    const liveIDs = new Set(proto.map((b) => b.id));

    for (const { marker, hostID, label } of markerBlocks) {
      const page = marker.pageIndex;
      const ordinal = markerOrdinal.get(page) ?? 0;
      markerOrdinal.set(page, ordinal + 1);

      const candidates = bodiesByPage.get(page) ?? [];
      const matched = candidates.find((b) => b.label === label) ?? candidates[ordinal];

      marker.label = label;
      const host = survivingID(hostID);
      if (host === undefined || !liveIDs.has(host)) continue;

      if (matched) {
        const list = footnoteIDsByHost.get(host);
        if (list) list.push(matched.id);
        else footnoteIDsByHost.set(host, [matched.id]);
      }
      const hostList = markersByHost.get(host);
      const entry = { marker, bodyID: matched?.id };
      if (hostList) hostList.push(entry);
      else markersByHost.set(host, [entry]);
    }

    // Interleave: each main block, then the markers that came out of it, then
    // this page's footnote bodies after the last block on the page.
    const blocks: Block[] = [];
    const emittedNotesForPage = new Set<number>();
    for (let i = 0; i < proto.length; i++) {
      const block = proto[i];
      blocks.push(materialize(block, footnoteIDsByHost.get(block.id) ?? []));
      for (const { marker, bodyID } of markersByHost.get(block.id) ?? []) {
        blocks.push(materialize(marker, bodyID ? [bodyID] : []));
      }
      const isLastOnPage = i + 1 >= proto.length || proto[i + 1].pageIndex !== block.pageIndex;
      if (isLastOnPage && !emittedNotesForPage.has(block.pageIndex)) {
        emittedNotesForPage.add(block.pageIndex);
        for (const body of bodiesByPage.get(block.pageIndex) ?? []) blocks.push(materialize(body));
      }
    }
    // Notes on pages with no main text at all still have to reach §8.5.
    for (const page of [...bodiesByPage.keys()].sort((a, b) => a - b)) {
      if (emittedNotesForPage.has(page)) continue;
      for (const body of bodiesByPage.get(page) ?? []) blocks.push(materialize(body));
    }

    if (blocks.length === 0) throw new PolyReadError("extractionProducedNothing");
    checkBlocks(blocks, "extractDocument");

    return {
      blocks,
      decision,
      title: await titleOf(document, fallbackTitle),
      pageCount,
      invariantViolations: violations(blocks),
    };
  } finally {
    await ocr?.dispose();
  }
}

/** §9 — "title from the PDF's document title or filename". */
async function titleOf(document: PdfDocumentProxy, fallback: string): Promise<string> {
  try {
    const { info } = await document.getMetadata();
    const title = info?.Title;
    if (typeof title === "string" && title.trim().length > 0) return title.trim();
  } catch {
    // Metadata is optional; the filename is always there.
  }
  return fallback;
}

export { protoText };
