/**
 * Look film x kertas sebagai LUT 3D yang dipanggang (`tools/bake_looks.ts`):
 * pratinjau instan di pemilih film tanpa menunggu engine. LUT = `.cube`
 * engine sendiri untuk input sRGB ter-encode -> keluaran sRGB pada parameter
 * bawaan; efek spasial (grain, halation, DIR, difusi) dan penyesuaian
 * pengguna tidak termasuk, jadi render sungguhan tetap menggantikannya.
 *
 * Penerap memakai WebGL2: foto asli diunggah sekali sebagai tekstur, LUT
 * sebagai tekstur 3D (interpolasi trilinear perangkat keras), jadi menerapkan
 * look ke foto pratinjau penuh hanya satu draw call.
 */
import { FILM_SECTIONS, PAPER_SECTIONS } from '../model/stocks';
import type { RenderParams } from '../../params/renderParams';
import type { Frame } from './display';

/** Sisi kisi LUT. 8-bit RGB: 17^3 x 3 = 14,7 KB per look. */
export const LOOK_SIZE = 17;

type Process = RenderParams['process'];

export function lookKey(film: string, paper: string, process: Process): string {
  // Scan tidak mencetak ke kertas: satu look per film.
  return process === 'scanNegative' ? `${film}|scan` : `${film}|${paper}`;
}

/** Kombinasi yang dipanggang: negatif x kertas foto/bioskop (print), semua film (scan). */
export function lookCombos(): Array<{ film: string; paper: string; process: Process }> {
  const negatives = FILM_SECTIONS.filter((s) => !s.locked && !s.scanOnly).flatMap((s) => s.stocks.map((x) => x.id));
  const slides = FILM_SECTIONS.filter((s) => !s.locked && s.scanOnly).flatMap((s) => s.stocks.map((x) => x.id));
  const papers = PAPER_SECTIONS.filter((s) => !s.locked && !s.title.startsWith('Film print LUTs')).flatMap((s) => s.stocks.map((x) => x.id));
  const scanPaper = 'kodak_portra_endura';
  return [
    ...negatives.flatMap((film) => papers.map((paper) => ({ film, paper, process: 'printSimulation' as const }))),
    ...[...negatives, ...slides].map((film) => ({ film, paper: scanPaper, process: 'scanNegative' as const })),
  ];
}

/** Look untuk resep ini, bila ada (Film Off dan LUT cetak tidak dipanggang). */
export function lookFor(params: Pick<RenderParams, 'filmEnabled' | 'film' | 'paper' | 'process'>, film = params.film): string | undefined {
  if (!params.filmEnabled && film === params.film) return undefined;
  if (film === 'off') return undefined;
  return lookKey(film, params.paper, params.process);
}

interface LookTable { size: number; data: Uint8Array; index: Record<string, number> }
let table: Promise<LookTable | undefined> | undefined;
let loaded: LookTable | undefined;

/** Look ini ada dan tabelnya sudah dimuat (sinkron; `loadLooks` dulu). */
export function hasLook(key: string | undefined): boolean {
  return !!key && loaded?.index[key] !== undefined;
}

let renderer: LookRenderer | null | undefined;
/** Penerap bersama (satu konteks WebGL2); `null` bila WebGL2 tidak ada. */
export function lookRenderer(): LookRenderer | null {
  if (renderer === undefined) {
    const r = typeof document === 'undefined' ? null : new LookRenderer();
    renderer = r?.ok ? r : null;
  }
  return renderer;
}

/** Muat tabel look sekali (`public/data/looks`); gagal = tanpa pratinjau LUT. */
export function loadLooks(base = `${import.meta.env?.BASE_URL ?? '/'}data/looks`): Promise<LookTable | undefined> {
  table ??= (async () => {
    try {
      const [meta, bin] = await Promise.all([
        fetch(`${base}/looks.json`).then((r) => (r.ok ? r.json() as Promise<{ size: number; looks: Record<string, number> }> : Promise.reject(new Error(String(r.status))))),
        fetch(`${base}/looks.bin`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))),
      ]);
      loaded = { size: meta.size, data: new Uint8Array(bin), index: meta.looks };
      return loaded;
    } catch {
      table = undefined;
      return undefined;
    }
  })();
  return table;
}

function lutBytes(t: LookTable, key: string): Uint8Array | undefined {
  const i = t.index[key];
  if (i === undefined) return undefined;
  const n = t.size ** 3 * 3;
  return t.data.subarray(i * n, (i + 1) * n);
}

const VERT = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `#version 300 es
precision highp float; precision highp sampler3D;
uniform sampler2D src; uniform sampler3D lut; uniform float n;
in vec2 uv; out vec4 color;
void main() {
  vec3 c = texture(src, uv).rgb;
  vec3 t = (c * (n - 1.0) + 0.5) / n;
  color = vec4(texture(lut, t).rgb, 1.0);
}`;

/**
 * Penerap LUT WebGL2 untuk satu foto. `setSource` sekali per foto (dikonversi
 * ke sRGB oleh kanvas 2D bila foto ber-ruang P3), lalu `apply(key, w, h)`
 * menggambar look ke kanvas internal dan mengembalikan bitmap-nya.
 */
export class LookRenderer {
  readonly #canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
  readonly #gl: WebGL2RenderingContext | null;
  #program: WebGLProgram | null = null;
  #src: WebGLTexture | null = null;
  #lut: WebGLTexture | null = null;
  #lutKey: string | undefined;
  #source: Frame | undefined;
  #sourceSize = { width: 0, height: 0 };

  constructor() {
    this.#gl = (this.#canvas as HTMLCanvasElement).getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    const gl = this.#gl;
    if (!gl) return;
    const shader = (type: number, text: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, text);
      gl.compileShader(s);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    this.#program = program;
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(program, 'src'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'lut'), 1);
  }

  get ok(): boolean {
    return !!this.#program;
  }

  /** Foto sumber (frame asli). Dilewati bila sama dengan sebelumnya. */
  setSource(frame: Frame): void {
    const gl = this.#gl;
    if (!gl || !this.#program || frame === this.#source) return;
    this.#source = frame;
    // Kanvas 2D sRGB mengonversi P3 -> sRGB (input LUT = sRGB ter-encode).
    const staging = document.createElement('canvas');
    staging.width = frame.width;
    staging.height = frame.height;
    const ctx = staging.getContext('2d', { colorSpace: 'srgb' });
    if (!ctx) return;
    if (frame.colorSpace === 'srgb') {
      ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height), 0, 0);
    } else {
      const p3 = document.createElement('canvas');
      p3.width = frame.width;
      p3.height = frame.height;
      p3.getContext('2d', { colorSpace: frame.colorSpace })?.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height, { colorSpace: frame.colorSpace }), 0, 0);
      ctx.drawImage(p3, 0, 0);
    }
    this.#src ??= gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, staging);
    // Mipmap: kartu jauh lebih kecil dari foto; tanpa ini hasil kecilnya berderau.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.#sourceSize = { width: frame.width, height: frame.height };
  }

  /** Terapkan look `key` ke foto sumber pada ukuran `width` x `height`. */
  async apply(key: string, width = this.#sourceSize.width, height = this.#sourceSize.height): Promise<ImageBitmap | undefined> {
    const gl = this.#gl;
    const t = await loadLooks();
    if (!gl || !this.#program || !this.#src || !t) return undefined;
    const bytes = lutBytes(t, key);
    if (!bytes) return undefined;
    if (this.#lutKey !== key) {
      this.#lut ??= gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, this.#lut);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, t.size, t.size, t.size, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
      this.#lutKey = key;
    }
    this.#canvas.width = Math.max(1, Math.round(width));
    this.#canvas.height = Math.max(1, Math.round(height));
    gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
    gl.uniform1f(gl.getUniformLocation(this.#program, 'n'), t.size);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#src);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.#lut);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return createImageBitmap(this.#canvas);
  }
}
