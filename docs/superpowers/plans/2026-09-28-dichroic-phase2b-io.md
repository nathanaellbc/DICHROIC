# DICHROIC Fase 2B — `io/`: Rencana Implementasi

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode JPEG/PNG/TIFF/EXR/RAW ke `DecodedImage` dan encode PNG 8/16-bit serta TIFF 16-bit, semuanya digerbangi oracle Python. `Session` mendapat `exportImage`.

**Architecture:** Satu modul per format di `src/io/`, masing-masing murni (tanpa DOM, tanpa GPU) sehingga bisa diuji di Node. `decodeImage(bytes)` memilih decoder dari magic bytes. RAW memakai `libraw-wasm` dengan setelan rawpy hulu. Karena binding 1.6.0 mengabaikan `gamm`, keluarannya selalu melalui kurva gamma dcraw bawaan (0,45; 4,5). Nilai linear dipulihkan dengan membalik tabel `gamma_curve` dcraw yang sama persis.

**Tech Stack:** `jpeg-js` 0.4.4, `fast-png` 8.0.0, `utif2` 4.1.0, `parse-exr` 1.0.2, `libraw-wasm` 1.6.0; oracle Pillow 12.3, OpenImageIO 3.1, rawpy (LibRaw 0.22.1) di `.venv-ref`.

**Spec:** `docs/superpowers/specs/2026-09-28-dichroic-phase2-core-design.md` §5.

## Global Constraints

- Decoder tidak menyentuh DOM atau GPU; semuanya diuji di Node.
- `DecodedImage.rgba` 4 kanal f32; nilai integer dinormalisasi ke [0,1] (`v / (2^bits − 1)`).
- Deteksi format dari magic bytes, bukan ekstensi.
- Galat decode dibungkus `DecodeError { format, reason }`.
- Fixture dibangkitkan `.venv-ref`, manifest hanya bertambah.
- RAW: setelan = `raw_file_processor.py::_postprocess_params('as_shot')` hulu.

## Review Focus

1. **Berkas rusak/terpotong.** Diharapkan `DecodeError` yang menyebut format, bukan exception mentah pustaka. Dipin di Task 1.
2. **PNG/TIFF 16-bit big-endian dan grayscale/RGBA.** Diharapkan normalisasi per bit depth dan grayscale disebar ke RGB. Dipin di Task 2–3.
3. **EXR dengan kanal hilang (mis. hanya Y) atau kompresi tak didukung.** Diharapkan `DecodeError` yang jelas. Dipin di Task 4.
4. **RAW dengan orientasi (flip).** `userFlip` default memakai orientasi berkas seperti rawpy. Dipin di Task 5 (dicatat bila tidak bisa diuji dengan DNG sintetis).
5. **Encode nilai di luar [0,1] atau NaN.** Diharapkan clamp ke [0,1] dan NaN → 0, bukan wrap-around integer. Dipin di Task 6.

---

### Task 1: `detect.ts`, `DecodeError`, `decodeImage`

**Files:** Create `src/io/errors.ts`, `src/io/detect.ts`, `src/io/index.ts`; Test `test/io/detect.test.ts`.

**Interfaces:**
```ts
export type ImageFormat = 'jpeg' | 'png' | 'tiff' | 'exr' | 'raw';
export class DecodeError extends Error { constructor(readonly format: ImageFormat | 'unknown', readonly reason: string) }
export function detectFormat(bytes: Uint8Array): ImageFormat | 'unknown';
export async function decodeImage(bytes: Uint8Array, name?: string): Promise<DecodedImage>;
```
- JPEG `FF D8 FF`; PNG `89 50 4E 47 0D 0A 1A 0A`; EXR `76 2F 31 01`; TIFF `II*\0`/`MM\0*`. TIFF yang merupakan DNG (tag 50706) atau RAW berbasis TIFF (CR2 `II*\0` + `CR` di offset 8, NEF/ARW dengan tag Make kamera) → `'raw'`. Selain itu dicoba sebagai RAW bila LibRaw bisa membukanya (CR3, RAF, ORF, RW2, dll.), atau `'unknown'`.
- Test: tiap magic dikenali; DNG sintetis → `raw`; byte acak → `unknown` dan `decodeImage` melempar `DecodeError('unknown', …)`.

### Task 2: JPEG dan PNG

**Files:** Create `src/io/jpeg.ts`, `src/io/png.ts`, `tools/gen_io_reference.py`, fixture `test/fixtures/io/*`; Test `test/io/jpeg.test.ts`, `test/io/png.test.ts`.

- Fixture Pillow: JPEG RGB baseline q90, JPEG progresif, JPEG grayscale; PNG RGB8, RGBA8, RGB16, gray16. Oracle = array Pillow (`np.asarray(Image.open(...))`) dinormalisasi.
- Gerbang: PNG bit-identik (lossless). JPEG: jpeg-js vs Pillow (libjpeg-turbo) bisa berbeda di pembulatan IDCT dan upsampling chroma. Ambang diukur lalu dikunci (target ≤ 2/255), dan selisihnya dicatat.

### Task 3: TIFF

**Files:** Create `src/io/tiff.ts`; fixture tifffile: RGB8, RGB16 (little dan big endian), RGB float32, LZW, deflate; Test `test/io/tiff.test.ts`.
- Oracle tifffile. Gerbang bit-identik (lossless). Float → `encoding: 'linear'`, `suggestedColorSpace: 'Linear Rec.709'`.

### Task 4: EXR

**Files:** Create `src/io/exr.ts`; fixture OIIO: half RGB none/ZIP/PIZ, float RGBA ZIP, satu berkas dengan atribut `chromaticities` ACES AP0; Test `test/io/exr.test.ts`.
- Gerbang bit-identik terhadap OIIO (half → f32 eksak). `chromaticities` AP0 → `'ACES2065-1'`, AP1 → `'ACEScg'`, Rec.709 atau tidak ada → `'Linear Rec.709'`.

### Task 5: RAW

**Files:** Create `src/io/raw.ts`, `src/io/dcrawGamma.ts`; `tools/gen_raw_reference.py` (sudah ada); Test `test/io/raw.test.ts`, `test/io/dcrawGamma.test.ts`.

**Interfaces:**
```ts
export function dcrawGammaCurve(pwr: number, ts: number, mode: number, imax: number): Uint16Array; // port gamma_curve dcraw/LibRaw
export function invertDcrawCurve(curve: Uint16Array): Float64Array; // encoded -> L linear (tengah rentang)
export async function decodeRaw(bytes: Uint8Array, opts?: { wasmBinary?: ArrayBuffer | Uint8Array }): Promise<DecodedImage>;
```
- Setelan LibRaw: `outputColor: 6` (ACES), `outputBps: 16`, `noAutoBright: true`, `useCameraWb: true`, `gamm: [1, 1]` (dikirim demi masa depan, tapi diabaikan binding 1.6.0). Keluaran dipulihkan lewat `invertDcrawCurve(dcrawGammaCurve(0.45, 4.5, 2, 0x10000))`; `L / 65535`. `suggestedColorSpace: 'ACES2065-1'`, `encoding: 'linear'`.
- Gerbang: DNG sintetis vs rawpy ≤ 2 LSB (3,1e-5), terukur 1,5e-5. Unit: kurva tidak menurun; `curve[0] = 0`; invers eksak di wilayah gelap (`curve` injektif).
- Browser: WASM dimuat lazy (`import()` hanya saat RAW pertama). Butuh `crossOriginIsolated` (memori WASM bersama, pthread) — dicatat untuk fase PWA.

### Task 6: Encoder PNG 8/16 dan TIFF 16

**Files:** Create `src/io/encode.ts`, `src/io/tiffWriter.ts`; Test `test/io/encode.test.ts`.

**Interfaces:**
```ts
export function quantize(rgb: Float32Array, bits: 8 | 16): Uint8Array | Uint16Array; // clamp [0,1], NaN -> 0, round
export function encodePng(rgb: Float32Array, width: number, height: number, bits: 8 | 16): Uint8Array;
export function encodeTiff16(rgb: Float32Array, width: number, height: number): Uint8Array;
```
- Gerbang: round-trip lewat decoder kita dan dibaca tifffile/Pillow di Python (skrip verifikasi yang dijalankan dari test lewat berkas sementara bila `.venv-ref` ada; bila tidak ada, test itu dilewati dengan alasan tertulis).

### Task 7: `Session.exportImage` dan `decodeImage` di RPC

**Files:** Modify `src/session/session.ts`, `protocol.ts`, `client.ts`, `worker.ts`; Test `test/session.test.ts`, `test/rpc.test.ts`.
- `exportImage(format: 'png8' | 'png16' | 'tiff16'): Promise<Uint8Array>` dari render penuh (cache dipakai bila ada).
- Worker menyediakan `decode(bytes, name)` → `DecodedImage` (decode di worker, bukan di thread UI).

### Task 8: Penutup

- Spec §5 diperbarui dengan angka terukur dan catatan COOP/COEP; suite dua kali hijau; status diisi.

## Status 2B

(diisi di Task 8)
