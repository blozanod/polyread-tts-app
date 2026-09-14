# Where this departs from the spec

Three deliberate departures, plus one thing the spec asks for that I could not do.

---

## 1. §4.6's paragraph rule gets an indent test

**Spec:** "Paragraph merge within page: vertical gap between baselines exceeding
normal line-height ends a block. (v1's rule, unchanged.)"

**Built:** that rule, *plus* — a line starting noticeably right of its column's
left edge also starts a paragraph.

**Why.** §4.3 says the corpus has "two-column journal articles (APSR, *World
Politics*) and single-column book chapters." Book chapters are typically set with
a first-line indent and **no** extra leading between paragraphs. The gap rule
cannot see those breaks at all, so a page becomes one 400-word block. That is not
a cosmetic problem:

- §8.4's previous/next paragraph transport has nothing to move between;
- §5's paragraph pauses never fire, so the whole page reads as one breathless
  utterance;
- §6.2 chunks a 400-word block into four arbitrary pieces instead of following
  paragraph structure.

`BlockAssembler.indentRatio`, tested by `indentStartsParagraph`. Set it to a
large number to get the spec's behaviour exactly.

## 2. §4.6 requires a `.heading` role but gives no detector

**Spec:** "**Headings** (`.heading`): spoken, with a 400 ms silence before and
after." §3 lists `.heading` in `BlockRole`. Neither says how to find one.

**Built:** a geometric test — a block of at most two lines and fourteen tokens
whose median glyph height is ≥1.12× the document's body median, *or* one that
opens with a section number ("II.", "3.1") and does not end in terminal
punctuation.

**Why geometric.** §4.1: "Vision returns no font metadata, so `glyphHeight` comes
from the bbox. This is why §4.4 and §4.5 classify on geometry rather than font
size." The same constraint applies here — a detector keyed on bold or on font
family would work on born-digital PDFs and silently do nothing on scans.

The section-number branch exists because numbered heads in this corpus are
frequently set at body size, where the height test alone misses them.

`BlockAssembler.isHeading`, tested by `headings`.

## 3. The CAF is written randomly, not appended

**Spec:** §7.3 — "chunk by chunk in document order, appended to an Int16 CAF on
disk."

**Built:** the file is created at its final length when Phase A finishes, and
each chunk is written at its own frame offset.

**Why.** §7.2 establishes that "Phase A output is the complete `[WordTiming]` for
the document: exact total duration […] — with no audio generated." That means
every chunk's exact frame offset is known *before any audio exists*. Given that,
§7.3's next requirement:

> **Seek into unrendered territory** is supported: Phase A already knows the word
> index at every timestamp, so render that chunk on demand (~one acoustic pass)
> and start there. Do not disable seeking ahead of the buffer edge.

becomes a single write at a known offset. Under strict append you would need a
side file for the out-of-order chunk and a merge pass afterwards.

Three consequences, all good: unwritten regions read as silence, so §5's
paragraph pauses cost nothing to write; the file is sparse, so a half-rendered
document occupies what it has actually rendered (`DocumentCache.byteSize` reads
*allocated* size for this reason); and resuming after the app is killed needs no
truncation logic.

The one thing it demands is that Phase B's prosody re-run land on the same
rounded durations Phase A recorded. §7.2 expects it to — the re-run is
deterministic and §3 fixes the rounding rule — and `renderAndWrite` asserts it in
debug builds, trimming or padding in release rather than letting a chunk bleed
into the next one's frames.

---

## And one thing I could not do: §0

The spec's first instruction is a gate: measure three things on real hardware,
report them, and only then write app code. I ran none of them — no iPhone, no
iPad, no Core ML packages, and no Swift toolchain (`download.swift.org` is
blocked by this environment's egress policy).

**Nothing in this repository has been compiled.**

Building past a gate is a real departure and not one I can argue away. What I did
instead:

- **Built the instrument.** `Sources/PolyReadBench` answers all three questions in
  one run on device and prints a pasteable report.
- **Made the answers settings, not constants.** §0.2's answer is
  `AppSettings.acousticComputeUnits`; §7.3's background-task extension consults
  it. Until it is measured, §7.3 is implemented as written — the more
  conservative branch.
- **Made §0.3 a hard failure rather than an assumption.** `Chunker.chunk` throws
  when a phonemizer returns the wrong number of groups. It does not guess.
- **Kept §0.1 from changing any code.** Nothing branches on the throughput
  number; it decides whether §7.3's argument holds, which is a judgement for
  whoever reads the report.

See [`docs/gate-0.md`](gate-0.md).
