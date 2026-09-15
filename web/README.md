# PolyRead — web and desktop

The iOS app, ported to run in a browser and as a desktop app on macOS, Windows
and Linux. Same pipeline, same spec: a PDF goes in, and it is read aloud with
the word being spoken highlighted, on the reflowed text or on the rendered page.

Everything runs on your machine. The PDF is never uploaded, the synthesis is
local, and after the first setup the app talks to nothing but its own origin.

---

## Running it

Node 20 or newer. Node 24 and npm 11 are what this is currently built against.

```sh
cd web
npm install          # 83 packages, no warnings, no vulnerabilities
npm run assets       # downloads the Kokoro model and voices into public/models
npm run dev          # http://localhost:5173
```

The desktop toolchain is deliberately not part of that install. Electron and
electron-builder are 280 further packages and every deprecation warning the
install would otherwise print, and none of it is needed to run, test or build
the web app. When you want an installer:

```sh
npm run desktop:setup
```

That writes them into `package.json` and the lockfile, so they stay put across
later installs — `git checkout package.json package-lock.json` undoes it if you
would rather keep the committed state lean. The `dist:*` scripts check for the
toolchain and point you here if it is missing.

`npm run assets` is a one-time download of about 170 MB. **The same files serve
the website and the desktop installers** — it writes into `public/models/`, Vite
copies that into `dist/` at build time, and electron-builder packages `dist/`.
One download, both targets, no second set of files to manage.

To see exactly what is published before committing to a download:

```sh
node scripts/fetch-assets.mjs --list
```

Then pick a precision:

| `--dtype` | Roughly | Use it when |
|---|---|---|
| `fp32` | ~330 MB | You have WebGPU and want the best quality |
| `fp16` | ~170 MB | **Default.** Good on WebGPU, fine on CPU |
| `q8` | ~90 MB | CPU only, or you care about download size |
| `q4f16` | ~50 MB | You want it small and will accept some quality loss |

```sh
node scripts/fetch-assets.mjs --dtype q8        # smaller, faster on CPU
node scripts/fetch-assets.mjs --voices all      # every voice, +28 MB
node scripts/fetch-assets.mjs --voices-from-npm # voices from npm, if the Hub is blocked
```

The sizes are what 82M parameters comes to at each precision; `--list` prints
the real ones. If a dtype name does not match anything the repository has, the
script prints every model file it found so you can pass one by name.

### Exact word timings

**Do this.** It is one command and it is the difference between a highlight that
lands on the word and a highlight that drifts.

```sh
python3 -m pip install onnx onnxruntime numpy
python3 scripts/make-duration-model.py public/models/kokoro.onnx
```

The reason is in [Timings](#timings-the-one-real-compromise) below. The script
finds the duration predictor inside the model and cuts it out as a second, much
smaller model; the app picks it up automatically. It takes a couple of minutes
and only has to be done once per model file.

### Building the site

```sh
npm run build        # -> dist/
```

`dist/` is a static site with no server requirements. Copy it to
`blozanod.me/PolyRead/` and it works — `base` is `./`, so a subdirectory is
fine. `public/models` is copied into `dist/models`, so whatever you fetched ships
with it.

One optional server tweak: if you can set response headers, send

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

on that directory. Without them the multi-threaded CPU backend is not available
at all. It is off by default anyway — see Settings → CPU threads, and the note
in `src/synthesis/kokoroEngine.ts` about why — but the headers are what make
turning it up possible on machines where it works.

### Building the desktop apps

```sh
npm run desktop:setup   # once: adds Electron and electron-builder
npm run dist:linux      # AppImage + .deb
npm run dist:win        # NSIS installer + portable .exe
npm run dist:mac        # .dmg, arm64 and x64 — needs macOS
```

From WSL Ubuntu, `dist:linux` works directly. `dist:win` needs Wine
(`sudo apt install wine64`) or it can be built on the Windows side. macOS
builds need macOS; the GitHub Actions workflow at
`../.github/workflows/desktop.yml` builds all three on a push of a `v*` tag, so
you never need a Mac.

Run `npm run assets` before `npm run dist:*` and the installers are fully
offline. Skip it and the app will ask for a model URL on first run.

The builds are unsigned, because signing them costs money. On macOS that means
right-click → Open the first time; on Windows, "More info" → "Run anyway".

---

## Timings: the one real compromise

The spec's §7 describes Kokoro as two models. The first returns a `duration` for
every phoneme; the second turns those durations into audio. Word-level
highlighting is built on the first one — the per-phoneme durations are what say
when each word starts.

The ONNX build of Kokoro that browsers can run is a single graph with a single
output, `waveform`. The duration predictor is still inside it, but an ONNX
Runtime session will only hand back graph outputs, so there is no way to ask for
it. That leaves two tiers, and the app tells you which one it is in:

**Exact** — you ran `make-duration-model.py`. §7.2's Phase A works as specified:
the whole document is timed before a single sample of audio is rendered, so the
scrubber, the total duration and every word boundary are right immediately, and
seeking anywhere is instant.

**Estimated** — you did not. A chunk's *total* length is still known exactly the
moment it is rendered (the waveform is `frames × 600` samples), so the timeline
is exact at every chunk boundary, which is every paragraph. Inside a chunk the
time is divided between phonemes by class — vowels get more than plosives, a
full stop buys a pause — and then the word boundaries are nudged onto the quiet
spots the rendered audio actually has. It is good enough to follow. It is not
good enough to not notice, and it drifts most in the middle of a long paragraph.

Everything else about the two tiers is identical.

---

## What changed in the port, and why

The pipeline is §12's four agents, unchanged in shape:

```
src/core          §3 frozen types. The only module everything shares.
src/extraction    Agent A — §4. PDF -> [Block].
src/linguistics   Agent B — §5, §6. [Block] -> [PhonemizedChunk].
src/synthesis     Agent C — §7. -> [WordTiming] + rendered audio.
src/playback      Agent D — §8, §9.
src/ui            Agent D — §10.
src/workers       The thread boundary the web adds.
```

Eight things are genuinely different. Each is argued where it lives in the
source; this is the index.

**1. The phoneme vocabulary had a bug, and it is fixed.**
`src/linguistics/vocabulary.ts`. The Swift build shipped a reconstruction of
Kokoro's symbol list and said loudly that it had never been checked against a
real model. It was missing one character — an apostrophe, second from the end of
the IPA run. That shifted `ᵻ` down by one and dropped `'` entirely, and eSpeak
emits `ᵻ` in every unstressed *-es* and *-ed*. The corrected table is checked
against the reference implementation and pinned by a test.

**2. §0.3 is answered, and the answer is enforced rather than assumed.**
`src/linguistics/espeakPhonemizer.ts`. MisakiSwift was never evaluated; the web
uses eSpeak-NG compiled to WebAssembly, which is the same G2P the reference
Kokoro web client uses. It resolves homographs from context — *the record shows*
against *they record the vote* — but its word boundaries are its own: "1993"
comes back as three groups and a bare "(" as none. So the block is phonemized
once for context, and where the group count does not match the token count a
monotonic dynamic program assigns each token a run of groups, scored against
what the token structurally implies. The result is then *verified*, and if any
token came out with a group count its structure forbids, the whole alignment is
thrown away and each token is phonemized separately, which is one-to-one by
construction. There is always a correct fallback, so the clever part is an
optimization of pronunciation quality and never a guess about alignment.

**3. §4.2 scores function words, not dictionary hits.**
`src/extraction/quality.ts`. There is no `UITextChecker` here, and a 275 KB
English word list is both a download and the wrong instrument for a corpus of
Przeworski and Tocqueville. English prose is about 45% function words; a corrupt
OCR layer is near zero, and no proper noun is ever mistaken for one.

**4. pdf.js text items are cut into words.** `src/extraction/backends.ts`.
pdf.js emits a run per show-text operator, which can be a whole line. §4.4 and
§4.5 classify individual words, so items are split at their spaces with the width
divided by character count. The vertical measurements the footnote-marker test
actually depends on — `glyphHeight` and `baseline` — come from the item itself
and stay exact.

**5. The layout can move, and only ever ahead of the playhead.**
`src/synthesis/streamLayout.ts`. On iOS, Phase A knew every chunk's frame count
before any audio existed, so the layout was final. In the estimated tier it is
not, and `commit` is how the truth arrives. Because Phase B renders in document
order, committing chunk *k* only moves chunks after it — the part of the timeline
the playhead has not reached.

**6. Playback is a hand-written WSOLA stretcher.**
`src/playback/stretchProcessor.js`. The Web Audio API has no time-pitch unit:
`playbackRate` resamples, which shifts the pitch, and every third-party
stretcher reports position in *output* time. §8.3 is emphatic that the highlight
must read the *source* timeline. Owning the stretcher makes `sourcePosition` a
state variable rather than something inferred afterwards, and three other things
fall out of it: audio with holes in it (§7.3's seek into unrendered territory),
bounded memory on a 90-minute document, and the 24 kHz-to-device rate conversion.

**7. There is a thread boundary.** `src/workers/`. A WASM inference pass does
not yield, and Phase B runs for minutes behind the reader. Anything sharing a
thread with it gets a stuttering highlight, so extraction, linguistics and
synthesis run in a worker and the UI thread keeps only the audio graph and the
two surfaces.

**8. §9 is the Media Session API, and §0 lost two of its three questions.**
`src/playback/mediaSession.ts`, `src/ui/SettingsPanel.tsx`. Lock screen,
notification shade, headphone controls and media keys all come from the same
API. Of the §0 gate, §0.2 was about Metal in a backgrounded iOS app and does not
exist here, and §0.3 is settled above. §0.1 survives and decides the same thing
it always did — whether rendering outruns playback — and so do the two checks
`docs/gate-0.md` added on its own account. Settings → Benchmark runs all three.

Two things the Swift build shipped are gone, both because the reason for them
went away: the rule-based fallback G2P (eSpeak is better and always available)
and the CAF writer (IndexedDB stores one Int16 record per chunk, which
represents §7.3's holes better than a file with silent gaps in it).

Not yet ported: §8.5's footnote interjection. The markers are extracted,
classified, paired with their bodies, spliced into the reflow text at the right
word and given their own timelines by Phase A — everything §8.5 needs is in
place — but tapping one currently does nothing.

---

## Tests

```sh
npm test
```

74 tests in about two seconds. Most are unit tests over the parts that need
neither a GPU nor a PDF: frame arithmetic, the §5 span invariant through every
substitution, §4.3–§4.6 layout on synthetic geometry, the §6.2 budget and
sentence backoff, the phoneme vocabulary against the checkpoint's ids, §0.3 word
grouping over the cases that break it, and the duration estimator's exactness
properties.

Two of them are §13's integration gates, run against a hand-built two-page PDF
in `tests/fixtures/` that carries one of everything §4 has a rule for — a
running head, a folio, a heading, a superscript marker with its small-type body,
a word hyphenated across a line break, a §5 abbreviation, and a paragraph that
runs off the bottom of page one and continues in lowercase at the top of page
two. Gate 1 takes it from bytes to phonemized chunks and asserts each of those
was handled; gate 2 runs Phase A over it and asserts the timeline is monotonic,
gap-free, one entry per spoken word, and of a plausible length.

### What the tests do not cover, and how it was checked anyway

They cannot run the model or the browser. That half was verified by driving the
built site in headless Chromium against a stand-in model with Kokoro's exact
interface. `scripts/make-test-model.py` writes one — a tone generator, so the
pipeline is real and only the sound is a lie — which is also the quickest way to
work on the reader without a 170 MB download:

```sh
python3 -m pip install onnx numpy
python3 scripts/make-test-model.py public/models
npm run dev
```

The browser driving itself was ad hoc rather than committed, because pinning
Playwright and its browser into this repository costs more to install than it
earns back on a project this size. Import to reader took 1.8 s,
reopening from the cache 0.1 s, and the playhead, the word highlight, the page
overlay, ±15 s, paragraph skip, 1.5×, pause, end-of-stream and click-to-seek all
behaved. Six bugs were found and fixed that way, including two — the audio
node learning where the document ends, and IndexedDB transactions deactivating
across an `await` — that no unit test would have caught.

What none of it covers is the real checkpoint: whether it sounds right, and
whether §0.1's throughput clears playback on your machine. Settings → Benchmark
is for that.

## If something goes wrong

**The import stops partway through loading the model.** ONNX Runtime's
multi-threaded CPU backend starts its threads as workers, and the pipeline
already runs in one — nested workers hang on some browser builds rather than
failing. PolyRead ships with one thread for that reason, notices a stall after a
minute and retries on one anyway. If you raised the thread count in Settings,
put it back.

**It is slow.** Check Settings → Benchmark for which device it picked. WebGPU is
several times faster than the CPU backend; if it says `wasm`, your browser
either lacks WebGPU or refused it. Failing that, `--dtype q8` is the fastest
model on CPU.

**A word is mispronounced.** Proper nouns route through eSpeak's letter-to-sound
rules — Przeworski and Tocqueville come out about as well as you would expect.
§11 called a user pronunciation dictionary a v1.1 feature and it still is.

**`npm install` warns about install scripts.** It should not: `allowScripts` in
`package.json` already vouches for the three that matter (esbuild and protobufjs
need their platform binaries, Electron needs its runtime) and declines
tesseract.js's, which only prints a funding notice. If npm asks anyway it is
older than the policy field; `npm install-scripts approve --all` has the same
effect.

**"getOrInsertComputed is not a function".** You are on the wrong pdf.js build.
The app imports `pdfjs-dist/legacy/build/pdf.mjs` on purpose — pdf.js 6's
default build calls a JavaScript proposal method that Chromium 141 still does
not have, so page rendering throws on browsers people actually run. The legacy
build is the same library with the polyfills in.

## Licence

Apache-2.0, as is Kokoro, eSpeak-NG and kokoro-js, from which the text
normalization and phoneme post-processing in `src/linguistics/kokoroText.ts` are
ported.
