import { createReadStream } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);

/**
 * pdf.js 6 moved its image codecs out of JavaScript.
 *
 * JBIG2 — which is what every course-reserve and JSTOR scan is encoded with —
 * and JPEG 2000 are now WebAssembly modules loaded at runtime from `wasmUrl`,
 * and the standard fonts and CMaps have always been separate files. When those
 * URLs are not given, pdf.js does not fail the render: it logs
 * `Jbig2Error: JBig2 failed to initialize`, draws everything *except* the
 * image, and hands back a page that is blank apart from its text layer. A
 * scanned PDF renders as white paper.
 *
 * So the four asset directories ship with the app, under `pdfjs/`, and
 * `pdfAssets.ts` points pdf.js at them. This plugin is what puts them there:
 * served out of `node_modules` in dev, copied into `dist/` for a build.
 */
function pdfjsAssets(): Plugin {
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  const directories = ["wasm", "cmaps", "standard_fonts", "iccs"];
  const types: Record<string, string> = {
    ".wasm": "application/wasm",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".bcmap": "application/octet-stream",
    ".pfb": "application/octet-stream",
    ".ttf": "font/ttf",
    ".icc": "application/vnd.iccprofile",
  };

  return {
    name: "polyread:pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = (request.url ?? "").split("?")[0];
        const match = /^\/pdfjs\/(.+)$/.exec(url);
        if (!match) return next();
        // Path traversal out of pdfjs-dist is never a legitimate request.
        const relative = normalize(decodeURIComponent(match[1]));
        if (relative.startsWith("..") || !directories.includes(relative.split(/[\\/]/)[0])) return next();

        const file = join(root, relative);
        response.setHeader("Content-Type", types[extname(file)] ?? "application/octet-stream");
        createReadStream(file)
          .on("error", () => next())
          .pipe(response);
      });
    },
    async writeBundle(options) {
      const out = join(options.dir ?? resolve("dist"), "pdfjs");
      await mkdir(out, { recursive: true });
      for (const directory of directories) {
        await cp(join(root, directory), join(out, directory), { recursive: true });
      }
    },
  };
}

// `base` is "./" so the built site works from any path — blozanod.me/polyread/
// as easily as from a domain root, and from file:// inside Electron.
export default defineConfig({
  base: "./",
  plugins: [react(), pdfjsAssets()],
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
});
