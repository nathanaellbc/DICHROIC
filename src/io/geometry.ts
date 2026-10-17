/**
 * Crop & rotate (seperti galeri HP): potongan sumbu-sejajar di ruang tampilan
 * foto yang sudah diputar (luruskan +-45 derajat + kelipatan 90) dan
 * dicerminkan. Dipakai pratinjau (transform CSS, PhotoView/CropEditor) dan
 * ekspor (piksel diambil ulang di worker sebelum encode), jadi keduanya
 * berbagi satu definisi.
 *
 * Satuan: lebar sumber = 1. Sumber menempati [0, 1] x [0, A] dengan
 * A = tinggi / lebar, jadi crop sama untuk pratinjau resolusi berapa pun.
 *
 * Tampilan dari sumber: d = F(R(phi)(s - C)), phi = quarter*90 + angle
 * (derajat, positif = searah jarum jam di koordinat y-ke-bawah, sama dengan
 * CSS `rotate()`), F = cermin horizontal. Potongan = d dalam
 * [-w/2, w/2] x [-h/2, h/2].
 */

export interface Crop {
  /** Pusat potongan di sumber (satuan lebar sumber). */
  cx: number;
  cy: number;
  /** Ukuran potongan di ruang tampilan (satuan lebar sumber). */
  w: number;
  h: number;
  /** Luruskan, derajat, -45..45. */
  angle: number;
  /** Putar 90 derajat searah jarum jam, 0..3. */
  quarter: 0 | 1 | 2 | 3;
  /** Cermin horizontal (setelah putar). */
  flip: boolean;
  /** Rasio terkunci (`free`, `original`, atau `w:h`), untuk UI. */
  aspect: string;
}

const RAD = Math.PI / 180;

export function identityCrop(a: number): Crop {
  return { cx: 0.5, cy: a / 2, w: 1, h: a, angle: 0, quarter: 0, flip: false, aspect: 'free' };
}

export function isIdentityCrop(c: Crop | undefined, a: number): boolean {
  if (!c) return true;
  const eps = 1e-6;
  return c.angle === 0 && c.quarter === 0 && !c.flip && Math.abs(c.cx - 0.5) < eps && Math.abs(c.cy - a / 2) < eps
    && Math.abs(c.w - 1) < eps && Math.abs(c.h - a) < eps;
}

export function totalAngle(c: Crop): number {
  return c.quarter * 90 + c.angle;
}

/** Setengah jangkauan potongan di sumber per sumbu (untuk batas pusat). */
function extents(c: Crop): { ex: number; ey: number } {
  const phi = totalAngle(c) * RAD, cos = Math.abs(Math.cos(phi)), sin = Math.abs(Math.sin(phi));
  return { ex: (c.w * cos + c.h * sin) / 2, ey: (c.w * sin + c.h * cos) / 2 };
}

/** Potongan muat seluruhnya di dalam foto (tanpa sudut kosong). */
export function cropFits(c: Crop, a: number): boolean {
  const { ex, ey } = extents(c);
  const eps = 1e-6;
  return c.cx - ex >= -eps && c.cx + ex <= 1 + eps && c.cy - ey >= -eps && c.cy + ey <= a + eps;
}

/**
 * Paksa potongan muat: perkecil (rasio tetap) bila terlalu besar untuk sudut
 * ini, lalu geser pusatnya ke dalam. Seperti galeri: meluruskan memperbesar
 * foto, bukan memperlihatkan sudut kosong.
 */
export function fitCrop(c: Crop, a: number): Crop {
  let { w, h } = c;
  let { ex, ey } = extents(c);
  const s = Math.min(1, ex > 0 ? 1 / (2 * ex) : 1, ey > 0 ? a / (2 * ey) : 1);
  if (s < 1) {
    w *= s; h *= s; ex *= s; ey *= s;
  }
  const cx = Math.min(1 - ex, Math.max(ex, c.cx));
  const cy = Math.min(a - ey, Math.max(ey, c.cy));
  return { ...c, w, h, cx, cy };
}

/** Rasio `w:h` dari kunci rasio (`undefined` = bebas). */
export function aspectRatio(aspect: string, a: number, quarter: number): number | undefined {
  if (aspect === 'free') return undefined;
  if (aspect === 'original') return quarter % 2 ? a : 1 / a;
  const [x, y] = aspect.split(':').map(Number);
  return x && y ? x / y : undefined;
}

/**
 * Kunci rasio baru: potongan terbesar dengan rasio itu di foto utuh (pada
 * sudut sekarang), berpusat di potongan sekarang, lalu dipaskan ke foto.
 */
export function withAspect(c: Crop, aspect: string, a: number): Crop {
  const r = aspectRatio(aspect, a, c.quarter);
  if (!r) return { ...c, aspect };
  const fw = c.quarter % 2 ? a : 1, fh = c.quarter % 2 ? 1 : a;
  const w = Math.min(fw, fh * r);
  // Pusat di tengah foto dulu supaya ukuran terbesar yang muat dihitung benar, lalu kembali ke pusat potongan.
  const big = fitCrop({ ...c, cx: 0.5, cy: a / 2, w, h: w / r, aspect }, a);
  return fitCrop({ ...big, cx: c.cx, cy: c.cy }, a);
}

/** Putar 90 derajat searah jarum jam: area yang sama, kotak tampilan bertukar sisi. */
export function rotateQuarter(c: Crop, a: number): Crop {
  return fitCrop({ ...c, quarter: ((c.quarter + 1) % 4) as Crop['quarter'], w: c.h, h: c.w, aspect: flipAspect(c.aspect) }, a);
}

function flipAspect(aspect: string): string {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect);
  return m ? `${m[2]}:${m[1]}` : aspect;
}

/** Titik kotak potongan (0..1, 0..1) -> titik foto (u, v) 0..1. */
export function boxToImage(c: Crop, a: number, bx: number, by: number): { u: number; v: number } {
  let dx = (bx - 0.5) * c.w;
  const dy = (by - 0.5) * c.h;
  if (c.flip) dx = -dx;
  const phi = totalAngle(c) * RAD, cos = Math.cos(phi), sin = Math.sin(phi);
  // R(-phi)
  const sx = c.cx + dx * cos + dy * sin;
  const sy = c.cy - dx * sin + dy * cos;
  return { u: sx, v: sy / a };
}

/** Titik foto (u, v) -> titik kotak potongan (0..1 bila di dalam). */
export function imageToBox(c: Crop, a: number, u: number, v: number): { x: number; y: number } {
  const px = u - c.cx, py = v * a - c.cy;
  const phi = totalAngle(c) * RAD, cos = Math.cos(phi), sin = Math.sin(phi);
  let dx = px * cos - py * sin;
  const dy = px * sin + py * cos;
  if (c.flip) dx = -dx;
  return { x: dx / c.w + 0.5, y: dy / c.h + 0.5 };
}

/** Ukuran keluaran (px) untuk sumber selebar `width`. */
export function cropOutputSize(c: Crop, width: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(c.w * width)), height: Math.max(1, Math.round(c.h * width)) };
}

/**
 * Gaya CSS lapisan foto penuh di dalam kotak potongan: kotak (`overflow:
 * hidden`) menampilkan potongannya; persen relatif kotak/lapisan itu sendiri,
 * jadi tidak bergantung ukuran piksel.
 */
export function cropLayerStyle(c: Crop, a: number): { left: string; top: string; width: string; height: string; transformOrigin: string; transform: string } {
  return {
    left: '50%', top: '50%',
    width: `${100 / c.w}%`, height: `${(100 * a) / c.h}%`,
    transformOrigin: '0 0',
    transform: `${c.flip ? 'scaleX(-1) ' : ''}rotate(${totalAngle(c)}deg) translate(${-c.cx * 100}%, ${(-c.cy / a) * 100}%)`,
  };
}

type Pixels = Uint8Array | Uint8ClampedArray | Uint16Array;

/**
 * Potong + putar piksel (bilinear; potongan tanpa putar/cermin = salin
 * langsung). `channels` 3 (RGB) atau 4 (RGBA).
 */
export function applyCrop<T extends Pixels>(src: T, width: number, height: number, channels: number, c: Crop): { data: T; width: number; height: number } {
  const out = cropOutputSize(c, width);
  const data = new (src.constructor as { new (n: number): T })(out.width * out.height * channels);
  const phi = totalAngle(c) * RAD;
  const straight = c.angle === 0 && c.quarter === 0 && !c.flip;
  if (straight) {
    const x0 = Math.round((c.cx - c.w / 2) * width), y0 = Math.round((c.cy - c.h / 2) * width);
    for (let y = 0; y < out.height; y++) {
      const sy = Math.min(height - 1, Math.max(0, y0 + y));
      const sx = Math.min(width - out.width, Math.max(0, x0));
      data.set(src.subarray((sy * width + sx) * channels, (sy * width + sx + out.width) * channels) as never, y * out.width * channels);
    }
    return { data, width: out.width, height: out.height };
  }
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const max = src instanceof Uint16Array ? 65535 : 255;
  for (let y = 0; y < out.height; y++) {
    const dy = ((y + 0.5) / out.height - 0.5) * c.h;
    for (let x = 0; x < out.width; x++) {
      let dx = ((x + 0.5) / out.width - 0.5) * c.w;
      if (c.flip) dx = -dx;
      // Sumber (px), pusat piksel di +0.5.
      const fx = (c.cx + dx * cos + dy * sin) * width - 0.5;
      const fy = (c.cy - dx * sin + dy * cos) * width - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const xa = Math.min(width - 1, Math.max(0, x0)), xb = Math.min(width - 1, Math.max(0, x0 + 1));
      const ya = Math.min(height - 1, Math.max(0, y0)), yb = Math.min(height - 1, Math.max(0, y0 + 1));
      const o = (y * out.width + x) * channels;
      for (let k = 0; k < channels; k++) {
        const v = (src[(ya * width + xa) * channels + k]! * (1 - tx) + src[(ya * width + xb) * channels + k]! * tx) * (1 - ty)
          + (src[(yb * width + xa) * channels + k]! * (1 - tx) + src[(yb * width + xb) * channels + k]! * tx) * ty;
        data[o + k] = Math.min(max, Math.max(0, Math.round(v)));
      }
    }
  }
  return { data, width: out.width, height: out.height };
}
