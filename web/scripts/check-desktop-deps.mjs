#!/usr/bin/env node
/**
 * Stops a desktop build with an instruction rather than a stack trace.
 *
 * Electron and electron-builder are not in `devDependencies`, because between
 * them they are 280 of the project's packages and every deprecation warning the
 * install prints — and none of it is needed to run, test or build the web app,
 * which is what most sessions are doing. `npm run desktop:setup` adds them when
 * you actually want an installer.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const missing = ["electron", "electron-builder"].filter((name) => {
  try {
    require.resolve(`${name}/package.json`);
    return false;
  } catch {
    return true;
  }
});

if (missing.length > 0) {
  console.error(
    [
      "",
      `The desktop toolchain is not installed (${missing.join(", ")}).`,
      "",
      "  npm run desktop:setup",
      "",
      "That adds Electron and electron-builder — about 280 packages, and the only",
      "part of this project that still pulls deprecated transitive dependencies.",
      "The web app does not need any of it.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
