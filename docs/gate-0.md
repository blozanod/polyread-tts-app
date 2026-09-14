# §0 — the gate

> Three measurements on a real iPhone and a real iPad. Do not scaffold the app
> first. The answers change §7 and §10. […] Report all three before proceeding.

## Status: not run

It needs an iPhone, an iPad, and the two Core ML packages. This was built in a
Linux container with none of them, and with no Swift toolchain
(`download.swift.org` is blocked by the environment's egress policy, and I did
not route around it).

What follows is what the app does *until* each answer arrives, and what changes
when it does. Run **Settings → Run the §0 benchmark** on each device.

---

## §0.1 Acoustic throughput

> Load both packages, synthesize 60 s of audio, report the realtime multiple per
> device. The reference figure (63× on an M4 Pro) will not hold on a phone; an
> MLX Kokoro port managed ~3.3× on an iPhone 13 Pro. This number decides whether
> Phase B outruns playback.

`BenchmarkRunner` renders ≥60 s of audio from chunks sized near the §6.2 budget —
not from a short utterance, which would flatter the number — after one warm-up
pass to absorb first-prediction compilation. It reports the multiple at all three
compute-unit placements, plus prosody ms/chunk for a Phase A estimate.

**What it changes.** §7.3 argues that "at 15× realtime, one minute of listening
costs four seconds of rendering; the lead grows at ~14× and the renderer laps the
playhead within the first minute." Below roughly 2× that argument inverts and
Phase B never catches up. The benchmark says so explicitly in its notes if the
best placement lands there.

## §0.2 Does `KokoroAcoustic` run with `.cpuOnly`?

> The model card is self-contradictory here […] Resolve it empirically, because
> the stakes are large — iOS does not permit a backgrounded app to submit Metal
> work, so if acoustic runs CPU-only, Phase B keeps rendering while backgrounded
> and the entire buffering problem in §7.3 disappears. If it doesn't, §7.3
> applies as written.

The benchmark attempts a real render at `.cpuOnly` and reports success or the
exact failure. It does not consult the card.

**Currently:** `AcousticPlacement` defaults to `.all` and **§7.3 is implemented
as written**:

- the rendered-through edge is drawn on the scrubber permanently
  (`RenderProgress.contiguousChunkCount` → `BufferedScrubber`);
- playback runs to the edge and stops there, without blocking backgrounding;
- backgrounding with under ~2 minutes of lead takes a `beginBackgroundTask`
  extension (`DocumentSession.applicationDidEnterBackground`).

**If the answer is yes:** one tap in the benchmark screen sets the placement, and
`AcousticPlacement.keepsRenderingInBackground` turns the background-task
extension off. The scrubber edge stays — it is honest either way, and §7.3 wants
it permanent regardless.

## §0.3 Does `MisakiSwift` expose per-word phoneme grouping?

> The spec's entire highlight mechanism is that grouping. If it only returns a
> flat phoneme string, stop and raise it — that's a module, not a patch.

`BenchmarkRunner.checkPhonemizer` runs a probe sentence carrying two homographs
and a proper noun through whatever `PhonemizerFactory` returns, and reports
whether the output is one entry per input token.

**This is enforced, not just reported.** `Chunker.chunk` throws
`PolyReadError.phonemizerLacksWordGrouping` when a phonemizer returns a different
number of groups than it was given tokens. It does not guess an alignment: a
guessed alignment produces a highlight that drifts, and §5 warns that "the bug
will look like a timing bug."

**Currently:** MisakiSwift is not linked, so `PhonemizerFactory` returns
`FallbackPhonemizer`, which does provide grouping. That makes the *pipeline*
verifiable end to end while §0.3 is open, and it is not a substitute for an
answer — the pronunciation is rule-based and mediocre.

---

## Two more things the gate should cover

Neither is in §0, and both fail the same way — silently, as fluent nonsense
rather than as an error. The benchmark checks them.

### The Kokoro phoneme vocabulary

`KokoroVocabulary.Fallback.table` is a **reconstruction** of Kokoro's symbol
list. It has not been checked against the packages, because there were none here
to check against. A vocabulary that is off by one does not throw; it synthesizes
the wrong phonemes confidently.

`KokoroVocabulary.load` prefers a bundled `kokoro_vocab.json` over the built-in
table and reports which is in use. Bundle one.

### Homograph and lexicon encodability

Every phoneme string in `HomographResolver` and in the fallback lexicon must
exist in the active vocabulary. An entry using a symbol that does not encodes
*shorter than it looks*, which shifts every duration after it in the chunk — and
the symptom is a highlight that drifts, again indistinguishable from a timing
bug. Checked by the benchmark and by `PhonemizerTests`.

---

## After the gate

§13's order, with what is already in place:

| Step | State |
|---|---|
| 0. §0 benchmark | harness ready, **not run** |
| 1. Shared types (§3) | committed first, as required |
| 2. Agents A–D in parallel | all four written |
| 3. Gate 1: A → B over three real PDFs | needs Xcode and the PDFs |
| 4. Gate 2: B → C, Phase A over a document | needs the packages |
| 5. Gate 3: C → D | wired; `DocumentSession` is the seam |
| 6. §7.3 edge, §8.5 footnotes, §7.4 LRU, §4.2 warning | all four in |
| 7. §9 background and lock screen | in |

Gate 1 is the one to run first and the one most likely to surface something.
`DocumentExtractor.extract` returns `invariantViolations` alongside the blocks
for exactly that purpose, and §4's classifiers are tuned against thresholds that
real course-reserve scans will argue with.
