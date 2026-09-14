# PolyRead — Build Spec v2

Personal iOS/iPadOS PDF reader that speaks poli-sci readings aloud with word-level
highlighting. Single user. Not a product.

**This spec supersedes v1.** v1 assumed macOS, assumed streaming synthesis, and left
the phonemizer, OCR, column layout, and source-provenance mapping unspecified. All four
were load-bearing.

---

## 0. Gate: benchmark before writing app code

Three measurements on a real iPhone and a real iPad. Do not scaffold the app first.
The answers change §7 and §10.

1. **Acoustic throughput.** Load both packages, synthesize 60 s of audio, report the
   realtime multiple per device. The reference figure (63× on an M4 Pro) will not hold
   on a phone; an MLX Kokoro port managed ~3.3× on an iPhone 13 Pro. This number decides
   whether Phase B outruns playback.

2. **Does `KokoroAcoustic` run with `.cpuOnly`?** The model card is self-contradictory
   here: its speed table lists a `.cpuOnly` column with timings for both packages, while
   the prose says neither package runs with the GPU excluded. Resolve it empirically,
   because the stakes are large — iOS does not permit a backgrounded app to submit Metal
   work, so if acoustic runs CPU-only, Phase B keeps rendering while backgrounded and the
   entire buffering problem in §7.3 disappears. If it doesn't, §7.3 applies as written.

3. **Does `MisakiSwift` expose per-word phoneme grouping?**
   (`jpillora/MisakiSwift`, as consumed by `mlalma/kokoro-ios`.) The spec's entire
   highlight mechanism is that grouping. If it only returns a flat phoneme string,
   stop and raise it — that's a module, not a patch.

Report all three before proceeding.

---

## 1. Platform

- iOS 18+ / iPadOS 18+. Required by the Core ML packages. No macOS target.
- **One universal target.** Size class selects the listening surface (§10), not a
  separate app.
- Import: register as a PDF document-type handler in `Info.plist`
  (`CFBundleDocumentTypes`, `LSItemContentTypes = com.adobe.pdf`) plus a
  `UIDocumentPickerViewController`. That covers "Open in PolyRead" from Files, Safari,
  and Mail with no share-extension target and no App Group.
- No iCloud container, no cross-device sync, no playhead sync. Audio cache is local
  and per-device.
- Practical: a free Apple developer account expires provisioning every 7 days. Use a
  paid account or the app dies weekly.

---

## 2. Pipeline

```
PDF
 ├─ born-digital ──▶ PDFKit runs ─┐
 └─ scanned ──────▶ Vision OCR ───┴──▶ [TextRun]        (§4.1, one type, two backends)
                                          │
                        column detect, header/footer strip,
                        footnote classify, hyphenation join,
                        cross-page paragraph merge          (§4.2–4.6)
                                          │
                                       [Block]             (§3, role-tagged, span-mapped)
                                          │
                              substitution normalization    (§5)
                                          │
                                  MisakiSwift G2P           (§6.1)
                                          │
                        phoneme-budget chunking (≤510)      (§6.2)
                                          │
                                 [PhonemizedChunk]
                                          │
        ┌─────────────────────────────────┴──────────────────────────┐
        │ PHASE A (loading bar)                 PHASE B (background)  │
        │ KokoroProsody → duration              KokoroProsody (rerun) │
        │ discard prosody/text tensors          → gather              │
        │ → [WordTiming] for whole doc          → KokoroAcoustic      │
        │ → exact total duration, scrubber      → Int16 CAF on disk   │
        └────────────────────────────────────────────────────────────┘
                                          │
                  AVAudioEngine ▸ AVAudioUnitTimePitch ▸ output       (§8)
                                          │
                     highlight sync from playerNode.playerTime        (§8.3)
```

---

## 3. Frozen interface types

**These are contracts. Do not change them without saying so.** They are what lets
extraction, synthesis, and playback be built in parallel against stubs.

```swift
// Unit of extraction. Backend-agnostic: PDFKit and Vision both produce these.
struct TextRun {
    let text: String
    let bbox: CGRect        // PDF user space, origin bottom-left
    let glyphHeight: CGFloat
    let baseline: CGFloat
    let pageIndex: Int
    var columnIndex: Int    // assigned by §4.2
    var orderIndex: Int     // reading order across the document
}

enum BlockRole {
    case body, heading, footnoteMarker, footnoteBody
    case runningHead, pageNumber, caption
}

// Provenance for exactly one spoken token.
struct SourceSpan {
    let pageIndex: Int
    let bboxes: [CGRect]    // >1 when the word was hyphenated across lines
    let reflowRange: NSRange
}

// Paragraph-level unit, post-normalization.
struct Block {
    let id: UUID
    let role: BlockRole
    let spokenText: String         // normalized; markers removed, substitutions applied
    let spans: [SourceSpan]        // INVARIANT: index-aligned 1:1 with whitespace-split
                                   // tokens of spokenText. See §5.
    let footnoteBodyIDs: [UUID]    // footnotes referenced from inside this block
}

// ≤510 phonemes. May be a fragment of a Block.
struct PhonemizedChunk {
    let id: UUID
    let blockID: UUID
    let tokens: [Int32]                  // Kokoro vocab, WITHOUT the two boundary zeros
    let wordPhonemeRanges: [Range<Int>]  // into tokens; one entry per spoken token
    let spanOffset: Int                  // index into Block.spans of this chunk's first word
}

// Phase A output, per chunk.
struct ChunkTiming {
    let chunkID: UUID
    let frameDurations: [Int]            // rounded to ≥1, one per token
    var frameCount: Int { frameDurations.reduce(0, +) }
}

// Phase A output, flattened to document level. This is the playback timeline.
struct WordTiming {
    let start: TimeInterval
    let end: TimeInterval
    let span: SourceSpan
    let blockID: UUID
}
```

**Frame arithmetic:** one frame is 600 samples at 24 kHz, so 40 frames/sec,
0.025 s/frame. `duration` comes out of the model unrounded; round to at least 1 before
the gather, and use the *rounded* values for timing so audio and timeline agree exactly.

---

## 4. Extraction

### 4.1 Two backends, one output

Both backends emit `[TextRun]`. Everything downstream is source-agnostic. Do not write
two parallel versions of §4.2–4.6.

- **Born-digital:** `PDFPage.attributedString` for text and font attributes,
  `PDFPage.characterBounds(at:)` for geometry. Cache bounds once at import —
  per-character calls are slow and you need them exactly once.
- **Scanned:** `VNRecognizeTextRequest` with `.accurate`, `recognitionLanguages = ["en-US"]`.
  Use `VNRecognizedText.boundingBox(for:)` for sub-observation geometry. Vision returns
  no font metadata, so `glyphHeight` comes from the bbox. This is why §4.4 and §4.5
  classify on geometry rather than font size.

### 4.2 Deciding which backend

Not a presence check. Course-reserve scans frequently ship a *bad* embedded OCR layer,
so `page.string` returns something and it's garbage.

Score it: characters-per-page normalized by page area, plus dictionary-hit ratio over
extracted tokens (`UITextChecker.rangeOfMisspelledWord`). Below threshold, discard the
embedded layer and re-OCR with Vision.

Then score the Vision output the same way. **If Vision also scores badly, surface it in
the import flow and let the user decide whether to continue** — do not silently
synthesize nonsense, and do not refuse outright.

### 4.3 Column detection

Required: the corpus contains two-column journal articles (APSR, *World Politics*) and
single-column book chapters.

Per page, histogram run bbox x-midpoints in ~10 pt bins. Look for a zero-density gap
spanning >15% of page width, centred between 30% and 70% of page width. Found → two
columns; assign `columnIndex` and order runs column-major. Not found → single column,
order runs by descending y.

### 4.4 Running heads and page numbers

Position alone is insufficient — footnote bodies also live in the bottom region.
Combine:

- Candidate if bbox falls in the top 8% or bottom 8% of the page box, **and**
- text is a bare number, **or** its digit-normalized form (`\d+` → `#`) repeats on ≥40%
  of pages.

Tag `.runningHead` / `.pageNumber`. Excluded from speech, retained in the reflow view.

### 4.5 Footnotes

**Markers** (`.footnoteMarker`): `glyphHeight < 0.8 ×` line median, **and** baseline
offset `> 0.15 ×` line height above the line baseline, **and** text is digits or
`† ‡ * §`. Excluded from speech. **Kept visible and tappable in the reflow view** —
this is the affordance for §8.5.

**Bodies** (`.footnoteBody`): contiguous runs in the bottom region whose median
`glyphHeight < 0.85 ×` the page's body median, grouped upward from the page bottom
until glyph height returns to body size. Often preceded by a horizontal rule.

v1 ships both markers and bodies excluded from the main TTS stream. Bodies are still
G2P'd, chunked, and prosody-run in Phase A so their timings exist for §8.5.

**This is a correction to v1**, which stripped markers only. Leaving bodies in the
stream dumps a page of footnotes into the middle of a sentence at every page break.

### 4.6 Joining

- **Hyphenation:** line-final run ending in `-` or `‐`, next line begins lowercase →
  join into one spoken token, drop the hyphen, emit one `SourceSpan` carrying **two**
  bboxes.
- **Paragraph merge within page:** vertical gap between baselines exceeding normal
  line-height ends a block. (v1's rule, unchanged.)
- **Paragraph merge across pages:** last block on page *N* doesn't end in terminal
  punctuation **and** first block on page *N+1* begins lowercase → merge into one
  `Block`. v1 missed this; without it every page break inserts a spurious pause and a
  chunk boundary mid-sentence.
- **Headings** (`.heading`): spoken, with a 400 ms silence before and after. Not merged
  into the following paragraph — merging reads the heading as a sentence fragment.

---

## 5. Normalization

Ordered find-replace on block text, before G2P. Not an NLP layer.

```
"et al."  → "et al"
"e.g."    → "for example"
"i.e."    → "that is"
"cf."     → "compare"
"ibid."   → "ibid"
"pp. A-B" → "pages A to B"
```

In-text author-date citations are read naturally. Do not strip them — `(Putnam 1993, 45)`
is a sub-clause, not a short utterance, and doesn't hit the short-chunk weakness.

**The span invariant.** Substitution is not 1:1. `"e.g."` is one source token and two
spoken tokens. Any substitution that changes token count **must emit one `SourceSpan`
per resulting spoken token, all pointing at the same source bbox.** Same rule in reverse
for hyphenation joins (two source runs, one spoken token, two bboxes).

`Block.spans.count == Block.spokenText.split(separator: " ").count`, index-aligned, is
the invariant the entire highlight mechanism rests on. Assert it in a debug build after
every normalization pass. If it breaks, highlighting drifts silently and the bug will
look like a timing bug.

**No SSML.** Kokoro ignores inline markup. Paragraph pauses are real silence inserted
between rendered chunks (300–500 ms; 400 ms for headings per §4.6).

---

## 6. G2P and chunking

### 6.1 Phonemizer

`MisakiSwift`. The Core ML repo's `G2PEncoder`/`G2PDecoder` is **OOV fallback only** —
the card is explicit that it's for words a dictionary lacks, ~1.5% of ordinary text,
scoring 63% exact. The dictionary path, POS-based homograph resolution, and number
expansion are not in that repo.

Homographs matter here: *the record shows* / *record the vote*, and likewise *conflict*,
*present*, *subject*, *contract*, *lead*. Upstream misaki resolves these with POS tags.
If `MisakiSwift` lacks POS tagging, wire `NLTagger` (`.lexicalClass`) as the tagger.

Proper nouns — Przeworski, Tocqueville, Linz, Huntington — route to the 63%-exact OOV
model. Expect some mispronunciation. Not worth fixing in v1; a user override dictionary
is a v1.1 feature.

G2P **must** return per-word phoneme grouping. That grouping *is* `wordPhonemeRanges`,
and it is the only thing making word-level highlighting possible.

### 6.2 Chunking runs AFTER phonemization

v1 had this backwards. `tokens` is capped at `[1, 3…512]` — 510 phonemes plus two
boundary zeros — and you cannot know a paragraph's phoneme length until you phonemize it.
Long poli-sci paragraphs will blow the cap.

Phonemize the whole block, accumulate phoneme counts per word, and split on word
boundaries when the running total would exceed 510. Prefer sentence boundaries: when a
split is needed, back off to the most recent sentence end within the last 25% of the
budget; if none exists, split at the word boundary.

Emit chunks as close to uniform length as the text allows — the style vector is selected
by phoneme count (§7.1), so wildly varying chunk lengths give wandering prosody.

---

## 7. Synthesis

### 7.1 Model facts

- `KokoroProsody`: `tokens [1, 3…512]` int32, `style [1, 256]` fp32
  → `prosody [1, 640, T]`, `text [1, 512, T]`, `duration [1, T]` fp32.
  Token 0 at both ends. Duration is in frames, unrounded, unscaled.
- Caller gather: repeat column *i* of `prosody` and `text` `round(duration[i])` times.
  `F` = sum of rounded durations.
- `KokoroAcoustic`: `prosody [1, 640, F]`, `text [1, 512, F]`, `style [1, 256]`
  → `audio [1, F·600]` fp32 @ 24 kHz.
- `Voices.bin`: 24-byte header (magic `"AIOSVOX"` + version byte, count, lengths=510,
  dimension=256, reserved), then `24·n` NUL-padded ASCII names, then
  `count · 510 · 256` float32 LE. **Style row index = phoneme count excluding the two
  boundary tokens.**
- Set compute units per package. Prosody on `.cpuOnly` — the default placement runs it
  5.6× slower. Acoustic per the §0 benchmark.
- Load both once at startup, ~0.35 s, keep resident. ~150 MB.
- Apache-2.0.

**Voice:** hardcode one for v1. Picker is v1.1.

**The duration path is documented and real. Delete v1 §3's proportional-allocation
fallback and its build step.** It was insurance against a risk that doesn't exist.

### 7.2 Phase A — during the loading bar

G2P the whole document, run `KokoroProsody` on every chunk including footnote bodies,
keep **only** `ChunkTiming.frameDurations`. Discard `prosody` and `text`.

Discarding costs a prosody re-run in Phase B — ~14% overhead at 5.8 ms/chunk — and keeps
peak RAM flat. Retaining them would be ~2.3 MB per 510-phoneme chunk, several hundred MB
across a long document, which jetsams a phone.

Phase A output is the complete `[WordTiming]` for the document: exact total duration,
working scrubber, complete highlight map, correct seek — **with no audio generated**.
Prosody is ~7× cheaper than acoustic, so this is seconds on a typical article.

### 7.3 Phase B — after the bar dismisses

`KokoroProsody` → gather → `KokoroAcoustic`, chunk by chunk in document order, appended
to an Int16 CAF on disk. Never throttled.

**Dismiss the loading bar when Phase A completes and ~60 s of audio exists.**

Buffering is a cold-start problem, not a steady-state one. At 15× realtime, one minute
of listening costs four seconds of rendering; the lead grows at ~14× and the renderer
laps the playhead within the first minute. The single failure case is importing, hitting
play, and locking the device inside the first ~20 seconds.

Therefore:
- Show the rendered-through edge on the scrubber permanently, like a video preload bar.
  Most of the time it sits pinned at the end.
- Play to the edge and stop there. Do not block backgrounding.
- If the app backgrounds with under ~2 minutes of lead, take a `beginBackgroundTask`
  extension to bank ~30 s more.
- **If §0.2 shows acoustic runs `.cpuOnly`, none of the above is needed** — Phase B
  submits no Metal work and keeps rendering while backgrounded.

**Seek into unrendered territory** is supported: Phase A already knows the word index at
every timestamp, so render that chunk on demand (~one acoustic pass) and start there.
Do not disable seeking ahead of the buffer edge.

### 7.4 Cache

Int16 CAF per document — no encode latency, seekable, ~260 MB per 90 minutes — plus a
JSON sidecar holding `[WordTiming]` and `[Block]`. Keyed by PDF content hash so
reopening a document is instant.

LRU eviction of whole documents against a size cap (default ~4 GB), with a user-visible
storage figure in settings.

---

## 8. Playback

### 8.1 Graph

`AVAudioPlayerNode` → `AVAudioUnitTimePitch` → `mainMixerNode`. Source format 24 kHz
mono; let the engine convert to the output format.

### 8.2 Speed

`AVAudioUnitTimePitch.rate`. **Do not** follow the card's advice to divide durations by
speed at synthesis — under two-phase rendering that invalidates every cached chunk on
every speed change.

### 8.3 Highlight sync

Read position from `AVAudioPlayerNode.playerTime` (converted via `nodeTime`), **not**
wall clock. That is the *source* timeline, pre-time-stretch, so `[WordTiming]` indexes
directly and needs **no** rate rescaling. This deletes v1 §5's rescaling workaround along
with the drift class of bugs it was patching.

Binary-search `[WordTiming]`, but cache the last index and search outward from it —
playback is monotonic except on seek. Drive updates from a `CADisplayLink` at screen
refresh, not an audio render callback (no UI work on the render thread).

### 8.4 Transport

- Play / pause.
- Skip ±15 s, snapped to the nearest `WordTiming` boundary — never a raw audio seek, or
  you land mid-word.
- Previous / next paragraph, using `Block` boundaries.
- Scrubber over the `[WordTiming]` timeline, with the §7.3 buffer edge drawn on it.

### 8.5 Footnote interjection

Tapping a `.footnoteMarker` in the reflow view: pause main stream → render that footnote
body's chunks on demand → play → resume at the same word. A state-machine branch, not a
free feature. The main timeline position must not move.

---

## 9. Background audio

- `AVAudioSession` category `.playback`, activated on first play.
- `UIBackgroundModes` includes `audio` in `Info.plist`.
- `MPNowPlayingInfoCenter`: title from the PDF's document title or filename, duration
  from Phase A, elapsed time from §8.3. Artwork from a rendered thumbnail of page 1.
- `MPRemoteCommandCenter`: play, pause, skip forward/back (15 s), change playback
  position. Lock screen and AirPods controls are the actual point of the app.
- Handle `AVAudioSession.interruptionNotification` and route changes.

---

## 10. UI

**Compact width (iPhone): reflowed text.** A `UITextView`/TextKit view built from the
normalized `[Block]` list — not from `page.string`. Its character ranges are
`SourceSpan.reflowRange`. Highlight = a background attribute on the current word's range,
auto-scrolled to stay on screen. This is the primary surface; build it first.

**Regular width (iPad): the rendered page.** A custom overlay layer over `PDFView`
drawing rects from `SourceSpan.bboxes`. **Not `PDFSelection`** — scanned documents have
no text layer to select, and a bbox-driven overlay serves both backends identically.
Needs column-aware auto-scroll and page advance to keep the spoken word visible.

Both surfaces read the same `WordTiming` stream. The current word index is one piece of
state; the two views are renderers of it.

**Import:** a progress bar with phase labels (OCR if applicable → Phase A → first audio),
dismissing per §7.3.

---

## 11. Non-goals for v1

- No scientific notation or equations.
- No multi-voice, no voice picker, no per-character voices.
- No cross-device sync, no cloud, no library beyond recently-opened.
- No SSML or manual pause authoring.
- No export to audio file.
- No user pronunciation override dictionary.
- No number-expansion layer beyond §5. Fix what you actually hear; don't pre-solve.

---

## 12. Swarm partition

Four agents. They meet only at the §3 types. Write the types first, as a shared module,
and have each agent build against stubs.

| Agent | Owns | Produces |
|---|---|---|
| **A — Extraction** | §4 both backends, column/header/footnote/join logic | `[Block]` from a PDF URL |
| **B — Linguistics** | §5 normalization, §6 G2P + chunking | `[PhonemizedChunk]` from `[Block]` |
| **C — Synthesis** | §7 both Core ML packages, gather, Phase A/B scheduler, §7.4 cache | `[WordTiming]` + CAF on disk |
| **D — Playback & UI** | §8, §9, §10 | The app |

Agent D can build the entire transport, both highlight surfaces, and lock-screen
integration against a **hand-written fixture**: one `[WordTiming]` array and one CAF file
generated offline. It never needs to wait on A, B, or C.

Agent A's output is verifiable standalone (dump blocks to console). Agent C's Phase A is
verifiable standalone (durations sum to a plausible audio length).

**Shared invariant to test in every agent's debug build:** §5's span-count assertion.

---

## 13. Build order

0. §0 benchmark. Report all three answers. **Gate.**
1. Shared types module (§3) committed first, before any agent starts.
2. Agents A–D in parallel.
3. **Integration gate 1:** A → B. Dump `[PhonemizedChunk]` for 3 real PDFs — one
   two-column journal article, one single-column book chapter, one scanned book. Verify
   column order, footnote separation, hyphenation joins, cross-page merges, and that no
   chunk exceeds 510 phonemes. Show output before continuing.
4. **Integration gate 2:** B → C. Phase A over a full document. Verify total duration
   is plausible and `[WordTiming]` is monotonic and gap-free. Show output.
5. **Integration gate 3:** C → D. Replace D's fixture with real output. This is the
   moment the core loop exists end-to-end.
6. §7.3 buffer edge, §8.5 footnote interjection, §7.4 LRU, §4.2 OCR warning.
7. §9 background and lock-screen integration.

Do not build the iPad page surface before the iPhone reflow surface works.
