import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
const context = createContext({ nativeHost: {
  readText: name => readFileSync(`public/${name}`, 'utf8'),
  readAsset: name => { const bytes = readFileSync(`public/${name}`); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
  command: () => JSON.stringify({ result: { maxStorageBufferBindingSize: 32 * 1024 * 1024 } }),
} });
runInContext(readFileSync('mobile/packages/exposure_engine/ios/exposure_engine/Resources/renderer.js', 'utf8'), context);
const data = runInContext('runtime = ExposureHost.createNativeRuntime(nativeHost); catalog = JSON.parse(runtime.catalog()); JSON.stringify({ catalog, groups: JSON.parse(runtime.controls(JSON.stringify(catalog.baseline))) })', context);
mkdirSync('mobile/test/fixtures', { recursive: true });
writeFileSync('mobile/test/fixtures/controls.json', data);
