import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { copyFileSync, mkdirSync } from "fs";

const root = dirname(fileURLToPath(import.meta.url));

function copyServiceWorker() {
  return {
    name: "copy-service-worker",
    closeBundle() {
      const destDir = join(root, "dist", "background");
      mkdirSync(destDir, { recursive: true });
      copyFileSync(
        join(root, "src", "background", "service_worker.js"),
        join(destDir, "service_worker.js")
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), copyServiceWorker()],
  publicDir: "public",
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(root, "popup.html"),
        review: resolve(root, "review.html"),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
