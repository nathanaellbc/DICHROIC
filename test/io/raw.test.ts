import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeImage, DecodeError } from '../../src/io';
import { readF32 } from '../readF32';

const RAW_DIR = join('test', 'fixtures', 'raw');
const wasmBinary = new Uint8Array(readFileSync(join('node_modules', 'libraw-wasm', 'dist', 'libraw.wasm')));
const options = { raw: { wasmBinary } };

// Rencana 2B Task 5: libraw-wasm (kurva gamma bawaan dibalik) vs rawpy
// (gamma 1,1), keduanya LibRaw 0.22.1. Ambang 2 LSB 16-bit; terukur di
// handoff 1,5e-5 (1 LSB). Yang tersisa murni kuantisasi kurva: kode ter-encode
// di wilayah terang mewakili rentang beberapa kode linear, dan inversnya
// mengambil tengah rentang.
const MAX_ABS = 2 / 65535;

describe.each(readdirSync(RAW_DIR).sort())('RAW %s vs rawpy', (name) => {
  const meta = JSON.parse(readFileSync(join(RAW_DIR, name, 'case.json'), 'utf8')) as { width: number; height: number };
  const bytes = () => new Uint8Array(readFileSync(join(RAW_DIR, name, 'input.dng')));

  it(`dimensi, orientasi, dan nilai <= ${MAX_ABS.toExponential(2)}`, async () => {
    const image = await decodeImage(bytes(), `${name}.dng`, options);
    expect([image.width, image.height]).toEqual([meta.width, meta.height]);
    expect(image.suggestedColorSpace).toBe('ACES2065-1');
    expect(image.encoding).toBe('linear');
    expect(image.source).toEqual({ format: 'raw', bitDepth: 16, name: `${name}.dng` });
    const expected = readF32(join(RAW_DIR, name, 'output.f32'));
    let worst = 0;
    for (let i = 0; i < meta.width * meta.height; i += 1) {
      for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(image.rgba[i * 4 + c]! - expected[i * 3 + c]!));
    }
    expect(worst).toBeLessThanOrEqual(MAX_ABS);
  });

  it('DNG terpotong -> DecodeError("raw") dengan alasan dari LibRaw', async () => {
    const data = bytes();
    const error = (await decodeImage(data.subarray(0, Math.floor(data.length / 2)), undefined, options).catch((e: unknown) => e)) as DecodeError;
    expect(error).toBeInstanceOf(DecodeError);
    expect(error.format).toBe('raw');
    expect(error.reason.length).toBeGreaterThan(0);
  });
});

describe('format tak dikenal', () => {
  it('dicoba LibRaw, lalu DecodeError("unknown") yang menyebut LibRaw', async () => {
    const error = (await decodeImage(new Uint8Array(512).fill(0x13), undefined, options).catch((e: unknown) => e)) as DecodeError;
    expect(error).toBeInstanceOf(DecodeError);
    expect(error.format).toBe('unknown');
    expect(error.reason).toMatch(/LibRaw/);
  });
});

describe('browser tanpa cross-origin isolation', () => {
  it('DecodeError("raw") yang menyebut COOP/COEP', async () => {
    const g = globalThis as { crossOriginIsolated?: boolean };
    g.crossOriginIsolated = false;
    try {
      const data = new Uint8Array(readFileSync(join(RAW_DIR, 'synthetic_rggb', 'input.dng')));
      const error = (await decodeImage(data, undefined, options).catch((e: unknown) => e)) as DecodeError;
      expect(error).toBeInstanceOf(DecodeError);
      expect(error.format).toBe('raw');
      expect(error.reason).toMatch(/COOP/);
    } finally {
      delete g.crossOriginIsolated;
    }
  });
});
