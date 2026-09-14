#!/usr/bin/env python3
"""
Builds a fake Kokoro: same interface, nonsense audio.

The real model is a ~170 MB download, which is a lot to ask of anyone who only
wants to change the scrubber. This writes a few kilobytes of ONNX with exactly
the interface `src/synthesis/kokoroEngine.ts` expects — `input_ids`, `style`,
`speed` in; `waveform` out — plus the duration-only companion that
`make-duration-model.py` would normally cut from the real graph, and a voice
file of the right shape.

What comes out is a tone, not speech. Everything around it is real: the session
loading, the tensor types, the style-row lookup, the frame arithmetic, the audio
store, the time stretcher and the highlight all run exactly as they do with the
real weights. So the pipeline can be exercised end to end, and only the sound is
a lie.

    python3 -m pip install onnx numpy
    python3 scripts/make-test-model.py public/models

Then start the app as usual. It will say its timings are exact, because with the
companion model they are.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

SAMPLES_PER_FRAME = 600
STYLE_DIMENSION = 256
VOICE_ROWS = 510
# Every token is worth exactly one frame, so the two models agree by
# construction — which is the property the real pair has to be checked for.
FRAMES_PER_TOKEN = 1


def const(name: str, array: np.ndarray):
    return helper.make_node("Constant", [], [name], value=numpy_helper.from_array(array, name))


def waveform_model() -> onnx.ModelProto:
    input_ids = helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, "n"])
    style = helper.make_tensor_value_info("style", TensorProto.FLOAT, [1, STYLE_DIMENSION])
    speed = helper.make_tensor_value_info("speed", TensorProto.FLOAT, [1])
    waveform = helper.make_tensor_value_info("waveform", TensorProto.FLOAT, [1, "samples"])

    nodes = [
        const("axis2", np.array([2], dtype=np.int64)),
        const("repeats", np.array([1, 1, SAMPLES_PER_FRAME * FRAMES_PER_TOKEN], dtype=np.int64)),
        const("flat_shape", np.array([1, -1], dtype=np.int64)),
        const("pitch", np.array([0.31], dtype=np.float32)),
        const("gain", np.array([0.25], dtype=np.float32)),
        helper.make_node("Cast", ["input_ids"], ["as_float"], to=TensorProto.FLOAT),
        helper.make_node("Unsqueeze", ["as_float", "axis2"], ["column"]),
        helper.make_node("Tile", ["column", "repeats"], ["held"]),
        helper.make_node("Reshape", ["held", "flat_shape"], ["ramp"]),
        # A tone whose pitch follows the token id, so a wrong style row or a
        # mis-sized tensor is audible rather than silent.
        helper.make_node("Mul", ["ramp", "pitch"], ["phase"]),
        helper.make_node("Sin", ["phase"], ["tone"]),
        helper.make_node("Mul", ["tone", "gain"], ["quiet"]),
        # `style` and `speed` have to be consumed, or ORT prunes them and the
        # engine's input resolution has nothing to find.
        helper.make_node("ReduceMean", ["style"], ["style_mean"], keepdims=0),
        helper.make_node("Mul", ["style_mean", "gain"], ["style_trim"]),
        helper.make_node("Add", ["quiet", "style_trim"], ["voiced"]),
        helper.make_node("Mul", ["voiced", "speed"], ["waveform"]),
    ]

    graph = helper.make_graph(nodes, "fake_kokoro", [input_ids, style, speed], [waveform])
    model = helper.make_model(graph, opset_imports=[helper.make_operatorsetid("", 18)])
    model.ir_version = 9
    onnx.checker.check_model(model)
    return model


def duration_model() -> onnx.ModelProto:
    input_ids = helper.make_tensor_value_info("input_ids", TensorProto.INT64, [1, "n"])
    style = helper.make_tensor_value_info("style", TensorProto.FLOAT, [1, STYLE_DIMENSION])
    speed = helper.make_tensor_value_info("speed", TensorProto.FLOAT, [1])
    duration = helper.make_tensor_value_info("duration", TensorProto.FLOAT, [1, "n"])

    nodes = [
        const("zero", np.array([0.0], dtype=np.float32)),
        const("per_token", np.array([float(FRAMES_PER_TOKEN)], dtype=np.float32)),
        helper.make_node("Cast", ["input_ids"], ["as_float"], to=TensorProto.FLOAT),
        helper.make_node("Mul", ["as_float", "zero"], ["zeroed"]),
        helper.make_node("Add", ["zeroed", "per_token"], ["flat"]),
        helper.make_node("ReduceMean", ["style"], ["style_mean"], keepdims=0),
        helper.make_node("Mul", ["style_mean", "zero"], ["style_zero"]),
        helper.make_node("Add", ["flat", "style_zero"], ["with_style"]),
        helper.make_node("Mul", ["speed", "zero"], ["speed_zero"]),
        helper.make_node("Add", ["with_style", "speed_zero"], ["duration"]),
    ]

    graph = helper.make_graph(nodes, "fake_kokoro_duration", [input_ids, style, speed], [duration])
    model = helper.make_model(graph, opset_imports=[helper.make_operatorsetid("", 18)])
    model.ir_version = 9
    onnx.checker.check_model(model)
    return model


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "public/models")
    (out / "voices").mkdir(parents=True, exist_ok=True)

    onnx.save(waveform_model(), out / "kokoro.onnx")
    onnx.save(duration_model(), out / "kokoro-duration.onnx")

    # §7.1's style table: 510 rows of 256, one row per phoneme count.
    rng = np.random.default_rng(7)
    table = (rng.standard_normal((VOICE_ROWS, STYLE_DIMENSION)) * 0.05).astype(np.float32)
    for name in ("af_heart", "af_bella"):
        (out / "voices" / f"{name}.bin").write_bytes(table.tobytes())

    print(f"wrote {out}/kokoro.onnx, {out}/kokoro-duration.onnx and 2 voices")
    print("These are a tone generator with Kokoro's interface. Delete them and run")
    print("`npm run assets` when you want it to sound like a person.")


if __name__ == "__main__":
    main()
