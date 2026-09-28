import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodeImage } from '../../src/io';
import { encodePng, encodeTiff16, quantize } from '../../src/io/encode';

describe('quantize', () => {
  it('clamp, NaN -> 0, tanpa wrap-around, pembulatan terdekat', () => {
    const input = new Float32Array([NaN, -0.5, -0, 0, 1 / 255 / 2 - 1e-6, 1 / 255 / 2 + 1e-6, 0.5, 1, 1.5, Infinity, -Infinity]);
    expect(Array.from(quantize(input, 8))).toEqual([0, 0, 0, 0, 0, 1, 128, 255, 255, 255, 0]);
    expect(Array.from(quantize(new Float32Array([0.5, 2, NaN]), 16))).toEqual([32768, 65535, 0]);
  });
});

const W = 37;
const H = 23;

/** Gradien penuh dengan nilai tepi, di luar rentang, dan NaN. */
function testImage(): Float32Array {
  const rgb = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      rgb[i] = x / (W - 1);
      rgb[i + 1] = y / (H - 1);
      rgb[i + 2] = ((x * 7 + y * 13) % 101) / 100;
    }
  }
  rgb[0] = NaN;
  rgb[1] = -0.25;
  rgb[2] = 1.75;
  return rgb;
}

const FORMATS = [
  { name: 'PNG 8-bit', bits: 8 as const, encode: (rgb: Float32Array) => encodePng(rgb, W, H, 8), ext: 'png', reader: 'pillow' },
  { name: 'PNG 16-bit', bits: 16 as const, encode: (rgb: Float32Array) => encodePng(rgb, W, H, 16), ext: 'png', reader: 'oiio' },
  { name: 'TIFF 16-bit', bits: 16 as const, encode: (rgb: Float32Array) => encodeTiff16(rgb, W, H), ext: 'tif', reader: 'tifffile' },
];

describe.each(FORMATS)('$name', ({ bits, encode }) => {
  it('round-trip lewat decoder io/ bit-identik dengan quantize', async () => {
    const rgb = testImage();
    const q = quantize(rgb, bits);
    const image = await decodeImage(encode(rgb));
    expect([image.width, image.height, image.source.bitDepth]).toEqual([W, H, bits]);
    const max = bits === 8 ? 255 : 65535;
    let mismatch = 0;
    for (let i = 0; i < W * H; i += 1) {
      for (let c = 0; c < 3; c += 1) if (image.rgba[i * 4 + c] !== Math.fround(q[i * 3 + c]! / max)) mismatch += 1;
    }
    expect(mismatch).toBe(0);
  });

  it('dimensi atau panjang data salah -> RangeError', () => {
    expect(() => encode(new Float32Array(10))).toThrow(RangeError);
  });
});

/**
 * Python `.venv-ref` (tools/setup_envs.md): `DICHROIC_REF_PYTHON`, atau
 * `../upstream/.venv-ref` di samping repositori.
 */
function refPython(): string | undefined {
  const candidates = [
    process.env.DICHROIC_REF_PYTHON,
    resolve('..', 'upstream', '.venv-ref', 'bin', 'python'),
    resolve('..', 'upstream', '.venv-ref', 'Scripts', 'python.exe'),
  ];
  return candidates.find((p): p is string => !!p && existsSync(p));
}

const python = refPython();

describe.each(FORMATS)('$name dibaca pustaka pihak lain ($reader)', ({ bits, encode, ext, reader }) => {
  it.skipIf(!python)(
    python ? 'bit-identik' : 'DILEWATI: .venv-ref tidak ditemukan (set DICHROIC_REF_PYTHON atau ../upstream/.venv-ref)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'dichroic-encode-'));
      try {
        const rgb = testImage();
        const imagePath = join(dir, `image.${ext}`);
        const outPath = join(dir, 'samples.u16');
        writeFileSync(imagePath, encode(rgb));
        const run = spawnSync(python!, [join('tools', 'read_image_oracle.py'), reader, imagePath, outPath], { encoding: 'utf8' });
        expect(run.status, run.stderr).toBe(0);
        const raw = readFileSync(outPath);
        const got = new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
        expect(Array.from(got)).toEqual(Array.from(quantize(rgb, bits)));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
