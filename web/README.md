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
npm install          # 87 packages, no warnings, no vulnerabilities
npm run assets       # downloads the Kokoro model and voices into public/models
npm run dev          # http://localhost:5173
```

`npm run fonts` is the other fetch, and it has already been run: Archivo and
IBM Plex Mono live in `public/fonts/`, so the app carries the typography of
blozanod.me without asking Google for it on every load. Re-run it only to
change or update a face.

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

`npm run assets` is a one-time download of about 480 MB: the model twice, at
two precisions, for reasons in the next section. **The same files serve
the website and the desktop installers** — it writes into `public/models/`, Vite
copies that into `dist/` at build time, and electron-builder packages `dist/`.
One download, both targets, no second set of files to manage.

To see exactly what is published before committing to a download:

```sh
node scripts/fetch-assets.mjs --list
```

By default that is two model files, one for each processor:

| File | Precision | Size | Runs on | Why |
|---|---|---|---|---|
| `kokoro-gpu.onnx` | `fp32` | 310 MB | the GPU, first | kokoro-js, the reference client for this checkpoint, recommends fp32 on WebGPU: at half precision the vocoder is audibly worse, and some drivers refuse the graph |
| `kokoro.onnx` | `fp16` | 156 MB | the CPU, and a GPU that refuses fp32 | The fastest file on the CPU backend |

The CPU numbers, measured on the same four-core machine with onnxruntime-web's
own WebAssembly build: `fp16` 1.35× realtime on four threads, `fp32` 1.19×, and
`q8` 0.72× — its integer kernels do not use the thread pool. On one thread all
three are near 0.4×, which is why threads matter more than the file (see
[Building the site](#building-the-site)).

The browser only downloads the file its first rung will run, so neither kind of
machine fetches both. To choose differently:

```sh
node scripts/fetch-assets.mjs --no-gpu-model      # fp16 only, 156 MB; the GPU runs it too
node scripts/fetch-assets.mjs --dtype q8f16       # a smaller file for the CPU
node scripts/fetch-assets.mjs --voices all        # all 55 voices, +28 MB
node scripts/fetch-assets.mjs --voices-from-npm   # voices from npm, if the Hub is blocked
```

`--dtype` accepts `fp32`, `fp16`, `q8`, `q8f16`, `q4`, `q4f16`, `uint8` and
`uint8f16`, or a filename from `--list`; `--gpu-dtype` does the same for the GPU
file. Files ending `f16` need a GPU with `shader-f16`. Note that the quantized
files are not ordered the way the names suggest — `q4` is nearly twice `q4f16`
and larger than `fp16`, because only some of the graph is quantized in each.

If a dtype name does not match anything the repository has, the script prints
every model file it found so you can pass one by name.

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

Threads on the CPU need a cross-origin-isolated page, which takes two response
headers. If you can set them, send

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

on that directory. If you cannot — GitHub Pages and most personal hosts do not
let you — nothing needs doing: `public/isolation-sw.js` is a service worker that
adds them to the app's own responses, and the first visit reloads once to come
under it. It caches nothing and touches nothing but this app's files. Without
isolation of either kind the CPU backend has one thread, and one thread renders
at about 0.4× realtime — slower than the voice speaks. The desktop builds serve
themselves over a local HTTP server for no other reason than to send these two
headers. Settings → CPU threads overrides the thread count either way.

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

## Which processor it runs on

Synthesis on a GPU is several times faster than synthesis on a CPU, and that is
not a performance detail — it is the difference between rendering that outruns
playback and rendering that does not, which is the assumption the whole of §7.3
rests on. So the GPU is not a preference here. It is the design, and the CPU is
what happens when there is no other answer left.

`src/synthesis/gpu.ts` picks the hardware and builds the device; the ladder in
`src/synthesis/kokoroEngine.ts` is climbed down in this order, and every rung is
proven by *running* the graph rather than merely compiling it, because WebGPU
compiles a shader the first time an operator runs and not before:

1. **Every GPU the machine will hand out**, best first, each with the
   full-precision model and then the half-precision one. Adapters are probed at
   all three request shapes and ranked: discrete before integrated, NVIDIA first
   among discrete, anything that can run the model before anything that cannot.
   Software rasterizers (SwiftShader, lavapipe, WARP) are dropped rather than
   ranked — they are the CPU with extra steps, and slower at this model than the
   CPU backend is.
2. **The best GPU with graph fusions off.** ORT's WebGPU shader generation is
   thinnest around its fused kernels; a driver that refuses one will usually run
   the same graph unfused, and that is still a GPU.
3. **The CPU**, on the half-precision model — and reaching it is never silent. It raises a card on the
   library page that names the GPU, the reason, and the one command that would
   have kept it on the GPU.

Two things make step 1 work that did not before. The device is **created here**,
with `shader-f16` required and the adapter's own limits rather than the spec's
256 MB defaults, and handed to the session as the WebGPU provider's `device`
option — which is the only path `onnxruntime-web` honours, and why the previous
`env.webgpu.adapter` assignment had no effect at all. And in the desktop build
`electron/main.ts` forces Chromium onto the discrete GPU before its GPU process
starts, since the renderer can only rank adapters Chromium already initialized.

Settings → Compute chooses between **GPU first** (the default: the ladder above),
**GPU only** (the same ladder with step 3 removed, so a machine that cannot use
its GPU says so instead of quietly running ten times slower) and **CPU**.
Settings → Benchmark prints the whole ladder, rung by rung, with what each said.

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

**Exact** — you ran `make-duration-model.py`. Every word boundary comes from the
model rather than from arithmetic, so the scrubber, the total duration and the
highlight are all exact.

The duration pass runs *behind* the reader rather than in front of it, which is
a departure from §7.2 and a deliberate one: the subgraph is most of Kokoro's
text encoder, and a document's worth of it on the CPU backend is several
minutes — minutes spent staring at a loading bar instead of at the document the
timeline is describing. So the reader opens on the estimated timeline
immediately and the exact pass walks the document from the front, staying ahead
of the audio, replacing each estimate before anything can reach it. The reader
says "~" in front of the total for as long as any of it is still an estimate.

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

**1. The phoneme vocabulary is the checkpoint's own.**
`src/linguistics/vocabulary.ts`. The Swift build shipped a reconstruction of
Kokoro's symbol list, and a first correction of it here was still wrong: both
enumerated v0.19's symbol string, whose tail repeats an apostrophe, so `ᵻ` —
the vowel eSpeak writes in nearly every unstressed *-es* and *-ed* — was sent
as 175 when v1.0 has it at 177, and 175 is a slot the model never trained. The
table is now v1.0's `config.json` vocabulary verbatim, pinned id for id by a
test. The loaded `tokenizer.json`, when present, is what the chunker encodes
with; it used to be read and then not passed to it.

**2. §0.3 is answered, and the voice hears what the reference client sends.**
`src/linguistics/espeakPhonemizer.ts`. MisakiSwift was never evaluated; the web
uses eSpeak-NG, which is the same G2P the reference Kokoro web client uses. It
resolves homographs from context — *the record shows* against *they record the
vote* — but its word boundaries are its own: "1993" comes back as three groups,
"of the" as one. So each passage is phonemized as running text, exactly as
kokoro-js does it, and that string goes to the model unchanged; only its
*division* among the tokens is solved for, by a monotonic alignment in which a
number may take several groups, several short words may share one, and a bare
dash may take none. Words that share a group are marked `joined` and encoded
with no space between them, so the stream is byte-for-byte kokoro-js's. The
alignment checks that each word's phonemes can begin the way it is spelled,
which keeps one miscount from sliding every later word onto its neighbour. A
misplaced cut inside `ʌvðə` moves a highlight by milliseconds and never changes
a sound. The previous version re-phonemized welded words one at a time, which
read "a" as the letter *A* and gave every "the" full stress, and it sometimes
kept both copies of a weld, so "on the" was spoken "on on-the".

Passages go to eSpeak on a small pool of workers (`phonemizerPool.ts`): the
`phonemizer` package is eSpeak compiled to plain JavaScript and makes its
phonemes by running the synthesizer, about a millisecond a word, and it was the
longest stage of an import.

**3. §4.2 scores function words, not dictionary hits.**
`src/extraction/quality.ts`. There is no `UITextChecker` here, and a 275 KB
English word list is both a download and the wrong instrument for a corpus of
Przeworski and Tocqueville. English prose is about 45% function words; a corrupt
OCR layer is near zero, and no proper noun is ever mistaken for one.

**4. Words, lines and columns are rebuilt from pdf.js's items.**
`src/extraction/words.ts`, `pageLayout.ts`, `blockAssembler.ts`. pdf.js emits a
text item per run of one font, which can be a whole line or part of a word.
Pieces with no space and no visible gap between them are joined into one word
(small caps, an italic word's roman period, a TeX accent over its letter), text
struck twice for a bold effect is dropped, and rotated text is left out. Words
are then chained into line segments that stop at any gap wider than an em — a
gutter, never a word space — and a page's columns are found as a vertical strip
that column-shaped text stands either side of, with whatever crosses it (title,
abstract, a wide caption) read as a band of its own. Paragraphs break at a gap,
at an indent from a margin fitted through the lines (so a scan's skew is not an
indent), and where a run of lines set in together — a block quote, a centred
title — returns to the margin, never on each of their lines. They continue
across a column or a page break, past the page's running head. The vertical
measurements the footnote-marker test depends on — `glyphHeight` and
`baseline` — come from the items themselves and stay exact.

`scripts/make-layout-fixtures.py` typesets a book chapter, a two-column journal
article, a skewed per-word OCR layer and a fake-bold chapter whose correct
reading is known exactly; `tests/layouts.test.ts` holds the extractor to them
paragraph for paragraph.

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

146 tests in a few seconds. Most are unit tests over the parts that need
neither a GPU nor a PDF: frame arithmetic, the §5 span invariant through every
substitution, §4.3–§4.6 layout on synthetic geometry, sentence-aligned §6.2
chunking, the phoneme vocabulary against the checkpoint's ids, §0.3 word
alignment over the cases that break it, and the duration estimator's exactness
properties. Four more read the typeset layout fixtures (see §4 above) through
the real pdf.js.

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
work on the reader without a 480 MB download:

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

**The import stops partway through loading the model.** This used to happen on
every cross-origin-isolated page of a production build, and it was not the
browser. ONNX Runtime starts its CPU threads from its own script's URL, and once
Vite bundles it into the pipeline worker that URL is the pipeline worker, whose
message handler then replaced the one each thread runs on. The pipeline now
leaves a runtime thread alone (`isRuntimeThread` in `pipeline.worker.ts`). The
stall watchdog that retries on a single thread is still there for anything
else that hangs.

**It is slow.** Check Settings → Benchmark for which device it picked, and for
the ladder underneath it — every rung tried, in order, with what each one said.
WebGPU is several times faster than the CPU backend, and reaching the CPU means
every GPU configuration on the machine was refused; the note beside the import
says which and why. Set Compute to **GPU only** if you would rather have an
error than a silent tenfold slowdown.

**`ShaderModule with 'Clip' label is invalid`.** Clip has nothing to do with it.
ONNX Runtime emits WGSL's `enable f16;` only when the *device* reports the
`shader-f16` feature, and then generates `f16` code for an fp16 model
regardless — so on a device without 16-bit shader support *every* shader it
compiles is invalid, and the error names whichever one was compiled first.

Note "device", not "GPU". This used to be reported alongside an adapter that
*did* have `shader-f16`, which looked like a contradiction and was not: they
were two different pieces of hardware. `onnxruntime-web`'s WebGPU build reads
`env.webgpu.adapter`, type-checks it and then discards it — Dawn goes and asks
`navigator.gpu` for its own adapter and builds its own device with its own
feature set. So the adapter PolyRead chose was reported and the adapter Dawn
chose ran the model.

PolyRead now creates the `GPUDevice` itself — with `shader-f16` required and the
adapter's real limits rather than the spec's 256 MB default, which is the other
half of that error message — and passes it to the session as the WebGPU
provider's `device` option, which is the one path ONNX Runtime honours. If a
device genuinely cannot do 16-bit arithmetic, the remedy is a model file rather
than a GPU — the full-precision one, which `npm run assets` fetches by default
and every GPU tries first:

```sh
npm run assets   # includes kokoro-gpu.onnx, fp32, 310 MB
```

**It picked the wrong GPU.** On a laptop with an integrated and a discrete GPU,
`navigator.gpu.requestAdapter()` with no options returns the integrated one.
PolyRead probes all three request shapes, ranks what comes back — discrete
before integrated, NVIDIA first among discrete, anything that can run the model
before anything that cannot, software rasterizers not at all — and creates the
device on the winner. Settings → Benchmark names it and says how it was
classified.

The desktop build goes a step further, because the renderer can only rank the
adapters Chromium initialized: `electron/main.ts` starts the browser process
with `force_high_performance_gpu`, `ignore-gpu-blocklist`, `enable-unsafe-webgpu`
and Dawn's `allow_unsafe_apis`, adds `Vulkan` on Linux, and exports NVIDIA's
three PRIME offload variables where an NVIDIA driver is loaded. `POLYREAD_GPU=off`
turns all of it off and runs on the CPU, for a machine whose driver is the
problem.

**A word is mispronounced.** Proper nouns route through eSpeak's letter-to-sound
rules — Przeworski and Tocqueville come out about as well as you would expect.
§11 called a user pronunciation dictionary a v1.1 feature and it still is.

**`npm install` warns about install scripts.** It should not: `allowScripts` in
`package.json` already vouches for the three that matter (esbuild and protobufjs
need their platform binaries, Electron needs its runtime) and declines
tesseract.js's, which only prints a funding notice. If npm asks anyway it is
older than the policy field; `npm install-scripts approve --all` has the same
effect.

**A scanned PDF renders as blank white pages.** This was a real bug, fixed
here, and the shape of it is worth knowing because it fails silently. pdf.js 6
decodes JBIG2 — the encoding behind essentially every library scan, JSTOR and
course reserves included — in a WebAssembly module it fetches from the `wasmUrl`
option at runtime. Given no `wasmUrl`, it does not throw: it logs
`Jbig2Error: JBig2 failed to initialize`, skips the image, and hands back a page
carrying nothing but its text layer. `standardFontDataUrl` fails the same way
and quietly clips extracted text mid-word. All four asset roots are now served
out of `pdfjs/` by the `pdfjsAssets` plugin in `vite.config.ts` and handed over
by `src/extraction/pdfAssets.ts`. If scans go blank again, check that
`dist/pdfjs/wasm/jbig2.wasm` is being served.

**Nothing is read aloud and the clock runs anyway.** Also fixed. The audio
worklet reads unrendered audio as a hole of silence, so playback used to run
straight through a document that had not been synthesized yet — silently, with
the position advancing. Reaching unrendered audio now parks the playhead, says
so in the transport, renders that chunk and resumes by itself. If it parks and
never resumes, the model did not load: the chip in the header says which.

**"getOrInsertComputed is not a function".** You are on the wrong pdf.js build.
The app imports `pdfjs-dist/legacy/build/pdf.mjs` on purpose — pdf.js 6's
default build calls a JavaScript proposal method that Chromium 141 still does
not have, so page rendering throws on browsers people actually run. The legacy
build is the same library with the polyfills in.

## Licence

Apache-2.0, as is Kokoro, eSpeak-NG and kokoro-js, from which the text
normalization and phoneme post-processing in `src/linguistics/kokoroText.ts` are
ported.
