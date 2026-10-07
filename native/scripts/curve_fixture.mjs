// Extract measured curve data directly from the canonical asset blob.
// This fixture is pre-DIR density, not Python's final cmy_film tap.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(`${root}public/data/manifest.json`, 'utf8'));
const stock = manifest.stocks.find(stock => stock.id === 'kodak_portra_400');
const blob = readFileSync(`${root}public/data/stocks.f32`);
const fields = ['logExposure', 'densityCurves'].map(name => {
  const field = stock.fields[name];
  return blob.subarray(field.offsetFloats * 4, (field.offsetFloats + field.lengthFloats) * 4);
});
const header = Buffer.alloc(4);
header.writeUInt32LE(stock.exposureCount);
const fixture = Buffer.concat([header, ...fields]);
const path = `${root}native/testdata/portra400_curve.bin`;
if (process.argv.includes('--check')) {
  if (!readFileSync(path).equals(fixture)) throw new Error('Regenerate native curve fixture from current canonical assets.');
} else {
  mkdirSync(`${root}native/testdata`, { recursive: true });
  writeFileSync(path, fixture);
}
