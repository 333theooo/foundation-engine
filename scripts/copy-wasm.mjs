/**
 * Copies the web-ifc WebAssembly runtime into /public/wasm so the browser
 * worker can fetch it from a same-origin URL (required by our CSP, which does
 * not allow wasm from third-party CDNs).
 *
 * Runs on postinstall. It is intentionally forgiving: if web-ifc is not
 * installed yet (or the layout changed), IFC import degrades to a clear
 * runtime error instead of breaking `npm install`.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const source = join(root, 'node_modules', 'web-ifc');
const target = join(root, 'public', 'wasm');

if (!existsSync(source)) {
  console.warn('[copy-wasm] web-ifc not installed; skipping IFC runtime copy.');
  process.exit(0);
}

mkdirSync(target, { recursive: true });

let copied = 0;
for (const file of readdirSync(source)) {
  if (file.endsWith('.wasm')) {
    copyFileSync(join(source, file), join(target, file));
    copied += 1;
  }
}
console.log(`[copy-wasm] copied ${copied} wasm file(s) into public/wasm`);
