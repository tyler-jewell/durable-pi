// The local Artifacts simulator for the offline e2e leg (`npm run e2e:offline`). Run by `cf dev`, on loopback, with no
// Cloudflare credentials: the artifacts binding uses the local simulator unless remote = true.
import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "dpi-artifacts-sim",
    entrypoint: "./index.ts",
    compatibilityDate: "2026-11-18",
    env: {
      ARTIFACTS: bindings.artifacts({ namespace: "default" }),
    },
  },
});
