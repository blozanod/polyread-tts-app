"""Python port of Chunker.split, run against the scenarios in ChunkerTests."""
import math

BUDGET = 510
BACKOFF_FRACTION = 0.25

ABBREVIATIONS = {'al', 'nn', 'et', 'dept', 'jr', 'dr', 'eds', 'vs', 'corp', 'esp', 'vol', 'vols', 'nos', 'figs', 'inc', 'sr', 'tabs', 'chaps', 'secs', 'ff', 'mrs', 'prof', 'sec', 'repr', 'ch', 'univ', 'co', 'rev', 'mr', 'st', 'chap', 'ms', 'no', 'pp', 'trans', 'ed', 'cf', 'tab', 'cit', 'fig'}

def is_sentence_end(token):
    trimmed = token.rstrip(chr(34) + chr(39) + chr(0x201d) + chr(0x2019) + ")]}")
    if not trimmed: return False
    if trimmed[-1] not in ".!?": return False
    if trimmed[-1] != ".": return True
    core = trimmed[:-1]
    if len(core) <= 1: return False
    if "." in core: return False
    return core.lower() not in ABBREVIATIONS

def split(token_ids, ranges, tokens):
    if not ranges: return []
    total = len(token_ids)
    if total <= BUDGET:
        return [dict(tokens=token_ids, ranges=[(a - ranges[0][0], b - ranges[0][0]) for a, b in ranges],
                     span_offset=0)]

    chunk_count = math.ceil(total / BUDGET)
    target = min(BUDGET, math.ceil(total / chunk_count))
    backoff = int(target * BACKOFF_FRACTION)

    chunks, word_index = [], 0
    while word_index < len(ranges):
        chunk_start = ranges[word_index][0]
        end = word_index
        last_sentence_end = None
        while end < len(ranges):
            would_be = ranges[end][1] - chunk_start
            if end > word_index and would_be > target: break
            if end > word_index and would_be > BUDGET: break
            if is_sentence_end(tokens[end]): last_sentence_end = end
            end += 1

        cut = end
        if last_sentence_end is not None and last_sentence_end + 1 < end:
            length_at = ranges[last_sentence_end][1] - chunk_start
            if length_at >= target - backoff:
                cut = last_sentence_end + 1
        cut = max(cut, word_index + 1)

        slice_end = ranges[cut-1][1]
        chunk_ranges = [(a - chunk_start, b - chunk_start) for a, b in ranges[word_index:cut]]
        if slice_end - chunk_start > BUDGET:
            slice_end = chunk_start + BUDGET
            chunk_ranges = [(a, min(b, BUDGET)) for a, b in chunk_ranges]
            chunk_ranges = [(a, b) if a <= b else (a, a) for a, b in chunk_ranges]
        chunks.append(dict(
            tokens=token_ids[chunk_start:slice_end],
            ranges=chunk_ranges,
            span_offset=word_index))
        word_index = cut
    return chunks

def synthetic(word_count, phonemes_per_word, sentence_every=None):
    token_ids, ranges, words = [], [], []
    for i in range(word_count):
        if i > 0: token_ids.append(16)
        start = len(token_ids)
        token_ids += [50] * phonemes_per_word
        ranges.append((start, len(token_ids)))
        words.append(f"word{i}." if sentence_every and (i+1) % sentence_every == 0 else f"word{i}")
    return token_ids, ranges, words

failures = []
def check(cond, msg):
    print(("  OK   " if cond else "  FAIL ") + msg)
    if not cond: failures.append(msg)

print("=== budget: no chunk exceeds 510 ===")
for wc in [1, 40, 120, 400, 1200]:
    t, r, w = synthetic(wc, 6)
    cs = split(t, r, w)
    check(all(len(c['tokens']) <= BUDGET for c in cs),
          f"{wc} words -> {len(cs)} chunks, max {max((len(c['tokens']) for c in cs), default=0)}")

print("\n=== short block is one chunk ===")
t, r, w = synthetic(20, 5)
cs = split(t, r, w)
check(len(cs) == 1 and cs[0]['tokens'] == t and cs[0]['span_offset'] == 0, f"{len(cs)} chunk(s)")

print("\n=== partition: each word in exactly one chunk, in order ===")
t, r, w = synthetic(600, 7)
cs = split(t, r, w)
expected = 0
ok = True
for c in cs:
    if c['span_offset'] != expected: ok = False
    expected += len(c['ranges'])
check(ok and expected == len(w), f"{len(cs)} chunks covering {expected}/{len(w)} words")

print("\n=== ranges rebased into their own chunk ===")
ok = all(c['ranges'][0][0] == 0 and all(0 <= a and b <= len(c['tokens']) for a, b in c['ranges']) for c in cs)
check(ok, "every chunk's first range starts at 0 and all stay in bounds")

print("\n=== uniformity: shortest > 0.66 * longest ===")
t, r, w = synthetic(300, 6)
cs = split(t, r, w)
lens = [len(c['tokens']) for c in cs]
check(len(cs) > 2 and min(lens) > max(lens) * 0.66, f"lengths {lens}")

print("\n=== sentence backoff: every split lands on a sentence end ===")
t, r, w = synthetic(300, 6, sentence_every=9)
cs = split(t, r, w)
boundaries, index = 0, 0
for c in cs[:-1]:
    index += len(c['ranges'])
    if is_sentence_end(w[index-1]): boundaries += 1
check(boundaries == len(cs) - 1, f"{boundaries} of {len(cs)-1} splits on a sentence end")

print("\n=== abbreviations ===")
for tok, want in [("shows.", True), ("vote?", True), ('argued."', True),
                  ("APSR.", True), ("J.", False), ("U.S.", False),
                  ("Vol.", False), ("eds.", False), ("word", False), ("", False)]:
    check(is_sentence_end(tok) == want, f"is_sentence_end({tok!r}) == {want}")

print("\n=== pathological: one word longer than the budget ===")
t, r, w = [50]*700, [(0, 700)], ["x"]
cs = split(t, r, w)
check(len(cs) == 1, f"terminates, {len(cs)} chunk of {len(cs[0]['tokens'])} tokens (over budget by design)")

print(f"\n{len(failures)} failures")
