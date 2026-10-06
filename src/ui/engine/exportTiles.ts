/**
 * Skala tile ekspor yang dipelajari lintas muatan halaman, plus jejak tahap
 * terakhir untuk diagnosis.
 *
 * Safari iOS mematikan tab yang memakai terlalu banyak memori tanpa event
 * yang bisa ditangkap. Jadi selama Develop berjalan disimpan penanda
 * `pending` (dan tahap terakhirnya: tile ke berapa, ukuran tile); bila
 * halaman dimuat ulang dan penanda itu masih ada, Develop sebelumnya mati di
 * tengah render -- skala tile dibagi dua untuk percobaan berikutnya dan
 * tahapnya ditampilkan di lembar Ekspor. Encode yang mati juga dicatat
 * (tanpa mengubah skala: ukuran tile tidak memengaruhi encode).
 */
import { MIN_EXPORT_TILE_SCALE, clampTileScale } from '../../io/budget';

export const EXPORT_TILES_KEY = 'dichroic.exportTiles.v1';

interface TileState {
  scale: number;
  pending: boolean;
  /** Tahap Develop terakhir yang tercatat. */
  stage?: string;
  /** Format yang sedang di-encode. */
  encoding?: string;
  /** Tahap tempat ekspor sebelumnya mati (untuk ditampilkan). */
  crashed?: string;
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStore(): Store | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function read(store: Store | undefined): TileState {
  try {
    const raw = store?.getItem(EXPORT_TILES_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<TileState>) : {};
    const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const state: TileState = { scale: clampTileScale(typeof parsed.scale === 'number' ? parsed.scale : undefined), pending: parsed.pending === true };
    const stage = text(parsed.stage);
    const encoding = text(parsed.encoding);
    const crashed = text(parsed.crashed);
    if (stage) state.stage = stage;
    if (encoding) state.encoding = encoding;
    if (crashed) state.crashed = crashed;
    return state;
  } catch {
    return { scale: 1, pending: false };
  }
}

function write(store: Store | undefined, state: TileState): void {
  try {
    store?.setItem(EXPORT_TILES_KEY, JSON.stringify(state));
  } catch {
    // Penyimpanan diblokir: skala tetap dipelajari di worker selama sesi ini.
  }
}

let active = 0;
let encoding = 0;

/** Penanda yang tertinggal dari muatan sebelumnya = tab mati di tengah jalan. */
function recover(state: TileState): TileState {
  const next = { ...state };
  if (state.pending && active === 0) {
    next.scale = Math.max(MIN_EXPORT_TILE_SCALE, state.scale / 2);
    next.crashed = state.stage ?? 'Develop';
    next.pending = false;
  }
  if (state.encoding && encoding === 0) {
    next.crashed = `Encoding ${state.encoding}`;
    delete next.encoding;
  }
  if (active === 0) delete next.stage;
  return next;
}

/** Mulai Develop: kembalikan skala tile awal (dibagi dua bila Develop sebelumnya mati). */
export function startExportTiles(store = defaultStore()): number {
  const state = recover(read(store));
  active += 1;
  write(store, { ...state, pending: true });
  return state.scale;
}

/** Catat tahap Develop yang sedang berjalan (mis. tile ke berapa). */
export function noteExportStage(stage: string, store = defaultStore()): void {
  if (active === 0) return;
  write(store, { ...read(store), stage });
}

/** Develop selesai (berhasil, gagal, atau tersalip): hapus penanda bila tak ada lagi yang berjalan. */
export function finishExportTiles(succeeded = false, store = defaultStore()): void {
  active = Math.max(0, active - 1);
  if (active > 0) return;
  const state = read(store);
  delete state.stage;
  if (succeeded) delete state.crashed;
  write(store, { ...state, pending: false });
}

/** Simpan skala yang berhasil dipakai worker. */
export function rememberExportTiles(scale: number, store = defaultStore()): void {
  write(store, { ...read(store), scale: clampTileScale(scale) });
}

/** Encode berkas ekspor berjalan / selesai. */
export function startExportEncode(format: string, store = defaultStore()): void {
  const state = recover(read(store));
  encoding += 1;
  write(store, { ...state, encoding: format });
}

export function finishExportEncode(store = defaultStore()): void {
  encoding = Math.max(0, encoding - 1);
  if (encoding > 0) return;
  const state = read(store);
  delete state.encoding;
  write(store, state);
}

/** Tahap tempat ekspor sebelumnya mati, bila ada (memeriksa penanda yang tertinggal). */
export function previousExportCrash(store = defaultStore()): string | undefined {
  const state = recover(read(store));
  write(store, active > 0 ? { ...state, pending: true } : state);
  return state.crashed;
}
