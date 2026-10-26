import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8090",
        changeOrigin: true,
      },
    },
  },
  worker: {
    format: "es",
  },
  build: {
    outDir: path.join(root, "dist"),
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ["@huggingface/transformers"],
  },
});
