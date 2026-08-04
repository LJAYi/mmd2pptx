import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ALLOWED_ORIGINS: "https://app.test",
          BROKER_PUBLIC_URL: "https://broker.test",
          GITHUB_API_BASE_URL: "https://api.github.test",
          GITHUB_OAUTH_BASE_URL: "https://github.test",
          GITHUB_APP_CLIENT_ID: "test-client-id",
          GITHUB_APP_CLIENT_SECRET: "test-client-secret",
          GITHUB_APP_SLUG: "mmd2pptx-test",
          // 32 deterministic bytes generated only inside the isolated local test runtime.
          SESSION_ENCRYPTION_KEY: btoa("0123456789abcdef0123456789abcdef"),
        },
      },
    }),
  ],
});
