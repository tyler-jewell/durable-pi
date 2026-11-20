import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      config: "./cloudflare.config.ts",
      miniflare: {
        bindings: {
          DPI_TOKEN: "test-token",
        },
      },
    }),
  ],
  test: {
    include: ["test/do/*.test.ts"],
  },
});
