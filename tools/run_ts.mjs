/**
 * Jalankan skrip TypeScript alat (mis. `tools/bake_looks.ts`) di Node:
 * dibundel esbuild dengan impor `?raw` ala Vite (shader WGSL), lalu dijalankan
 * dengan argumen yang sama.
 *
 *   node tools/run_ts.mjs tools/bake_looks.ts [argumen...]
 */
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, join, resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const [entry, ...args] = process.argv.slice(2);
if (!entry) throw new Error('usage: node tools/run_ts.mjs <entry.ts> [args...]');
const outDir = resolve('node_modules/.cache/tools');
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, basename(entry).replace(/\.ts$/, '.mjs'));

const rawPlugin = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolve(dirname(a.importer), a.path.replace(/\?raw$/, '')), namespace: 'raw' }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async (a) => ({ contents: await readFile(a.path, 'utf8'), loader: 'text' }));
  },
};

await build({
  entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['webgpu'], plugins: [rawPlugin], logLevel: 'warning',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const child = spawn(process.execPath, [outfile, ...args], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
