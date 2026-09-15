#!/usr/bin/env node
/**
 * Downloads the Kokoro model, its tokenizer and its voices into public/models/,
 * which is where the app's default settings look for them.
 *
 * This is what makes PolyRead local. After it has run once, the app talks to
 * nothing but its own origin: the desktop builds bundle what lands here, and a
 * self-hosted copy serves it from the same directory as the page.
 *
 *   node scripts/fetch-assets.mjs                 # fp16, the default voices
 *   node scripts/fetch-assets.mjs --dtype q8f16   # smaller, faster on CPU
 *   node scripts/fetch-assets.mjs --dtype fp32    # largest, best on WebGPU
 *   node scripts/fetch-assets.mjs --voices all    # every voice, ~28 MB more
 *   node scripts/fetch-assets.mjs --voices-from-npm
 *
 * Nothing here is hardcoded to a filename in the model repository: the file
 * list comes from the Hub API and the requested dtype is matched against what
 * actually exists, so a re-export that renames things fails with a list of
 * what is there rather than a 404.
 */
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = join(root, "public", "models");

const MODEL_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
const HUB = "https://huggingface.co";

/** The voices worth having by default: everything the model card grades B or better. */
const DEFAULT_VOICES = [
  "af_heart", "af_bella", "af_nicole", "bf_emma",
  "af_aoede", "af_kore", "af_sarah", "am_fenrir", "am_michael", "am_puck",
];

function parseArgs(argv) {
  const args = { dtype: "fp16", voices: "default", voicesFromNpm: false, force: false, list: false, repo: MODEL_REPO };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dtype") args.dtype = argv[++i];
    else if (arg === "--voices") args.voices = argv[++i];
    else if (arg === "--voices-from-npm") args.voicesFromNpm = true;
    else if (arg === "--repo") args.repo = argv[++i];
    else if (arg === "--force") args.force = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node scripts/fetch-assets.mjs [options]",
          "",
          "  --list                                 show what the repository publishes, and stop",
          "  --dtype <fp32|fp16|q8|q4|q4f16|FILE>   model precision, or an exact filename (default fp16)",
          "  --voices <default|all|a,b,c>           which voices (default: the B-and-better ones)",
          "  --voices-from-npm                      take voices from the kokoro-js package instead of the Hub",
          "  --repo <owner/name>                    a different model repository",
          "  --force                                re-download files that are already present",
        ].join("\n"),
      );
      process.exit(0);
    }
  }
  return args;
}

async function listRepo(repo) {
  const response = await fetch(`${HUB}/api/models/${repo}`);
  if (!response.ok) {
    throw new Error(
      `Could not list ${repo} (HTTP ${response.status}). ` +
        "If this machine cannot reach huggingface.co, copy public/models/ from a machine that can.",
    );
  }
  const info = await response.json();
  return (info.siblings ?? []).map((s) => s.rfilename);
}

/**
 * dtype -> the filename onnx-community publishes it under.
 *
 * These follow transformers.js's suffix convention, which is what the Kokoro
 * ONNX repository is laid out for. The mapping is not one word to one file —
 * `q8` is published as `model_quantized.onnx`, not `model_q8.onnx` — so each
 * dtype lists every spelling worth trying, and `--list` exists for when none of
 * them match because a re-export moved things.
 */
const DTYPE_FILES = {
  fp32: ["model.onnx"],
  fp16: ["model_fp16.onnx"],
  q8: ["model_quantized.onnx", "model_q8.onnx", "model_uint8.onnx"],
  q4: ["model_q4.onnx"],
  q4f16: ["model_q4f16.onnx"],
  int8: ["model_int8.onnx"],
  uint8: ["model_uint8.onnx"],
};

function onnxFiles(files) {
  return files.filter((f) => f.endsWith(".onnx"));
}

/** Which file in the repo is the model at this precision. */
function pickModelFile(files, dtype) {
  const onnx = onnxFiles(files);

  // An exact filename always wins, so a repository this script has never seen
  // can still be used without editing it.
  const exact = onnx.find((f) => f === dtype || f.endsWith(`/${dtype}`) || f === `onnx/${dtype}`);
  if (exact) return exact;

  for (const name of DTYPE_FILES[dtype] ?? []) {
    const match = onnx.find((f) => f === name || f === `onnx/${name}`);
    if (match) return match;
  }

  throw new Error(
    `No model file for --dtype ${dtype}.\n` +
      `This repository publishes:\n${onnx.map((f) => `  ${f}`).join("\n")}\n` +
      "Pass one of those filenames directly, e.g. --dtype model_q4f16.onnx",
  );
}

async function listAndExit(repo) {
  const files = await listRepo(repo);
  const sizes = await fileSizes(repo);
  const show = (name) => {
    const size = sizes.get(name);
    return `  ${name}${size ? `  (${mb(size)})` : ""}`;
  };

  console.log(`${repo} publishes:\n`);
  console.log("Models:");
  for (const file of onnxFiles(files).sort()) console.log(show(file));

  const voices = files.filter((f) => f.startsWith("voices/") && f.endsWith(".bin"));
  console.log(`\nVoices: ${voices.length} files, about 0.5 MB each`);
  console.log(`  ${voices.slice(0, 6).map((f) => f.slice(7, -4)).join(", ")}${voices.length > 6 ? ", …" : ""}`);

  console.log("\nThe same download serves the website and the desktop installers.");
  console.log("Pick one model file and run, for example:");
  console.log("  node scripts/fetch-assets.mjs --dtype fp16");
}

/** Sizes, if the Hub will give them. Best-effort: the listing is useful without. */
async function fileSizes(repo) {
  const sizes = new Map();
  for (const path of ["", "onnx"]) {
    try {
      const response = await fetch(`${HUB}/api/models/${repo}/tree/main/${path}`);
      if (!response.ok) continue;
      for (const entry of await response.json()) {
        if (entry.type === "file" && typeof entry.size === "number") sizes.set(entry.path, entry.size);
      }
    } catch {
      // No sizes; the names are the part that matters.
    }
  }
  return sizes;
}

async function download(url, destination, label, force) {
  if (!force) {
    try {
      const existing = await stat(destination);
      if (existing.size > 0) {
        console.log(`  ${label}: already present (${mb(existing.size)})`);
        return;
      }
    } catch {
      // Not there yet; fall through and fetch it.
    }
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`${label}: HTTP ${response.status} from ${url}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  await mkdir(dirname(destination), { recursive: true });

  let loaded = 0;
  let lastReport = 0;
  const reporter = new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.length;
      const now = Date.now();
      if (now - lastReport > 500) {
        lastReport = now;
        const suffix = total > 0 ? ` of ${mb(total)} (${Math.round((loaded / total) * 100)}%)` : "";
        process.stdout.write(`\r  ${label}: ${mb(loaded)}${suffix}   `);
      }
      controller.enqueue(chunk);
    },
  });

  await pipeline(response.body.pipeThrough(reporter), createWriteStream(destination));
  process.stdout.write(`\r  ${label}: ${mb(loaded)} done            \n`);
}

const mb = (bytes) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/**
 * The voices are also published inside the `kokoro-js` npm package, which is a
 * useful second source when the Hub is blocked or slow. Same files, same
 * licence (Apache-2.0).
 */
async function voicesFromNpm(names) {
  const temp = join(root, "node_modules", ".polyread-voices");
  await rm(temp, { recursive: true, force: true });
  await mkdir(temp, { recursive: true });
  console.log("  fetching kokoro-js from npm for its bundled voices…");
  const { stdout } = await run("npm", ["pack", "kokoro-js", "--silent"], { cwd: temp });
  const tarball = stdout.trim().split("\n").pop();
  await run("tar", ["xzf", tarball], { cwd: temp });

  const source = join(temp, "package", "voices");
  const available = (await readdir(source)).filter((f) => f.endsWith(".bin"));
  const wanted = names === "all" ? available.map((f) => f.replace(/\.bin$/, "")) : names;
  for (const voice of wanted) {
    const file = `${voice}.bin`;
    if (!available.includes(file)) {
      console.warn(`  ${voice}: not in the package, skipping`);
      continue;
    }
    const bytes = await readFile(join(source, file));
    await mkdir(join(outDir, "voices"), { recursive: true });
    await writeFile(join(outDir, "voices", file), bytes);
    console.log(`  ${voice}: ${mb(bytes.length)} from npm`);
  }
  await rm(temp, { recursive: true, force: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    await listAndExit(args.repo);
    return;
  }
  await mkdir(outDir, { recursive: true });

  console.log(`PolyRead assets -> ${outDir}`);
  console.log(`Repository: ${args.repo}`);

  const files = await listRepo(args.repo);
  const modelFile = pickModelFile(files, args.dtype);
  console.log(`\nModel (${args.dtype}):`);
  await download(
    `${HUB}/${args.repo}/resolve/main/${modelFile}`,
    join(outDir, "kokoro.onnx"),
    `kokoro.onnx (${modelFile})`,
    args.force,
  );

  // Some exports keep the weights in a sidecar next to the graph.
  const externalData = files.filter((f) => f === `${modelFile}_data` || f === `${modelFile}.data`);
  for (const file of externalData) {
    await download(
      `${HUB}/${args.repo}/resolve/main/${file}`,
      join(outDir, file.split("/").pop()),
      file,
      args.force,
    );
  }

  console.log("\nTokenizer:");
  if (files.includes("tokenizer.json")) {
    await download(
      `${HUB}/${args.repo}/resolve/main/tokenizer.json`,
      join(outDir, "tokenizer.json"),
      "tokenizer.json",
      args.force,
    );
  } else {
    console.log("  not published; the built-in vocabulary will be used");
  }

  const names =
    args.voices === "all"
      ? "all"
      : args.voices === "default"
        ? DEFAULT_VOICES
        : args.voices.split(",").map((v) => v.trim()).filter(Boolean);

  console.log("\nVoices:");
  if (args.voicesFromNpm) {
    await voicesFromNpm(names);
  } else {
    const published = files.filter((f) => f.startsWith("voices/") && f.endsWith(".bin"));
    const wanted =
      names === "all" ? published.map((f) => f.slice("voices/".length, -4)) : names;
    for (const voice of wanted) {
      const file = `voices/${voice}.bin`;
      if (!published.includes(file)) {
        console.warn(`  ${voice}: not published in this repository, skipping`);
        continue;
      }
      await download(
        `${HUB}/${args.repo}/resolve/main/${file}`,
        join(outDir, "voices", `${voice}.bin`),
        voice,
        args.force,
      );
    }
  }

  console.log("\nDone.");
  console.log("Word timings are estimated until a duration model exists. To make one:");
  console.log("  python3 -m pip install onnx onnxruntime numpy");
  console.log("  python3 scripts/make-duration-model.py public/models/kokoro.onnx");
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
