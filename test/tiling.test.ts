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

      // BLOCKED (lih. task-19-report.md untuk analisis lengkap) -- gerbang
      // ini SENGAJA dibiarkan merah, persis pola `gray_ramp_stochastic` di
      // `scannerPostGlare.test.ts` (Gate B): residual nyata, bukan derau,
      // dilaporkan alih-alih ditala/dilonggarkan.
      //
      // Diukur: 10155/16384 komponen berbeda (62%), maxAbsDiff=0.87 (nyaris
      // skala penuh), TERSEBAR di seluruh 64x64 (minX/maxX/minY/maxY =
      // 0/63/0/63) -- BUKAN pita tipis di sekitar batas region aktif.
      // Per rubrik tugas ini ("selisih di seam berarti apron kurang,
      // selisih tersebar berarti koordinat"): pola ini adalah kategori
      // KEDUA, tapi akar masalahnya BUKAN salah pakai koordinat lokal vs
      // absolut -- `estimateTileOverlap`/`planTiles` sendiri lulus
      // (test di atas) dan apron 16px jauh di atas radius kernel terukur
      // (0-2px, lih. dir.wgsl/halation.wgsl). Akarnya: SETIAP tahap
      // per-piksel dari Task 9-18 (`materializeActiveRegion.wgsl`,
      // `filmExposure.wgsl`, `diffusion.wgsl`, `curveDevelop.wgsl`,
      // `dir.wgsl`, dan pass "generate"/"pre" `grain.wgsl`/
      // `scannerPost.wgsl`) mem-batasi grid dispatch DAN penjaga WGSL-nya
      // ke `activeWidth/activeHeight` SAJA -- benar untuk render penuh
      // (activeWidth=0 berarti "seluruh buffer", jadi tidak pernah
      // termanifestasi di 349 test lain), tapi untuk tile SUNGGUHAN
      // (activeWidth < width) berarti apron buffer TIDAK PERNAH ditulis
      // oleh tahap manapun sepanjang rantai -- bukan hanya `grain.ts` yang
      // sudah mencatat ini sebagai "KETERBATASAN TILING YANG DIKETAHUI,
      // TIDAK DISELESAIKAN DI SINI". `halation.wgsl` (SEMUA 8 dispatch
      // internalnya, bukan cuma resolve akhir) dan `scannerPost.wgsl`
      // (glareGenerate/scanPreUnsharp) punya pola identik. Karena gambar
      // uji 64x64 memaksa tile menjadi hampir seluruh buffer (aktif hanya
      // 1/4-nya), kekosongan itu memanifest di HAMPIR SELURUH gambar,
      // bukan pita tipis -- pada gambar produksi, radius apron OFX (256px)
      // relatif terhadap gambar besar membuat manifestasinya jauh lebih
      // sempit (mendekati seam), tapi bug-nya sama.
      //
      // Memperbaikinya berarti melebarkan grid dispatch + penjaga WGSL ke
      // `params.width/height` (bukan `activeWidth/Height`) di SEMBILAN
      // berkas tahap di atas (masing-masing perubahan TS+WGSL kecil dan
      // mekanis), lalu memverifikasi ULANG ke-17 berkas gerbang lain yang
      // memakai berkas yang sama tetap hijau -- di luar cakupan file Task
      // 19 (`tiling.ts` + `graph.ts` saja) dan anggaran sesi ini. Rencana
      // tindak lanjut lengkap ada di task-19-report.md.
      expect(tiled).toEqual(fullFrame);
    },
    30_000,
  );
});
