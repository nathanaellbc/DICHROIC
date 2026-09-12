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

export function precomputeArenaData(bundle: AssetBundle, stockId: string): ArenaPlan {
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
