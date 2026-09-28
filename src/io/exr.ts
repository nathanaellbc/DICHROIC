/**
 * Decoder OpenEXR (`parse-exr`, MIT; port EXRLoader three.js): scanline atau
 * tile satu level, kompresi none/RLE/ZIPS/ZIP/PIZ/PXR24/DWAA/DWAB, kanal
 * R/G/B(/A) atau Y saja. Keluaran linear; colour space disarankan dari atribut
 * `chromaticities` (spec Fase 2 §5).
 *
 * Pagar di atas `parse-exr`, yang diam-diam salah pada kasus berikut:
 * - tipe piksel diambil dari kanal R/G/B/A/Y TERAKHIR untuk semua kanal,
 *   jadi campuran half/float dibaca salah -> ditolak;
 * - berkas luminance-chroma (Y + RY/BY) dikembalikan sebagai grayscale Y
 *   saja -> ditolak;
 * - kanal ber-layer (`diffuse.R`) tidak dikenali -> ditolak dengan nama
 *   kanal yang ada.
 * - baris ditulis dari bawah ke atas (konvensi tekstur) -> dibalik;
 * - chunk scanline ditempatkan menurut urutan berkas, bukan y-nya -> berkas
 *   `decreasingY` disusun ulang dulu (`toIncreasingY`).
 * Y saja (grayscale sah) disebar ke RGB. Yang dibaca adalah data window,
 * seperti OpenImageIO.
 */
import parseExr from 'parse-exr';
import type { DecodedImage } from './decoded';

const FLOAT_TYPE = 1015;

type Chromaticities = [number, number, number, number, number, number, number, number];

/** Primer + titik putih (Rx, Ry, Gx, Gy, Bx, By, Wx, Wy) -> label manifest. */
const KNOWN_PRIMARIES: Array<[string, Chromaticities]> = [
  ['ACES2065-1', [0.7347, 0.2653, 0.0, 1.0, 0.0001, -0.077, 0.32168, 0.33767]],
  ['ACEScg', [0.713, 0.293, 0.165, 0.83, 0.128, 0.044, 0.32168, 0.33767]],
  ['Linear Rec.709', [0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329]],
  ['Linear Rec.2020', [0.708, 0.292, 0.17, 0.797, 0.131, 0.046, 0.3127, 0.329]],
  ['Linear P3-D65', [0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329]],
];

/** Toleransi pencocokan: atribut disimpan float32, dan penulis membulatkan beda-beda. */
const CHROMATICITY_TOLERANCE = 2e-3;

interface ExrChannel {
  name: string;
  pixelType: number; // 0 uint, 1 half, 2 float
  xSampling: number;
  ySampling: number;
}

interface ExrHeader {
  flags: number;
  channels: ExrChannel[];
  chromaticities?: Chromaticities;
  compression?: number;
  /** Offset byte nilai atribut `lineOrder` (0 increasingY, 1 decreasingY). */
  lineOrderAt?: number;
  dataWindow?: [number, number, number, number];
  /** Offset byte pertama setelah header (awal tabel offset chunk). */
  end: number;
}

/**
 * Pembaca header minimal: cukup untuk memeriksa kanal dan chromaticities
 * SEBELUM `parse-exr` mendecode (pustaka itu tidak memberi kesempatan).
 */
function readHeader(bytes: Uint8Array): ExrHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (at: number, n: number) => {
    if (at + n > bytes.length) throw new Error('header EXR terpotong');
  };
  need(0, 8);
  if (view.getUint32(0, true) !== 20000630) throw new Error('bukan OpenEXR');
  const flags = view.getUint8(5);
  let pos = 8;
  const cstring = (): string => {
    const end = bytes.indexOf(0, pos);
    if (end < 0) throw new Error('header EXR terpotong');
    const text = String.fromCharCode(...bytes.subarray(pos, end));
    pos = end + 1;
    return text;
  };
  const header: ExrHeader = { flags, channels: [], end: 0 };
  for (;;) {
    const attr = cstring();
    if (attr === '') break;
    const type = cstring();
    need(pos, 4);
    const size = view.getUint32(pos, true);
    pos += 4;
    need(pos, size);
    const end = pos + size;
    if (attr === 'channels' && type === 'chlist') {
      while (pos < end && bytes[pos] !== 0) {
        const channelName = cstring();
        need(pos, 16);
        header.channels.push({
          name: channelName,
          pixelType: view.getInt32(pos, true),
          xSampling: view.getInt32(pos + 8, true),
          ySampling: view.getInt32(pos + 12, true),
        });
        pos += 16;
      }
    } else if (attr === 'chromaticities' && type === 'chromaticities' && size === 32) {
      header.chromaticities = Array.from({ length: 8 }, (_, i) => view.getFloat32(pos + i * 4, true)) as Chromaticities;
    } else if (attr === 'compression' && size === 1) {
      header.compression = bytes[pos];
    } else if (attr === 'lineOrder' && size === 1) {
      header.lineOrderAt = pos;
    } else if (attr === 'dataWindow' && size === 16) {
      header.dataWindow = [0, 4, 8, 12].map((k) => view.getInt32(pos + k, true)) as [number, number, number, number];
    }
    pos = end;
  }
  header.end = pos;
  return header;
}

/** Baris per chunk scanline menurut kompresi (spesifikasi OpenEXR). */
const LINES_PER_CHUNK = [1, 1, 1, 16, 32, 16, 32, 32, 32, 256];

/**
 * `parse-exr` menempatkan chunk scanline menurut URUTANNYA di berkas, bukan
 * menurut koordinat y yang dibawa tiap chunk -- berkas `decreasingY` jadi
 * teracak. Chunk disusun ulang menaik (memakai y di header chunk) dan
 * `lineOrder` diset `increasingY`; isi chunk tidak disentuh.
 */
function toIncreasingY(bytes: Uint8Array, header: ExrHeader): Uint8Array {
  const at = header.lineOrderAt;
  if (at === undefined || bytes[at] !== 1 || header.flags & 0x02 || !header.dataWindow) return bytes;
  const lines = LINES_PER_CHUNK[header.compression ?? 0];
  if (lines === undefined) return bytes; // kompresi tak dikenal: biar parse-exr yang menolak
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const height = header.dataWindow[3] - header.dataWindow[1] + 1;
  const count = Math.ceil(height / lines);
  const chunks: Array<{ y: number; data: Uint8Array }> = [];
  for (let i = 0; i < count; i += 1) {
    const tableAt = header.end + i * 8;
    if (tableAt + 8 > bytes.length) throw new Error('tabel offset EXR terpotong');
    const offset = Number(view.getBigUint64(tableAt, true));
    if (offset + 8 > bytes.length) throw new Error('chunk EXR di luar berkas (terpotong?)');
    const size = view.getInt32(offset + 4, true);
    if (size < 0 || offset + 8 + size > bytes.length) throw new Error('chunk EXR terpotong');
    chunks.push({ y: view.getInt32(offset, true), data: bytes.subarray(offset, offset + 8 + size) });
  }
  chunks.sort((a, b) => a.y - b.y);
  const tableEnd = header.end + count * 8;
  const out = new Uint8Array(tableEnd + chunks.reduce((n, c) => n + c.data.length, 0));
  out.set(bytes.subarray(0, header.end));
  out[at] = 0;
  const outView = new DataView(out.buffer);
  let pos = tableEnd;
  chunks.forEach((c, i) => {
    outView.setBigUint64(header.end + i * 8, BigInt(pos), true);
    out.set(c.data, pos);
    pos += c.data.length;
  });
  return out;
}

export function colorSpaceFromChromaticities(c: Chromaticities | undefined): string {
  if (!c) return 'Linear Rec.709';
  for (const [label, want] of KNOWN_PRIMARIES) {
    if (want.every((v, i) => Math.abs(v - c[i]!) <= CHROMATICITY_TOLERANCE)) return label;
  }
  // Primer tak dikenal: saran hanya saran (spec §5); pengguna memilih sendiri.
  return 'Linear Rec.709';
}

/** Periksa kanal sebelum menyerahkan ke `parse-exr` (lihat komentar berkas). */
function checkChannels(channels: ExrChannel[]): { gray: boolean; pixelType: number } {
  const names = new Set(channels.map((c) => c.name));
  const listed = channels.map((c) => c.name).join(', ') || '(tidak ada)';
  const rgb = names.has('R') && names.has('G') && names.has('B');
  if (!rgb && (names.has('RY') || names.has('BY'))) {
    throw new Error('EXR luminance-chroma (Y/RY/BY) belum didukung');
  }
  if (!rgb && !names.has('Y')) throw new Error(`EXR tanpa kanal R/G/B atau Y (kanal: ${listed})`);
  const used = channels.filter((c) => (rgb ? ['R', 'G', 'B', 'A'] : ['Y']).includes(c.name));
  if (used.some((c) => c.xSampling !== 1 || c.ySampling !== 1)) throw new Error('EXR dengan kanal tersubsampel belum didukung');
  const types = new Set(used.map((c) => c.pixelType));
  if (types.size !== 1) throw new Error('EXR dengan tipe piksel campuran (half/float) belum didukung');
  const pixelType = used[0]!.pixelType;
  if (pixelType !== 1 && pixelType !== 2) throw new Error('EXR bertipe piksel uint belum didukung');
  return { gray: !rgb, pixelType };
}

export function decodeExr(bytes: Uint8Array, name?: string): DecodedImage {
  const header = readHeader(bytes);
  if (header.flags & 0x18) throw new Error('EXR multi-part atau deep belum didukung');
  const { gray, pixelType } = checkChannels(header.channels);

  // parse-exr butuh ArrayBuffer yang tepat seukuran berkas.
  const exr = parseExr(toIncreasingY(bytes, header).slice().buffer, FLOAT_TYPE);
  const { width, height, data } = exr;
  const n = width * height;
  const channels = gray ? 1 : 4;
  if (!(data instanceof Float32Array) || data.length !== n * channels) {
    throw new Error('keluaran parse-exr tidak sesuai ukuran data window');
  }
  // parse-exr menulis baris dari bawah ke atas (konvensi tekstur WebGL
  // three.js); dibalik ke baris-mayor dari atas seperti semua decoder lain.
  const rgba = new Float32Array(n * 4);
  for (let y = 0; y < height; y += 1) {
    const src = (height - 1 - y) * width;
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const j = src + x;
      if (gray) {
        const v = data[j]!;
        rgba[i * 4] = v;
        rgba[i * 4 + 1] = v;
        rgba[i * 4 + 2] = v;
        rgba[i * 4 + 3] = 1;
      } else {
        rgba[i * 4] = data[j * 4]!;
        rgba[i * 4 + 1] = data[j * 4 + 1]!;
        rgba[i * 4 + 2] = data[j * 4 + 2]!;
        rgba[i * 4 + 3] = data[j * 4 + 3]!;
      }
    }
  }
  return {
    width,
    height,
    rgba,
    suggestedColorSpace: colorSpaceFromChromaticities(header.chromaticities),
    encoding: 'linear',
    source: { format: 'exr', bitDepth: pixelType === 1 ? 16 : 32, ...(name === undefined ? {} : { name }) },
  };
}
