import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base` is "./" so the built site works from any path — blozanod.me/PolyRead/
// as easily as from a domain root, and from file:// inside Electron.
export default defineConfig({
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    // The ONNX wasm binaries and the espeak worker are large and already
    // compressed; inlining anything would only defeat caching.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
  },
  optimizeDeps: {
    // The `onnxruntime-web/webgpu` entry point is the "bundle" build, which
    // carries its wasm inline. That is a larger file than the split build, and
    // worth it: no `wasmPaths` to get wrong, and the app works unchanged from a
    // subdirectory on a static host and from file:// inside Electron.
    include: ["onnxruntime-web/webgpu"],
  },
  server: {
    headers: {
      // Cross-origin isolation, which onnxruntime-web needs before it will use
      // SharedArrayBuffer for multi-threaded wasm. Without these two headers it
      // silently falls back to a single thread and synthesis is ~4x slower.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
} as never);
