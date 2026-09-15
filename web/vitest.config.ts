import { defineConfig } from "vitest/config";

// Separate from vite.config.ts, which is about building the app: these settings
// are about running the pipeline under Node, where there is no DOM and no GPU.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // eSpeak and pdf.js both warm up slowly on a first call, and the two §13
    // integration gates put a whole PDF through the pipeline.
    testTimeout: 120_000,
  },
});
