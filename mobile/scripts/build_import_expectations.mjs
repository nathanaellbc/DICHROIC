import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Decode the actual ImageIO-written EXR with the independent web decoder.
// The encoder may transform source values while assigning its output profile.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = resolve(process.argv[2] ?? resolve(root, 'mobile/assets/parity'));
const bundle = resolve(root, 'mobile/build/import-oracle.mjs');
await mkdir(dirname(bundle), { recursive: true });
await build({ entryPoints: [resolve(root, 'src/io/exr.ts')], outfile: bundle,
  bundle: true, platform: 'node', format: 'esm' });
const { decodeExr } = await import(pathToFileURL(bundle).href);
const image = decodeExr(await readFile(resolve(directory, 'float-native.exr')));
await writeFile(resolve(directory, 'float-native.exr.f32'),
  new Uint8Array(image.rgba.buffer, image.rgba.byteOffset, image.rgba.byteLength));
console.log(`Independent EXR reference: ${image.width}x${image.height}, ${image.suggestedColorSpace}, ${Array.from(image.rgba)}`);
