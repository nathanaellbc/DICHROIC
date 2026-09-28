import { beforeAll, describe, expect, it } from 'vitest';
import { precomputeArenaData } from '../src/host/spectral';
import type { ArenaPlan } from '../src/host/spectral';
import { exposureFactor, midgrayDensitySpectral, midgrayTablesFrom, printMidgrayFactor } from '../src/host/printExposure';
import type { MidgrayTables } from '../src/host/printExposure';
import { loadAssets } from '../src/profiles/load';
import type { AssetBundle } from '../src/profiles/load';

/**
 * Port host midgray print (Fase 2C Task 2) terhadap nilai yang di-bake
 * langsung dari Python (`densitySpectralMidgray`, `bake_web_assets.py`
 * memanggil `_simple_rgb_to_density_spectral` hulu) dan terhadap faktor
 * Fase 1 yang dihitung dari nilai bake itu. Tanpa GPU.
 */

const FILM = 'kodak_portra_400';
const PRINT = {
  printStockId: 'kodak_portra_endura',
  enlargerFilters: {
    cFilterNeutral: 0,
    mFilterNeutral: 51.56801468495496,
    mFilterShift: 0,
    yFilterNeutral: 52.53400422349596,
    yFilterShift: 0,
  },
};

let bundle: AssetBundle;
let plan: ArenaPlan;
let tables: MidgrayTables;
let srgb: number;

beforeAll(async () => {
  bundle = await loadAssets('public/data');
  plan = precomputeArenaData(bundle, FILM, PRINT);
  tables = midgrayTablesFrom((arena, name) => plan[arena].values(name), bundle.manifest.hanatos.width, bundle.manifest.hanatos.height);
  srgb = bundle.manifest.colorSpaces.labels.indexOf('sRGB');
});

const BASE = { inputCompression: true, gamma: 1, compensation: false, exposureCompensationEv: 0 };

describe('midgray print di host', () => {
  it('densitas spektral midgray = nilai bake Python', () => {
    const ours = midgrayDensitySpectral(tables, 0.184, { ...BASE, srgbColorSpace: srgb });
    const baked = bundle.stockField(FILM, 'densitySpectralMidgray')!;
    expect(ours.length).toBe(baked.length);
    let maxAbs = 0;
    for (let wl = 0; wl < baked.length; wl += 1) {
      if (Number.isNaN(baked[wl]!)) {
        expect(Number.isNaN(ours[wl]!)).toBe(true);
        continue;
      }
      maxAbs = Math.max(maxAbs, Math.abs(ours[wl]! - baked[wl]!));
    }
    console.log(`densitySpectralMidgray max abs ${maxAbs.toExponential(3)}`);
    expect(maxAbs).toBeLessThanOrEqual(1e-6); // terukur 9.3e-8
  });

  it('faktor tanpa kompensasi = faktor dari nilai bake (jalur Fase 1)', () => {
    const fromBake = exposureFactor(tables, bundle.stockField(FILM, 'densitySpectralMidgray')!);
    const ours = printMidgrayFactor(tables, { ...BASE, srgbColorSpace: srgb });
    const rel = Math.abs(ours / fromBake - 1);
    console.log(`factor rel ${rel.toExponential(3)}`);
    expect(rel).toBeLessThanOrEqual(1e-6); // terukur 2.5e-9
  });

  it('kompensasi pada ev 0 sama dengan tanpa kompensasi', () => {
    const a = printMidgrayFactor(tables, { ...BASE, srgbColorSpace: srgb });
    const b = printMidgrayFactor(tables, { ...BASE, srgbColorSpace: srgb, compensation: true });
    expect(b).toBe(a);
  });
});
