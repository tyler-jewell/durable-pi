import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
const sdk = fileURLToPath(new URL("../dpi-sdk/src", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  resolve: { alias: { "@sdk": sdk } },
  build: { outDir: "dist", emptyOutDir: true },
});
