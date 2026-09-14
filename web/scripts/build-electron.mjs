#!/usr/bin/env node
/**
 * Bundles the two Electron entry points to CommonJS.
 *
 * They are TypeScript and the rest of the app is ESM, but Electron's main
 * process wants CJS and its preload script requires it. esbuild is already a
 * Vite dependency, so this costs nothing extra.
 */
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: {
    main: resolve(root, "electron/main.ts"),
    preload: resolve(root, "electron/preload.ts"),
  },
  outdir: resolve(root, "dist-electron"),
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
});
