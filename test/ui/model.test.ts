import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIELD_STATUS } from '../../src/params/registry';
import { BASELINE_RENDER_PARAMS } from '../../src/params/renderParams';
import { FILM_FORMAT_LONG_EDGE_MM, INPUT_DECODE_WITHOUT_ORACLE } from '../../src/params/plan';
import { FILM_SECTIONS, PAPER_SECTIONS, matchesQuery, selectableIds, stockInfo } from '../../src/ui/model/stocks';
import {
  DECODE_WITHOUT_ORACLE,
  FILM_FORMATS,
  GROUPS,
  INPUT_COLOR_SPACES,
  OUTPUT_COLOR_SPACES,
  choicePatch,
  findTool,
  formatNumber,
  formatPushPull,
  isModified,
  resetPatch,
  snap,
  sliderPatch,
  sliderValue,
  stockPatch,
  suggestedInput,
  visibleTools,
  formatStops,
  valueText,
} from '../../src/ui/model/tools';
import type { ChoiceTool, DiffusionTool, SliderTool } from '../../src/ui/model/tools';

interface Manifest {
  stocks: Array<{ id: string; type: string }>;
  neutralPrintFilters: { table: Record<string, Record<string, unknown>> };
  colorSpaces: { labels: string[] };
  outputColorSpaces: Record<string, unknown>;
}
const manifest = JSON.parse(readFileSync(join('public', 'data', 'manifest.json'), 'utf8')) as Manifest;
const papers = Object.keys(manifest.neutralPrintFilters.table);
const films = Object.keys(manifest.neutralPrintFilters.table[papers[0]!]!);
const type = (id: string) => manifest.stocks.find((s) => s.id === id)?.type;

describe('katalog stok UI == manifest', () => {
  it('film yang bisa dipilih = semua film di database netral (negatif dan reversal)', () => {
    expect(selectableIds(FILM_SECTIONS).sort()).toEqual([...films].sort());
  });

  it('bagian scan-only = semua film reversal (Fase 2D), tidak ada yang terkunci', () => {
    const scanOnly = FILM_SECTIONS.filter((s) => s.scanOnly).flatMap((s) => s.stocks.map((x) => x.id)).sort();
    expect(scanOnly).toEqual(films.filter((id) => type(id) === 'positive').sort());
    expect(FILM_SECTIONS.some((s) => s.locked)).toBe(false);
  });

  it('kertas = kunci database netral', () => {
    expect(selectableIds(PAPER_SECTIONS).sort()).toEqual([...papers].sort());
  });

  it('baseline ada di katalog; pencarian cocok nama dan keterangan', () => {
    expect(stockInfo(BASELINE_RENDER_PARAMS.film).name).toBe('Kodak Portra 400');
    expect(stockInfo(BASELINE_RENDER_PARAMS.paper).name).toBe('Kodak Portra Endura');
    expect(matchesQuery(stockInfo('kodak_vision3_500t'), 'tungsten')).toBe(true);
    expect(matchesQuery(stockInfo('kodak_vision3_500t'), 'velvia')).toBe(false);
  });
});

describe('alat UI == permukaan parameter engine', () => {
  const tools = GROUPS.flatMap((g) => g.tools);

  it('setiap field yang diubah alat berstatus verified', () => {
    for (const tool of tools) {
      if (tool.kind === 'locked') continue;
      const fields = tool.kind === 'diffusion' ? [tool.enabledBy, tool.familyField, tool.strengthField] : [tool.field];
      for (const field of fields) expect(FIELD_STATUS[field], tool.id).toBe('verified');
      if (tool.kind === 'slider' && tool.enabledBy) expect(FIELD_STATUS[tool.enabledBy], tool.id).toBe('verified');
    }
  });

  it('nilai baseline berada di dalam rentang slider/stepper', () => {
    for (const tool of tools) {
      if (tool.kind !== 'slider' && tool.kind !== 'stepper') continue;
      const v = BASELINE_RENDER_PARAMS[tool.field];
      expect(v, tool.id).toBeGreaterThanOrEqual(tool.min);
      expect(v, tool.id).toBeLessThanOrEqual(tool.max);
    }
  });

  it('pilihan colour space dan format sama persis dengan aset dan plan', () => {
    expect(INPUT_COLOR_SPACES.map((o) => o.value).sort()).toEqual([...manifest.colorSpaces.labels].sort());
    expect(OUTPUT_COLOR_SPACES.map((o) => o.value).sort()).toEqual(Object.keys(manifest.outputColorSpaces).sort());
    expect(FILM_FORMATS.map((o) => o.value).sort()).toEqual(Object.keys(FILM_FORMAT_LONG_EDGE_MM).sort());
    expect([...DECODE_WITHOUT_ORACLE].sort()).toEqual([...INPUT_DECODE_WITHOUT_ORACLE].sort());
  });
});

describe('format, snap, patch', () => {
  it('angka: minus tipografis, plus untuk nilai bipolar', () => {
    expect(formatNumber(-1.25, 1, true)).toBe('−1.3');
    expect(formatNumber(0.5, 1, true)).toBe('+0.5');
    expect(formatNumber(0, 1, true)).toBe('0.0');
    expect(formatNumber(-0.04, 1, true)).toBe('0.0');
    expect(formatPushPull(0)).toBe('Box speed');
    expect(formatPushPull(1)).toBe('Push 1 stop');
    expect(formatPushPull(-1.5)).toBe('Pull 1.5 stops');
  });

  it('snap menjepit ke rentang dan kelipatan langkah tanpa galat biner', () => {
    const range = { min: -3, max: 3, step: 0.1 };
    expect(snap(0.1 + 0.2, range)).toBe(0.3);
    expect(snap(9, range)).toBe(3);
    expect(snap(-0.049, range)).toBe(0);
    expect(snap(0.037, { min: 0, max: 0.2, step: 0.005 })).toBe(0.035);
  });

  it('valueText, isModified, dan resetPatch mengikuti sakelar alat', () => {
    const halation = findTool('halationAmount');
    const params = { ...BASELINE_RENDER_PARAMS, halationEnabled: false };
    expect(valueText(halation, params)).toBe('Off');
    expect(isModified(halation, params, BASELINE_RENDER_PARAMS)).toBe(true);
    expect(resetPatch(halation, BASELINE_RENDER_PARAMS)).toEqual({ halationAmount: 1, halationEnabled: true });
    expect(valueText(findTool('filmExposureEv'), { ...BASELINE_RENDER_PARAMS, filmExposureEv: 1.5 })).toBe('+1.5 EV');
  });

  it('slider terbalik: rentang simetris, + di UI = field negatif (semantik kamar gelap)', () => {
    const inverted = GROUPS.flatMap((g) => g.tools).filter((t): t is SliderTool => t.kind === 'slider' && !!t.invert);
    expect(inverted.map((t) => t.field).sort()).toEqual(['filterC', 'filterMShift', 'filterYShift', 'preflashMFilterShift', 'preflashYFilterShift', 'printExposureEv']);
    for (const tool of inverted) expect(tool.min, tool.id).toBe(-tool.max);
    const exposure = findTool('printExposureEv') as SliderTool;
    expect(sliderPatch(exposure, 1)).toEqual({ printExposureEv: -1 });
    expect(sliderPatch(exposure, 0)).toEqual({ printExposureEv: 0 });
    expect(Object.is(sliderValue(exposure, BASELINE_RENDER_PARAMS), 0)).toBe(true);
    expect(valueText(exposure, { ...BASELINE_RENDER_PARAMS, printExposureEv: -0.5 })).toBe('+0.5 EV');
    expect(sliderValue(findTool('filterC') as SliderTool, { ...BASELINE_RENDER_PARAMS, filterC: 12 })).toBe(-12);
  });

  it('input tanpa oracle decode mematikan decode', () => {
    const input = findTool('inputColorSpace') as ChoiceTool;
    expect(choicePatch(input, 'Rec.709 Gamma 2.4')).toEqual({ inputColorSpace: 'Rec.709 Gamma 2.4', inputCctfDecoding: false });
    expect(choicePatch(input, 'Display P3')).toEqual({ inputColorSpace: 'Display P3' });
  });

  it('saran input dari decoder: ter-encode -> decode, linear -> tanpa decode', () => {
    expect(suggestedInput({ suggestedColorSpace: 'sRGB', encoding: 'encoded' })).toEqual({ inputColorSpace: 'sRGB', inputCctfDecoding: true, autoExposure: false });
    expect(suggestedInput({ suggestedColorSpace: 'ACES2065-1', encoding: 'linear' })).toEqual({ inputColorSpace: 'ACES2065-1', inputCctfDecoding: false, autoExposure: true });
    expect(suggestedInput({ suggestedColorSpace: 'Linear Rec.709', encoding: 'linear' })).toEqual({ inputColorSpace: 'Linear Rec.709', inputCctfDecoding: false, autoExposure: true });
  });
});

describe('mode proses dan stok (Fase 2D)', () => {
  it('slide film memindah ke scan; kembali ke negatif memindah ke print; negatif tetap scan bila disengaja', () => {
    expect(stockPatch('film', 'fujifilm_velvia_100', { film: 'kodak_portra_400', process: 'printSimulation' })).toEqual({
      film: 'fujifilm_velvia_100',
      process: 'scanNegative',
    });
    expect(stockPatch('film', 'kodak_gold_200', { film: 'fujifilm_velvia_100', process: 'scanNegative' })).toEqual({
      film: 'kodak_gold_200',
      process: 'printSimulation',
    });
    expect(stockPatch('film', 'kodak_gold_200', { film: 'kodak_portra_400', process: 'scanNegative' })).toEqual({ film: 'kodak_gold_200' });
    expect(stockPatch('paper', 'kodak_2383', { film: 'kodak_portra_400', process: 'printSimulation' })).toEqual({ paper: 'kodak_2383' });
  });

  it('Process -> Print dengan slide film mengganti ke negatif bawaan', () => {
    const process = findTool('process') as ChoiceTool;
    expect(choicePatch(process, 'printSimulation', { film: 'kodak_ektachrome_100' })).toEqual({ process: 'printSimulation', film: 'kodak_portra_400' });
    expect(choicePatch(process, 'scanNegative', { film: 'kodak_portra_400' })).toEqual({ process: 'scanNegative' });
  });

  it('alat per mode: scan menyembunyikan tahap print dan memakai exposure film', () => {
    const film = GROUPS.find((g) => g.id === 'film')!;
    const print = visibleTools(film, { process: 'printSimulation' }).map((t) => t.id);
    const scan = visibleTools(film, { process: 'scanNegative' }).map((t) => t.id);
    expect(print).toContain('printExposureEv');
    expect(print).not.toContain('scanExposureEv');
    expect(scan).toContain('scanExposureEv');
    expect(scan).not.toContain('printExposureEv');
    expect(scan).not.toContain('filmExposureEv');
    const color = GROUPS.find((g) => g.id === 'color')!;
    expect(visibleTools(color, { process: 'scanNegative' }).map((t) => t.id)).toEqual(['inputColorSpace', 'inputCctfDecoding', 'outputColorSpace']);
  });

  it('filter difusi: nilai dalam stop, Off saat mati, reset mengembalikan ketiganya', () => {
    const lens = findTool('cameraDiffusion') as DiffusionTool;
    const on = { ...BASELINE_RENDER_PARAMS, cameraDiffusionEnabled: true, cameraDiffusionStrength: 0.25, cameraDiffusionFamily: 'cinebloom' as const };
    expect(valueText(lens, on)).toBe('¼');
    expect(valueText(lens, BASELINE_RENDER_PARAMS)).toBe('Off');
    expect(isModified(lens, on, BASELINE_RENDER_PARAMS)).toBe(true);
    expect(resetPatch(lens, BASELINE_RENDER_PARAMS)).toEqual({
      cameraDiffusionEnabled: false,
      cameraDiffusionFamily: 'black_pro_mist',
      cameraDiffusionStrength: 0.5,
    });
    expect(formatStops(1.5)).toBe('1½');
    expect(formatStops(2)).toBe('2');
  });
});
