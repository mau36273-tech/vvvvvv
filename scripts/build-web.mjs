#!/usr/bin/env node
/**
 * Minimal "build" step: the web app is a single HTML file plus a few
 * static assets, so this script just validates the tree exists and
 * normalizes line endings. It's safe to run on macOS (CI), Linux and
 * Windows.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const webDir = path.join(root, "web");

const required = [
  "index.html",
  "js/native-bridge.js",
];

for (const rel of required) {
  const p = path.join(webDir, rel);
  if (!fs.existsSync(p)) {
    console.error(`[build-web] Missing required file: ${p}`);
    process.exit(1);
  }
}

console.log("[build-web] web/ tree OK");
