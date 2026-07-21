import { defineConfig } from "vite";

const processEnvironment = (
  globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }
).process?.env;

export default defineConfig({
  // A relative default works for both user and project GitHub Pages sites.
  // Set MMD2PPTX_BASE_PATH (for example, /mmd2pptx/) when absolute URLs are preferred.
  base: processEnvironment?.MMD2PPTX_BASE_PATH || "./",
  resolve: {
    // Keep local development usable before the core package has been published/built.
    alias: {
      "@mmd2pptx/core": new URL("../../packages/core/src/index.ts", import.meta.url).pathname,
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
