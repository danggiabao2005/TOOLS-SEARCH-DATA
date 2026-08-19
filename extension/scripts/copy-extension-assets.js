/**
 * Copy static extension assets into dist after Vite build.
 * Run: node scripts/copy-extension-assets.js
 */
import { copyFileSync, cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

mkdirSync(join(dist, "background"), { recursive: true });
mkdirSync(join(dist, "icons"), { recursive: true });

// Manifest: point popup to built html
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
manifest.action.default_popup = "popup.html";
manifest.background.service_worker = "background/service_worker.js";
writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));

// Icons
const iconsSrc = join(root, "icons");
if (existsSync(iconsSrc)) {
  cpSync(iconsSrc, join(dist, "icons"), { recursive: true });
}

// Ensure popup.html is at dist root (vite already does this for named input)
const popupBuilt = join(dist, "popup.html");
if (!existsSync(popupBuilt)) {
  console.warn("popup.html missing in dist — check vite build");
}

console.log("Extension assets copied to dist/");
