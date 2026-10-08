import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
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
});
