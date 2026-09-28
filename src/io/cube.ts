/**
 * Ekspor `.cube` 3D (Resolve/Adobe). Spec induk §7.2: kubus identitas
 * `size^3` diumpankan sebagai "frame" ke rantai yang sama, hasilnya dibaca
 * balik dan diformat -- tidak ada jalur kode kedua. Efek spasial secara
 * prinsip tidak bisa dibawa kubus; daftarnya ditulis sebagai komentar agar
 * pengguna tahu apa yang tidak ikut (seperti `disabledEffects`
 * `SpektraFilmPlugin.cpp`).
 */

export const CUBE_MIN_SIZE = 2;
export const CUBE_MAX_SIZE = 65;

export interface CubeMeta {
  title: string;
  film: string;
  paper: string;
  inputColorSpace: string;
  outputColorSpace: string;
  disabledEffects: string[];
  version: string;
}

function assertSize(size: number): void {
  if (!Number.isInteger(size) || size < CUBE_MIN_SIZE || size > CUBE_MAX_SIZE) {
    throw new RangeError(`Ukuran .cube harus bilangan bulat ${CUBE_MIN_SIZE}..${CUBE_MAX_SIZE}, diterima ${size}.`);
  }
}

/**
 * Lattice identitas sebagai frame `size^2 x size`: titik ke-`i` =
 * `(r, g, b)` dengan `i = r + g*size + b*size^2` (R tercepat, urutan data
 * `.cube`), nilai `r/(size-1)`. Piksel ke-`i` frame (baris-mayor) adalah
 * titik ke-`i`, jadi keluaran render langsung berurutan `.cube`.
 */
export function identityLattice(size: number): { rgba: Float32Array; width: number; height: number } {
  assertSize(size);
  const n = size * size * size;
  const rgba = new Float32Array(n * 4);
  const step = 1 / (size - 1);
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const i = r + g * size + b * size * size;
        rgba[i * 4] = r * step;
        rgba[i * 4 + 1] = g * step;
        rgba[i * 4 + 2] = b * step;
        rgba[i * 4 + 3] = 1;
      }
    }
  }
  // `r * step` untuk r = size-1 bisa meleset 1 ulp dari 1; titik ujung dipaku.
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < 3; c += 1) if (rgba[i * 4 + c]! > 1) rgba[i * 4 + c] = 1;
  }
  return { rgba, width: size * size, height: size };
}

export function formatCube(rgb: Float32Array, size: number, meta: CubeMeta): string {
  assertSize(size);
  const n = size * size * size;
  if (rgb.length !== n * 3) {
    throw new RangeError(`Data .cube ${size}^3 butuh ${n * 3} float RGB, diterima ${rgb.length}.`);
  }
  const lines = [
    `TITLE "${meta.title.replace(/"/g, "'")}"`,
    `# DICHROIC ${meta.version}`,
    `# film: ${meta.film} / paper: ${meta.paper}`,
    `# input: ${meta.inputColorSpace} / output: ${meta.outputColorSpace}`,
    `# disabled effects: ${meta.disabledEffects.length ? meta.disabledEffects.join(', ') : 'none'}`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0 0 0',
    'DOMAIN_MAX 1 1 1',
  ];
  for (let i = 0; i < n; i += 1) {
    lines.push(`${rgb[i * 3]!.toFixed(6)} ${rgb[i * 3 + 1]!.toFixed(6)} ${rgb[i * 3 + 2]!.toFixed(6)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Pembaca minimal untuk berkas yang ditulis `formatCube` (dipakai test dan pratinjau LUT). */
export function parseCube(text: string): { size: number; data: Float32Array } {
  let size = 0;
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('LUT_3D_SIZE')) {
      size = Number(line.split(/\s+/)[1]);
      continue;
    }
    if (/^[A-Z_]/.test(line)) continue;
    for (const token of line.split(/\s+/)) values.push(Number(token));
  }
  assertSize(size);
  const n = size * size * size;
  if (values.length !== n * 3) {
    throw new Error(`.cube ${size}^3 butuh ${n} baris data, ditemukan ${values.length / 3}.`);
  }
  return { size, data: Float32Array.from(values) };
}
