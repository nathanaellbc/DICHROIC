/**
 * Piksel foto sumber yang dipegang `Session`, disimpan seringkas mungkin
 * TANPA mengubah satu nilai pun.
 *
 * Decoder menghasilkan RGBA f32 (16 B/px). Foto 8-bit (JPEG, HEIC lewat
 * browser, PNG 8-bit) hanya berisi nilai `k / 255`, foto 16-bit hanya
 * `k / 65535` -- jadi disimpan sebagai kode Uint8/Uint16 plus tabel
 * `lut[k] = fround(k / max)`: 4 B/px atau 8 B/px, dan setiap pembacaan
 * memberi float32 yang sama persis dengan larik aslinya. Foto 21,6 MP:
 * 86 MB, bukan 346 MB -- selisih yang membuat ekspor iPhone dimatikan
 * sistem di tile-tile terakhir. Sumber float sungguhan (RAW, EXR, TIFF
 * float) tetap f32.
 */
export type SourceData = Float32Array | Uint8Array | Uint16Array;

function table(max: number): Float32Array {
  const lut = new Float32Array(max + 1);
  for (let k = 0; k <= max; k += 1) lut[k] = k / max;
  return lut;
}

let lut8: Float32Array | undefined;
let lut16: Float32Array | undefined;

/** Semua nilai = `lut[round(v * max)]` persis (termasuk alpha)? Berhenti di nilai pertama yang tidak. */
function fits(rgba: Float32Array, lut: Float32Array): boolean {
  const max = lut.length - 1;
  for (let i = 0; i < rgba.length; i += 1) {
    const v = rgba[i]!;
    if (!(v >= 0 && v <= 1)) return false;
    if (lut[Math.round(v * max)] !== v) return false;
  }
  return true;
}

export class SourcePixels {
  private constructor(readonly data: SourceData, readonly lut: Float32Array | undefined) {}

  /** Simpan `rgba` dalam bentuk terkecil yang lossless (`rgba` tidak dipegang bila diringkas). */
  static from(rgba: Float32Array): SourcePixels {
    lut8 ??= table(255);
    if (fits(rgba, lut8)) {
      const codes = new Uint8Array(rgba.length);
      for (let i = 0; i < rgba.length; i += 1) codes[i] = Math.round(rgba[i]! * 255);
      return new SourcePixels(codes, lut8);
    }
    lut16 ??= table(65535);
    if (fits(rgba, lut16)) {
      const codes = new Uint16Array(rgba.length);
      for (let i = 0; i < rgba.length; i += 1) codes[i] = Math.round(rgba[i]! * 65535);
      return new SourcePixels(codes, lut16);
    }
    return new SourcePixels(rgba, undefined);
  }

  /** Bungkus RGBA f32 apa adanya (tanpa diringkas), mis. setelah hapus objek mengubah nilainya. */
  static float(rgba: Float32Array): SourcePixels {
    return new SourcePixels(rgba, undefined);
  }

  get length(): number {
    return this.data.length;
  }

  get byteLength(): number {
    return this.data.byteLength;
  }

  /** Larik f32 mentah bila sumbernya memang float (tanpa salinan). */
  get float(): Float32Array | undefined {
    return this.lut ? undefined : (this.data as Float32Array);
  }

  /** RGBA f32 penuh: tanpa salinan bila float, selain itu salinan sementara. */
  toFloat(): Float32Array {
    if (!this.lut) return this.data as Float32Array;
    const out = new Float32Array(this.data.length);
    const { data, lut } = this;
    for (let i = 0; i < data.length; i += 1) out[i] = lut[data[i]!]!;
    return out;
  }
}
