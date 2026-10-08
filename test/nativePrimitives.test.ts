import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('UTF-8 in the DOM-free native runtime matches web encoding and decoding', () => {
  const context = createContext({});
  runInContext(readFileSync('mobile/scripts/native_web_primitives.js', 'utf8'), context);
  for (const text of ['DICHROIC', 'Fujifilm · ISO 400', '日本語 🖼️', '\ud800x', '\ufeffmanifest']) {
    context.input = text;
    const bytes = runInContext('new TextEncoder().encode(input)', context) as Uint8Array;
    expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode(text)));
    context.bytes = bytes;
    expect(runInContext('new TextDecoder().decode(bytes)', context)).toBe(new TextDecoder().decode(bytes));
  }
  for (const bytes of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x9f], [0xe0, 0x81, 65]]) {
    context.bytes = Uint8Array.from(bytes);
    expect(runInContext('new TextDecoder().decode(bytes)', context)).toBe(new TextDecoder().decode(Uint8Array.from(bytes)));
    expect(() => runInContext('new TextDecoder("utf8", { fatal: true }).decode(bytes)', context)).toThrow();
  }
  context.bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  expect(runInContext('new TextDecoder("latin1").decode(bytes)', context)).toBe(new TextDecoder('latin1').decode(context.bytes as Uint8Array));
});

it('the complete bundled host starts without browser globals and exposes canonical controls', () => {
  execFileSync(process.execPath, ['mobile/scripts/build_host.mjs']);
  const context = createContext({ nativeHost: {
    readText: (name: string) => readFileSync(`public/${name}`, 'utf8'),
    readAsset: (name: string) => { const bytes = readFileSync(`public/${name}`); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    command: () => JSON.stringify({ result: { maxStorageBufferBindingSize: 32 * 1024 * 1024 } }),
  } });
  runInContext(readFileSync('mobile/packages/exposure_engine/ios/exposure_engine/Resources/renderer.js', 'utf8'), context);
  runInContext('runtime = ExposureHost.createNativeRuntime(nativeHost); catalog = JSON.parse(runtime.catalog())', context);
  const groups = JSON.parse(runInContext('runtime.controls(JSON.stringify(catalog.baseline))', context) as string) as { tools: { id: string }[] }[];
  expect(groups).toHaveLength(6);
  expect(groups.flatMap(group => group.tools).length).toBeGreaterThan(40);
  expect(runInContext('runtime.icc("Display P3").length', context)).toBeGreaterThan(132);
  expect(runInContext('runtime.rawLookup().length', context)).toBe(65536);
}, 30000);
