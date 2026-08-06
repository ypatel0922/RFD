/**
 * Keep the browser PDF.js worker in `public/` in sync with the installed
 * `pdfjs-dist` version. Statement PDFs are rasterized client-side before upload.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
const targetDir = join(root, "public");
const target = join(targetDir, "pdf.worker.min.mjs");

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);
console.log(`Copied PDF.js worker to ${target}`);
