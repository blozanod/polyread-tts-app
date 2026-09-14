#!/usr/bin/env python3
"""
Cuts a duration-only model out of the Kokoro ONNX graph.

## Why

The build spec's §7 describes Kokoro as two packages: a prosody pass that
returns per-token `duration`, and an acoustic pass that turns it into audio.
That split is what makes §7.2's Phase A possible — "exact total duration,
working scrubber, complete highlight map, correct seek, with no audio
generated" — and word-level highlighting rests on the per-token durations it
returns.

The ONNX export published for the web is one graph with one output, `waveform`.
The duration predictor is still in there; it is just not something an ONNX
Runtime session will hand back, because only graph outputs can be fetched.

So: find the tensor inside the graph that carries the durations, and cut a
subgraph that ends at it. That subgraph is §7.2's prosody pass, it runs in a
fraction of a render, and PolyRead uses it automatically the moment it exists.

## How it identifies the right tensor

Not by name — names differ between exports and guessing one wrong is the exact
failure mode the spec warns about, a highlight that drifts for reasons that look
like a timing bug. Instead it is *measured*: the full model is run once to get a
waveform, which fixes the frame count exactly (one frame is 600 samples at
24 kHz). Every intermediate float tensor is then promoted to a graph output and
the model run again, and the durations are whichever tensor has one entry per
input token and whose rounded entries sum to that frame count. That is a strong
enough coincidence test that a false positive is not a practical worry, and it
cannot be fooled by a rename.

## Use

    python3 -m pip install onnx onnxruntime numpy
    python3 scripts/make-duration-model.py public/models/kokoro.onnx

Writes public/models/kokoro-duration.onnx, which the app's default settings
already point at. Nothing else needs changing; the reader stops saying its
timings are estimated the next time a document is imported.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SAMPLES_PER_FRAME = 600
STYLE_DIMENSION = 256


def fail(message: str) -> "NoReturn":  # type: ignore[valid-type]
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


try:
    import numpy as np
    import onnx
    import onnxruntime as ort
except ImportError as exc:  # pragma: no cover - a setup problem, not a code path
    fail(f"{exc}. Install the dependencies first:\n  python3 -m pip install onnx onnxruntime numpy")


def load_style(voices_dir: Path, phoneme_count: int) -> "np.ndarray":
    """One row of a voice's style table. §7.1: the row index is the phoneme count."""
    candidates = sorted(voices_dir.glob("*.bin")) if voices_dir.is_dir() else []
    if not candidates:
        print(f"note: no voice files in {voices_dir}; probing with a zero style vector")
        return np.zeros((1, STYLE_DIMENSION), dtype=np.float32)
    table = np.fromfile(candidates[0], dtype=np.float32)
    rows = table.size // STYLE_DIMENSION
    row = min(max(phoneme_count, 0), rows - 1)
    start = row * STYLE_DIMENSION
    return table[start : start + STYLE_DIMENSION].reshape(1, STYLE_DIMENSION).astype(np.float32)


def probe_tokens(count: int) -> list[int]:
    """A plausible phoneme sequence, framed by §7.1's boundary zeros."""
    # Ids 69-150 are the IPA run of the vocabulary; anything in it is a real
    # phoneme, which is all the duration predictor needs to behave normally.
    body = [69 + (i * 7) % 80 for i in range(count)]
    return [0, *body, 0]


def session_for(model_bytes: bytes) -> "ort.InferenceSession":
    options = ort.SessionOptions()
    # Promoting intermediates to outputs only works if the optimizer has not
    # fused them away first.
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    options.log_severity_level = 3
    return ort.InferenceSession(model_bytes, options, providers=["CPUExecutionProvider"])


def build_feeds(session: "ort.InferenceSession", tokens: list[int], style: "np.ndarray") -> dict:
    feeds = {}
    for meta in session.get_inputs():
        name = meta.name
        lowered = name.lower()
        if "int" in str(meta.type):
            dtype = np.int64 if "int64" in str(meta.type) else np.int32
            feeds[name] = np.array([tokens], dtype=dtype)
        elif lowered in {"speed", "rate", "alpha"}:
            feeds[name] = np.array([1.0], dtype=np.float32)
        else:
            feeds[name] = style
    return feeds


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("model", type=Path, help="the full Kokoro .onnx file")
    parser.add_argument("-o", "--output", type=Path, help="where to write the duration model")
    parser.add_argument("--voices", type=Path, help="folder of <voice>.bin files, for a realistic probe")
    parser.add_argument("--tokens", type=int, default=96, help="probe length in phonemes (default 96)")
    parser.add_argument("--batch", type=int, default=256, help="intermediates promoted per pass")
    args = parser.parse_args()

    model_path: Path = args.model
    if not model_path.is_file():
        fail(f"{model_path} does not exist. Run `npm run assets` first.")

    output_path: Path = args.output or model_path.with_name("kokoro-duration.onnx")
    voices_dir: Path = args.voices or (model_path.parent / "voices")

    tokens = probe_tokens(args.tokens)
    phoneme_count = len(tokens) - 2
    style = load_style(voices_dir, phoneme_count)

    print(f"Loading {model_path} ({model_path.stat().st_size / 1024**2:.0f} MB)…")
    model = onnx.load(str(model_path))

    # Step 1: what does the full graph actually produce?
    print("Running the full model once to fix the frame count…")
    baseline = session_for(model.SerializeToString())
    feeds = build_feeds(baseline, tokens, style)
    outputs = baseline.run(None, feeds)
    waveform = max(outputs, key=lambda a: a.size)
    if waveform.size % SAMPLES_PER_FRAME != 0:
        print(
            f"note: the waveform is {waveform.size} samples, not a whole number of "
            f"{SAMPLES_PER_FRAME}-sample frames; matching to the nearest frame"
        )
    target_frames = round(waveform.size / SAMPLES_PER_FRAME)
    print(f"  waveform: {waveform.size} samples = {target_frames} frames = {waveform.size / 24000:.2f} s")

    # Step 2: promote intermediates and look for the tensor that explains it.
    try:
        inferred = onnx.shape_inference.infer_shapes(model, strict_mode=False)
        value_info = list(inferred.graph.value_info)
    except Exception:  # noqa: BLE001 - shape inference is best-effort here
        value_info = list(model.graph.value_info)

    if not value_info:
        fail(
            "the graph carries no intermediate value_info, so there is nothing to search. "
            "Re-export the model with shape inference, or pass the duration tensor name by hand."
        )

    existing_outputs = {o.name for o in model.graph.output}
    candidates = [vi.name for vi in value_info if vi.name not in existing_outputs]
    print(f"Searching {len(candidates)} intermediate tensors for one that sums to {target_frames} frames…")

    found: str | None = None
    for start in range(0, len(candidates), args.batch):
        batch = candidates[start : start + args.batch]
        probe = onnx.load(str(model_path))
        by_name = {vi.name: vi for vi in value_info}
        for name in batch:
            probe.graph.output.append(by_name[name])
        try:
            session = session_for(probe.SerializeToString())
        except Exception as exc:  # noqa: BLE001 - a batch that will not load is skipped
            print(f"  [{start}-{start + len(batch)}) would not load ({type(exc).__name__}); skipping")
            continue

        names = [o.name for o in session.get_outputs()]
        try:
            values = session.run(None, build_feeds(session, tokens, style))
        except Exception as exc:  # noqa: BLE001
            print(f"  [{start}-{start + len(batch)}) would not run ({type(exc).__name__}); skipping")
            continue

        for name, value in zip(names, values):
            if name not in batch:
                continue
            match = matches_duration(value, len(tokens), target_frames)
            if match:
                found = name
                print(f"  match: {name}  shape={value.shape}  sum={match}")
                break
        if found:
            break

    if not found:
        fail(
            "no intermediate tensor had one entry per token summing to the waveform's frame count.\n"
            "This export may compute durations in a form this script does not recognize. "
            "The app still works; its word timings stay estimated."
        )

    # Step 3: cut the subgraph and check it against the full model.
    input_names = [i.name for i in baseline.get_inputs()]
    print(f"Extracting {input_names} -> [{found}]…")
    onnx.utils.extract_model(str(model_path), str(output_path), input_names, [found])

    print("Verifying…")
    check = ort.InferenceSession(str(output_path), providers=["CPUExecutionProvider"])
    for count in (32, 96, 200):
        probe = probe_tokens(count)
        probe_style = load_style(voices_dir, count)
        durations = check.run(None, build_feeds(check, probe, probe_style))[0]
        frames = int(np.maximum(1, np.round(np.asarray(durations).reshape(-1))).sum())

        full = baseline.run(None, build_feeds(baseline, probe, probe_style))
        audio = max(full, key=lambda a: a.size)
        expected = round(audio.size / SAMPLES_PER_FRAME)
        drift = frames - expected
        status = "ok" if abs(drift) <= 1 else f"OFF BY {drift}"
        print(f"  {count:>3} phonemes: duration model {frames} frames, model {expected} frames — {status}")
        if abs(drift) > 1:
            fail("the extracted model disagrees with the full model; not writing a manifest")

    manifest = output_path.with_suffix(".json")
    manifest.write_text(
        json.dumps(
            {
                "source": os.fspath(model_path),
                "durationTensor": found,
                "inputs": input_names,
                "samplesPerFrame": SAMPLES_PER_FRAME,
            },
            indent=2,
        )
        + "\n"
    )

    size = output_path.stat().st_size / 1024**2
    print(f"\nWrote {output_path} ({size:.1f} MB) and {manifest.name}.")
    print("PolyRead's default settings already point at it. Re-import a document and the")
    print("reader will stop calling its timings estimated.")


def matches_duration(value, token_count: int, target_frames: int):
    """One entry per input token, and the rounded entries sum to the frame count."""
    array = np.asarray(value)
    if array.dtype.kind != "f":
        return None
    flat = array.reshape(-1)
    if flat.size != token_count:
        return None
    if not np.all(np.isfinite(flat)) or np.any(flat < 0):
        return None
    total = int(np.maximum(1, np.round(flat)).sum())
    # One frame of slack: the export may clamp or floor where we round.
    if abs(total - target_frames) <= 1:
        return total
    return None


if __name__ == "__main__":
    main()
