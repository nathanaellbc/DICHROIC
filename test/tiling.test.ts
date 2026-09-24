import { describe, it, expect } from 'vitest';
import { estimateTileOverlap, planTiles } from '../src/engine/tiling';
import { RenderGraph } from '../src/engine/graph';
import { Tap } from '../src/engine/taps';
import { fullChain } from './parity/chain';
import { sharedResources } from './parity/run';
import { defaultCoreParams } from './parity/params';
import { loadCase, loadInputAsRgba } from './parity/compare';

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
