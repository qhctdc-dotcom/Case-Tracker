// Copies the OCR engine and English language data into public/ocr so the
// app never needs an outside server to read scanned reports. Runs before
// every build (see "prebuild" in package.json).
import fs from "node:fs";
const out = "public/ocr";
fs.mkdirSync(out, { recursive: true });
const files = [
  ["node_modules/tesseract.js/dist/worker.min.js", "worker.min.js"],
  ["node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js", "tesseract-core-lstm.wasm.js"],
  ["node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js"],
  ["node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "eng.traineddata.gz"],
];
for (const [from, to] of files) fs.copyFileSync(from, `${out}/${to}`);
console.log("OCR files ready in public/ocr");
