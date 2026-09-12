// Primitif yang port ini butuhkan sendiri — bukan port dari file hulu manapun.
//
// Peran: menyalin region aktif (activeOrigin/activeWidth/activeHeight) dari
// buffer sumber bertata-letak 2D (stride penuh `width`) ke buffer tujuan,
// piksel vec4<f32> demi vec4<f32>, tanpa konversi bit apa pun. Ini adalah
// tahap PERTAMA di graf: ia menulis tap `rgb_in`.
//
// `GPUCommandEncoder.copyBufferToBuffer` TIDAK bisa menggantikan primitif
// ini: sebuah sub-rektangel dari buffer bertata-letak 2D bukan rentang byte
// kontigu (setiap baris di dalam region aktif dipisahkan oleh `width -
// activeWidth` piksel yang bukan bagian region), sehingga tidak ada satu
// pasang (offset, length) yang bisa menangkapnya lewat satu panggilan copy.
// Ini justru yang dibutuhkan Task 19 untuk tiling: mengekstrak satu tile
// dari buffer full-frame yang lebih besar.
//
// Dari sepuluh shader compute hulu ($SPEKTRAFILM_OFX/shaders/vulkan/), DUA
// tidak di-port ke WGSL — masing-masing dengan alasannya sendiri, bukan
// diabaikan begitu saja:
//
//   - SpektraCopy.comp (24 baris): menyalin satu buffer linear ke buffer
//     lain (dispatch 1D atas kata). `copyBufferToBuffer` WebGPU melakukan
//     hal yang identik tanpa shader — dipakai langsung, bukan diport.
//
//   - SpektraFormatConvert.comp (90 baris, dibaca langsung untuk tugas ini):
//     BUKAN salinan-per-piksel seperti diduga draf rencana sebelumnya.
//     Isinya: blok push-constant SENDIRI (`FormatConvertParams { pixelCount;
//     mode; }`, dicatat sejak params.ts Task 7 sebagai "tidak dicerminkan
//     di sini"), dispatch 1D atas array kata mentah (bukan piksel 2D,
//     dikonfirmasi independen oleh task-6-report.md/task-7-report.md:
//     workgroup 256x1x1, bukan 32x8x1), dan konversi setengah-presisi
//     (fp16, dipaketkan 2 per kata lewat unpackHalf2x16/packHalf2x16) <->
//     presisi-penuh (fp32) lengkap dengan dithering TPDF saat memaketkan ke
//     fp16. Perannya — mengonversi buffer host OFX yang bisa berformat
//     half-float ke format kerja internal engine, dan sebaliknya — TIDAK
//     berlaku di port WebGPU/browser ini: setiap sumber piksel DICHROIC
//     (Task 1-8: loader, arena, params, device) adalah Float32Array dari
//     ujung ke ujung, jadi tidak pernah ada batas half-float untuk
//     dikonversi. Mem-port algoritmanya apa adanya berarti mengubah rasio
//     ukuran buffer source/dest (2 kata per piksel vs 4) dan kehilangan
//     presisi lewat dithering — dua hal yang bertentangan langsung dengan
//     buffer ping-pong berukuran-tetap `RenderGraph` dan dengan uji
//     round-trip identitas Task 9 (lih. graph.test.ts). Karena itu tidak
//     diport; primitif materialisasi-region-aktif di file ini menggantikan
//     perannya di graf (menulis `rgb_in`) dengan operasi yang benar-benar
//     dibutuhkan port ini.
//
// CORE_PARAMS_WGSL disisipkan di sini saat pembuatan modul (lih.
// materializeActiveRegion.ts).

@group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: CoreParams;

@compute @workgroup_size(32, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.activeWidth || gid.y >= params.activeHeight) {
    return;
  }
  let index = (gid.y + params.activeOriginY) * params.width
            + (gid.x + params.activeOriginX);
  dst[index] = src[index];
}
