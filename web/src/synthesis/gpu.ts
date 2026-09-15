/**
 * Which GPU runs the model, and a device that can actually run it.
 *
 * ## Why this file exists
 *
 * PolyRead used to pick its adapter like this:
 *
 * ```ts
 * ort.env.webgpu.adapter = chosenAdapter;
 * ort.env.webgpu.powerPreference = "high-performance";
 * ```
 *
 * Neither line did anything. In `onnxruntime-web@1.30`'s WebGPU build — the
 * native execution provider, the one whose errors name
 * `core/providers/webgpu/buffer_manager.cc` — the backend's init reads
 * `env.webgpu.adapter`, type-checks it, requests an adapter itself when it is
 * unset, and then *drops the result on the floor*. Dawn, compiled into the
 * wasm alongside the runtime, goes and asks `navigator.gpu` for its own adapter
 * with its own options and creates its own device with its own feature set.
 * `env.webgpu.adapter` is read in exactly one place in that bundle and it is
 * that discarded probe.
 *
 * Two consequences, and they are the whole bug report:
 *
 *  1. **The adapter choice never took effect.** On a laptop with an RTX and an
 *     Iris Xe, Dawn's own `requestAdapter()` gets the integrated one, so the
 *     careful scoring in this file's predecessor chose an RTX that was never
 *     used. The reported adapter and the adapter that refused the model were
 *     not the same device, which is why the error said the GPU "reports 16-bit
 *     shader support but still refused the model": it was reporting the RTX's
 *     features and Iris Xe's failure.
 *
 *  2. **The device's feature set was nobody's choice.** ONNX Runtime emits
 *     `enable f16;` into its WGSL if and only if *the device it was given* has
 *     `shader-f16`, and then generates `f16` arithmetic for an fp16 model
 *     regardless. A device created without the feature therefore fails to
 *     compile every shader in the graph, and reports the first one it tried —
 *     `ShaderModule with 'Clip' label is invalid`. Nothing to do with Clip.
 *
 * The supported way to control both, and the one this file uses, is the
 * per-session execution-provider option: `{ name: "webgpu", device }`, which
 * ORT hands to `webgpuRegisterDevice` and passes into the native provider as
 * `deviceId`/`webgpuInstance`/`webgpuDevice`. We create the device, so we
 * choose the adapter *and* the features *and* the limits.
 *
 * ## The limits matter too
 *
 * A `GPUDevice` created with no `requiredLimits` gets the spec's defaults, not
 * the hardware's: 256 MiB `maxBufferSize` and 128 MiB `maxStorageBufferBindingSize`
 * on a card with 8 GiB of VRAM. Kokoro's larger intermediates land on the wrong
 * side of that, and the failure surfaces from `BufferManager::Create` — which
 * is the other half of the reported error. So a device is asked for everything
 * its adapter says it can do.
 */

/**
 * The WebGPU types come from `lib.dom` / `lib.webworker`, which carry them as
 * of TypeScript 7 — so `GPUAdapter`, `GPUDevice` and the rest below are the
 * real ones, and so is the `device` this file hands to ONNX Runtime, whose own
 * option type resolves to the same global.
 *
 * `navigator.gpu` is still optional at runtime: an old browser, a hardened
 * profile, or a GPU process that failed to start all leave it undefined.
 */
export interface GpuRequestOptions {
  powerPreference?: GPUPowerPreference;
  forceFallbackAdapter?: boolean;
}

/**
 * What kind of hardware an adapter is.
 *
 * WebGPU has no field for this — `GPUAdapterInfo` carries vendor, architecture,
 * device and description and nothing that says "discrete" — so it is inferred
 * below. It is inferred rather than ignored because it is the entire point of
 * the exercise: on the machines this app runs on, choosing the discrete GPU
 * over the integrated one is most of the difference between synthesis that
 * outruns playback and synthesis that does not.
 */
export type GpuClass = "discrete" | "integrated" | "software" | "unknown";

/** What the chosen adapter is, and what it can do. Reported in Settings. */
export interface AdapterReport {
  /** Vendor and device as the browser describes them. */
  description: string;
  vendor: string;
  architecture: string;
  klass: GpuClass;
  /**
   * Whether the driver exposes 16-bit shader arithmetic.
   *
   * ONNX Runtime emits `enable f16;` only when the *device* has `shader-f16`,
   * and then generates `f16` WGSL for an fp16 model regardless — so without it
   * every shader it compiles is invalid, and the first one compiled is the one
   * named in the error. That is what `ShaderModule with 'Clip' label is
   * invalid` means: not a problem with Clip.
   *
   * Which is why `acquireDevice` requires the feature rather than hoping for
   * it, and why an adapter without it is ranked below one with it.
   */
  shaderF16: boolean;
  subgroups: boolean;
  powerPreference: "high-performance" | "low-power" | "default";
  isFallback: boolean;
}

/**
 * An adapter worth trying, identified by *how to ask for it again* rather than
 * by the object itself.
 *
 * `GPUAdapter.requestDevice()` expires its adapter whether it succeeds or
 * fails, so a second attempt with a different descriptor — which is exactly
 * what `acquireDevice` does when the first descriptor is refused — needs a
 * fresh adapter. Keeping the request options is what makes that possible.
 */
export interface GpuCandidate {
  request: GpuRequestOptions;
  report: AdapterReport;
}

/** PCI vendor ids, for the browsers that report a number instead of a name. */
const VENDOR_IDS: Record<string, string> = {
  "0x10de": "nvidia",
  "0x1002": "amd",
  "0x1022": "amd",
  "0x8086": "intel",
  "0x106b": "apple",
  "0x5143": "qualcomm",
  "0x13b5": "arm",
  "0x1414": "microsoft",
};

function normalizeVendor(raw: string | undefined): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "";
  return VENDOR_IDS[value] ?? value;
}

/**
 * Discrete, integrated, or a software rasterizer pretending to be a GPU.
 *
 * The heuristics are deliberately conservative: an adapter that cannot be
 * classified is `"unknown"` and still ranks above everything integrated,
 * because an unrecognized GPU on a machine that also reports an Intel iGPU is
 * far more likely to be the discrete card than not.
 */
export function classifyAdapter(info: Partial<GPUAdapterInfo>, isFallback: boolean): GpuClass {
  const vendor = normalizeVendor(info.vendor);
  const text = [info.architecture, info.device, info.description].join(" ").toLowerCase();

  if (isFallback) return "software";
  // SwiftShader, lavapipe, llvmpipe, WARP. These are the CPU wearing a GPU's
  // clothes, and slower at this model than the CPU backend is.
  if (/swiftshader|lavapipe|llvmpipe|softpipe|basic render|warp|microsoft basic/.test(text)) return "software";
  if (vendor === "microsoft") return "software";

  if (vendor === "nvidia") {
    // Tegra is the one NVIDIA part that is an integrated GPU.
    return /tegra/.test(text) ? "integrated" : "discrete";
  }
  if (vendor === "intel") {
    // Arc is Intel's discrete line; everything else Intel makes is on the die.
    return /\barc\b|dg[12]|alchemist|battlemage/.test(text) ? "discrete" : "integrated";
  }
  if (vendor === "amd") {
    // AMD's APUs report as "Radeon Graphics" / "Radeon Vega Graphics" with no
    // model number, or name the APU family outright.
    if (/radeon\s+(r[2-7]\s+)?(vega\s+)?graphics\b|\bvega\s+\d+\b|renoir|cezanne|rembrandt|phoenix|raphael|barcelo|lucienne|picasso|strix/.test(text)) {
      return "integrated";
    }
    return "discrete";
  }
  // Apple silicon, Mali, Adreno, PowerVR: unified memory, one GPU, and it is
  // the fast one. Calling it integrated is accurate and costs nothing, since
  // there is nothing to rank it against.
  if (vendor === "apple" || vendor === "arm" || vendor === "qualcomm" || vendor === "imagination") {
    return "integrated";
  }
  return "unknown";
}

/**
 * Ranking, best first.
 *
 * In order of what actually decides whether this app is usable:
 *
 *  1. **Can it run an fp16 model at all** (`shader-f16`). An adapter without it
 *     cannot run the default model no matter how fast it is.
 *  2. **Is it the discrete GPU.** NVIDIA first among equals, as asked for, then
 *     anything else discrete, then an unclassified adapter, then the iGPU.
 *  3. **Which power preference produced it**, as a tiebreak between what are
 *     usually two handles on the same silicon.
 *
 * Software adapters are excluded before ranking — see `probeAdapters`.
 */
function rank(report: AdapterReport): number {
  const klass = { discrete: 0, unknown: 1, integrated: 2, software: 3 }[report.klass];
  const nvidia = normalizeVendor(report.vendor) === "nvidia" ? 0 : 1;
  const f16 = report.shaderF16 ? 0 : 1;
  const preference = report.powerPreference === "high-performance" ? 0 : report.powerPreference === "default" ? 1 : 2;
  // f16 outranks everything: it is a yes/no on running the model, not a speed.
  return f16 * 1000 + klass * 100 + nvidia * 10 + preference;
}

/**
 * `GPUAdapter.info` is the current spelling; `requestAdapterInfo()` was the
 * previous one and `isFallbackAdapter` used to live on the adapter rather than
 * on its info. Chromium of the vintage Electron ships has all three at various
 * points, and a build that has only the old ones would otherwise describe every
 * GPU as "unnamed adapter" — which is exactly what the reported error did.
 */
interface LegacyAdapter {
  requestAdapterInfo?: () => Promise<GPUAdapterInfo | undefined>;
  isFallbackAdapter?: boolean;
}

async function describeAdapter(
  adapter: GPUAdapter,
  powerPreference: AdapterReport["powerPreference"],
): Promise<AdapterReport> {
  const legacy = adapter as unknown as LegacyAdapter;
  const info =
    adapter.info ?? (await legacy.requestAdapterInfo?.().catch(() => undefined)) ?? ({} as GPUAdapterInfo);
  const isFallback = legacy.isFallbackAdapter === true || info.isFallbackAdapter === true;
  const described = [info.vendor, info.architecture, info.device, info.description]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");

  return {
    description: described || "unnamed adapter",
    vendor: normalizeVendor(info.vendor),
    architecture: (info.architecture ?? "").toLowerCase(),
    klass: classifyAdapter(info, isFallback),
    shaderF16: adapter.features.has("shader-f16"),
    subgroups: adapter.features.has("subgroups"),
    powerPreference,
    isFallback,
  };
}

/** Two handles on the same silicon, as far as anything here can tell. */
function sameHardware(a: AdapterReport, b: AdapterReport): boolean {
  return a.description === b.description && a.vendor === b.vendor && a.shaderF16 === b.shaderF16;
}

/**
 * Every distinct GPU this machine will hand out, ranked.
 *
 * WebGPU has no enumeration API — `requestAdapter` is the only door — so the
 * three request shapes a browser distinguishes are asked in turn and the
 * answers deduplicated. On a single-GPU machine that is one adapter reported
 * three times; on a laptop with switchable graphics it is two.
 *
 * Software adapters are dropped rather than ranked last. A WebGPU fallback
 * adapter is a CPU rasterizer, and Kokoro on SwiftShader is slower than Kokoro
 * on the multi-threaded wasm backend — so putting one ahead of the CPU backend
 * would be choosing "a GPU" over "the fastest thing available", which is not
 * what wanting the GPU means.
 */
export async function probeAdapters(gpu: GPU | undefined): Promise<GpuCandidate[]> {
  if (!gpu?.requestAdapter) return [];

  const requests: Array<{ request: GpuRequestOptions; powerPreference: AdapterReport["powerPreference"] }> = [
    { request: { powerPreference: "high-performance" }, powerPreference: "high-performance" },
    { request: {}, powerPreference: "default" },
    { request: { powerPreference: "low-power" }, powerPreference: "low-power" },
  ];

  const found: GpuCandidate[] = [];
  for (const { request, powerPreference } of requests) {
    try {
      const adapter = await gpu.requestAdapter(request);
      if (!adapter) continue;
      const report = await describeAdapter(adapter, powerPreference);
      if (report.klass === "software") continue;
      if (found.some((candidate) => sameHardware(candidate.report, report))) continue;
      found.push({ request, report });
    } catch {
      // An adapter that cannot be requested is one fewer candidate, not a failure.
    }
  }

  return found.sort((a, b) => rank(a.report) - rank(b.report));
}

/**
 * The limits worth raising from the spec's defaults to the hardware's.
 *
 * Every one of these is a ceiling ONNX Runtime runs into on a real model: the
 * first four decide how large a single tensor may be, and the rest decide how
 * a kernel may be dispatched. Asking for the adapter's own value is always
 * valid — it is by definition supported — and the ladder in `acquireDevice`
 * falls back to the defaults if a driver disagrees anyway.
 */
const WANTED_LIMITS = [
  "maxBufferSize",
  "maxStorageBufferBindingSize",
  "maxUniformBufferBindingSize",
  "maxStorageBuffersPerShaderStage",
  "maxBindGroups",
  "maxBindingsPerBindGroup",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY",
  "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupsPerDimension",
] as const;

function limitsFrom(adapter: GPUAdapter): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const name of WANTED_LIMITS) {
    const value = adapter.limits?.[name];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) limits[name] = value;
  }
  return limits;
}

export interface AcquiredDevice {
  device: GPUDevice;
  report: AdapterReport;
  /** What was asked for and granted, for the benchmark screen. */
  features: string[];
  maxBufferMB: number;
}

/**
 * A device on this candidate's hardware, with the features the model needs.
 *
 * The descriptors are tried in order of how much they ask for. A driver that
 * refuses the whole set still gets a chance to grant the one feature that
 * decides whether an fp16 model can run at all, and the run after that asks
 * for nothing but a device — at which point failing means the GPU is genuinely
 * unavailable rather than merely fussy.
 *
 * Each rung requests its own adapter, because `requestDevice` expires the
 * adapter it was called on whether or not it succeeded.
 */
export async function acquireDevice(
  gpu: GPU | undefined,
  candidate: GpuCandidate,
  onLost?: (message: string) => void,
): Promise<AcquiredDevice | undefined> {
  if (!gpu?.requestAdapter) return undefined;

  for (const rung of ["everything", "features-only", "bare"] as const) {
    let adapter: GPUAdapter | null = null;
    try {
      adapter = await gpu.requestAdapter(candidate.request);
    } catch {
      adapter = null;
    }
    if (!adapter) return undefined;

    const wanted: GPUFeatureName[] = [];
    if (rung !== "bare") {
      if (adapter.features.has("shader-f16")) wanted.push("shader-f16");
      // Subgroup intrinsics are a straight speedup in ORT's reduction and
      // matmul kernels where the driver has them, and inert where it does not.
      if (rung === "everything" && adapter.features.has("subgroups")) wanted.push("subgroups");
    }

    try {
      const device = await adapter.requestDevice({
        label: "PolyRead Kokoro",
        requiredFeatures: wanted,
        requiredLimits: rung === "everything" ? limitsFrom(adapter) : {},
      });

      // A device that is lost — a driver reset, a laptop switching GPUs, the
      // browser reclaiming it — takes every session built on it with it. The
      // engine rebuilds rather than spending the rest of the document throwing.
      void device.lost
        ?.then((info) => onLost?.(info?.message || info?.reason || "the GPU device was lost"))
        .catch(() => undefined);
      device.addEventListener?.("uncapturederror", (event) => {
        const error = (event as { error?: { message?: string } }).error;
        if (error?.message) onLost?.(`GPU error: ${error.message}`);
      });

      const features = wanted.filter((feature) => device.features.has(feature));
      const granted = device.limits?.maxBufferSize;
      return {
        device,
        report: {
          ...candidate.report,
          // The device is the authority now, not the adapter: what it was
          // granted is what ONNX Runtime will generate shaders against.
          shaderF16: device.features.has("shader-f16"),
          subgroups: device.features.has("subgroups"),
        },
        features,
        maxBufferMB: typeof granted === "number" ? Math.round(granted / 1024 ** 2) : 0,
      };
    } catch {
      // Too much asked for. Next rung asks for less.
    }
  }
  return undefined;
}
