# PolyRead

PDF reader that speaks poli-sci readings aloud with word-level highlighting.
Built to [`docs/polyread-spec-v2.md`](docs/polyread-spec-v2.md).

There are two builds in this repository:

| | Where | Status |
|---|---|---|
| [**`web/`**](web/README.md) | Browser, and macOS / Windows / Linux desktop apps | Builds, tested, runs |
| `Sources/`, `App/` | iOS / iPadOS | Written to spec, **never compiled** — see below |

The web build is a full port of the same pipeline: the §3 types, §4's extraction
and layout rules, §5's normalization and its span invariant, §6's chunking, §7's
two phases, §8's transport and highlight sync, and both §10 surfaces. It runs
entirely on the machine it is open on — the PDF is never uploaded and the
synthesis is local. [`web/README.md`](web/README.md) has the eight places it
departs from the iOS build and why, and one of those is a bug in the phoneme
vocabulary that the iOS build shipped.

Start there unless you specifically want the iOS app. Everything below concerns
the iOS build.

---

## Read this first: §0 has not been run

The spec opens with a gate:

> **0. Gate: benchmark before writing app code.** Three measurements on a real
> iPhone and a real iPad. Do not scaffold the app first. The answers change §7
> and §10. […] Report all three before proceeding.

**I could not run it.** It needs an iPhone, an iPad, and the two Core ML
packages; this was built in a Linux container with none of the three. **Nothing
in this repository has been compiled** — there is no Swift toolchain here and
`download.swift.org` is blocked by the environment's egress policy.

So rather than answer the gate, the repository ships the instrument for it.
Build, run, open **Settings → Run the §0 benchmark**. It measures all three on
whatever device it is running on and prints a report you can paste back:

| | Question | What it changes |
|---|---|---|
| §0.1 | Acoustic throughput, realtime multiple | Whether Phase B outruns playback at all (§7.3) |
| §0.2 | Does `KokoroAcoustic` run with `.cpuOnly`? | Yes → §7.3's entire buffering problem disappears |
| §0.3 | Does the phonemizer group phonemes per word? | No → word-level highlighting is impossible; stop |

The benchmark also checks two things the spec assumes but cannot state: that the
Kokoro phoneme vocabulary in this repository matches the shipped packages, and
that every homograph entry encodes in it. Both fail silently as fluent nonsense
rather than as errors, so they are checked at the gate. See
[`docs/gate-0.md`](docs/gate-0.md).

**Until §0.2 is answered, `AcousticPlacement` defaults to `.all` and §7.3 is
implemented as written** — buffer edge on the scrubber, play to the edge, and a
`beginBackgroundTask` extension when backgrounding with a thin lead. If the
benchmark says acoustic runs CPU-only, one tap in Settings switches it and all
of that becomes dead weight rather than wrong.

---

## Getting it running

1. Open `PolyRead.xcodeproj`. (If Xcode refuses to parse it — it is
   hand-written — delete it and run `brew install xcodegen && xcodegen generate`;
   `project.yml` produces the same target.)
2. Put `KokoroProsody.mlpackage`, `KokoroAcoustic.mlpackage` and `Voices.bin`
   into `Models/` and add them to the target's Copy Bundle Resources phase. See
   [`Models/README.md`](Models/README.md) — particularly the note about
   `kokoro_vocab.json`, which you want.
3. Set your team and a bundle id. §1: "a free Apple developer account expires
   provisioning every 7 days. Use a paid account or the app dies weekly."
4. Run on a device. The simulator has no Neural Engine, so §0.1 measured there
   means nothing.

Without the model files the app still builds, imports a PDF, extracts it,
normalizes, phonemizes and chunks it — everything up to §7. It cannot synthesize.

---

## Layout

```
Sources/PolyReadCore          §3 frozen types. The only module everything shares.
Sources/PolyReadExtraction    Agent A — §4. PDF URL → [Block].
Sources/PolyReadLinguistics   Agent B — §5, §6. [Block] → [PhonemizedChunk].
Sources/PolyReadSynthesis     Agent C — §7. → [WordTiming] + a CAF on disk.
Sources/PolyReadPlayback      Agent D — §8, §9.
Sources/PolyReadUI            Agent D — §10, plus the pipeline orchestration.
Sources/PolyReadBench         §0.
App/PolyRead                  The SwiftUI entry point and Info.plist.
tools/                        Structural checkers, standing in for a compiler.
```

§12's partition is the module boundary, and §3 is the only place the four meet.

---

## Two integration points

Both are marked `INTEGRATION POINT` in the source. Everything else is written
against types this repository owns.

**1. MisakiSwift** (`Sources/PolyReadLinguistics/Phonemizer.swift`). Not a
package dependency: §0.3 has to be answered before anyone knows whether the
adapter is a patch or a module, and the app should build either way. Add it to
`Package.swift`, and the one function inside `#if canImport(MisakiSwift)` is
what needs to match its real API.

Until then `PhonemizerFactory` returns `FallbackPhonemizer`, a rule-based G2P
written for this repository. Its pronunciation is mediocre and it is not meant
to ship. What it does give you is *correct per-word grouping*, which is the
structural property everything downstream rests on — so §13's integration gates
1 and 2 can be run, and Agent D's fixture can be generated rather than
hand-written, before MisakiSwift lands.

**2. Core ML tensor names** (`Sources/PolyReadSynthesis/KokoroRunner.swift`).
The app drives both packages through `MLModel` and `MLDictionaryFeatureProvider`
rather than Xcode's generated classes, so a name that turns out to be different
is a one-line fix in `KokoroIO` instead of a regenerate-and-rewrite. The
benchmark screen prints what the packages actually declare.

---

## Where this departs from the spec

Three places, each argued in [`docs/deviations.md`](docs/deviations.md):

1. **§4.6's paragraph rule gets an indent test alongside the gap test.** Gap-only
   collapses a single-column book chapter — half the corpus — into one block per
   page, which costs §8.4 its paragraph transport and §5 its pauses.
2. **§4.6 requires a `.heading` role but gives no detector.** Added a geometric
   one, since §4.1 rules out font metadata on the Vision path.
3. **The CAF is created at full length and written randomly, not appended.**
   Phase A knows every chunk's exact frame offset before any audio exists, so
   §7.3's "seek into unrendered territory" becomes one write at a known offset.

---

## Tests

`swift test` covers what is testable without a device: frame arithmetic, the §5
span invariant through every substitution, the §6.2 budget and sentence backoff,
§4.3–4.6 layout on synthetic geometry, `Voices.bin`, and the Phase A timeline.
§12's shared invariant — `Block.spans.count == tokens(spokenText).count` — is
asserted in debug builds at every stage boundary as well as tested directly.

**None of it has been run.** See the top of this file.
