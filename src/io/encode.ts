/**
 * Encoder ekspor (spec Fase 2 §5): PNG 8/16-bit (`fast-png`) dan TIFF 16-bit
 * (`tiffWriter.ts`). Masukan `rgb_out` 3 kanal rapat yang sudah ter-encode di
 * `outputColorSpace`; tidak ada konversi warna di sini. Profil ICC belum
 * disematkan -- penampil akan menganggap sRGB.
 */
import { encode } from 'fast-png';
import { encodeTiff16 as writeTiff16 } from './tiffWriter';

/**
 * Clamp ke [0,1] lalu bulatkan ke bilangan bulat terdekat (`round(v * max)`,
 * setengah dibulatkan ke atas). NaN -> 0, +Inf -> max, -Inf -> 0: nilai di
 * luar rentang tidak boleh membungkus (wrap-around) seperti konversi integer
 * mentah (Review Focus #5 rencana 2B).
 */
export function quantize(rgb: Float32Array, bits: 8 | 16): Uint8Array | Uint16Array {
  const max = bits === 8 ? 255 : 65535;
  const out = bits === 8 ? new Uint8Array(rgb.length) : new Uint16Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 1) {
    const v = rgb[i]!;
    out[i] = v > 0 ? (v >= 1 ? max : Math.round(v * max)) : 0; // `v > 0` salah untuk NaN
  }
  return out;
}

function checkSize(rgb: Float32Array, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`dimensi tidak sah: ${width}x${height}`);
  }
  if (rgb.length !== width * height * 3) {
    throw new RangeError(`butuh ${width * height * 3} nilai RGB untuk ${width}x${height}, diterima ${rgb.length}`);
  }
}

export function encodePng(rgb: Float32Array, width: number, height: number, bits: 8 | 16): Uint8Array {
  checkSize(rgb, width, height);
  return encode({ width, height, data: quantize(rgb, bits), depth: bits, channels: 3 });
}

export function encodeTiff16(rgb: Float32Array, width: number, height: number): Uint8Array {
  checkSize(rgb, width, height);
  return writeTiff16(quantize(rgb, 16) as Uint16Array, width, height);
}
