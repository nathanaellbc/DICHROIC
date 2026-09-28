import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectFormat, decodeImage, DecodeError } from '../../src/io';
import { buildTiff, RGB_TAGS } from './tiffBuilder';

const bytes = (...values: number[]) => new Uint8Array([...values, ...new Array(64).fill(0)]);
const ascii = (text: string, offset = 0) => {
  const out = new Uint8Array(64);
  out.set(Array.from(text, (c) => c.charCodeAt(0)), offset);
  return out;
};

describe('detectFormat: magic bytes', () => {
  it.each([
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ['exr', bytes(0x76, 0x2f, 0x31, 0x01)],
    ['tiff', buildTiff(RGB_TAGS)],
    ['tiff', buildTiff(RGB_TAGS, { bigEndian: true })],
  ] as const)('%s', (want, input) => {
    expect(detectFormat(input)).toBe(want);
  });

  it.each([
    ['ORF', ascii('IIRO')],
    ['RW2', bytes(0x49, 0x49, 0x55, 0x00)],
    ['RAF', ascii('FUJIFILMCCD-RAW 0201')],
    ['CR3', ascii('ftypcrx ', 4)],
    ['CRW', ascii('HEAPCCDR', 6)],
    ['X3F', ascii('FOVb')],
    ['MRW', bytes(0x00, 0x4d, 0x52, 0x4d)],
  ] as const)('RAW non-TIFF %s -> raw', (_name, input) => {
    expect(detectFormat(input)).toBe('raw');
  });

  it('berkas kosong atau terlalu pendek -> unknown', () => {
    expect(detectFormat(new Uint8Array(0))).toBe('unknown');
    expect(detectFormat(new Uint8Array([0xff, 0xd8]))).toBe('unknown');
  });

  it('byte acak -> unknown', () => {
    const random = new Uint8Array(256);
    let s = 12345;
    for (let i = 0; i < random.length; i += 1) random[i] = (s = (s * 1103515245 + 12345) >>> 0) >>> 24;
    random[0] = 0x13; // pastikan bukan magic yang dikenal
    expect(detectFormat(random)).toBe('unknown');
  });
});

describe('detectFormat: RAW berbasis TIFF', () => {
  it('DNG sintetis fixture -> raw', () => {
    const dng = new Uint8Array(readFileSync(join('test', 'fixtures', 'raw', 'synthetic_rggb', 'input.dng')));
    expect(detectFormat(dng)).toBe('raw');
  });

  it('tag DNGVersion di IFD0 -> raw', () => {
    expect(detectFormat(buildTiff([...RGB_TAGS, { tag: 50706, type: 4, values: [0x01040000] }]))).toBe('raw');
  });

  it('CR2 (II*\\0 + "CR" di offset 8) -> raw', () => {
    const cr2 = new Uint8Array(64);
    cr2.set([0x49, 0x49, 0x2a, 0x00, 0x10, 0, 0, 0, 0x43, 0x52, 0x02, 0x00]);
    expect(detectFormat(cr2)).toBe('raw');
  });

  it('NEF/ARW: SubIFD ber-photometric CFA -> raw (big dan little endian)', () => {
    const sub = [{ tag: 262, type: 3 as const, values: [32803] }];
    expect(detectFormat(buildTiff(RGB_TAGS, { subIfd: sub }))).toBe('raw');
    expect(detectFormat(buildTiff(RGB_TAGS, { subIfd: sub, bigEndian: true }))).toBe('raw');
  });

  it('kompresi vendor RAW (Sony 32767) di IFD0 -> raw', () => {
    const tags = RGB_TAGS.map((e) => (e.tag === 259 ? { ...e, values: [32767] } : e));
    expect(detectFormat(buildTiff(tags))).toBe('raw');
  });

  it('TIFF RGB biasa dengan tag Make kamera tetap tiff', () => {
    // Make (271) bertipe ASCII; builder hanya menulis SHORT/LONG, tapi
    // detektor tidak membedakan tipe untuk tag yang tidak dibacanya.
    expect(detectFormat(buildTiff([...RGB_TAGS, { tag: 271, type: 4, values: [0] }]))).toBe('tiff');
  });

  it('rantai IFD melingkar tidak menggantung', () => {
    const tiff = buildTiff(RGB_TAGS);
    const view = new DataView(tiff.buffer);
    view.setUint32(8 + 2 + RGB_TAGS.length * 12, 8, true); // next IFD -> IFD0 lagi
    expect(detectFormat(tiff)).toBe('tiff');
  });

  it('offset IFD di luar berkas -> tiff (decoder yang melaporkan kerusakan)', () => {
    const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0xff, 0xff, 0x00, 0x00]);
    expect(detectFormat(tiff)).toBe('tiff');
  });
});

describe('decodeImage', () => {
  it('byte acak -> DecodeError("unknown")', async () => {
    const wasmBinary = new Uint8Array(readFileSync(join('node_modules', 'libraw-wasm', 'dist', 'libraw.wasm')));
    const error = await decodeImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), undefined, { raw: { wasmBinary } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecodeError);
    expect((error as DecodeError).format).toBe('unknown');
  });
});
