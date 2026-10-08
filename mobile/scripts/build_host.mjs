import { build } from 'esbuild';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const destination = join(root, 'mobile/packages/exposure_engine/ios/exposure_engine/Resources');
await mkdir(destination, { recursive: true });
await build({
  absWorkingDir: root, entryPoints: ['src/native/runtime.ts'], bundle: true,
  format: 'iife', globalName: 'ExposureHost', platform: 'neutral', target: 'es2022',
  outfile: join(destination, 'renderer.js'), treeShaking: true,
  banner: { js: await readFile(join(root, 'mobile/scripts/native_web_primitives.js'), 'utf8') },
  plugins: [{ name: 'native-shared-shaders', setup(api) {
    api.onResolve({ filter: /webgpuGlobals$/ }, () => ({ path: join(root, 'src/native/constants.ts') }));
    api.onLoad({ filter: /\.wgsl$/ }, async args => ({
      contents: await readFile(args.path, 'utf8'), loader: 'text',
    }));
    // These loaders are eliminated by tree shaking; a retained loader is a
    // bundling error, never an accidental Node dependency on the phone.
    api.onResolve({ filter: /^node:/ }, args => ({ path: args.path, external: true }));
  } }],
});
const text = await readFile(join(destination, 'renderer.js'), 'utf8');
if (/\brequire\(|\bimport\(/.test(text)) throw new Error('Native renderer must not contain runtime module imports');
for (const folder of ['data', 'luts']) {
  await mkdir(join(destination, folder), { recursive: true });
  const files = folder === 'data' ? ['manifest.json', 'stocks.f32', 'hanatos.f16', 'static.f32']
    : ['kodak-2383-d55.cube', 'kodak-2383-d60.cube', 'kodak-2383-d65.cube', 'kodak-2393-d65.cube',
      'fuji-3513-d55.cube', 'fuji-3513-d60.cube', 'fuji-3513-d65.cube'];
  for (const name of files) await copyFile(join(root, 'public', folder, name), join(destination, folder, name));
}
console.log('Canonical native host, WGSL, spectral assets and film print LUTs bundled.');
