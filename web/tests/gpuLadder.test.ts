import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ladder, driven end to end against a fake runtime.
 *
 * The unit tests next door pin the *shape* of the plan. This one pins what the
 * plan is for: that a GPU refusing the model moves to the next GPU rather than
 * to the CPU, that the CPU is reached only when every GPU rung is gone, and
 * that reaching it is never silent — which was the reported bug's real sting,
 * since "synthesis runs on the CPU" is a different app and the person has to
 * be told.
 */

/** What the fake `InferenceSession.create` should do, per provider. */
const runtime = {
  webgpuFailsWith: undefined as string | undefined,
  /** Optimization levels at which WebGPU works anyway, e.g. unfused. */
  webgpuWorksWhenOptimization: undefined as string | undefined,
  /** Model file size at which WebGPU works anyway — stands in for "fp32". */
  webgpuWorksWhenBytes: undefined as number | undefined,
  created: [] as Array<{ provider: string; optimization: string; bytes: number }>,
};

function fakeSession() {
  return {
    inputNames: ["input_ids", "style", "speed"],
    inputMetadata: [
      { isTensor: true, type: "int64", shape: [1, -1] },
      { isTensor: true, type: "float32", shape: [1, 256] },
      { isTensor: true, type: "float32", shape: [1] },
    ],
    outputNames: ["waveform"],
    outputMetadata: [{ isTensor: true, type: "float32", shape: [1, -1] }],
    run: () => Promise.resolve({ waveform: { data: new Float32Array(2400), type: "float32" } }),
    release: () => Promise.resolve(),
  };
}

vi.mock("onnxruntime-web/webgpu", () => ({
  env: { wasm: { numThreads: 1, proxy: false }, webgpu: {}, logLevel: "error" },
  Tensor: class {
    constructor(
      readonly type: string,
      readonly data: unknown,
      readonly dims: number[],
    ) {}
  },
  InferenceSession: {
    create: (bytes: Uint8Array, options: { executionProviders: unknown[]; graphOptimizationLevel: string }) => {
      const first = options.executionProviders[0] as string | { name: string };
      const provider = typeof first === "string" ? first : first.name;
      runtime.created.push({ provider, optimization: options.graphOptimizationLevel, bytes: bytes.length });
      if (provider === "webgpu" && runtime.webgpuFailsWith) {
        const excused =
          options.graphOptimizationLevel === runtime.webgpuWorksWhenOptimization ||
          bytes.length === runtime.webgpuWorksWhenBytes;
        if (!excused) return Promise.reject(new Error(runtime.webgpuFailsWith));
      }
      return Promise.resolve(fakeSession());
    },
  },
}));

const VOICE_BYTES = 510 * 256 * 4;
/** Distinct sizes so a rung can be identified by the file it loaded. */
const PRIMARY_MODEL_BYTES = 1024;
const GPU_MODEL_BYTES = 2048;

/** One GPU, with or without 16-bit shader support. */
function stubNavigator(adapters: Array<{ description: string; vendor: string; features: string[] }>) {
  let index = 0;
  const adapterFor = () => {
    const spec = adapters[Math.min(index, adapters.length - 1)];
    if (!spec) return null;
    return {
      features: { has: (f: string) => spec.features.includes(f) },
      limits: { maxBufferSize: 2 ** 31 },
      info: { vendor: spec.vendor, device: spec.description },
      requestDevice: (descriptor?: { requiredFeatures?: string[] }) => {
        const wanted = descriptor?.requiredFeatures ?? [];
        if (wanted.some((f) => !spec.features.includes(f))) return Promise.reject(new Error("unsupported"));
        return Promise.resolve({
          features: { has: (f: string) => wanted.includes(f) },
          limits: { maxBufferSize: 2 ** 31 },
          lost: new Promise(() => {}),
          destroy: () => {},
          addEventListener: () => {},
        });
      },
    };
  };

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      hardwareConcurrency: 8,
      gpu: {
        requestAdapter: (options?: { powerPreference?: string }) => {
          // "high-performance" gets the first adapter, everything else the last.
          index = options?.powerPreference === "high-performance" ? 0 : adapters.length - 1;
          return Promise.resolve(adapterFor());
        },
      },
    },
  });
}

/** Model and voice files, served from memory. */
function stubFetch(present: (url: string) => boolean) {
  vi.stubGlobal("fetch", (url: string) => {
    if (!present(url)) {
      return Promise.resolve({ ok: false, status: 404, headers: new Headers(), body: null });
    }
    const bytes = url.endsWith(".bin")
      ? new Uint8Array(VOICE_BYTES)
      : new Uint8Array(url.includes("kokoro-gpu") ? GPU_MODEL_BYTES : PRIMARY_MODEL_BYTES);
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
      arrayBuffer: () => Promise.resolve(bytes.buffer),
    });
  });
}

const config = {
  modelUrl: "models/kokoro.onnx",
  voicesBaseUrl: "models/voices",
  voiceID: "af_heart",
};

beforeEach(() => {
  runtime.webgpuFailsWith = undefined;
  runtime.webgpuWorksWhenOptimization = undefined;
  runtime.webgpuWorksWhenBytes = undefined;
  runtime.created = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "navigator");
});

describe("running on the GPU, always", () => {
  const CLIP = "Failed to create a WebGPU compute pipeline: ShaderModule with 'Clip' label is invalid";

  it("uses the discrete GPU when there is one", async () => {
    stubNavigator([
      { description: "RTX 3050", vendor: "nvidia", features: ["shader-f16"] },
      { description: "Iris Xe", vendor: "intel", features: ["shader-f16"] },
    ]);
    stubFetch(() => true);
    const { KokoroEngine } = await import("../src/synthesis/kokoroEngine");
    const { defaultVocabulary } = await import("../src/linguistics/vocabulary");

    const engine = await KokoroEngine.load(config, defaultVocabulary);
    expect(engine.device).toBe("webgpu");
    expect(engine.deviceDetail).toContain("RTX 3050");
    // Asked for, and granted — which is the difference between a shader that
    // compiles for an fp16 model and the reported "'Clip' label is invalid".
    expect(engine.deviceDetail).toContain("shader-f16");
    expect(engine.adapter?.klass).toBe("discrete");
  });

  it("tries the second GPU before it tries the CPU", async () => {
    stubNavigator([
      { description: "RTX 3050", vendor: "nvidia", features: ["shader-f16"] },
      { description: "Iris Xe", vendor: "intel", features: ["shader-f16"] },
    ]);
    stubFetch(() => true);
    // Both GPUs refuse, and only the unfused rung works — so the ladder must
    // get through four WebGPU attempts before the CPU is even considered.
    runtime.webgpuFailsWith = CLIP;
    runtime.webgpuWorksWhenOptimization = "disabled";

    const { KokoroEngine } = await import("../src/synthesis/kokoroEngine");
    const { defaultVocabulary } = await import("../src/linguistics/vocabulary");
    const engine = await KokoroEngine.load(config, defaultVocabulary);

    expect(engine.device).toBe("webgpu");
    expect(runtime.created.map((c) => c.provider)).toEqual(["webgpu", "webgpu", "webgpu"]);
    expect(runtime.created.at(-1)?.optimization).toBe("disabled");
    expect(engine.attempts.join(" ")).toContain("graph fusions off");
  });

  it("loads the GPU-compatible model rather than dropping to the CPU", async () => {
    stubNavigator([{ description: "Iris Xe", vendor: "intel", features: [] }]);
    stubFetch(() => true);
    runtime.webgpuFailsWith = CLIP;

    // The GPU refuses the fp16 model in every configuration, and accepts the
    // fp32 spare. That is the real shape of the reported failure, and the rung
    // that answers it is the last one before the CPU.
    runtime.webgpuWorksWhenBytes = GPU_MODEL_BYTES;

    const { KokoroEngine } = await import("../src/synthesis/kokoroEngine");
    const { defaultVocabulary } = await import("../src/linguistics/vocabulary");
    const rejected: string[] = [];
    const engine = await KokoroEngine.load(
      { ...config, gpuFallbackModelUrl: "models/kokoro-gpu.onnx" },
      defaultVocabulary,
      { onProviderRejected: (_p, reason) => rejected.push(reason) },
    );

    expect(engine.device).toBe("webgpu");
    // Three WebGPU rungs: the fp16 model fused, the same unfused, then the
    // fp32 spare — and no CPU rung reached, so nothing to report.
    expect(runtime.created.map((c) => c.bytes)).toEqual([
      PRIMARY_MODEL_BYTES,
      PRIMARY_MODEL_BYTES,
      GPU_MODEL_BYTES,
    ]);
    expect(engine.attempts.at(-1)).toContain("GPU-compatible model");
    expect(rejected).toEqual([]);
  });

  it("says so, loudly, when it does end up on the CPU", async () => {
    stubNavigator([{ description: "Iris Xe", vendor: "intel", features: [] }]);
    // No GPU-compatible spare has been fetched: the rung is skipped rather than
    // failed, which is exactly the path that used to reach the CPU in silence.
    stubFetch((url) => !url.includes("kokoro-gpu"));
    runtime.webgpuFailsWith = CLIP;

    const { KokoroEngine } = await import("../src/synthesis/kokoroEngine");
    const { defaultVocabulary } = await import("../src/linguistics/vocabulary");
    const rejected: string[] = [];
    const engine = await KokoroEngine.load(
      { ...config, gpuFallbackModelUrl: "models/kokoro-gpu.onnx" },
      defaultVocabulary,
      { onProviderRejected: (_p, reason) => rejected.push(reason) },
    );

    expect(engine.device).toBe("wasm");
    expect(rejected).toHaveLength(1);
    // The GPU has no 16-bit shaders, so the message has to name the remedy —
    // a model file, not a GPU — rather than quoting a shader called Clip.
    expect(rejected[0]).toContain("Iris Xe");
    expect(rejected[0]).toContain("--gpu-fallback");
  });

  it("refuses to run at all when Settings says GPU only", async () => {
    stubNavigator([{ description: "Iris Xe", vendor: "intel", features: ["shader-f16"] }]);
    stubFetch(() => true);
    runtime.webgpuFailsWith = CLIP;

    const { KokoroEngine } = await import("../src/synthesis/kokoroEngine");
    const { defaultVocabulary } = await import("../src/linguistics/vocabulary");

    await expect(
      KokoroEngine.load({ ...config, device: "webgpu" }, defaultVocabulary),
    ).rejects.toThrow(/no GPU on this machine would run the model/i);
    expect(runtime.created.every((c) => c.provider === "webgpu")).toBe(true);
  });
});
