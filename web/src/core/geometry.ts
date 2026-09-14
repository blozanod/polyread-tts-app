/**
 * The CoreGraphics stand-in. PDF user space, origin bottom-left — the same
 * space §4.2-§4.6 were written against, so the layout heuristics port without
 * a coordinate flip anywhere in them.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height,
});

export const zeroRect: Rect = { x: 0, y: 0, width: 0, height: 0 };

export const minX = (r: Rect): number => r.x;
export const maxX = (r: Rect): number => r.x + r.width;
export const minY = (r: Rect): number => r.y;
export const maxY = (r: Rect): number => r.y + r.height;
export const midX = (r: Rect): number => r.x + r.width / 2;
export const midY = (r: Rect): number => r.y + r.height / 2;

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(maxX(a), maxX(b)) - x,
    height: Math.max(maxY(a), maxY(b)) - y,
  };
}

export function unionAll(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return zeroRect;
  return rects.reduce(union);
}

/**
 * Median, used everywhere §4 needs "the normal size of a thing on this page".
 * The mean is no good here: one display capital or one stray OCR box the size
 * of the page would drag it, and both are common in a course-reserve scan.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
