/**
 * Decoder RAW lewat `libraw-wasm` (LibRaw 0.22), dengan setelan hulu
 * `spektrafilm/utils/raw_file_processor.py::_postprocess_params('as_shot')`:
 * `output_color=ACES`, `output_bps=16`, `no_auto_bright`, `use_camera_wb`,
 * orientasi dari berkas. Keluaran linear ACES2065-1 (spec Fase 2 §5).
 *
 * Gamma: hulu meminta `gamma=(1, 1)`, tetapi binding 1.6.0 mengabaikan `gamm`
 * dalam semua bentuk dan selalu menerapkan kurva bawaan LibRaw (0,45; 4,5).
 * `gamm` SENGAJA tidak dikirim: bila versi binding kelak menghormatinya,
 * keluaran akan linear sementara kode ini tetap membalik kurva -- gambar
 * salah tanpa galat. Tanpa `gamm`, LibRaw selalu memakai kurva bawaannya, dan
 * `invertDcrawCurve` membaliknya dengan tabel yang sama persis.
 *
 * Browser: modul WASM memakai memori bersama (pthread), jadi halaman harus
 * cross-origin isolated (COOP/COEP) -- dicatat untuk fase PWA. Modul dimuat
 * lazy: `decodeImage` hanya meng-`import()` berkas ini untuk RAW.
 */
import type { LibRawModule } from 'libraw-wasm/dist/libraw.js';
import type { DecodedImage } from './decoded';
import { dcrawGammaCurve, invertDcrawCurve } from './dcrawGamma';

export interface RawDecodeOptions {
  /** Biner `libraw.wasm`. Wajib di Node (loader Emscripten hanya bisa `fetch` di browser). */
  wasmBinary?: ArrayBuffer | Uint8Array;
}

const LIBRAW_SETTINGS = {
  outputColor: 6, // ACES
  outputBps: 16,
  noAutoBright: true,
  useCameraWb: true,
} as const;

let modulePromise: Promise<LibRawModule> | undefined;
/** Baris stderr terakhir LibRaw: alasan yang dibawa `DecodeError` (exception C++ tidak membawa pesan). */
let lastLibRawMessage = '';

function loadLibRaw(wasmBinary?: ArrayBuffer | Uint8Array): Promise<LibRawModule> {
  modulePromise ??= import('libraw-wasm/dist/libraw.js')
    .then(({ default: factory }) =>
      factory({
        ...(wasmBinary ? { wasmBinary } : {}),
        print: () => {},
        printErr: (text) => {
          lastLibRawMessage = text;
        },
      }),
    )
    .catch((error: unknown) => {
      modulePromise = undefined; // coba lagi di panggilan berikutnya
      throw error;
    });
  return modulePromise;
}

let inverseCurve: Float64Array | undefined;

/** Kode 16-bit ter-encode -> linear [0,1] (invers kurva bawaan LibRaw, `imax = 0x10000`). */
function linearFromEncoded(): Float64Array {
  if (!inverseCurve) {
    inverseCurve = invertDcrawCurve(dcrawGammaCurve(0.45, 4.5, 2, 0x10000));
    for (let e = 0; e < inverseCurve.length; e += 1) inverseCurve[e] = inverseCurve[e]! / 65535;
  }
  return inverseCurve;
}

export async function decodeRaw(bytes: Uint8Array, name?: string, options: RawDecodeOptions = {}): Promise<DecodedImage> {
  // Di Node `crossOriginIsolated` tidak ada (undefined); di browser `false`
  // berarti memori WASM bersama tidak tersedia dan LibRaw gagal dengan pesan
  // yang tidak menyebut penyebabnya.
  if ((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === false) {
    throw new Error('RAW butuh halaman cross-origin isolated (header COOP same-origin + COEP require-corp)');
  }
  const libraw = await loadLibRaw(options.wasmBinary);
  const instance = new libraw.LibRaw();
  lastLibRawMessage = '';
  let image;
  try {
    // LibRaw boleh menahan referensi ke buffer; salinan menjaga masukan pemanggil.
    instance.open(bytes.slice(), { ...LIBRAW_SETTINGS });
    image = instance.imageData();
  } catch (error) {
    const reason = lastLibRawMessage.trim() || (error instanceof Error ? error.message : 'LibRaw menolak berkas');
    throw new Error(reason);
  }
  if (!image) throw new Error(lastLibRawMessage.trim() || 'LibRaw tidak menghasilkan gambar');
  const { width, height, colors, bits, data } = image;
  if (bits !== 16 || !(data instanceof Uint16Array)) throw new Error(`LibRaw mengembalikan ${bits}-bit, bukan 16-bit`);
  if (colors !== 1 && colors !== 3) throw new Error(`LibRaw mengembalikan ${colors} kanal`);
  const n = width * height;
  if (data.length < n * colors) throw new Error('data LibRaw terpotong');

  const toLinear = linearFromEncoded();
  const rgba = new Float32Array(n * 4);
  for (let i = 0; i < n; i += 1) {
    const s = i * colors;
    rgba[i * 4] = toLinear[data[s]!]!;
    rgba[i * 4 + 1] = toLinear[data[s + (colors === 3 ? 1 : 0)]!]!;
    rgba[i * 4 + 2] = toLinear[data[s + (colors === 3 ? 2 : 0)]!]!;
    rgba[i * 4 + 3] = 1;
  }
  return {
    width,
    height,
    rgba,
    suggestedColorSpace: 'ACES2065-1',
    encoding: 'linear',
    source: { format: 'raw', bitDepth: 16, ...(name === undefined ? {} : { name }) },
  };
}
