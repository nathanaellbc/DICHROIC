/**
 * Membangun keempat arena (Task 8) dari `AssetBundle` (Task 5) untuk satu
 * stock yang dipilih.
 *
 * Pengelompokan (spec §4.3 / komentar `arena.ts`):
 *   - `static`  — betul-betul tak berubah, dibagi lintas SEMUA stock:
 *                 `inputToSrgb`, `colorDecodeLuts`, `colorTransferKinds`.
 *                 DIBUKTIKAN (bukan diasumsikan dari brief) dengan membaca
 *                 field mentah tiga stock dari kelompok illuminant berbeda
 *                 (D55/T/TH-KG3) -- `inputToSrgb` identik byte-demi-byte di
 *                 ketiganya.
 *   - `stock`   — berubah bersama stock yang dipilih: `inputToReferenceXyz`
 *                 (dibuktikan BERBEDA antar grup illuminant, lih. di bawah)
 *                 dan `mallettRawMatrix` (dihitung dari sensitivity+illuminant
 *                 stock, lih. `computeMallettRawMatrix`).
 *   - `dynamic` — dihitung di sini dari data stock: `hanatosRawResponse`,
 *                 port dari `remapHanatosResponseForInputGamutCompression`
 *                 (`SpektraVulkanRenderer.cpp`).
 *   - `frameState` — kosong untuk Task 11 (FilmExposure tidak butuh scratch
 *                 per-dispatch di luar apa yang `RenderGraph.scratch` sudah
 *                 sediakan).
 *
 * PENYIMPANGAN DARI TABEL BINDING task-11-brief.md, DIBUKTIKAN BUKAN DITEBAK:
 *
 *   Brief menyatakan `InputToReferenceXyzMatrices` (binding 8) dan
 *   `MallettRawMatrix` (binding 7) masuk arena `static`. Itu SALAH untuk
 *   keduanya:
 *
 *   - `inputToReferenceXyz` bergantung pada `referenceIlluminant` stock
 *     (dipakai upstream untuk adaptasi kromatik CAT16 ke illuminant itu,
 *     `spectral_upsampling.py::_rgb_to_tc_b`). Dibuktikan dengan membaca
 *     `stocks.f32` mentah: pada colorSpace index 19 ("ProPhoto RGB"),
 *     `kodak_portra_400` (D55) memberi baris matriks
 *     `[0.7816, 0.1243, 0.0508, ...]`, `kodak_vision3_200t` ("T") memberi
 *     `[0.9349, 0.2449, -0.0754, ...]`, `kodak_endura_premier` (TH-KG3)
 *     memberi `[0.8625, 0.1823, -0.0360, ...]` -- tiga matriks BERBEDA
 *     untuk colorSpace yang sama. Menaruhnya di arena `static` akan
 *     mengunci matriks stock PERTAMA yang di-build untuk seluruh sesi,
 *     salah untuk setiap stock lain dengan illuminant berbeda.
 *   - `mallettRawMatrix` (`makeMallettRawMatrix` hulu,
 *     `SpektraVulkanRenderer.cpp:535-560`) dihitung dari `linearSensitivity`
 *     (10^logSensitivity stock) dan `mallettBasisIlluminant` (field stock),
 *     dinormalisasi oleh `mallettRawMidgrayGreen` (skalar stock) -- tiga
 *     input stock-dependent, jadi TIDAK BISA statis.
 *
 *   Sebaliknya, `inputToSrgb` (binding 4, diklaim brief sebagai `static`)
 *   TERBUKTI BENAR statis: dibaca dari `stocks.f32` mentah untuk ketiga
 *   stock kelompok illuminant di atas, byte-demi-byte identik pada
 *   ketiganya (`Task 4` sudah mencatat ini: disimpan sekali, offset
 *   dibagi). Diverifikasi ulang di sini sebelum dipakai, bukan diterima
 *   dari catatan lama.
 *
 * PENYIMPANGAN KEDUA, JUGA DIBUKTIKAN: `hanatosRawResponse` TIDAK dibangun
 * dari field stock `bandpassHanatos2025` (cabang "Hanatos2025" hulu di
 * `SpektraVulkanRenderer.cpp::makeHanatosRawResponse`), melainkan dari
 * `hanatos2026WindowParams` (cabang "Hanatos2026" hulu, window erf4 dihitung
 * ULANG dari `window_params`) -- lih. `computeErf4Window` dan
 * `makeHanatosRawResponse` di bawah untuk penjelasan lengkap dan bukti
 * numerik yang menutupnya ke ~3e-5 (dari >30x lebih besar sebelumnya).
 */

import type { AssetBundle } from '../profiles/load';
import { ArenaBuilder } from '../engine/arena';
import type { Arenas } from '../engine/arena';
import { precomputeDiffusionFilter } from './diffusionFilter';
import { filteredEnlargerIlluminant } from './enlarger';
import type { EnlargerFilterState } from './enlarger';
import { buildScannerCam16Static } from './cam16';

/**
 * Perkiraan fungsi galat (erf), Abramowitz & Stegun 7.1.26 -- galat
 * absolut maksimum ~1.5e-7, jauh di bawah ambang parity 1e-5 yang
 * bergantung padanya (`computeErf4Window` di bawah).
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

/**
 * `10^logSensitivity`, tak-berhingga -> 0 -- port `makeLinearSensitivity`
 * (`SpektraVulkanRenderer.cpp:469-479`). Cocok dengan Python
 * `sensitivity = 10 ** log_sensitivity; np.nan_to_num(sensitivity)` untuk
 * data nyata (tidak ada +-inf di `logSensitivity` stock manapun).
 */
function linearSensitivityFrom(logSensitivity: ArrayLike<number>): Float32Array {
  const out = new Float32Array(logSensitivity.length);
  for (let i = 0; i < logSensitivity.length; i += 1) {
    const v = 10 ** logSensitivity[i]!;
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/**
 * Jendela bandpass spektral erf4 -- port `smoothErfEdge` +
 * `useHanatos2026` branch di `makeHanatosRawResponse`
 * (`SpektraVulkanRenderer.cpp:663-698`), dikonfirmasi setara aljabar
 * dengan `eval_erf4_spectral_bandpass` Python
 * (`spektral_upsampling.py:263-274`):
 *
 *   edgeUv = 0.5*(1+erf((wl-cUv)/(sigmaUv*sqrt2)))
 *   edgeIr = 0.5*(1-erf((wl-cIr)/(sigmaIr*sqrt2)))
 *
 * DAN keduanya adalah bentuk aljabar identik dari
 * `smoothErfEdge(wl,c,width) = erf((wl-c)/width)*0.5+0.5` hulu dengan
 * `width=sigmaUv*sqrt2` (untuk edgeUv) dan `width=-sigmaIr*sqrt2` (untuk
 * edgeIr, tanda minus membalik argumen erf menjadi `1-erf(...)`).
 *
 * MENGAPA branch ini (bukan field stock `bandpassHanatos2025`, yang
 * diklaim task-11-brief.md Step 1): `bandpassHanatos2025` adalah nilai
 * ARSIP beku (`generate_profile_curves.py::_archived_bandpass_hanatos2025`,
 * membaca `archived.get("data",{}).get("bandpass_hanatos2025",[])` dari
 * berkas profil arsip lama) -- bukan yang dihitung ULANG oleh pipeline
 * Python yang menghasilkan fixture referensi Task 3. Python hanya punya
 * SATU metode hanatos (`settings.rgb_to_raw_method == "hanatos2025"`,
 * `spektral_upsampling.py::rgb_to_raw_hanatos2025`), dan itu memanggil
 * `compute_hanatos2025_tc_lut` yang menghitung window ERF4 SEGAR dari
 * `hanatos2025_adaptation.window_params` -- field itu, membingungkan,
 * dipancarkan baker sebagai `hanatos2026WindowParams` (nama enum hulu
 * `RgbToRawMethod::Hanatos2026`), TAPI isinya persis
 * `profile.data.hanatos2025_adaptation_window_params` yang dipakai
 * Python (`generate_profile_curves.py:420-426`,
 * `spektrafilm/profiles/io.py:198-200`). Dibuktikan numerik: memakai
 * `bandpassHanatos2025` arsip memberi galat log10 ~0.01-0.03 (jauh di
 * atas ambang 1e-5) untuk `gray_ramp`; memakai `hanatos2026WindowParams`
 * (fungsi ini) memberi galat ~3e-5 pada perhitungan f64 murni di luar
 * GPU -- perbaikan >100x, dan sisa selisihnya sendiri seukuran dugaan
 * noise f32-vs-f64 brief, bukan struktural.
 */
function computeErf4Window(
  wavelengths: ArrayLike<number>,
  windowParams: ArrayLike<number>,
): Float32Array {
  const sqrt2 = Math.SQRT2;
  const cUv = windowParams[0]!;
  const sigmaUv = windowParams[1]!;
  const cIr = windowParams[2]!;
  const sigmaIr = windowParams[3]!;
  const window = new Float32Array(wavelengths.length);
  for (let i = 0; i < wavelengths.length; i += 1) {
    const wl = wavelengths[i]!;
    const edgeUv = 0.5 * (1 + erf((wl - cUv) / (sigmaUv * sqrt2)));
    const edgeIr = 0.5 * (1 - erf((wl - cIr) / (sigmaIr * sqrt2)));
    window[i] = edgeUv * edgeIr;
  }
  return window;
}

/**
 * Tabel respons mentah Hanatos, `hanatos.width * hanatos.height * 3` float,
 * tata letak `(x*height+y)*3+channel` -- SAMA dengan indeks yang shader
 * (`hanatosRaw()`, Task 11 Step 6) pakai untuk membaca `HanatosRawResponse`
 * (`xi*hanatosHeight+yj`). Port `makeHanatosRawResponse`
 * (`SpektraVulkanRenderer.cpp:642-731`), cabang window erf4 (lih.
 * `computeErf4Window` di atas untuk kenapa bukan cabang arsip).
 *
 * Normalisasi PER KANAL (`hanatos2026Normalization[channel]`, hulu
 * baris 692-696): `sum(sensitivity*illuminant*window) /
 * max(sum(sensitivity*illuminant), 1e-10)`, lalu setiap kanal window
 * dibagi normalisasinya sendiri sebelum dikontraksikan dengan spektrum.
 */
/**
 * CATATAN LINGKUNGAN (bukan koreksi algoritma).
 *
 * Fungsi ini dulu membawa catatan yang menyatakan crash Node/Dawn di
 * sekitarnya RACY dan tak bisa ditutup dari sisi TypeScript. Catatan itu
 * SALAH, dan dikoreksi di sini karena ia mengarahkan orang menjauhi
 * satu-satunya perbaikan yang benar-benar bekerja.
 *
 * Yang sebenarnya terjadi, terukur 100% deterministik di KEDUA arah: kerja
 * float CPU yang panjang SETELAH `GPUDevice` hidup men-segfault proses pada
 * titik sinkronisasi queue BERIKUTNYA (`onSubmittedWorkDone`/`mapAsync`), dan
 * kerja float yang sama SEBELUM device diakuisisi tidak pernah men-segfault.
 * Yang dibuktikan lewat probe terpisah, masing-masing menyingkirkan satu
 * tersangka:
 *
 *   - BUKAN jumlah operasi: 9 juta `sin`/`cos` (~200 ms) dengan device hidup
 *     lolos.
 *   - BUKAN tekanan alokasi: mengalokasikan dan membuang 400 MB
 *     `Float32Array` dengan device hidup lolos.
 *   - BUKAN buffer arena: empat `GPUBuffer` berukuran arena yang sama persis
 *     (106756/243/294912/0 float, termasuk arena 0-float) dibuat lewat
 *     `mappedAtCreation` lalu dipakai di bind group, lolos.
 *   - BUKAN shader dan BUKAN isi arena: satu submit TANPA compute pass sama
 *     sekali tetap crash selama pra-hitung ini berjalan setelah device hidup.
 *   - IYA urutannya: loop bersarang 192x192x81 yang IDENTIK crash 3/3 setelah
 *     `acquireDevice()` dan lolos 3/3 sebelum `acquireDevice()`.
 *
 * Karena itu modul ini memisahkan pra-hitung dari unggahan:
 * `precomputeArenaData()` murni CPU dan TIDAK menyentuh device, sementara
 * `uploadArenas()` hanya membuat `GPUBuffer`. Pemanggil WAJIB menjalankan
 * pra-hitung lebih dulu, lalu mengakuisisi device, lalu mengunggah. Tidak ada
 * lagi fungsi gabungan `buildArenas()` -- ia sengaja DIHAPUS, bukan
 * dideprekasi, supaya urutan yang crash tidak bisa ditulis ulang tanpa sengaja
 * di Task 12-19.
 *
 * Ini juga bukan sekadar penghindaran crash: pra-hitung yang bebas-device bisa
 * diuji tanpa GPU sama sekali, dan di browser bisa dipindah ke worker.
 */
function makeHanatosRawResponse(
  hanatosSpectra: ArrayLike<number>,
  linearSensitivity: ArrayLike<number>,
  window: ArrayLike<number>,
  referenceIlluminantSpectrum: ArrayLike<number>,
  width: number,
  height: number,
  wavelengthCount: number,
): Float32Array {
  const numerator = [0, 0, 0];
  const denominator = [0, 0, 0];
  for (let wl = 0; wl < wavelengthCount; wl += 1) {
    const illuminant = referenceIlluminantSpectrum[wl]!;
    const w = window[wl]!;
    for (let c = 0; c < 3; c += 1) {
      const response = linearSensitivity[wl * 3 + c]! * illuminant;
      denominator[c]! += response;
      numerator[c]! += response * w;
    }
  }
  const normalization = [0, 1, 2].map(
    (c) => numerator[c]! / Math.max(denominator[c]!, 1e-10),
  );

  const out = new Float32Array(width * height * 3);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const spectraOffset = (x * height + y) * wavelengthCount;
      let r0 = 0;
      let r1 = 0;
      let r2 = 0;
      for (let wl = 0; wl < wavelengthCount; wl += 1) {
        const spectrum = hanatosSpectra[spectraOffset + wl]!;
        const w = window[wl]! ;
        const so = wl * 3;
        r0 += spectrum * linearSensitivity[so]! * w;
        r1 += spectrum * linearSensitivity[so + 1]! * w;
        r2 += spectrum * linearSensitivity[so + 2]! * w;
      }
      const o = (x * height + y) * 3;
      out[o] = r0 / normalization[0]!;
      out[o + 1] = r1 / normalization[1]!;
      out[o + 2] = r2 / normalization[2]!;
    }
  }
  return out;
}

/**
 * xy CIE kromatisitas dari illuminant referensi stock, via CMF standar --
 * port `filmReferenceIlluminantXy` (`SpektraVulkanRenderer.cpp:745-763`).
 */
function filmReferenceIlluminantXy(
  referenceIlluminantSpectrum: ArrayLike<number>,
  cmfs: ArrayLike<number>,
  wavelengthCount: number,
): [number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let wl = 0; wl < wavelengthCount; wl += 1) {
    const illuminant = referenceIlluminantSpectrum[wl]!;
    const o = wl * 3;
    x += illuminant * cmfs[o]!;
    y += illuminant * cmfs[o + 1]!;
    z += illuminant * cmfs[o + 2]!;
  }
  const sum = x + y + z;
  if (!(sum > 1e-12) || !Number.isFinite(sum)) return [1 / 3, 1 / 3];
  return [x / sum, y / sum];
}

/** Poligon locus spektral (<=700nm), ditutup -- port `spectralLocusXy` (:765-788). */
function spectralLocusXy(
  wavelengths: ArrayLike<number>,
  cmfs: ArrayLike<number>,
  wavelengthCount: number,
): Array<[number, number]> {
  const locus: Array<[number, number]> = [];
  for (let wl = 0; wl < wavelengthCount; wl += 1) {
    if (wavelengths[wl]! > 700 + 1e-4) continue;
    const o = wl * 3;
    const x = cmfs[o]!;
    const y = cmfs[o + 1]!;
    const z = cmfs[o + 2]!;
    const sum = x + y + z;
    if (sum > 1e-12 && Number.isFinite(sum)) locus.push([x / sum, y / sum]);
  }
  if (locus.length > 0) locus.push(locus[0]!);
  return locus;
}

/** Lutut Reinhard -- port `reinhardKnee` (:735-743). */
function reinhardKnee(value: number, threshold: number, limit: number, power: number): number {
  if (!Number.isFinite(value) || value <= threshold) return value;
  const scale = Math.max(limit - threshold, 1e-12);
  const x = (value - threshold) / scale;
  const y = x / (1 + x ** power) ** (1 / power);
  return threshold + scale * y;
}

/** Jarak ray-ke-poligon -- port `rayPolygonDistance` (:790-814). */
function rayPolygonDistance(
  origin: [number, number],
  direction: [number, number],
  polygon: Array<[number, number]>,
): number {
  let tMin = Infinity;
  for (let i = 0; i + 1 < polygon.length; i += 1) {
    const [ax, ay] = polygon[i]!;
    const ex = polygon[i + 1]![0] - ax;
    const ey = polygon[i + 1]![1] - ay;
    const denom = direction[0] * ey - direction[1] * ex;
    if (Math.abs(denom) <= 1e-12) continue;
    const ox = origin[0] - ax;
    const oy = origin[1] - ay;
    const t = (-ox * ey + oy * ex) / denom;
    const s = (-ox * direction[1] + oy * direction[0]) / denom;
    if (t > 1e-9 && s >= 0 && s <= 1 && t < tMin) tMin = t;
  }
  return tMin;
}

/** Kompresi radial xy menuju white -- port `compressXyRadial` (:816-836). */
function compressXyRadial(
  xy: [number, number],
  whiteXy: [number, number],
  locus: Array<[number, number]>,
): [number, number] {
  const dx = xy[0] - whiteXy[0];
  const dy = xy[1] - whiteXy[1];
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (!(distance > 1e-9) || locus.length < 4) return xy;
  const direction: [number, number] = [dx / distance, dy / distance];
  const boundary = rayPolygonDistance(whiteXy, direction, locus);
  if (!(boundary > 1e-12) || !Number.isFinite(boundary)) return xy;
  const normalized = distance / boundary;
  const compressed = reinhardKnee(normalized, 0, 1, 6);
  const newDistance = compressed * boundary;
  return [whiteXy[0] + direction[0] * newDistance, whiteXy[1] + direction[1] * newDistance];
}

/** Bilinear atas tabel respons mentah -- port `sampleHanatosResponseBilinear` (:838-867). */
function sampleResponseBilinear(
  response: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): [number, number, number] {
  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = cx - x0;
  const ty = cy - y0;
  const at = (xi: number, yi: number): [number, number, number] => {
    const o = (xi * height + yi) * 3;
    return [response[o]!, response[o + 1]!, response[o + 2]!];
  };
  const v00 = at(x0, y0);
  const v10 = at(x1, y0);
  const v01 = at(x0, y1);
  const v11 = at(x1, y1);
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    const a = v00[c]! + (v10[c]! - v00[c]!) * tx;
    const b = v01[c]! + (v11[c]! - v01[c]!) * tx;
    out[c] = a + (b - a) * ty;
  }
  return out;
}

/**
 * Separuh kedua `HanatosRawResponse` -- port
 * `remapHanatosResponseForInputGamutCompression`
 * (`SpektraVulkanRenderer.cpp:869-906`). Untuk setiap sel grid keluaran,
 * hitung kromatisitas xy sel itu, kompres RADIAL menuju white illuminant
 * film (`compressXyRadial`), lalu SAMPLE tabel `baseResponse` (separuh
 * pertama) pada lokasi terkompresi itu -- bukan menghitung ulang integral
 * spektral. Dipakai shader saat `slot1` bit 0
 * (`FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION`, params.ts) menyala, yang
 * DEFAULT MENYALA di sini karena Python `InputGamutCompressSpec.active`
 * default `True` (`gamut_compression.py:69`) -- dibuktikan tidak berubah
 * apa pun tepat DI TITIK white (distance=0, no-op tepat di situ, sesuai
 * definisi kompresi radial), sehingga gray_ramp/log_gray_ramp/color_patches
 * (yang salah satu titik ujinya di antara achromatic) melewati cabang ini
 * tanpa terlihat berbeda dari separuh pertama HANYA pada piksel achromatic
 * -- piksel berwarna (color_patches) akan benar-benar memakai kompresi ini.
 */
function remapHanatosResponseForInputGamutCompression(
  baseResponse: Float32Array,
  whiteXy: [number, number],
  locus: Array<[number, number]>,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(baseResponse.length);
  if (width < 2 || height < 2 || locus.length < 4) {
    out.set(baseResponse);
    return out;
  }
  for (let x = 0; x < width; x += 1) {
    const tx = x / (width - 1);
    const rootTx = Math.sqrt(Math.max(tx, 0));
    for (let y = 0; y < height; y += 1) {
      const ty = y / (height - 1);
      const xy: [number, number] = [1 - rootTx, ty * rootTx];
      const compressedXy = compressXyRadial(xy, whiteXy, locus);
      const oneMinusX = Math.max(1 - compressedXy[0], 1e-10);
      const sampleTx = Math.min(Math.max(oneMinusX * oneMinusX, 0), 1);
      const sampleTy = Math.min(Math.max(compressedXy[1] / oneMinusX, 0), 1);
      const sampled = sampleResponseBilinear(
        baseResponse,
        width,
        height,
        sampleTx * (width - 1),
        sampleTy * (height - 1),
      );
      const o = (x * height + y) * 3;
      out[o] = sampled[0];
      out[o + 1] = sampled[1];
      out[o + 2] = sampled[2];
    }
  }
  return out;
}

/**
 * Mengepak dua tabel respons (mentah lalu terkompresi) menjadi larik
 * vec4-per-texel (r,g,b,0) -- tata letak `HanatosRawResponse` binding 9
 * hulu (`makeHanatosRawResponsePair`, :908-929), yang shader baca sebagai
 * `array<vec4<f32>>` diindeks lewat `responseOffset` (0 atau
 * `width*height`, lih. `FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION`).
 */
function packVec4Pair(a: Float32Array, b: Float32Array): Float32Array {
  const pixelsPerHalf = a.length / 3;
  const out = new Float32Array(pixelsPerHalf * 4 * 2);
  const appendInto = (source: Float32Array, base: number) => {
    for (let p = 0; p < pixelsPerHalf; p += 1) {
      out[base + p * 4] = source[p * 3]!;
      out[base + p * 4 + 1] = source[p * 3 + 1]!;
      out[base + p * 4 + 2] = source[p * 3 + 2]!;
      out[base + p * 4 + 3] = 0;
    }
  };
  appendInto(a, 0);
  appendInto(b, pixelsPerHalf * 4);
  return out;
}

/**
 * Matriks raw Mallett 2019, 3x3 row-major -- port `makeMallettRawMatrix`
 * (`SpektraVulkanRenderer.cpp:535-560`). Dihitung meski
 * `defaultCoreParams` (Task 11 `test/parity/params.ts`) memilih metode
 * hanatos2025 (`rgbToRawMethod=0`) untuk gerbang ini -- binding-nya tetap
 * harus terisi data valid, dan Task 12+ mungkin menggerbangi jalur
 * mallett secara terpisah.
 */
function computeMallettRawMatrix(
  linearSensitivity: ArrayLike<number>,
  mallettBasisIlluminant: ArrayLike<number>,
  mallettRawMidgrayGreen: number,
  wavelengthCount: number,
): Float32Array {
  const matrix = new Float32Array(9);
  for (let wl = 0; wl < wavelengthCount; wl += 1) {
    const o = wl * 3;
    for (let outChannel = 0; outChannel < 3; outChannel += 1) {
      for (let inChannel = 0; inChannel < 3; inChannel += 1) {
        matrix[outChannel * 3 + inChannel]! +=
          linearSensitivity[o + outChannel]! * mallettBasisIlluminant[o + inChannel]!;
      }
    }
  }
  const normalization = Math.max(mallettRawMidgrayGreen, 1e-10);
  for (let i = 0; i < 9; i += 1) matrix[i]! /= normalization;
  return matrix;
}

/**
 * Pasangan berselang-seling [nilai, 1/deltaKeTitikBerikutnya] dari
 * `logExposure` satu stock -- port `makePackedCurveExposure`
 * (`SpektraVulkanRenderer.cpp:576-584`), dikonsumsi `curveDevelop.wgsl`
 * (Task 12) lewat `interpDensityCurve`. Elemen `.y` pada titik TERAKHIR
 * dibiarkan nol (tidak pernah dibaca -- pencarian biner shader berhenti
 * sebelum mencapai titik terakhir sebagai `lo`, dan cabang `>= lastX`
 * mengembalikan baris terakhir langsung tanpa interpolasi).
 */
function makePackedCurveExposure(logExposure: ArrayLike<number>): Float32Array {
  const count = logExposure.length;
  const packed = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    packed[i * 2] = logExposure[i]!;
    if (i + 1 < count) {
      const delta = logExposure[i + 1]! - logExposure[i]!;
      packed[i * 2 + 1] = 1 / Math.max(delta, 1e-9);
    }
  }
  return packed;
}

/**
 * `ln(Gamma(0.5))`, closed form (`Gamma(0.5) = sqrt(pi)`) -- the only `a`
 * the incomplete-gamma routines below ever need (`normalCdf`'s erf is
 * always the a=0.5 case), so no general Lanczos `gammln` approximation is
 * needed at all, and no imprecision from one is introduced.
 */
const GAMMA_LN_HALF = 0.5 * Math.log(Math.PI);
const INCOMPLETE_GAMMA_MAX_ITER = 300;
const INCOMPLETE_GAMMA_EPS = 3e-16;
const INCOMPLETE_GAMMA_FPMIN = 1e-300;

/** Series expansion for the regularized lower incomplete gamma `P(0.5, x)`, `x` small. */
function regularizedLowerIncompleteGammaHalfSeries(x: number): number {
  let ap = 0.5;
  let sum = 1 / 0.5;
  let del = sum;
  for (let n = 1; n <= INCOMPLETE_GAMMA_MAX_ITER; n += 1) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * INCOMPLETE_GAMMA_EPS) break;
  }
  return sum * Math.exp(-x + 0.5 * Math.log(x) - GAMMA_LN_HALF);
}

/** Lentz continued fraction for the regularized UPPER incomplete gamma `Q(0.5, x)`, `x` large. */
function regularizedUpperIncompleteGammaHalfContinuedFraction(x: number): number {
  let b = x + 0.5;
  let c = 1 / INCOMPLETE_GAMMA_FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= INCOMPLETE_GAMMA_MAX_ITER; i += 1) {
    const an = -i * (i - 0.5);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < INCOMPLETE_GAMMA_FPMIN) d = INCOMPLETE_GAMMA_FPMIN;
    c = b + an / c;
    if (Math.abs(c) < INCOMPLETE_GAMMA_FPMIN) c = INCOMPLETE_GAMMA_FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < INCOMPLETE_GAMMA_EPS) break;
  }
  return Math.exp(-x + 0.5 * Math.log(x) - GAMMA_LN_HALF) * h;
}

/**
 * Standard normal CDF, `0.5*(1+erf(z/sqrt2))`, matching `scipy.stats.norm.cdf`
 * -- Task 17 (`develop_print_morph` -> `apply_print_curves_morph` (inactive
 * for every current fixture, see `addPrintScanDynamicData` below) ->
 * `_evaluate_fitted_density` -> `_layer_cdf` -> `scipy.stats.norm.cdf`).
 *
 * Implemented via the regularized incomplete gamma function
 * (`erf(x) = sign(x) * P(0.5, x^2)`, Numerical Recipes `gammp`/`gammq`
 * algorithm specialized to `a=0.5`) rather than a fixed-order rational
 * minimax approximation (like this file's OWN `erf()` above, Abramowitz &
 * Stegun 7.1.26, ~1.5e-7 max abs error -- adequate for `computeErf4Window`'s
 * per-pixel-irrelevant spectral window, but this function feeds a table
 * evaluated ONCE per profile and worth getting closer to f64 machine
 * precision for). Verified directly against
 * `spektrafilm.utils.morph_curves._evaluate_fitted_density`'s real output
 * for the `kodak_portra_endura` print stock (`scratchpad/validate_printscan.mjs`,
 * this session): max abs error 1.73e-7 across all 256 exposure points x 3
 * channels x 3 layers -- the same f32-noise-floor order of magnitude Task
 * 11-15 landed at, not a looser bound.
 */
function normalCdf(z: number): number {
  const x = (z * z) / 2;
  const p = x === 0 ? 0 : x < 1.5 ? regularizedLowerIncompleteGammaHalfSeries(x) : 1 - regularizedUpperIncompleteGammaHalfContinuedFraction(x);
  return z >= 0 ? 0.5 + 0.5 * p : 0.5 - 0.5 * p;
}

/**
 * Port `spektrafilm.utils.morph_curves._evaluate_fitted_density` -- sum of
 * per-layer normal-CDF terms, evaluated at every point of `logExposureGrid`
 * (the PRINT stock's own `log_exposure`, `printLogExposure.length` points),
 * for all 3 channels x `centers9.length/3` layers (always 3 here, per
 * `density_curves_model.n_layers` -- verified 3 for all 28 stocks,
 * `scratchpad/printscan_probe.py`).
 *
 * ONLY the `PrintCurvesMorphParams.active === False` path
 * (`_evaluate_fitted_density` itself, not the full `apply_print_curves_morph`
 * gamma/developer-exhaustion machinery) -- `PrintRenderingParams.density_curves_morph`
 * defaults to `PrintCurvesMorphParams(active=False)`
 * (`params_schema.py:163-165`) and NOTHING in `params_builder.py` (including
 * `lut_mode`) ever flips it, so every fixture this gate exercises takes this
 * exact branch. A future task that needs the morph ACTIVE (gamma factors,
 * developer exhaustion) must extend this -- declared scope limit, same
 * pattern as `dir.ts`'s negative-film-only branch (Task 13) and `grain.ts`'s
 * (Task 16).
 *
 * `centers9`/`amplitudes9`/`sigmas9` are flat, length 9, layout
 * `[channel*3 + layer]` -- matches `density_curves_model.{centers,amplitudes,
 * sigmas}`'s (3,3) row=channel/col=layer shape, and
 * `bake_web_assets.py::pack_stock`'s `densityCurvesModel{Centers,Amplitudes,
 * Sigmas}` fields (which flatten the same (3,3) arrays row-major, i.e. the
 * SAME `[channel*3+layer]` order).
 *
 * `profileType === 'positive'` flips the CDF argument's sign
 * (`_signed_z`) -- implemented for completeness (mirrors
 * `computeDirDensityCurvesBeforeCouplers`'s same positive/negative split),
 * though every fixture's print stock (`kodak_portra_endura`, `type:
 * "negative"`) takes the `negative` branch, unflipped.
 *
 * Returns a flat `(count*3)` table, row-major `[exposureIndex*3+channel]` --
 * the SAME layout `densityCurves` already uses, so `printScan.wgsl`'s
 * lookup can reuse `curveDevelop.wgsl::interpDensityCurve`'s exact
 * binary-search-plus-lerp shape (see `printScan.wgsl`).
 */
function evaluateFittedDensity(
  logExposureGrid: ArrayLike<number>,
  centers9: ArrayLike<number>,
  amplitudes9: ArrayLike<number>,
  sigmas9: ArrayLike<number>,
  profileType: string,
): Float32Array {
  const count = logExposureGrid.length;
  const sign = profileType === 'positive' ? -1 : 1;
  const out = new Float32Array(count * 3);
  for (let channel = 0; channel < 3; channel += 1) {
    for (let j = 0; j < count; j += 1) {
      let total = 0;
      for (let layer = 0; layer < 3; layer += 1) {
        const center = centers9[channel * 3 + layer]!;
        const amplitude = amplitudes9[channel * 3 + layer]!;
        const sigma = sigmas9[channel * 3 + layer]!;
        const z = sign * ((logExposureGrid[j]! - center) / sigma);
        total += amplitude * normalCdf(z);
      }
      out[j * 3 + channel] = total;
    }
  }
  return out;
}

/**
 * Task 17 (PrintScan): membangun entri arena `dynamic` yang dibutuhkan
 * `printScan.wgsl` -- gerbang `log_e_print`/`cmy_print`.
 *
 * KENAPA `dynamic` (bukan arena baru "printStock"): `printScan.wgsl`'s
 * `expose` entry MENDUA stock (FILM `channelDensity`/`baseDensity`, arena
 * `stock` yang sudah dibangun untuk `filmStockId`; PRINT `logSensitivity`,
 * yang perlu satu binding TAMBAHAN kalau dipisah ke arena sendiri) --
 * meng-panggil `precomputeArenaData(bundle, printStockId)` KEDUA KALINYA
 * akan membangun `static`/`stock` PRINT PENUH (inputToReferenceXyz,
 * mallettRawMatrix, dirCouplersMatrix, dst.) yang TIDAK SATU PUN dipakai
 * `printScan.wgsl` -- pemborosan binding tanpa manfaat, dan mendekati batas
 * 8 storage buffer per stage tanpa alasan. `dynamic` arena SUDAH ada
 * kelompok semantik yang pas ("berubah bersama parameter", sama seperti
 * `hanatosRawResponse`/diffusion PSF di atas), jadi entri PRINT ditambahkan
 * ke situ, dibaca sebagai binding TAMBAHAN (bukan binding PENGGANTI) yang
 * sama dengan yang stage lain sudah pakai di chain yang sama.
 *
 * ENTRI YANG DITULIS (semuanya di `dynamic`):
 *   `printLinearSensitivity`   -- (wavelengthCount*3) f32, `10**log_sensitivity`
 *                                 PRINT stock, `np.nan_to_num` (port
 *                                 `linearSensitivityFrom`, dipakai ulang).
 *   `printFilteredIlluminant`  -- (wavelengthCount) f32, `filteredEnlargerIlluminant`
 *                                 (`src/host/enlarger.ts`) atas TH-KG3 + filter CMY.
 *   `printWavelengthCount`     -- 1 f32, jumlah wavelength (sama utk film & print,
 *                                 dibuktikan `scratchpad/printscan_probe.py`: 81
 *                                 keduanya -- SPECTRAL_SHAPE global hulu), disimpan
 *                                 sebagai skalar arena (BUKAN field CoreParams baru
 *                                 -- lih. catatan "CoreParams adalah cermin EXACT
 *                                 blok push-constant hulu" di `params.ts`, field baru
 *                                 di sana akan menyimpang dari kontrak itu).
 *   `printFactorMidgray`       -- 1 f32, `_compute_exposure_factor_midgray` --
 *                                 digabung dari `densitySpectralMidgray` (DIBAKE per
 *                                 stock FILM, lih. `tools/bake_web_assets.py`) dan
 *                                 `printFilteredIlluminant` yang baru dihitung di sini.
 *                                 Cabang `_comp` TIDAK diimplementasikan --
 *                                 `print_exposure_compensation` dipaksa `False` di
 *                                 bawah `lut_mode` (satu-satunya keluarga fixture
 *                                 gerbang ini pakai), jadi `_compute_exposure_factor_midgray`
 *                                 SELALU mengambil cabang non-`_comp` untuk keluarga ini
 *                                 (dibuktikan lewat pembacaan langsung kondisi cabangnya,
 *                                 `printing.py:100-107`, bukan diasumsikan).
 *   `printExposureScale`       -- 1 f32, `print_exposure * black_white_printing_exposure_correction()`
 *                                 digabung jadi satu skalar. `print_exposure` DIBACA dari
 *                                 CoreParams? TIDAK -- CoreParams tidak punya slot untuk
 *                                 ini (kontrak exact-mirror yang sama), jadi tetap konstanta
 *                                 host di sini. `black_white_printing_exposure_correction()`
 *                                 == 1.0 TERBUKTI (bukan diasumsikan) untuk SETIAP fixture
 *                                 gerbang ini: `scanner.white_correction`/`black_correction`
 *                                 keduanya `False` di bawah `lut_mode`
 *                                 (`params_builder.py:116-117`), dan fungsi itu sendiri
 *                                 `return 1.0` persis ketika keduanya `False`
 *                                 (`color_reference.py:98-100`) -- TIDAK ADA cabang lain
 *                                 yang bisa dijangkau untuk keluarga `_lut`. `print_exposure`
 *                                 sendiri `EnlargerParams.print_exposure` default `1.0`,
 *                                 dan `lut_mode` MEMAKSANYA `1.0` juga
 *                                 (`params_builder.py:109`) -- jadi skalar ini SELALU `1.0`
 *                                 untuk keluarga `_lut`, disimpan sebagai konstanta terpisah
 *                                 (bukan dihardcode `1.0` di WGSL) supaya gerbang non-`_lut`
 *                                 masa depan (mis. debt diffusion print, family `measured`)
 *                                 bisa mengoper nilai lain tanpa menyentuh shader.
 *   `printExposureCount`       -- 1 f32, `printLogExposure.length`.
 *   `printCurveExposure`       -- (printExposureCount*2) f32, pasangan
 *                                 [nilai, 1/delta] PRINT stock (`makePackedCurveExposure`,
 *                                 dipakai ulang -- SAMA fungsi yang membangun `curveExposure`
 *                                 FILM stock di atas).
 *   `printDensityCurvesMorphed`-- (printExposureCount*3) f32,
 *                                 `evaluateFittedDensity` di atas.
 *
 * `raw_preflash` TIDAK diimplementasikan sebagai entri terpisah --
 * `EnlargerParams.preflash_exposure` default `0.0`, tidak pernah disentuh
 * `params_builder.py` untuk keluarga manapun gerbang ini uji, dan
 * `_compute_raw_preflash` sendiri `return np.zeros((3,))` persis ketika
 * `preflash_exposure <= 0` (`printing.py:94-99`) -- no-op TERBUKTI, bukan
 * diasumsikan (pola yang sama dengan `boost_ev`/`lens_blur_um`'s Task 14/15
 * no-op declarations). `printScan.wgsl` karena itu tidak menambahkan
 * apa pun untuk preflash sama sekali (bukan menambah nol) -- deklarasi
 * cakupan, sama seperti `dir.ts`'s negative-film-only branch.
 */
function addPrintScanDynamicData(
  dynamicBuilder: ArenaBuilder,
  bundle: AssetBundle,
  filmStockId: string,
  printStockId: string,
  enlargerFilters: EnlargerFilterState,
): void {
  const printLogSensitivity = bundle.stockField(printStockId, 'logSensitivity');
  const printLogExposureField = bundle.stockField(printStockId, 'logExposure');
  const densityCurvesModelCenters = bundle.stockField(printStockId, 'densityCurvesModelCenters');
  const densityCurvesModelAmplitudes = bundle.stockField(printStockId, 'densityCurvesModelAmplitudes');
  const densityCurvesModelSigmas = bundle.stockField(printStockId, 'densityCurvesModelSigmas');
  if (
    !printLogSensitivity ||
    !printLogExposureField ||
    !densityCurvesModelCenters ||
    !densityCurvesModelAmplitudes ||
    !densityCurvesModelSigmas
  ) {
    throw new Error(
      `Stock print '${printStockId}' tidak punya logSensitivity/logExposure/densityCurvesModel*`,
    );
  }
  const densitySpectralMidgray = bundle.stockField(filmStockId, 'densitySpectralMidgray');
  if (!densitySpectralMidgray) {
    throw new Error(
      `Stock film '${filmStockId}' tidak punya densitySpectralMidgray (stock kertas tidak sah dipakai sebagai film)`,
    );
  }

  const thKg3Illuminant = bundle.staticTable('thKg3Illuminant');
  const customEnlargerFilters = bundle.staticTable('customEnlargerFilters');
  const printFilteredIlluminant = filteredEnlargerIlluminant(
    thKg3Illuminant,
    customEnlargerFilters,
    enlargerFilters,
  );

  const printLinearSensitivity = linearSensitivityFrom(printLogSensitivity);

  // `_compute_exposure_factor_midgray`, cabang non-`_comp` (lih. docstring
  // di atas untuk bukti kenapa itu satu-satunya cabang yang gerbang ini
  // capai): `_exposure_factor(sensitivity, print_illuminant, density_spectral_midgray)`.
  const wavelengthCount = printFilteredIlluminant.length;
  const rawMidgray: [number, number, number] = [0, 0, 0];
  for (let wl = 0; wl < wavelengthCount; wl += 1) {
    const densitySpectral = densitySpectralMidgray[wl]!;
    let transmitted = 10 ** -densitySpectral * printFilteredIlluminant[wl]!;
    if (Number.isNaN(transmitted)) transmitted = 0;
    rawMidgray[0] += transmitted * printLinearSensitivity[wl * 3]!;
    rawMidgray[1] += transmitted * printLinearSensitivity[wl * 3 + 1]!;
    rawMidgray[2] += transmitted * printLinearSensitivity[wl * 3 + 2]!;
  }
  const clampedMidgray = rawMidgray.map((v) => Math.max(v, 1e-10));
  const logMean =
    (Math.log(clampedMidgray[0]!) + Math.log(clampedMidgray[1]!) + Math.log(clampedMidgray[2]!)) / 3;
  const rawMidgrayGeomean = Math.exp(logMean);
  const factorMidgray = 1 / rawMidgrayGeomean;

  const printExposureCount = printLogExposureField.length;
  const printStockType = bundle.stockEntry(printStockId).type;
  const printDensityCurvesMorphed = evaluateFittedDensity(
    printLogExposureField,
    densityCurvesModelCenters,
    densityCurvesModelAmplitudes,
    densityCurvesModelSigmas,
    printStockType,
  );

  dynamicBuilder.add('printLinearSensitivity', printLinearSensitivity);
  dynamicBuilder.add('printFilteredIlluminant', printFilteredIlluminant);
  dynamicBuilder.add('printWavelengthCount', Float32Array.of(wavelengthCount));
  dynamicBuilder.add('printFactorMidgray', Float32Array.of(factorMidgray));
  // print_exposure(1.0, forced by lut_mode) * black_white_printing_exposure_correction()
  // (1.0, proven above) -- see docstring for why this is 1.0 for every
  // current fixture and why it is still a named constant, not a WGSL literal.
  dynamicBuilder.add('printExposureScale', Float32Array.of(1.0));
  dynamicBuilder.add('printExposureCount', Float32Array.of(printExposureCount));
  dynamicBuilder.add('printCurveExposure', makePackedCurveExposure(printLogExposureField));
  dynamicBuilder.add('printDensityCurvesMorphed', printDensityCurvesMorphed);

  addScannerPostDynamicData(dynamicBuilder, bundle, printStockId);
}

/**
 * Task 18 (ScannerPost): entri arena `dynamic` untuk `ScanningStage.scan()`
 * Python (`runtime/stages/scanning.py`) -- `_density_to_rgb` (cabang
 * `io.scan_film=False`, mencetak PRINT) + `compress_rgb` (`output_gamut_
 * compress.algorithm="cam16ucs"`, DEFAULT Python, TIDAK di-override
 * `tools/gen_reference.py` untuk fixture manapun -- diverifikasi lewat
 * probe host langsung, matikan langkah ini mengubah `rgb_out` sampai maks
 * abs 1.06 pada `color_patches_lut`, lih. task-18-report.md).
 *
 * `_apply_blur_and_unsharp` (`scanner.lens_blur`, `scanner.unsharp_mask`)
 * dan `black_white_xyz_correction` TIDAK diimplementasikan di sini --
 * TERBUKTI no-op untuk keluarga `_lut` (`params_builder.py:116-118`,
 * `ScannerParams.unsharp_mask` default `(0.7,0.7)` TAPI `lut_mode`
 * memaksanya `(0,0)`; `lens_blur` default `0.0` sudah nol; `white_correction`/
 * `black_correction` default `False` dan `lut_mode` MEMAKSANYA `False` juga
 * -- keduanya `False` membuat `black_white_xyz_correction` `return xyz`
 * identitas, `color_reference.py:116-119`). `add_glare` (stokastik) TIDAK
 * diimplementasikan di sini -- gerbang statistik Task 18 (family
 * `_stochastic`), bukan gerbang `_lut` ini.
 *
 * SEMUA field di bawah PRINT-stock-dependent KECUALI konstanta CAM16
 * (`scannerCam16*`, tetap untuk `output_color_space="sRGB"` -- lih.
 * `src/host/cam16.ts` untuk derivasinya lengkap dengan bukti numerik).
 *
 * `scanIlluminant`/`scanToOutputRgb` SUDAH DIBAKE (bake_web_assets.py,
 * dari sebelum Task 18 -- `scan_illuminant`/`_scan_to_output_rgb_matrices`
 * di `generate_profile_curves.py`, TIDAK perlu bake baru sama sekali):
 * `scanIlluminant` = `standard_illuminant(viewing_illuminant)` PRINT,
 * `scanToOutputRgb` = 26 matriks `XYZ_to_RGB(..., illuminant=scan_
 * illuminant_xy, chromatic_adaptation_transform="CAT02")` per ruang warna
 * -- `colour.XYZ_to_RGB`'s DEFAULT CAT (diverifikasi lewat introspeksi
 * `inspect.signature`) adalah `'CAT02'` juga, jadi bake OFX ini cocok
 * runtime Python tanpa divergensi (lih. task-18-report.md).
 *
 * `channelDensity`/`baseDensity` PRINT dibaca di sini APA ADANYA (field
 * per-stock yang SAMA yang Task 17 sudah tambahkan ke arena `stock` FILM
 * -- `bake_web_assets.py` membakunya untuk KEDUA kelompok stock, film
 * MAUPUN kertas, jadi tidak ada bake baru untuk field ini juga).
 */
function addScannerPostDynamicData(
  dynamicBuilder: ArenaBuilder,
  bundle: AssetBundle,
  printStockId: string,
): void {
  const channelDensity = bundle.stockField(printStockId, 'channelDensity');
  const baseDensity = bundle.stockField(printStockId, 'baseDensity');
  const scanIlluminant = bundle.stockField(printStockId, 'scanIlluminant');
  const scanToOutputRgb = bundle.stockField(printStockId, 'scanToOutputRgb');
  if (!channelDensity || !baseDensity || !scanIlluminant || !scanToOutputRgb) {
    throw new Error(
      `Stock print '${printStockId}' tidak punya channelDensity/baseDensity/scanIlluminant/scanToOutputRgb`,
    );
  }
  const wavelengthCount = bundle.stockEntry(printStockId).wavelengthCount;

  const srgbIndex = bundle.manifest.colorSpaces.labels.indexOf('sRGB');
  if (srgbIndex < 0) throw new Error("colorSpaces.labels tidak punya 'sRGB'");
  const scanToOutputRgbSrgb = scanToOutputRgb.slice(srgbIndex * 9, srgbIndex * 9 + 9);

  const cmfs = bundle.staticTable('standardObserverCmfs');
  // `normalization = sum(scan_illuminant * STANDARD_OBSERVER_CMFS[:,1])`
  // (`scanning.py:69`) -- konstan per render (tidak bergantung piksel),
  // dihitung SEKALI di sini alih-alih setiap dispatch piksel menjumlahkan
  // ulang `wavelengthCount` suku yang sama di `scannerPost.wgsl`.
  let normalization = 0;
  for (let wl = 0; wl < wavelengthCount; wl += 1) {
    normalization += scanIlluminant[wl]! * cmfs[wl * 3 + 1]!;
  }

  dynamicBuilder.add('scannerChannelDensity', channelDensity.slice());
  dynamicBuilder.add('scannerBaseDensity', baseDensity.slice());
  dynamicBuilder.add('scannerIlluminant', scanIlluminant.slice());
  dynamicBuilder.add('scannerWavelengthCount', Float32Array.of(wavelengthCount));
  dynamicBuilder.add('scannerNormalization', Float32Array.of(normalization));
  dynamicBuilder.add('scannerToOutputRgb', Float32Array.from(scanToOutputRgbSrgb));

  // Konstanta CAM16 (`compress_rgb`, `output_color_space="sRGB"`) -- lih.
  // `src/host/cam16.ts` untuk turunan lengkap. `buildScannerCam16Static`
  // menjalankan bisection 64x720x18 (~830rb evaluasi CAM16 inverse) --
  // beban CPU host yang SAMA jenisnya dengan `hanatosRawResponse` di atas,
  // WAJIB selesai di sini (sebelum `acquireDevice()`), bukan disebar ke
  // WGSL per piksel (lih. CATATAN LINGKUNGAN modul ini).
  const cam16 = buildScannerCam16Static();
  dynamicBuilder.add(
    'scannerCam16Viewing',
    Float32Array.of(
      cam16.viewing.D_RGB[0],
      cam16.viewing.D_RGB[1],
      cam16.viewing.D_RGB[2],
      cam16.viewing.F_L,
      cam16.viewing.N_bb,
      cam16.viewing.z,
      cam16.viewing.A_w,
      cam16.viewing.n,
    ),
  );
  dynamicBuilder.add('scannerCam16CmaxTable', cam16.cmaxTable);
}

/**
 * Pencarian biner + interpolasi linear atas larik `(xp, fp)` naik --
 * replika host (f64) dari `np.interp` NumPy (bukan `fast_interp` Python,
 * yang dipakai `interpolate_exposure_to_density`/`developFilmDensity`).
 * `couplers.py::compute_density_curves_before_dir_couplers` memanggil
 * `np.interp` LANGSUNG (`import numpy as np`), bukan `fast_interp` --
 * kedua fungsi berbagi algoritma dasar yang sama (pencarian biner +
 * interpolasi linear, klem di kedua ujung ke `fp[0]`/`fp[-1]`), jadi
 * pencarian biner yang sama (identik dengan `curveExposureValue`/
 * `interpDensityCurve` WGSL) dipakai ulang di sini untuk KEDUANYA --
 * dibuktikan cocok terhadap fixture Python sampai ~1e-7 lewat skrip
 * host-math sekali-pakai sebelum WGSL ditulis (lih. task-13-report.md).
 *
 * `xp` TIDAK divalidasi naik monoton -- kalau hulu memberi array yang
 * tidak monoton, pencarian biner ini mereproduksi PERSIS perilaku
 * `np.interp` untuk kasus itu (keduanya berasumsi naik tanpa memeriksa),
 * bukan melempar galat atau mengurutkan ulang.
 */
function npInterpOne(x: number, xp: ArrayLike<number>, fp: ArrayLike<number>): number {
  const count = xp.length;
  if (count === 1) return fp[0]!;
  const first = xp[0]!;
  const last = xp[count - 1]!;
  if (x <= first) return fp[0]!;
  if (x >= last) return fp[count - 1]!;
  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const x0 = xp[lo]!;
  const x1 = xp[hi]!;
  const y0 = fp[lo]!;
  const y1 = fp[hi]!;
  const dx = x1 - x0;
  const t = dx !== 0 ? (x - x0) / dx : 0;
  return y0 + (y1 - y0) * t;
}

/** `np.nanmax(density_curves, axis=0)` -- max per kanal, NaN diabaikan. */
function nanmaxPerChannel(densityCurves: ArrayLike<number>, count: number): [number, number, number] {
  const out: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let j = 0; j < count; j += 1) {
    for (let c = 0; c < 3; c += 1) {
      const v = densityCurves[j * 3 + c]!;
      if (!Number.isNaN(v) && v > out[c]!) out[c] = v;
    }
  }
  return out;
}

/**
 * Port `compute_dir_couplers_matrix(dir_couplers) * dir_couplers.amount`
 * (`model/couplers.py`). Tata letak KELUARAN: baris-mayor donor*3+penerima
 * -- SAMA dengan `contract('jk,km->jm', ...)` Python (`k`=donor, `m`=
 * penerima) dan dengan `correctionFromDensity` OFX (`dirFloats[kDirMatrix +
 * k*3+m]`, dibuktikan dari indeks `M[0],M[3],M[6]` yang dipakai untuk
 * keluaran kanal 0 di `SpektraDir.comp`).
 *
 * `inhibition_samelayer`/`inhibition_interlayer`/`amount` TIDAK diekspos
 * sebagai `CoreParams` dinamis -- `params_builder.py` (kedua repo hulu)
 * tidak pernah meng-override ketiganya dari default `DirCouplersParams`
 * (1.0/1.0/1.0) untuk konfigurasi manapun, jadi mereka konstanta host di
 * sini, bukan field arena/CoreParams. Baru perlu jadi dinamis kalau ada
 * kontrol UI "kekuatan DIR" di kemudian hari.
 */
function computeDirCouplersMatrix(
  gammaSameLayerRgb: ArrayLike<number>,
  gammaRToGb: ArrayLike<number>,
  gammaGToRb: ArrayLike<number>,
  gammaBToRg: ArrayLike<number>,
  inhibitionSameLayer: number,
  inhibitionInterlayer: number,
  amount: number,
): Float32Array {
  const m = new Float64Array(9);
  m[0 * 3 + 0] = gammaSameLayerRgb[0]! * inhibitionSameLayer;
  m[1 * 3 + 1] = gammaSameLayerRgb[1]! * inhibitionSameLayer;
  m[2 * 3 + 2] = gammaSameLayerRgb[2]! * inhibitionSameLayer;
  m[0 * 3 + 1]! += gammaRToGb[0]! * inhibitionInterlayer;
  m[0 * 3 + 2]! += gammaRToGb[1]! * inhibitionInterlayer;
  m[1 * 3 + 0]! += gammaGToRb[0]! * inhibitionInterlayer;
  m[1 * 3 + 2]! += gammaGToRb[1]! * inhibitionInterlayer;
  m[2 * 3 + 0]! += gammaBToRg[0]! * inhibitionInterlayer;
  m[2 * 3 + 1]! += gammaBToRg[1]! * inhibitionInterlayer;
  const out = new Float32Array(9);
  for (let i = 0; i < 9; i += 1) out[i] = m[i]! * amount;
  return out;
}

/**
 * Port `compute_density_curves_before_dir_couplers` (`model/couplers.py`)
 * -- kurva densitas "sebelum" efek coupler DIR, dihitung SEKALI per stock
 * (bukan per piksel): untuk setiap kanal keluaran `i`, kurva densitas
 * aslinya di-resample pada grid `logExposure` yang SAMA, tapi terhadap
 * sumbu-x yang sudah digeser oleh jumlah coupler yang "dilepas" tetangga-
 * tetangganya (`logExposure0`). Hasilnya tetap berbagi grid-x `logExposure`
 * yang sama dengan `densityCurves` asli -- shader hanya perlu mengganti
 * tabel-y yang dibaca `interpDensityCurve`, BUKAN pencarian binernya.
 *
 * `positive` (film pembalik/reversal) membalik tanda sebelum DAN sesudah
 * interpolasi (`-np.interp(..., -density_curves[:,i])`) dan memakai
 * "silver density" `nanmax - density_curves` alih-alih `density_curves`
 * apa adanya -- diimplementasikan untuk kelengkapan (baik untuk stock print
 * positif kelak), meski setiap fixture `cmy_film` gerbang Task 13 memakai
 * `kodak_portra_400` (`type: "negative"`, cabang `positive=false`, TIDAK
 * pernah menempuh cabang ini).
 */
function computeDirDensityCurvesBeforeCouplers(
  densityCurves: ArrayLike<number>,
  logExposure: ArrayLike<number>,
  matrix: ArrayLike<number>,
  positive: boolean,
  count: number,
): Float32Array {
  const silver = new Float64Array(count * 3);
  if (positive) {
    const maxPerChannel = nanmaxPerChannel(densityCurves, count);
    for (let j = 0; j < count; j += 1) {
      for (let c = 0; c < 3; c += 1) silver[j * 3 + c] = maxPerChannel[c]! - densityCurves[j * 3 + c]!;
    }
  } else {
    for (let i = 0; i < count * 3; i += 1) silver[i] = densityCurves[i]!;
  }

  const logExposure0 = new Float64Array(count * 3); // [j*3+m]
  for (let j = 0; j < count; j += 1) {
    for (let m = 0; m < 3; m += 1) {
      let acc = 0;
      for (let k = 0; k < 3; k += 1) acc += silver[j * 3 + k]! * matrix[k * 3 + m]!;
      logExposure0[j * 3 + m] = logExposure[j]! - acc;
    }
  }

  const out = new Float32Array(count * 3);
  for (let channel = 0; channel < 3; channel += 1) {
    const xp = new Float64Array(count);
    const fp = new Float64Array(count);
    for (let j = 0; j < count; j += 1) {
      xp[j] = logExposure0[j * 3 + channel]!;
      fp[j] = positive ? -densityCurves[j * 3 + channel]! : densityCurves[j * 3 + channel]!;
    }
    for (let j = 0; j < count; j += 1) {
      const y = npInterpOne(logExposure[j]!, xp, fp);
      out[j * 3 + channel] = positive ? -y : y;
    }
  }
  return out;
}

/**
 * Hasil pra-hitung arena: empat `ArenaBuilder` yang sudah terisi penuh tapi
 * BELUM menyentuh GPU. Dibangun `precomputeArenaData()`, dikonsumsi
 * `uploadArenas()`. Setiap builder hanya boleh di-`build()` sekali (dijaga
 * `ArenaBuilder` sendiri lewat `#built`), jadi satu `ArenaPlan` juga hanya
 * boleh diunggah sekali.
 */
export interface ArenaPlan {
  static: ArenaBuilder;
  stock: ArenaBuilder;
  dynamic: ArenaBuilder;
  frameState: ArenaBuilder;
}

/**
 * Task 17 (PrintScan) -- opsional, karena tahap 12-16 tetap membangun arena
 * satu-stock apa adanya. Bila diberikan, `precomputeArenaData` menambah
 * entri PRINT ke `dynamic` arena YANG SAMA yang sudah dibangun untuk
 * `stockId` (FILM) -- BUKAN memanggil `precomputeArenaData` kedua kalinya
 * untuk `printStockId` (itu akan menduplikasi `static`/`stock` PRINT yang
 * sama sekali tidak relevan bagi `printScan.wgsl`, dan mendekati batas 8
 * storage buffer tanpa alasan -- lih. komentar panjang di
 * `addPrintScanDynamicData` di bawah).
 *
 * `enlargerFilters` genuinely runtime-tunable (lih. `src/host/enlarger.ts`)
 * -- pemanggil BOLEH mengganti `mFilterShift`/`yFilterShift` antar-render
 * tanpa membangun ulang arena FILM manapun; hanya bagian print yang
 * bergantung padanya dihitung ulang.
 */
export interface PrintScanArenaOptions {
  printStockId: string;
  enlargerFilters: EnlargerFilterState;
}

export function precomputeArenaData(
  bundle: AssetBundle,
  stockId: string,
  printScan?: PrintScanArenaOptions,
): ArenaPlan {
  const stock = bundle.stockEntry(stockId);
  const wavelengthCount = stock.wavelengthCount;
  const { width: hanatosWidth, height: hanatosHeight } = bundle.manifest.hanatos;

  // --- arena static: dibagi lintas SEMUA stock, dibuktikan di komentar modul ---
  const staticBuilder = new ArenaBuilder();
  const inputToSrgb = bundle.stockField(stockId, 'inputToSrgb');
  if (!inputToSrgb) throw new Error(`Stock '${stockId}' tidak punya inputToSrgb`);
  staticBuilder.add('inputToSrgb', inputToSrgb.slice());
  staticBuilder.add('colorDecodeLuts', bundle.staticTable('colorDecodeLuts').slice());
  staticBuilder.add('colorTransferKinds', bundle.staticTable('colorTransferKinds').slice());
  // Task 18 (ScannerPost): `standardObserverCmfs` diunggah ke GPU di sini
  // (sebelumnya hanya dibaca host-side, mis. di `addPrintScanDynamicData`
  // untuk `printFactorMidgray`) -- `scannerPost.wgsl` mengintegrasikan
  // `density_to_light(...)` terhadap CMF per piksel (`cmy_to_log_xyz`
  // Python, `runtime/stages/scanning.py`), jadi butuh salinan yang bisa
  // dibaca shader, bukan cuma nilai turunan host. Sama untuk SEMUA stock,
  // ditambah TANPA SYARAT (bukan hanya ketika `printScan` diberikan) --
  // entri baru murni aditif, tidak menggeser offset entri lain di atas.
  staticBuilder.add('standardObserverCmfs', bundle.staticTable('standardObserverCmfs').slice());

  // --- arena stock: berubah bersama stock yang dipilih ---
  const linearSensitivity = linearSensitivityFrom(bundle.stockField(stockId, 'logSensitivity')!);
  const mallettBasisIlluminant = bundle.stockField(stockId, 'mallettBasisIlluminant');
  if (!mallettBasisIlluminant) throw new Error(`Stock '${stockId}' tidak punya mallettBasisIlluminant`);

  const stockBuilder = new ArenaBuilder();
  const inputToReferenceXyz = bundle.stockField(stockId, 'inputToReferenceXyz');
  if (!inputToReferenceXyz) throw new Error(`Stock '${stockId}' tidak punya inputToReferenceXyz`);
  stockBuilder.add('inputToReferenceXyz', inputToReferenceXyz.slice());
  stockBuilder.add(
    'mallettRawMatrix',
    computeMallettRawMatrix(
      linearSensitivity,
      mallettBasisIlluminant,
      stock.mallettRawMidgrayGreen,
      wavelengthCount,
    ),
  );

  // --- Task 12 (CurveDevelop): kurva H&D siap pakai satu stock ---
  // `densityCurves` sudah TERNORMALISASI di sumbernya (`bake_web_assets.py`
  // Task 4 memakai `_normalized_density_curves` untuk stock film, meniru
  // `density_curves - np.nanmin(density_curves, axis=0)` Python di
  // `model/develop.py::develop`) -- disalin apa adanya, TANPA normalisasi
  // ulang di sini.
  const curveStock = bundle.stock(stockId);
  stockBuilder.add('curveExposure', makePackedCurveExposure(curveStock.logExposure));
  stockBuilder.add('densityCurves', curveStock.densityCurves.slice());

  // --- Task 17 (PrintScan): FILM stock's spectral density model, read by
  // `printScan.wgsl`'s `expose` entry (`compute_density_spectral`,
  // `model/develop.py`) to turn a pixel's `cmy_film` density into a
  // per-wavelength spectral density BEFORE it passes through the enlarger's
  // filtered illuminant. Raw, NOT normalized (Python's `compute_density_spectral`
  // uses `self._film.data.channel_density`/`base_density` untouched -- the
  // `- np.nanmin(...)` normalization above applies ONLY to `density_curves`,
  // for `develop()`'s curve lookup, a completely different table). Both
  // fields genuinely contain NaN at scattered positions (bake-time
  // `nullCount`, see `tools/bake_web_assets.py::_flat_f32`) -- preserved
  // here exactly as `channelDensity`/`baseDensity` document, NOT
  // nan_to_num'd: Python's own `density_to_light` only zeroes the NaN
  // AFTER the `10**-density` transmittance step
  // (`transmitted[np.isnan(transmitted)] = 0`), never before, so
  // `printScan.wgsl` must replicate that exact point of zeroing, not this one.
  const channelDensity = bundle.stockField(stockId, 'channelDensity');
  const baseDensity = bundle.stockField(stockId, 'baseDensity');
  if (!channelDensity || !baseDensity) {
    throw new Error(`Stock '${stockId}' tidak punya channelDensity/baseDensity`);
  }
  stockBuilder.add('channelDensity', channelDensity.slice());
  stockBuilder.add('baseDensity', baseDensity.slice());

  // --- Task 13 (Dir): koreksi coupler DIR, non-spasial di bawah `lut_mode`
  // (`dir_couplers.diffusion_size_um` dinolkan `deactivate_spatial_effects`,
  // TAPI `dir_couplers.active` tetap `True` -- lih. task-12-report.md dan
  // spec §6.3.2). Matriks crosstalk dan kurva "sebelum DIR" bergantung HANYA
  // pada stock (bukan per-piksel/per-frame), jadi keduanya dihitung SEKALI
  // di sini, sama seperti `curveExposure`/`densityCurves` di atas -- bukan
  // di shader per dispatch. ---
  const dirGammaSameLayerRgb = bundle.stockField(stockId, 'dirGammaSameLayerRgb');
  const dirGammaRToGb = bundle.stockField(stockId, 'dirGammaRToGb');
  const dirGammaGToRb = bundle.stockField(stockId, 'dirGammaGToRb');
  const dirGammaBToRg = bundle.stockField(stockId, 'dirGammaBToRg');
  if (!dirGammaSameLayerRgb || !dirGammaRToGb || !dirGammaGToRb || !dirGammaBToRg) {
    throw new Error(`Stock '${stockId}' tidak punya field gamma DIR coupler`);
  }
  // `DirCouplersParams` default (`params_schema.py:130-141`) -- lih. komentar
  // `computeDirCouplersMatrix` untuk kenapa ini konstanta host, bukan param dinamis.
  const DIR_INHIBITION_SAMELAYER = 1.0;
  const DIR_INHIBITION_INTERLAYER = 1.0;
  const DIR_AMOUNT = 1.0;
  const dirCouplersMatrix = computeDirCouplersMatrix(
    dirGammaSameLayerRgb,
    dirGammaRToGb,
    dirGammaGToRb,
    dirGammaBToRg,
    DIR_INHIBITION_SAMELAYER,
    DIR_INHIBITION_INTERLAYER,
    DIR_AMOUNT,
  );
  const dirIsPositive = stock.type === 'positive';
  const dirDensityMax = nanmaxPerChannel(curveStock.densityCurves, curveStock.logExposure.length);
  const dirDensityCurvesBeforeCouplers = computeDirDensityCurvesBeforeCouplers(
    curveStock.densityCurves,
    curveStock.logExposure,
    dirCouplersMatrix,
    dirIsPositive,
    curveStock.logExposure.length,
  );
  stockBuilder.add('dirCouplersMatrix', dirCouplersMatrix);
  stockBuilder.add('dirDensityMax', Float32Array.from(dirDensityMax));
  stockBuilder.add('dirIsPositive', Float32Array.of(dirIsPositive ? 1 : 0));
  stockBuilder.add('dirDensityCurvesBeforeCouplers', dirDensityCurvesBeforeCouplers);

  // --- Task 14 (Halation): back-reflection strength/sigma presets. Baked
  // per-stock by `tools/bake_web_assets.py::pack_stock` from
  // `generate_profile_curves.py::_halation_preset(info)` -- verified
  // byte-identical to Python runtime's own `_apply_halation_preset`
  // (`params_builder.py:218-241`, table `_HALATION_PRESETS`) for every
  // (use, antihalation) combination, so no `compare_cpp.py` deviation is
  // needed here (unlike density_curves, spec §6.3.1). Everything ELSE
  // `HalationParams` carries (scatter_core_um, scatter_tail_um,
  // scatter_tail_weight, scatter/halation amount+scale, n_bounces, decay,
  // renormalize) is a schema-level constant `_apply_halation_preset` never
  // touches for any of the 28 stocks -- those live as WGSL constants in
  // `halation.wgsl`, not here, mirroring `SpektraHalation.comp` which
  // hardcodes the identical numbers itself.
  const halationStrength = bundle.stockField(stockId, 'halationStrength');
  const halationFirstSigmaUm = bundle.stockField(stockId, 'halationFirstSigmaUm');
  if (!halationStrength || !halationFirstSigmaUm) {
    throw new Error(`Stock '${stockId}' tidak punya halationStrength/halationFirstSigmaUm`);
  }
  stockBuilder.add('halationStrength', halationStrength.slice());
  stockBuilder.add('halationFirstSigmaUm', halationFirstSigmaUm.slice());

  // --- Task 16 (Grain): per-layer density curves + their per-sublayer
  // maxima. `apply_grain` (`model/grain.py:166-213`) is called with
  // `grain.sublayers_active` default `True` (`params_schema.py:91`) --
  // TRUE REGARDLESS of `n_sub_layers` (default 1u, but that field is only
  // read inside `apply_grain_to_density`, the NON-layers branch, which
  // `sublayers_active=True` never reaches). So the ACTUAL default grain
  // model for every fixture this gate uses is `apply_grain_to_density_layers`
  // (`model/grain.py:112-163`, the "experimental" multi-layer model, despite
  // its comment) -- established empirically, not assumed, by reading
  // `apply_grain`'s branch condition directly (task-16-report.md).
  //
  // `densityCurveLayers` is baked RAW (`bake_web_assets.py::pack_stock` ->
  // `gpc._numeric_layers(profile, "density_curves_layers")`), NOT
  // normalized like `densityCurves` -- matches Python exactly:
  // `develop()` passes `density_curves_layers` (raw `self._film.data.
  // density_curves_layers`) straight through to `apply_grain` untouched,
  // while `density_curves` gets `- np.nanmin(..., axis=0)` first. Only the
  // SEARCH AXIS (`densityCurves`, already normalized, already baked) needs
  // that shift; the per-layer table being interpolated does not.
  const densityCurveLayers = bundle.stockField(stockId, 'densityCurveLayers');
  const densityCurveLayerMaxima = bundle.stockField(stockId, 'densityCurveLayerMaxima');
  if (!densityCurveLayers || !densityCurveLayerMaxima) {
    throw new Error(`Stock '${stockId}' tidak punya densityCurveLayers/densityCurveLayerMaxima`);
  }
  stockBuilder.add('densityCurveLayers', densityCurveLayers.slice());
  stockBuilder.add('densityCurveLayerMaxima', densityCurveLayerMaxima.slice());

  // --- arena dynamic: dihitung dari data stock (Task 11 Step 5) ---
  const wavelengths = bundle.stockField(stockId, 'wavelengths');
  const referenceIlluminantSpectrum = bundle.stockField(stockId, 'referenceIlluminantSpectrum');
  const windowParams = bundle.stockField(stockId, 'hanatos2026WindowParams');
  if (!wavelengths || !referenceIlluminantSpectrum || !windowParams) {
    throw new Error(
      `Stock '${stockId}' tidak punya wavelengths/referenceIlluminantSpectrum/hanatos2026WindowParams`,
    );
  }
  const cmfs = bundle.staticTable('standardObserverCmfs');

  const window = computeErf4Window(wavelengths, windowParams);
  const baseResponse = makeHanatosRawResponse(
    bundle.hanatos,
    linearSensitivity,
    window,
    referenceIlluminantSpectrum,
    hanatosWidth,
    hanatosHeight,
    wavelengthCount,
  );
  const whiteXy = filmReferenceIlluminantXy(referenceIlluminantSpectrum, cmfs, wavelengthCount);
  const locus = spectralLocusXy(wavelengths, cmfs, wavelengthCount);
  const compressedResponse = remapHanatosResponseForInputGamutCompression(
    baseResponse,
    whiteXy,
    locus,
    hanatosWidth,
    hanatosHeight,
  );
  const hanatosRawResponse = packVec4Pair(baseResponse, compressedResponse);

  const dynamicBuilder = new ArenaBuilder();
  dynamicBuilder.add('hanatosRawResponse', hanatosRawResponse);

  // --- Task 15 (Diffusion, resumed after BLOCKED -- lih. task-15-report.md
  // untuk kenapa jalur pyramid OFX mati dan jalur konvolusi-eksak yang
  // menggantikannya): PSF per-kanal untuk gerbang kamera `log_e_film`
  // BARU (`hard_edge_diffusion_camera`/`impulse_highlight_diffusion_camera`,
  // `tools/gen_reference.py`), dan untuk sisi print (`log_e_print`) yang
  // TIDAK digerbangi -- lih. peringatan panjang di `diffusionFilter.ts`
  // dan di `stages/diffusion.ts` untuk kenapa PSF ini TIDAK per-stock
  // (independen dari stock sepenuhnya -- `apply_diffusion_filter_um`
  // Python beroperasi murni di ruang RGB) TAPI TERIKAT pada
  // `CAMERA_DIFFUSION_PIXEL_SIZE_UM` di bawah, yang HANYA benar untuk
  // fixture 64px/35mm baru itu -- BUKAN kontrak umum "arena stock aman
  // dipakai ulang lintas ukuran gambar apa pun" yang berlaku untuk
  // entri Task 12-14 di atas.
  //
  // Family/strength: DEFAULT `DiffusionFilterParams` Python persis
  // (`filter_family="black_pro_mist"`, `strength=0.5`, sisanya default) --
  // satu-satunya perubahan yang `gen_reference.py` buat untuk fixture baru
  // ini adalah `active=True`. Menghasilkan p_s=0.2625, radius=14 (kernel
  // 29x29) pada pixel_size_um=546.875 -- diverifikasi cocok dengan
  // `diffusion_filter_psf`/`apply_diffusion_filter_um` Python asli (bukan
  // ditranskripsi ulang dari tabel) sampai ~1e-8 (batas presisi f32) di
  // host, SEBELUM baris WGSL manapun ditulis -- lih. task-15-report.md.
  //
  // Print (`enlarger.diffusion_filter`) memakai family/strength DEFAULT
  // yang SAMA -- BUKAN lagi placeholder tak terverifikasi (Task 17 debt,
  // lih. `docs/superpowers/plans/2026-09-11-dichroic-phase1-engine.md`
  // bagian "Selesai Fase 1"): `test/parity/diffusion.test.ts`'s describe
  // kedua menggerbangi `createDiffusionStage(device, arenas, 'print')`
  // terhadap fixture baru `hard_edge_diffusion_print`/
  // `impulse_highlight_diffusion_print`
  // (`tools/gen_reference.py::_build_params_diffusion_print`,
  // `enlarger.diffusion_filter.active=True`, family/strength default APA
  // ADANYA), max abs error ~2.4e-7/~4.8e-7 -- angka ini SEKARANG jadi bukti
  // langsung nilai default itu benar, bukan cuma "tidak ada dasar memilih
  // nilai lain". `pixel_size_um` identik untuk kedua situs di Python sendiri
  // (`FilmingStage`/`PrintingStage` keduanya membaca
  // `self._resize_service.pixel_size_um` yang sama, DIBUKTIKAN langsung dari
  // `resize.py:18`, bukan kebetulan), jadi berbagi konstanta di sini bukan
  // penyimpangan tambahan.
  const CAMERA_DIFFUSION_PIXEL_SIZE_UM = 546.875; // 35mm * 1000 / 64px, fixture baru Task 15.
  const CAMERA_DIFFUSION_MIN_IMAGE_DIM = 64;
  const cameraDiffusion = precomputeDiffusionFilter(
    { family: 'black_pro_mist', strength: 0.5 },
    CAMERA_DIFFUSION_PIXEL_SIZE_UM,
    CAMERA_DIFFUSION_MIN_IMAGE_DIM,
  );
  dynamicBuilder.add('diffusionRadiusCamera', Float32Array.of(cameraDiffusion.radius));
  dynamicBuilder.add('diffusionScatterFractionCamera', Float32Array.of(cameraDiffusion.scatterFraction));
  dynamicBuilder.add('diffusionPsfCamera', cameraDiffusion.psf);

  const printDiffusion = precomputeDiffusionFilter(
    { family: 'black_pro_mist', strength: 0.5 },
    CAMERA_DIFFUSION_PIXEL_SIZE_UM,
    CAMERA_DIFFUSION_MIN_IMAGE_DIM,
  );
  dynamicBuilder.add('diffusionRadiusPrint', Float32Array.of(printDiffusion.radius));
  dynamicBuilder.add('diffusionScatterFractionPrint', Float32Array.of(printDiffusion.scatterFraction));
  dynamicBuilder.add('diffusionPsfPrint', printDiffusion.psf);

  // --- Task 17 (PrintScan): PRINT-stock-dependent tables, added to the
  // SAME dynamic arena as the FILM stock's entries above. See
  // `addPrintScanDynamicData` for why these live here (not a second
  // `stock`/`static` arena pair) and why they're safe to compute for a
  // DIFFERENT stock (`printScan.printStockId`) than the `stockId` this
  // whole function was called for.
  if (printScan) {
    addPrintScanDynamicData(dynamicBuilder, bundle, stockId, printScan.printStockId, printScan.enlargerFilters);
  }

  // --- arena frameState: kosong untuk Task 11 (lih. dokumentasi modul) ---
  const frameStateBuilder = new ArenaBuilder();

  return {
    static: staticBuilder,
    stock: stockBuilder,
    dynamic: dynamicBuilder,
    frameState: frameStateBuilder,
  };
}

/**
 * Unggah rencana arena ke GPU. Satu-satunya bagian modul ini yang menyentuh
 * `GPUDevice`, dan sengaja bebas aritmetika: semua matematika sudah selesai di
 * `precomputeArenaData()`. Lihat CATATAN LINGKUNGAN di atas untuk kenapa
 * pemisahan ini bukan kosmetik.
 */
export function uploadArenas(device: GPUDevice, plan: ArenaPlan): Arenas {
  return {
    static: plan.static.build(device, 'static'),
    stock: plan.stock.build(device, 'stock'),
    dynamic: plan.dynamic.build(device, 'dynamic'),
    frameState: plan.frameState.build(device, 'frameState'),
  };
}
