/**
 * Downloads the ONNX weights and tokenizer files so the app can run without
 * reaching HuggingFace at demo time (useful for offline judges).
 *
 * Usage: npm run fetch-model [-- Xenova/bge-small-zh-v1.5]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const modelId = positional[0] || process.env.EMBEDDING_MODEL || "Xenova/bge-small-zh-v1.5";
const endpoint = (process.env.HF_ENDPOINT || "https://huggingface.co").replace(/\/$/, "");
const targetDir = path.join(repoRoot, "web", "public", "models", modelId);

const int8Only = process.argv.includes("--int8");

const TOKENIZER_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "vocab.txt",
];

// INT8 weights are small enough to ship with the repository, which keeps the
// default path fully offline. FP16/FP32 stay optional downloads.
const FILES = int8Only
  ? [...TOKENIZER_FILES, "onnx/model_quantized.onnx"]
  : [...TOKENIZER_FILES, "onnx/model.onnx", "onnx/model_fp16.onnx", "onnx/model_quantized.onnx"];

fs.mkdirSync(path.join(targetDir, "onnx"), { recursive: true });

const manifest = { model: modelId, endpoint, files: [] };

for (const file of FILES) {
  const url = `${endpoint}/${modelId}/resolve/main/${file}`;
  const destination = path.join(targetDir, file);
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
    const size = fs.statSync(destination).size;
    manifest.files.push({ file, size, cached: true });
    console.log(`cached  ${file}  ${(size / 1024 / 1024).toFixed(1)} MB`);
    continue;
  }
  process.stdout.write(`fetch   ${file} ... `);
  try {
    // curl handles the HF CDN redirects and works behind proxies that reject
    // the default fetch user agent.
    execFileSync("curl", ["-sSL", "-f", "--retry", "3", "-o", destination, url], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    console.log(`failed (${error instanceof Error ? error.message.split("\n")[0] : error})`);
    continue;
  }
  const size = fs.statSync(destination).size;
  manifest.files.push({ file, size });
  console.log(`${(size / 1024 / 1024).toFixed(1)} MB`);
}

const total = manifest.files.reduce((sum, item) => sum + item.size, 0);
manifest.totalBytes = total;
fs.writeFileSync(path.join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2));
// Root manifest lets the app discover the bundled model without guessing paths.
fs.writeFileSync(
  path.join(repoRoot, "web", "public", "models", "manifest.json"),
  JSON.stringify({ model: modelId, dir: modelId, totalBytes: total, files: manifest.files }, null, 2),
);
console.log(`\nmodel ready at ${targetDir}`);
console.log(`total ${(total / 1024 / 1024).toFixed(1)} MB; keep this directory to run fully offline`);
