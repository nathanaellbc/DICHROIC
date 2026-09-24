import { describe, it, expect } from 'vitest';
import { estimateTileOverlap, planTiles } from '../src/engine/tiling';

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
