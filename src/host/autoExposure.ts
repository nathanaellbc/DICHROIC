/**
 * Auto-exposure host-side, dipindah dari `test/parity/params.ts` (Fase 2A
 * Task 1) supaya `Session` bisa memakainya. OFX tidak punya tahap GPU untuk
 * auto-exposure: `SpektraVulkanRenderer.cpp::measureAutoExposureEv` selalu
 * pra-kalkulasi CPU sebelum mengisi `filmExposureEv`, dan port ini sama.
 * Gerbang parity-nya: `filmExposure.test.ts`/`measuredChain.test.ts` (rasio
 * `rgb_pre/input` Python, cocok 6+ angka signifikan -- lih. task-11-report).
 */


/**
 * Port `autoExposureMeterY` (`SpektraVulkanRenderer.cpp:2093-2112`), TANPA
 * decode CCTF -- lih. `src/shaders/filmExposure.wgsl::decodeInputRgb` untuk
 * bukti numerik kenapa decode TIDAK dipakai untuk kombinasi
 * (color_space="ProPhoto RGB", input_cctf_decoding=False) yang dipakai
 * `gen_reference.py`. Python (`_luminance_y`,
 * `spektrafilm/utils/autoexposure.py:5-7`) memanggil
 * `colour.RGB_to_XYZ(image, color_space, apply_cctf_decoding)` dengan
 * `apply_cctf_decoding=io.input_cctf_decoding=False` -- decode TIDAK
 * pernah terjadi di sini juga, untuk alasan yang sama persis.
 */
function meterY(r: number, g: number, b: number, meterMatrix: ArrayLike<number>, colorSpace: number): number {
  const o = colorSpace * 9;
  return meterMatrix[o + 3]! * r + meterMatrix[o + 4]! * g + meterMatrix[o + 5]! * b;
}

/**
 * Port `autoExposurePreviewShape` (:2114-2125) -- untuk gambar uji Task 11
 * (32x16 hingga 64x64), `longEdge <= 256` selalu, jadi preview == gambar
 * penuh (tidak ada downsample). Diimplementasikan penuh (bukan
 * disederhanakan ke identitas) agar benar juga untuk gambar lebih besar di
 * masa depan.
 */
function autoExposurePreviewShape(width: number, height: number): { width: number; height: number } {
  const kPreviewMaxSize = 256;
  const longEdge = Math.max(width, height);
  if (longEdge <= kPreviewMaxSize) return { width, height };
  const scale = kPreviewMaxSize / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Port `measureAutoExposureEv` (:2127-2201), method `center_weighted`
 * (default `CameraParams.auto_exposure_method`) -- satu-satunya method
 * yang `defaultCoreParams` butuh, karena `gen_reference.py` tidak pernah
 * mengubah default itu. Sampling preview dengan nearest-neighbor integer
 * (`(x*width)/previewWidth`), sama seperti hulu C++, meniru kotak
 * `skimage.transform.rescale(..., order=0)` Python untuk `small_preview`
 * (lih. `ResizingService.small_preview`, `resize.py:33-43`) -- keduanya
 * no-op untuk gambar <= 256px di sisi terpanjang.
 */
export function measureAutoExposureEv(
  inputRgba: Float32Array,
  width: number,
  height: number,
  meterMatrix: ArrayLike<number>,
  colorSpace: number,
): number {
  if (width <= 0 || height <= 0) return 0;
  const preview = autoExposurePreviewShape(width, height);
  const luminance = new Float64Array(preview.width * preview.height);
  for (let y = 0; y < preview.height; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor((y * height) / preview.height));
    for (let x = 0; x < preview.width; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor((x * width) / preview.width));
      const p = (sourceY * width + sourceX) * 4;
      luminance[y * preview.width + x] = meterY(
        inputRgba[p]!,
        inputRgba[p + 1]!,
        inputRgba[p + 2]!,
        meterMatrix,
        colorSpace,
      );
    }
  }
  if (luminance.length === 0) return 0;

  const longEdge = Math.max(preview.width, preview.height);
  const normX = preview.width / longEdge;
  const normY = preview.height / longEdge;
  const sigma = 0.2;
  let weightedSum = 0;
  let weightSum = 0;
  let index = 0;
  for (let y = 0; y < preview.height; y += 1) {
    const yf = (y / preview.height - 0.5) * normY;
    for (let x = 0; x < preview.width; x += 1, index += 1) {
      const xf = (x / preview.width - 0.5) * normX;
      const weight = Math.exp(-(xf * xf + yf * yf) / (2 * sigma * sigma));
      weightedSum += luminance[index]! * weight;
      weightSum += weight;
    }
  }
  const meteredY = weightedSum / Math.max(weightSum, 1e-30);

  const exposure = meteredY / 0.184;
  if (!(exposure > 0) || !Number.isFinite(exposure)) return 0;
  const ev = -Math.log2(exposure);
  return Number.isFinite(ev) ? ev : 0;
}
