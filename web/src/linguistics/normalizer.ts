import { checkBlock, checkBlocks, tokensOf } from "../core/spanInvariant";
import { isSpoken, textRange, type Block, type SourceSpan } from "../core/types";

/**
 * §5 — "Ordered find-replace on block text, before G2P. Not an NLP layer."
 *
 * It operates on the *token array*, not the string, because the span invariant
 * is defined over tokens: "Any substitution that changes token count must emit
 * one `SourceSpan` per resulting spoken token, all pointing at the same source
 * bbox." Rewriting the string and re-splitting would lose that alignment, and
 * §5 is explicit that when it breaks "the bug will look like a timing bug."
 */
export interface RuleMatch {
  consumed: number;
  output: string[];
}

export interface Rule {
  name: string;
  apply(tokens: readonly string[], index: number): RuleMatch | undefined;
}

const LEADING_PUNCTUATION = new Set("([{\"'“‘");
const TRAILING_PUNCTUATION = new Set(".,;:)]}\"'”’");

export interface Affixes {
  leading: string;
  core: string;
  trailing: string;
}

/**
 * "(e.g.," has to come out as "(for example," — the substitution is on the
 * abbreviation, not on the punctuation wrapped around it.
 */
export function affixes(token: string): Affixes {
  let start = 0;
  while (start < token.length && LEADING_PUNCTUATION.has(token[start])) start++;
  let end = token.length;
  while (end > start && TRAILING_PUNCTUATION.has(token[end - 1])) end--;
  return {
    leading: token.slice(0, start),
    core: token.slice(start, end),
    trailing: token.slice(end),
  };
}

export const coreOf = (token: string): string => affixes(token).core;

/**
 * The abbreviating period is part of the abbreviation and goes away with it; a
 * comma or a closing paren belongs to the sentence and stays.
 */
function keepingNonPeriods(trailing: string): string {
  return trailing.replace(/\./g, "");
}

function expand(
  tokens: readonly string[],
  i: number,
  from: string,
  output: readonly string[],
): RuleMatch | undefined {
  const { leading, core, trailing } = affixes(tokens[i]);
  if (core.toLowerCase() !== from) return undefined;
  const result = [...output];
  result[0] = leading + result[0];
  result[result.length - 1] += keepingNonPeriods(trailing);
  return { consumed: 1, output: result };
}

/**
 * §5 lists exactly these. §11 adds: "No number-expansion layer beyond §5. Fix
 * what you actually hear; don't pre-solve." So nothing else goes here without
 * having been heard to be wrong first. (eSpeak already expands numbers and
 * currency inside the phonemizer; that is §6.1's job, not this one's.)
 */
export const RULES: Rule[] = [
  {
    name: "et al.",
    apply(tokens, i) {
      if (i + 1 >= tokens.length) return undefined;
      if (coreOf(tokens[i]).toLowerCase() !== "et") return undefined;
      const { core, trailing } = affixes(tokens[i + 1]);
      if (core.toLowerCase() !== "al") return undefined;
      return { consumed: 2, output: ["et", "al" + keepingNonPeriods(trailing)] };
    },
  },
  { name: "e.g.", apply: (t, i) => expand(t, i, "e.g", ["for", "example"]) },
  { name: "i.e.", apply: (t, i) => expand(t, i, "i.e", ["that", "is"]) },
  { name: "cf.", apply: (t, i) => expand(t, i, "cf", ["compare"]) },
  { name: "ibid.", apply: (t, i) => expand(t, i, "ibid", ["ibid"]) },
  {
    name: "pp. A-B",
    apply(tokens, i) {
      if (i + 1 >= tokens.length) return undefined;
      if (coreOf(tokens[i]).toLowerCase() !== "pp") return undefined;
      const { leading, core, trailing } = affixes(tokens[i + 1]);
      const dash = core.search(/[-–—]/u);
      if (dash < 0) return undefined;
      const from = core.slice(0, dash);
      const to = core.slice(dash + 1);
      if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) return undefined;
      return { consumed: 2, output: [leading + "pages", from, "to", to + keepingNonPeriods(trailing)] };
    },
  },
];

export function normalizeBlock(block: Block): Block {
  if (!isSpoken(block.role)) return block;

  const tokens = tokensOf(block.spokenText);
  if (tokens.length !== block.spans.length) {
    // The invariant is already broken upstream; substituting would only bury
    // the evidence. `checkBlock` throws when checks are on; with them off the
    // block passes through untouched so the import still completes.
    checkBlock(block, "normalizeBlock (input)");
    return block;
  }

  const outTokens: string[] = [];
  const outSpans: SourceSpan[] = [];
  let i = 0;

  while (i < tokens.length) {
    let matched = false;
    for (const rule of RULES) {
      const match = rule.apply(tokens, i);
      if (!match || match.consumed <= 0) continue;

      // §5 — every output token points at every source box the match consumed.
      // One source token becoming two spoken tokens means two spans on the same
      // bbox; the highlight lights that word twice, which is exactly right.
      const sourceSpans = block.spans.slice(i, Math.min(i + match.consumed, block.spans.length));
      const mergedBoxes = sourceSpans.flatMap((s) => s.bboxes);
      const page = sourceSpans[0]?.pageIndex ?? 0;
      for (const token of match.output) {
        outTokens.push(token);
        outSpans.push({ pageIndex: page, bboxes: mergedBoxes, reflowRange: textRange(0, 0) });
      }
      i += match.consumed;
      matched = true;
      break;
    }

    if (!matched) {
      outTokens.push(tokens[i]);
      outSpans.push(block.spans[i]);
      i += 1;
    }
  }

  const result: Block = {
    id: block.id,
    role: block.role,
    spokenText: outTokens.join(" "),
    spans: outSpans,
    footnoteBodyIDs: block.footnoteBodyIDs,
  };
  checkBlock(result, "normalizeBlock (output)");
  return result;
}

export function normalize(blocks: readonly Block[]): Block[] {
  const out = blocks.map(normalizeBlock);
  checkBlocks(out, "normalize");
  return out;
}
