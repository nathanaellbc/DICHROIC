import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readF32 } from '../readF32';

export const IO_FIXTURES = join('test', 'fixtures', 'io');

export interface IoCase {
  name: string;
  format: string;
  width: number;
  height: number;
  bitDepth: number;
  oracle: string;
}

export function ioCases(format: string): string[] {
  return readdirSync(IO_FIXTURES).filter((name) => loadIoMeta(name).format === format).sort();
}

export function loadIoMeta(name: string): IoCase {
  return JSON.parse(readFileSync(join(IO_FIXTURES, name, 'case.json'), 'utf8')) as IoCase;
}

export function loadIoInput(name: string): Uint8Array {
  const file = readdirSync(join(IO_FIXTURES, name)).find((f) => f.startsWith('input.'));
  if (!file) throw new Error(`fixture io/${name} tidak punya input.*`);
  return new Uint8Array(readFileSync(join(IO_FIXTURES, name, file)));
}

export function loadIoExpected(name: string): Float32Array {
  return readF32(join(IO_FIXTURES, name, 'expected.f32'));
}

/** Selisih mutlak maksimum RGB `rgba` (4 kanal) terhadap `expected` (3 kanal). */
export function maxRgbDiff(rgba: Float32Array, expected: Float32Array): number {
  let max = 0;
  for (let i = 0; i < expected.length / 3; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      const d = Math.abs(rgba[i * 4 + c]! - expected[i * 3 + c]!);
      if (!(d <= max)) max = d; // NaN ikut dilaporkan
    }
  }
  return max;
}

/** Jumlah nilai RGB yang tidak bit-identik. */
export function mismatches(rgba: Float32Array, expected: Float32Array): number {
  let count = 0;
  for (let i = 0; i < expected.length / 3; i += 1) {
    for (let c = 0; c < 3; c += 1) if (!Object.is(rgba[i * 4 + c], expected[i * 3 + c])) count += 1;
  }
  return count;
}
