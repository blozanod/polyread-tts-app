import type { Block } from "./types";

/**
 * §5 — "`Block.spans.count == Block.spokenText.split(separator: " ").count`,
 * index-aligned, is the invariant the entire highlight mechanism rests on."
 *
 * §12 — "Shared invariant to test in every agent's debug build."
 *
 * If this breaks, highlighting drifts silently and the bug looks like a timing
 * bug. So it is checked loudly at every stage boundary when checking is on.
 */

/** Checks are on in dev and under vitest, off in a production bundle. */
let checksEnabled =
  (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") ||
  (typeof import.meta !== "undefined" && Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV));

export function setInvariantChecks(enabled: boolean): void {
  checksEnabled = enabled;
}

/**
 * Whitespace-split tokens of a block's spoken text. This is *the* definition of
 * "spoken token" for the whole codebase — the phonemizer, the chunker and the
 * timeline all split the same way, or the alignment is meaningless.
 */
export function tokensOf(spokenText: string): string[] {
  return spokenText.split(/\s+/u).filter((t) => t.length > 0);
}

export function holdsFor(block: Block): boolean {
  return tokensOf(block.spokenText).length === block.spans.length;
}

export class SpanInvariantError extends Error {}

/** `stage` names the pass that produced the block, so a failure points at the culprit. */
export function checkBlock(block: Block, stage: string): void {
  if (!checksEnabled) return;
  const tokenCount = tokensOf(block.spokenText).length;
  if (tokenCount === block.spans.length) return;
  throw new SpanInvariantError(
    `Span invariant broken after ${stage}.\n` +
      `Block ${block.id} role=${block.role}\n` +
      `${tokenCount} spoken tokens vs ${block.spans.length} spans.\n` +
      `text: ${block.spokenText.slice(0, 240)}`,
  );
}

export function checkBlocks(blocks: readonly Block[], stage: string): void {
  if (!checksEnabled) return;
  for (const block of blocks) checkBlock(block, stage);
}

/**
 * Non-fatal form, for the import path: a malformed PDF should surface a
 * diagnostic rather than abort the import.
 */
export function violations(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    const tokenCount = tokensOf(block.spokenText).length;
    if (tokenCount !== block.spans.length) {
      out.push(`${block.role} ${block.id}: ${tokenCount} tokens vs ${block.spans.length} spans`);
    }
  }
  return out;
}
