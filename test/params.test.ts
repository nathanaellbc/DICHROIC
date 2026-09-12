import { describe, it, expect } from 'vitest';
import {
  CORE_PARAMS_BYTES,
  CORE_PARAMS_WGSL,
  CORE_PARAMS_FIELD_NAMES,
  writeCoreParams,
  FLAG_COLOR_ADAPTATION_CURVE_SMOOTHING,
} from '../src/engine/params';
import type { CoreParams } from '../src/engine/params';

/**
 * Urutan field ini diverifikasi langsung dari blok push-constant hulu:
 *
 *   sed -n '/layout(push_constant)/,/} params;/p' \
 *     "$SPEKTRAFILM_OFX/shaders/vulkan/SpektraCurveDevelop.comp"
 *
 * dan dicocokkan dengan SpektraDiffusion.comp, SpektraFilmExposure.comp,
 * SpektraHalation.comp, SpektraDir.comp, SpektraGrain.comp,
 * SpektraPrintScan.comp, dan SpektraScannerPost.comp — kedelapan shader yang
 * memakai blok CoreParams berbagi urutan dan jumlah field yang identik; hanya
 * tiga slot tengah (di sini slot0/slot1/slot2) diberi nama lokal berbeda per
 * shader. Daftar ini sengaja ditulis ulang di sini, independen dari
 * `FIELDS` internal params.ts, supaya test benar-benar membandingkan
 * implementasi dengan hulu — bukan dengan dirinya sendiri.
 */
const EXPECTED_FIELDS: ReadonlyArray<readonly [keyof CoreParams, 'u32' | 'i32' | 'f32']> = [
  ['width', 'u32'],
  ['height', 'u32'],
  ['filmExposureEv', 'f32'],
  ['filmGamma', 'f32'],
  ['exposureCount', 'u32'],
  ['inputColorSpace', 'i32'],
  ['rgbToRawMethod', 'i32'],
  ['colorSpaceCount', 'u32'],
  ['transferLutSize', 'u32'],
  ['colorDecodeMin', 'f32'],
  ['colorDecodeMax', 'f32'],
  ['hanatosWidth', 'u32'],
  ['hanatosHeight', 'u32'],
  ['slot0', 'u32'],
  ['slot1', 'u32'],
  ['slot2', 'u32'],
  ['filmPushPullMode', 'i32'],
  ['filmPushPullStops', 'f32'],
  ['fullWidth', 'u32'],
  ['fullHeight', 'u32'],
  ['tileOriginX', 'u32'],
  ['tileOriginY', 'u32'],
  ['activeOriginX', 'u32'],
  ['activeOriginY', 'u32'],
  ['activeWidth', 'u32'],
  ['activeHeight', 'u32'],
];

const sample: CoreParams = {
  width: 1920,
  height: 1080,
  filmExposureEv: 0.5,
  filmGamma: 1.0,
  exposureCount: 256,
  inputColorSpace: 15,
  rgbToRawMethod: 2,
  colorSpaceCount: 26,
  transferLutSize: 4096,
  colorDecodeMin: -0.25,
  colorDecodeMax: 16.0,
  hanatosWidth: 192,
  hanatosHeight: 192,
  slot0: 7,
  slot1: FLAG_COLOR_ADAPTATION_CURVE_SMOOTHING,
  slot2: 65537,
  filmPushPullMode: -3,
  filmPushPullStops: -1.5,
  fullWidth: 3840,
  fullHeight: 2160,
  tileOriginX: 64,
  tileOriginY: 128,
  activeOriginX: 1,
  activeOriginY: 2,
  activeWidth: 1918,
  activeHeight: 1078,
};

describe('CoreParams', () => {
  it('cocok persis dengan urutan dan jumlah field blok push-constant hulu', () => {
    expect(EXPECTED_FIELDS).toHaveLength(26);
    expect(CORE_PARAMS_FIELD_NAMES).toEqual(EXPECTED_FIELDS.map(([name]) => name));
  });

  it('berukuran kelipatan 16 byte agar sah sebagai uniform', () => {
    expect(CORE_PARAMS_BYTES % 16).toBe(0);
    expect(CORE_PARAMS_BYTES).toBe(112); // ceil(26*4/16)*16, bukan 96
  });

  it('sample mencakup persis 26 field — TypeScript menolak kompilasi bila interface dan sample tidak sinkron', () => {
    expect(Object.keys(sample)).toHaveLength(26);
  });

  it('WGSL mendeklarasikan struct dengan jumlah dan urutan field yang sama dengan hulu', () => {
    const fields = [...CORE_PARAMS_WGSL.matchAll(/^\s+(\w+)\s*:/gm)].map((m) => m[1]);
    expect(fields).toEqual(EXPECTED_FIELDS.map(([name]) => name));
  });

  it('membawa flag colour adaptation di slot1, bit 1', () => {
    expect(FLAG_COLOR_ADAPTATION_CURVE_SMOOTHING).toBe(2);
  });

  it('menulis setiap field pada offset byte yang benar, dengan tipe yang benar (integer vs float tidak tertukar)', () => {
    const buffer = new ArrayBuffer(CORE_PARAMS_BYTES);
    writeCoreParams(sample, buffer);
    const view = new DataView(buffer);

    EXPECTED_FIELDS.forEach(([name, kind], index) => {
      const offset = index * 4;
      const expected = sample[name];
      if (kind === 'f32') {
        expect(view.getFloat32(offset, true)).toBeCloseTo(expected, 5);
      } else if (kind === 'i32') {
        expect(view.getInt32(offset, true)).toBe(expected);
      } else {
        expect(view.getUint32(offset, true)).toBe(expected);
      }
    });
  });

  it('tidak menyilangkan tata letak float/integer: byte mentah filmExposureEv (0.5) bukan bit pattern integer 0.5', () => {
    const buffer = new ArrayBuffer(CORE_PARAMS_BYTES);
    writeCoreParams(sample, buffer);
    const u32 = new Uint32Array(buffer);
    // offset field ke-2 (filmExposureEv) — bit pattern IEEE-754 dari 0.5,
    // BUKAN integer 0 yang akan muncul bila nilai float dibulatkan/di-cast.
    expect(u32[2]).toBe(0x3f000000);
  });

  it('menulis integer negatif (i32) dengan benar, bukan sebagai unsigned', () => {
    const buffer = new ArrayBuffer(CORE_PARAMS_BYTES);
    writeCoreParams(sample, buffer);
    const view = new DataView(buffer);
    // filmPushPullMode adalah field ke-17 (index 16) → offset 64.
    expect(view.getInt32(64, true)).toBe(-3);
  });

  it('menolak buffer yang lebih kecil dari CORE_PARAMS_BYTES', () => {
    const tooSmall = new ArrayBuffer(CORE_PARAMS_BYTES - 4);
    expect(() => writeCoreParams(sample, tooSmall)).toThrow();
  });
});
