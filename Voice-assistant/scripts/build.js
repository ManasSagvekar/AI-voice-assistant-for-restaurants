// Builds the two front ends into public/assets. Run with `npm run build`.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('public/assets/vendor', { recursive: true });
await build({
  entryPoints: { customer: 'customer-app/client/customer.jsx', admin: 'staff-app/client/admin.jsx', landing: 'customer-app/client/landing.js' },
  outdir: 'public/assets', bundle: true, format: 'iife', minify: true, target: 'es2020', jsx: 'transform', logLevel: 'warning',
});
execFileSync(process.execPath, ['node_modules/tailwindcss/lib/cli.js', '-c', 'tailwind.config.cjs', '-i', 'client/tailwind.css', '-o', 'public/assets/app.css', '--minify'], { stdio: ['ignore', 'ignore', 'inherit'] });
copyFileSync('background.avif', 'public/assets/background.avif');
for (const f of ['react/umd/react.production.min.js', 'react-dom/umd/react-dom.production.min.js']) {
  copyFileSync('node_modules/' + f, 'public/assets/vendor/' + f.split('/').pop());
}
// Silero VAD for the table tablets: the ONNX web runtime, the VAD library, its audio worklet and model.
mkdirSync('public/assets/vendor/ort', { recursive: true });
mkdirSync('public/assets/vendor/vad', { recursive: true });
const vendor = {
  'onnxruntime-web/dist/ort.wasm.min.js': 'ort.wasm.min.js',
  'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs': 'ort/ort-wasm-simd-threaded.mjs',
  'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm': 'ort/ort-wasm-simd-threaded.wasm',
  '@ricky0123/vad-web/dist/bundle.min.js': 'vad.bundle.min.js',
  '@ricky0123/vad-web/dist/vad.worklet.bundle.min.js': 'vad/vad.worklet.bundle.min.js',
  '@ricky0123/vad-web/dist/silero_vad_v5.onnx': 'vad/silero_vad_v5.onnx',
};
for (const [from, to] of Object.entries(vendor)) copyFileSync('node_modules/' + from, 'public/assets/vendor/' + to);
console.log('Built public/assets');
