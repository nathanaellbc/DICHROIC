/**
 * Panggang LUT "look" film x kertas untuk pratinjau instan (pemilih film HP):
 * `public/data/looks/looks.bin` + `looks.json`.
 *
 * Tiap look = `.cube` engine sendiri (rencana `'cube'`, semantik `lut_mode`,
 * digerbangi `test/parity/cube.test.ts`) untuk input sRGB ter-encode (seperti
 * foto HP / pratinjau asli) ke keluaran sRGB, pada parameter bawaan. Efek
 * spasial (grain, halation, DIR, difusi) dan penyesuaian pengguna tidak ada
 * di LUT: ia hanya pratinjau sampai render sungguhan selesai.
 *
 * Satu proses Node per look: arena wajib dipra-hitung SEBELUM device GPU
 * hidup (CATATAN LINGKUNGAN di `src/host/spectral.ts` -- pra-hitung setelah
 * device men-segfault Dawn), jadi proses induk memanggil dirinya sendiri.
 *
 * Jalankan:
 *   node tools/run_ts.mjs tools/bake_looks.ts
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDevice } from '../src/engine/device';
import { precomputeArenaData, uploadArenas } from '../src/host/spectral';
import { loadAssets } from '../src/profiles/load';
import { buildRenderPlan } from '../src/params/plan';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import type { RenderParams } from '../src/params/renderParams';
import { Session } from '../src/session/session';
import { parseCube } from '../src/io/cube';
import { LOOK_SIZE, lookKey, lookCombos } from '../src/ui/engine/looks';

const ASSETS = 'public/data';
const OUT_DIR = join(ASSETS, 'looks');

function lookParams(film: string, paper: string, process: RenderParams['process']): RenderParams {
  return {
    ...BASELINE_RENDER_PARAMS,
    filmEnabled: true, film, paper, process,
    inputColorSpace: 'sRGB', inputCctfDecoding: true, autoExposure: false, outputColorSpace: 'sRGB',
  };
}

/** Anak: satu look -> berkas biner `size^3 x RGB8`. */
async function bakeOne(film: string, paper: string, process: RenderParams['process'], out: string): Promise<void> {
  const bundle = await loadAssets(ASSETS);
  const params = lookParams(film, paper, process);
  const lattice = { width: 1, height: 1, rgba: new Float32Array(4) };
  const plan = buildRenderPlan(params, bundle, lattice, 'cube');
  const arenaPlan = precomputeArenaData(bundle, plan.arenaInputs.stockId, plan.arenaInputs.printScan);
  const engine = await acquireDevice();
  const session = await Session.create({
    assetsBaseUrl: ASSETS, engine, bundle,
    // Unggahan baru tiap permintaan: sesi boleh menghancurkan arena lama saat berganti kunci.
    arenaProvider: { get: async () => uploadArenas(engine.device, arenaPlan) },
  });
  const patch: Partial<RenderParams> = {};
  for (const k of Object.keys(params) as Array<keyof RenderParams>) {
    if (params[k] !== BASELINE_RENDER_PARAMS[k]) (patch as Record<string, unknown>)[k] = params[k];
  }
  session.setParams(patch);
  const { size, data } = parseCube(await session.exportCube(LOOK_SIZE));
  if (size !== LOOK_SIZE) throw new Error(`size ${size}`);
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, data[i]!)) * 255);
  writeFileSync(out, bytes);
  session.dispose();
}

function run(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function bakeAll(): Promise<void> {
  const combos = lookCombos();
  const tmp = join(tmpdir(), 'gamma-looks');
  mkdirSync(tmp, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const started = Date.now();
  let next = 0, done = 0;
  const failed: string[] = [];
  const worker = async () => {
    for (;;) {
      const i = next++;
      const c = combos[i];
      if (!c) return;
      const file = join(tmp, `${i}.bin`);
      if (!existsSync(file)) {
        const code = await run(['one', c.film, c.paper, c.process, file]);
        if (code !== 0) failed.push(lookKey(c.film, c.paper, c.process));
      }
      done += 1;
      process.stdout.write(`\r${done}/${combos.length} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    }
  };
  // Dua sekaligus: GPU satu, tetapi pra-hitung arena (CPU) bisa tumpang tindih.
  await Promise.all([worker(), worker()]);
  process.stdout.write('\n');
  if (failed.length) throw new Error(`Gagal: ${failed.join(', ')}`);
  const bytesPer = LOOK_SIZE ** 3 * 3;
  const blob = new Uint8Array(combos.length * bytesPer);
  const index: Record<string, number> = {};
  combos.forEach((c, i) => {
    blob.set(readFileSync(join(tmp, `${i}.bin`)), i * bytesPer);
    index[lookKey(c.film, c.paper, c.process)] = i;
  });
  writeFileSync(join(OUT_DIR, 'looks.bin'), blob);
  writeFileSync(join(OUT_DIR, 'looks.json'), JSON.stringify({ size: LOOK_SIZE, input: 'sRGB', output: 'sRGB', looks: index }, null, 1) + '\n');
  rmSync(tmp, { recursive: true, force: true });
  console.log(`${combos.length} looks, ${(blob.length / 1024).toFixed(0)} KB -> ${OUT_DIR}`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'one') {
  const [film, paper, proc, out] = rest as [string, string, RenderParams['process'], string];
  bakeOne(film, paper, proc, out).then(() => process.exit(0), (e: unknown) => { console.error(`\n${film}/${paper}/${proc}:`, e); process.exit(1); });
} else {
  bakeAll().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });
}
