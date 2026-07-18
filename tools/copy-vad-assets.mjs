// Copies the Silero VAD model + ONNX Runtime WASM assets needed by
// @ricky0123/vad-web into public/vad/ so they are self-hosted (no CDN).
// Wired into predev/prebuild; idempotent and cheap (skips up-to-date files).
import { copyFileSync, mkdirSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "vad");

const ASSETS = [
  // @ricky0123/vad-web: audio worklet + Silero models
  ["node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js", "vad.worklet.bundle.min.js"],
  ["node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx", "silero_vad_v5.onnx"],
  ["node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx", "silero_vad_legacy.onnx"],
  // onnxruntime-web: WASM runtime (version must match the installed package,
  // which is why these are copied at build time instead of vendored)
  ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.wasm"],
  ["node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.mjs"],
];

mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const [src, name] of ASSETS) {
  const from = path.join(root, src);
  const to = path.join(outDir, name);
  try {
    const srcStat = statSync(from);
    let needsCopy = true;
    try {
      const dstStat = statSync(to);
      needsCopy = dstStat.size !== srcStat.size || dstStat.mtimeMs < srcStat.mtimeMs;
    } catch {
      /* missing → copy */
    }
    if (needsCopy) {
      copyFileSync(from, to);
      copied++;
    }
  } catch (err) {
    console.error(`[vad-assets] MISSING ${src} — voice VAD will fall back to energy detection (${err.message})`);
    process.exitCode = 0; // non-fatal: the app degrades gracefully
  }
}

if (copied > 0) console.log(`[vad-assets] copied ${copied} asset(s) to public/vad/`);
