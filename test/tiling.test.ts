import { describe, it, expect } from 'vitest';
import { estimateTileOverlap, planTiles } from '../src/engine/tiling';
import { RenderGraph } from '../src/engine/graph';
import type { Stage } from '../src/engine/graph';
import { Tap } from '../src/engine/taps';
import { fullChain } from './parity/chain';
import { sharedResources } from './parity/run';
import { defaultCoreParams } from './parity/params';
import { loadCase, loadInputAsRgba } from './parity/compare';
import { createMaterializeActiveRegionStage } from '../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../src/engine/stages/filmExposure';
import { createHalationStage } from '../src/engine/stages/halation';
import { createCurveDevelopStage } from '../src/engine/stages/curveDevelop';
import { createDirStage } from '../src/engine/stages/dir';
import { createGrainStage } from '../src/engine/stages/grain';
import { createPrintExposureStage, createPrintDevelopStage } from '../src/engine/stages/printScan';
import { createScannerPostStage } from '../src/engine/stages/scannerPost';
import { createDiffusionStage } from '../src/engine/stages/diffusion';
import { dirRadiusPx, halationRadiusPx } from '../src/engine/spatialRadius';

describe('perencanaan tile', () => {
  it('tidak memakai apron ketika tidak ada efek spasial aktif', () => {
    expect(
      estimateTileOverlap({
        halationEnabled: false,
        grainEnabled: false,
        cameraDiffusionEnabled: false,
        printDiffusionEnabled: false,
        dirCouplersAmount: 0,
        scannerUnsharpEnabled: false,
      }),
    ).toBe(0);
  });

  it('menjumlahkan apron untuk tiap efek spasial aktif', () => {
    const one = estimateTileOverlap({
      halationEnabled: true,
      grainEnabled: false,
      cameraDiffusionEnabled: false,
      printDiffusionEnabled: false,
      dirCouplersAmount: 0,
      scannerUnsharpEnabled: false,
    });
    const two = estimateTileOverlap({
      halationEnabled: true,
      grainEnabled: true,
      cameraDiffusionEnabled: false,
      printDiffusionEnabled: false,
      dirCouplersAmount: 0,
      scannerUnsharpEnabled: false,
    });
    expect(two).toBeGreaterThan(one);
  });

  it('tile menutupi seluruh gambar tanpa celah', () => {
    const tiles = planTiles(1000, 800, 4_000_000, 32);
    const covered = new Uint8Array(1000 * 800);
    for (const t of tiles) {
      for (let y = t.activeOriginY; y < t.activeOriginY + t.activeHeight; y += 1) {
        for (let x = t.activeOriginX; x < t.activeOriginX + t.activeWidth; x += 1) {
          covered[y * 1000 + x] = 1;
        }
      }
    }
    expect(covered.every((v) => v === 1)).toBe(true);
  });

  it('wilayah aktif tidak tumpang tindih', () => {
    const tiles = planTiles(1000, 800, 4_000_000, 32);
    const counts = new Uint8Array(1000 * 800);
    for (const t of tiles) {
      for (let y = t.activeOriginY; y < t.activeOriginY + t.activeHeight; y += 1) {
        for (let x = t.activeOriginX; x < t.activeOriginX + t.activeWidth; x += 1) {
          counts[y * 1000 + x] = counts[y * 1000 + x]! + 1;
        }
      }
    }
    expect(counts.every((v) => v === 1)).toBe(true);
  });
});

/**
 * Step 5 (gerbang sebenarnya Task 19): render `hard_edge` -- SATU kali
 * full-frame, SATU kali dipaksa ter-tile menjadi empat tile -- dan tegaskan
 * keluarannya IDENTIK bit demi bit (`toEqual` atas `Float32Array`, bukan
 * pembanding toleransi). Bukan perbandingan terhadap `rgb_out.f32` Python
 * (fixture itu TIDAK dipakai di sini) -- ini murni self-consistency ANTARA
 * dua jalur `RenderGraph.run` milik engine ini sendiri.
 *
 * `hard_edge` (family `measured`, BUKAN `_lut`/`_stochastic`) dipilih
 * karena tepi tajamnya membuat seam antar-tile terlihat langsung kalau
 * apron kurang -- ramp halus akan menyembunyikannya (lih. Task 19 di
 * rencana). `stochasticEffectsActive: true` dipaksa true WALAU direktori
 * fixture `hard_edge` sendiri dibangkitkan dengan
 * `deactivate_stochastic_effects=True` (grain/glare MATI di sisi Python,
 * `tools/gen_reference.py::_build_params`) -- itu tidak masalah di sini
 * karena test ini tidak pernah baca `hard_edge/*.f32` Python, hanya
 * `input.f32`/`case.json` (dimensi) miliknya. Menyalakan grain/glare
 * sungguhan di rantai ini justru POIN test: Task 19 note 2 (grain seeded
 * dari koordinat absolut) hanya teruji kalau grain benar-benar jalan.
 * DIR-coupler spasial (Task 18c) dan halation sudah aktif tanpa embel-embel
 * tambahan untuk family `measured` mana pun -- lih. `defaultCoreParams`.
 *
 * Overlap: SENGAJA BUKAN keluaran `estimateTileOverlap` (256px per efek,
 * 832px totalnya untuk kombinasi flag di bawah) -- pada gambar 64x64,
 * apron seukuran itu sendirian sudah melebihi gambar, memaksa SETIAP tile
 * mencakup nyaris seluruh buffer dan mengalahkan tujuan "empat tile nyata"
 * (lih. task-19-report.md untuk aritmetika lengkap kenapa). 256px itu
 * dikalibrasi OFX untuk gambar produksi, bukan fixture 32-64px port ini --
 * `dir.wgsl`/`halation.wgsl` sendiri mencatat radius kernel TERUKUR pada
 * gambar sekecil ini cuma 0-2px. `TEST_OVERLAP_PX=16` di bawah delapan
 * kali radius terukur itu -- margin aman yang jauh lebih realistis untuk
 * ukuran gambar ini, dipilih AGAR `planTiles` menghasilkan tepat empat
 * tile 48x48 (bukan degenerasi jadi puluhan tile 1px ATAU satu tile yang
 * diam-diam mencakup seluruh gambar). Ini TIDAK melonggarkan gerbang:
 * `estimateTileOverlap` sendiri diverifikasi terpisah di atas: assert
 * eksplisit di bawah membuktikan ia >= `TEST_OVERLAP_PX` untuk flag yang
 * sama, jadi nilai produksi TETAP konservatif relatif terhadap apa yang
 * geometri test ini butuhkan.
 *
 * Task 19b -- `TEST_OVERLAP_PX=16` MASIH masuk akal setelah perbaikan ini,
 * TIDAK perlu dinaikkan: `RenderGraph.runSingleBuffer` mengklip active rect
 * yang dibesarkan ke batas BUFFER tile yang sebenarnya (`inflateActiveRect`),
 * jadi tahap paling awal (yang `remainingSpatialRadius`-nya, 832px, jauh
 * melebihi buffer 48x48 tile ini) otomatis memproses SELURUH buffer tile --
 * PERSIS yang `activeRectShrinkEnabled=false`/hulu lakukan pada kondisi
 * serupa (lih. `SpektraVulkanRenderer.cpp:6232-6236`, `setActiveRect`
 * dipanggil dengan rect PENUH saat inflasi tidak muat). 16px (8x radius
 * kernel TERUKUR 0-2px) tetap cukup -- gerbang ini lulus bit-exact
 * dengannya, tidak ada indikasi perlu apron lebih besar untuk fixture
 * seukuran ini.
 */
describe('Task 19 -- gerbang bit-identik (full-frame vs ter-tile)', () => {
  it(
    'hard_edge (halation + DIR spasial + grain aktif): full-frame === ter-tile empat tile',
    async () => {
      const stockId = 'kodak_portra_400';
      // `fullChain` menyertakan printExposure/printDevelop/scannerPost --
      // ketiganya butuh entri PRINT pada arena `dynamic`
      // (`addPrintScanDynamicData`), TIDAK hadir kecuali `printScan` di
      // sini diisi (lih. `measuredChain.test.ts`/`scannerPost.test.ts`
      // untuk pola identik). Nilai neutral C/M/Y SAMA yang test-test itu
      // pakai -- resolusi ini tidak bergantung `case`/family.
      const { engine, bundle, arenas } = await sharedResources(stockId, {
        printStockId: 'kodak_portra_endura',
        enlargerFilters: {
          cFilterNeutral: 0,
          mFilterNeutral: 51.56801468495496,
          mFilterShift: 0,
          yFilterNeutral: 52.53400422349596,
          yFilterShift: 0,
        },
      });

      const meta = loadCase('hard_edge');
      const inputRgba = loadInputAsRgba('hard_edge');
      const params = defaultCoreParams(
        meta.width,
        meta.height,
        bundle,
        inputRgba,
        'measured',
        /* stochasticEffectsActive */ true,
        stockId,
      );

      const flags = {
        halationEnabled: true,
        grainEnabled: true,
        cameraDiffusionEnabled: false,
        printDiffusionEnabled: false,
        dirCouplersAmount: 1,
        scannerUnsharpEnabled: true,
      };
      const TEST_OVERLAP_PX = 16;
      expect(estimateTileOverlap(flags)).toBeGreaterThanOrEqual(TEST_OVERLAP_PX);

      const plannedTiles = planTiles(meta.width, meta.height, 65536, TEST_OVERLAP_PX);
      expect(plannedTiles.length).toBe(4);

      const fullFrameGraph = new RenderGraph(engine);
      for (const stage of fullChain(engine.device, arenas)) fullFrameGraph.addStage(stage);
      const fullFrame = await fullFrameGraph.run(inputRgba, params, Tap.RGB_OUT);
      fullFrameGraph.dispose();

      const tiledGraph = new RenderGraph(engine);
      for (const stage of fullChain(engine.device, arenas)) tiledGraph.addStage(stage);
      const tiled = await tiledGraph.run(inputRgba, params, Tap.RGB_OUT, {
        maxBufferBytes: 65536,
        overlap: TEST_OVERLAP_PX,
      });
      tiledGraph.dispose();

      // Task 19b (lih. task-19-report.md): gerbang ini SEKARANG hijau, DUA
      // perbaikan, keduanya diperlukan:
      //
      // 1. `graph.ts` (`RenderGraph.runSingleBuffer`) -- `activeWidth/Height`
      //    MEMANG dimaksudkan sebagai rektangel aktif per-TAHAP yang
      //    MENYUSUT seiring radius spasial dikonsumsi (`remainingSpatialRadius`,
      //    port `setActiveForRemainingRadius`/`consumeSpatialRadius` hulu,
      //    `SpektraVulkanRenderer.cpp:6231-6604`), BUKAN rektangel keluaran
      //    tile yang TETAP untuk seluruh graf seperti yang Task 19 (sebelum
      //    ini) berikan ke SETIAP tahap. Begitu tiap tahap punya
      //    `spatialRadiusPx` (`tiling.ts::SPATIAL_EFFECT_RADIUS_PX`/
      //    `GRAIN_SPATIAL_RADIUS_PX`, sumber SAMA yang `estimateTileOverlap`
      //    jumlahkan) dan `graph.ts` membesarkan active rect per-tahap
      //    dengannya, tahap paling awal memproses (dan MENULIS) seluruh
      //    apron yang tersisa, dan setiap tahap spasial sesudahnya membaca
      //    tetangga yang SUDAH benar -- "restricts both dispatch grid and
      //    WGSL guard to activeWidth/Height" (diagnosis Task 19) memang
      //    PERSIS mekanisme yang menulis apron, bukan penyebab kekosongannya.
      //
      // 2. `grain.wgsl::generate`/`scannerPost.wgsl::glareGenerate` -- BUG
      //    TERPISAH, ditemukan lewat isolasi (tap `cmy_film` pra-grain
      //    bit-identik, residual muncul PERSIS di tahap grain): kedua shader
      //    men-seed noise spasialnya (`randNormal`/`glareRandNormal`) dari
      //    `absoluteGid`, yang HANYA lokal ke buffer TILE (lih. `params.ts`),
      //    bukan posisi piksel pada gambar PENUH -- untuk render full-frame
      //    `tileOriginX/Y=0` selalu, jadi kebetulan sama, tapi untuk tile
      //    sungguhan piksel yang SAMA mendapat seed BERBEDA tergantung tile
      //    mana yang memuatnya. Diperbaiki dengan `tileGid = absoluteGid +
      //    tileOrigin` (PERSIS pola `filmExposure.wgsl:243`) sebagai seed,
      //    bukan mengubah guard dispatch/aktif manapun.
      expect(tiled).toEqual(fullFrame);
    },
    30_000,
  );
});

/**
 * Review seluruh-branch, agenda #3 (`docs/superpowers/plans/2026-09-11-
 * dichroic-phase1-engine.md`, "Agenda review seluruh-branch"): `grain.wgsl`
 * (`blurLayersX/Y`/`microGenerate`/`microBlurX/Y`/`blurX/Y`) dan
 * `scannerPost.wgsl` (`glareBlurX/Y`/`unsharpBlurX/Y`) mendispatch LEWAT
 * SELURUH lebar/tinggi buffer tile, sementara pasangannya
 * (`generateLayers`/`combine` milik grain, `glareGenerate`/`scanPreUnsharp`/
 * `scan` milik scannerPost) hanya mendispatch sub-rektangel AKTIF
 * (ter-inflasi `remainingSpatialRadius`, lih. `graph.ts::inflateActiveRect`).
 * `grain.ts`/`scannerPost.ts` mendokumentasikan ini sebagai "keterbatasan
 * tiling yang diketahui, tidak diselesaikan" -- gerbang bit-identik Task 19
 * di atas TIDAK PERNAH menguji jalur ini: `TEST_OVERLAP_PX=16` dipilih
 * sekecil itu justru karena `remainingSpatialRadius` (832px, radius PORT
 * literal upstream) langsung melebihi buffer 48x48px-nya, memaksa
 * `inflateActiveRect` mengembalikan SELURUH buffer untuk SETIAP tahap
 * (fallback `width===0||height===0` di baris konstruksinya) -- tidak ada
 * satu tahap pun yang benar-benar menulis hanya SUB-rektangel dari
 * buffernya. "Terbukti tak berbahaya" hanya berarti "tidak pernah
 * benar-benar dieksekusi".
 *
 * PENGUKURAN (bukan tebakan): dengan radius PORT literal upstream dipakai
 * APA ADANYA (`SPATIAL_EFFECT_RADIUS_PX=256` x2 -- halation, unsharp scanner
 * -- + `GRAIN_SPATIAL_RADIUS_PX=64`, total 576px, PERSIS `estimateTileOverlap`
 * di bawah, TIDAK diperkecil seperti gerbang di atas -- DIR spasial DIMATIKAN
 * di rantai test ini, lih. `productionScaleChain` di bawah untuk alasannya:
 * batas `MAX_KERNEL_RADIUS` `dir.ts` yang tidak terkait agenda #3),
 * geometri `width=600,height=32,activeSide~120px` membuat setiap tile
 * planTiles menghasilkan buffer SAMA DENGAN lebar gambar penuh (overlap
 * lebih besar dari gambar) TAPI rektangel aktif grain/scannerPost ter-inflasi
 * (`center ± remainingSpatialRadius-nya sendiri`) MASIH sub-rektangel SEJATI
 * dari buffer itu -- persis skala "produksi" (radius menjadi signifikan
 * relatif terhadap buffer) yang gerbang di atas tidak pernah mencapai.
 * Diverifikasi lewat skrip murni (bukan GPU) sebelum test ini ditulis: pada
 * geometri ini `grainSubset`/`scannerPostSubset` (rektangel tulis tahap itu
 * < lebar buffer tile) bernilai true untuk hampir setiap tile yang
 * `planTiles` hasilkan.
 *
 * Kalau mismatch ini SUNGGUH berbahaya, tile mana pun yang datanya bocor
 * dari pool scratch (dipakai ulang ANTAR tile, lih. `StageContext.scratch`)
 * akan membuat gerbang bit-identik di bawah MERAH. Ia HIJAU -- diukur, bukan
 * diasumsikan -- karena `remainingSpatialRadius` yang menginflasi rektangel
 * aktif SETIAP tahap SELALU >= radius kernel tahap itu sendiri (dijumlahkan
 * SEBELUM radius tahap itu dikurangkan, lih. `runSingleBuffer`), jadi
 * rektangel yang DITULIS tahap manapun (generateLayers/combine,
 * glareGenerate/scanPreUnsharp/scan) selalu mencakup PALING SEDIKIT
 * `center ± radius-kernel-tahap-itu-sendiri` -- persis yang pass full-buffer
 * setelahnya (blurLayersX/Y, glareBlurX/Y, dst.) butuh baca untuk piksel di
 * dalam `center`. Data pool yang bocor dari tile SEBELUMNYA selalu berada DI
 * LUAR jendela itu, jadi tidak pernah terbaca saat menghitung piksel `center`
 * tile SEKARANG. Ini KESIMPULAN STRUKTURAL (berlaku selama `spatialRadiusPx`
 * yang dideklarasikan adalah batas atas SAH dari radius kernel runtime-nya --
 * premis yang sudah diterima di tempat lain repo ini, radius diambil literal
 * dari sumber upstream), dibuktikan EMPIRIS oleh gerbang di bawah pada
 * geometri yang benar-benar menekannya, bukan cuma dinalar di komentar ini.
 *
 * Keputusan: TIDAK diubah. `grain.ts`/`scannerPost.ts` boleh terus
 * mendispatch pass blur-nya full-buffer -- mengubahnya ke active-only+radius
 * akan menambah kerumitan (menghitung ulang rect per pass internal) tanpa
 * membeli korektnes yang belum ada. Komentar "keterbatasan tiling" di kedua
 * berkas itu digantikan referensi ke test ini di bawah -- lih. commit yang
 * memperbaruinya.
 */
/**
 * Rantai manual (bukan `fullChain`) -- SATU beda dari `fullChain`: DIR
 * dipanggil dengan `spatialDiffusionActive: false`. Bukan penghematan --
 * pada `pixel_size_um` yang geometri INI butuhkan (gambar lebih besar dari
 * fixture lain di repo ini, supaya radius grain/scannerPost berarti relatif
 * terhadap buffer, lih. blok komentar di atas), kernel DIR (fit dua-
 * eksponensial `DIFFUSION_TAIL_UM=200`) melampaui `MAX_KERNEL_RADIUS=16`
 * milik `dir.ts` (radius 28 terukur pada `width=600`) -- itu batas TERPISAH,
 * sudah ada sebelum test ini (lih. `dir.ts`), bukan sesuatu yang test ini
 * ada untuk menekan. Menonaktifkan cabang spasial DIR menghindarinya tanpa
 * mempengaruhi apa yang test ini SEBENARNYA mengukur (mismatch full-buffer/
 * active-only grain dan scannerPost) -- DIR tidak disebut agenda #3 sama
 * sekali. `estimateTileOverlap` diberi `dirCouplersAmount: 0` senada.
 */
function productionScaleChain(device: GPUDevice, arenas: Awaited<ReturnType<typeof sharedResources>>['arenas']): Stage[] {
  return [
    createMaterializeActiveRegionStage(device),
    createFilmExposureStage(device, arenas),
    createHalationStage(device, arenas),
    createCurveDevelopStage(device, arenas),
    createDirStage(device, arenas, { spatialDiffusionActive: false }),
    createGrainStage(device, arenas),
    createPrintExposureStage(device, arenas),
    createPrintDevelopStage(device, arenas),
    createScannerPostStage(device, arenas),
  ];
}

describe('Task 19b -- gerbang bit-identik pada skala apron produksi (agenda #3)', () => {
  it(
    'radius spasial PORT literal (576px total: halation+grain+unsharp) dipakai apa adanya, bukan diperkecil: full-frame === ter-tile',
    async () => {
      const stockId = 'kodak_portra_400';
      const { engine, bundle, arenas } = await sharedResources(stockId, {
        printStockId: 'kodak_portra_endura',
        enlargerFilters: {
          cFilterNeutral: 0,
          mFilterNeutral: 51.56801468495496,
          mFilterShift: 0,
          yFilterNeutral: 52.53400422349596,
          yFilterShift: 0,
        },
      });

      const width = 600;
      const height = 32;
      // Sintetik (bukan fixture Python) -- gerbang ini self-consistency
      // ANTARA dua jalur RenderGraph.run milik engine ini sendiri, persis
      // seperti gerbang hard_edge di atas, jadi tidak perlu tap referensi
      // Python. Tepi tajam dipilih dengan alasan yang sama (Task 19):
      // ramp halus akan menyembunyikan seam, tepi tajam tidak.
      const inputRgba = new Float32Array(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          const v = x < width / 2 ? 0.02 : 0.9;
          inputRgba[i] = v;
          inputRgba[i + 1] = v;
          inputRgba[i + 2] = v;
          inputRgba[i + 3] = 1;
        }
      }

      const params = defaultCoreParams(width, height, bundle, inputRgba, 'measured', true, stockId);

      const flags = {
        halationEnabled: true,
        grainEnabled: true,
        cameraDiffusionEnabled: false,
        printDiffusionEnabled: false,
        dirCouplersAmount: 0,
        scannerUnsharpEnabled: true,
      };
      // TIDAK diperkecil (beda dari `TEST_OVERLAP_PX` di atas) -- inilah
      // seluruh poin gerbang ini.
      const overlap = estimateTileOverlap(flags);
      expect(overlap).toBe(576);

      const ACTIVE_SIDE_PX = 120;
      const budgetSide = ACTIVE_SIDE_PX + 2 * overlap;
      const maxBufferBytes = budgetSide * budgetSide * 16;

      const plannedTiles = planTiles(width, height, maxBufferBytes, overlap);
      expect(plannedTiles.length).toBeGreaterThan(1);

      const fullFrameGraph = new RenderGraph(engine);
      for (const stage of productionScaleChain(engine.device, arenas)) fullFrameGraph.addStage(stage);
      const fullFrame = await fullFrameGraph.run(inputRgba, params, Tap.RGB_OUT);
      fullFrameGraph.dispose();

      const tiledGraph = new RenderGraph(engine);
      for (const stage of productionScaleChain(engine.device, arenas)) tiledGraph.addStage(stage);
      const tiled = await tiledGraph.run(inputRgba, params, Tap.RGB_OUT, {
        maxBufferBytes,
        overlap,
      });
      tiledGraph.dispose();

      expect(tiled).toEqual(fullFrame);
    },
    60_000,
  );
});

describe('Fase 2A.5 -- tiling di rezim resolusi produksi (IIR)', () => {
  /**
   * 6.25 um/px (foto sungguhan): ekor DIR sigma ~89 px, bounce halation
   * ~18 px -- keduanya IIR Young-van Vliet, ekor tak terbatas. Overlap dan
   * radius tahap dihitung dari sigma (`src/engine/spatialRadius.ts`):
   * halation 181 + DIR 886 (10 sigma, lih. catatan ekor YvV di sana). Tile TIDAK bisa bit-identik dengan full-frame
   * di rezim IIR (rekursi baris penuh dimulai dari tepi rect yang berbeda);
   * yang dijamin adalah galat batas meluruh di bawah 1e-6 di dalam apron.
   * Gerbang bit-identik rezim FIR di atas tetap berlaku apa adanya.
   */
  it(
    'full-frame vs ter-tile (20 tile, cmy_film, halation + DIR IIR): selisih <= 1e-6',
    async () => {
      const stockId = 'kodak_portra_400';
      const { engine, bundle, arenas } = await sharedResources(stockId, {
        printStockId: 'kodak_portra_endura',
        enlargerFilters: {
          cFilterNeutral: 0,
          mFilterNeutral: 51.56801468495496,
          mFilterShift: 0,
          yFilterNeutral: 52.53400422349596,
          yFilterShift: 0,
        },
      });

      const width = 1500;
      const height = 1000;
      const frame = { filmFormatMm: 9.375 }; // 9375 um / 1500 px = 6.25 um/px
      const inputRgba = new Float32Array(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          let v = (x >> 7) % 2 === (y >> 7) % 2 ? 0.03 : 0.7;
          if ((x - 700) ** 2 + (y - 480) ** 2 < 36) v = 8; // sorotan untuk halation
          inputRgba[i] = v;
          inputRgba[i + 1] = v * 0.9;
          inputRgba[i + 2] = v * 0.8;
          inputRgba[i + 3] = 1;
        }
      }
      const params = defaultCoreParams(width, height, bundle, inputRgba, 'measured', false, stockId);

      const pixelSizeUm = (frame.filmFormatMm * 1000) / width;
      const firstSigma = Array.from(arenas.stock.values('halationFirstSigmaUm')) as [number, number, number];
      const overlap = halationRadiusPx(pixelSizeUm, firstSigma) + dirRadiusPx(pixelSizeUm);
      expect(overlap).toBe(181 + 886);

      const chain = (): Stage[] => [
        createMaterializeActiveRegionStage(engine.device),
        createFilmExposureStage(engine.device, arenas),
        createDiffusionStage(engine.device, arenas, 'camera', { bypassConvolution: true }),
        createHalationStage(engine.device, arenas),
        createCurveDevelopStage(engine.device, arenas),
        createDirStage(engine.device, arenas),
      ];
      const maxBufferBytes = (300 + 2 * overlap) * (300 + 2 * overlap) * 16;
      expect(planTiles(width, height, maxBufferBytes, overlap).length).toBe(20);

      const fullGraph = new RenderGraph(engine);
      for (const stage of chain()) fullGraph.addStage(stage);
      const full = await fullGraph.run(inputRgba, params, Tap.CMY_FILM, { frame });
      fullGraph.dispose();

      const tiledGraph = new RenderGraph(engine);
      for (const stage of chain()) tiledGraph.addStage(stage);
      const tiled = await tiledGraph.run(inputRgba, params, Tap.CMY_FILM, { frame, maxBufferBytes, overlap });
      tiledGraph.dispose();

      let maxAbs = 0;
      for (let p = 0; p < width * height; p += 1) {
        for (let c = 0; c < 3; c += 1) maxAbs = Math.max(maxAbs, Math.abs(tiled[p * 4 + c]! - full[p * 4 + c]!));
      }
      expect(maxAbs, `max abs tile vs full ${maxAbs.toExponential(3)}`).toBeLessThanOrEqual(1e-6);
    },
    120_000,
  );
});
