/**
 * Skala tile ekspor yang dipelajari lintas muatan halaman.
 *
 * Safari iOS mematikan tab yang memakai terlalu banyak memori tanpa event
 * yang bisa ditangkap. Jadi selama Develop berjalan disimpan penanda
 * `pending`; bila halaman dimuat ulang dan penanda itu masih ada, Develop
 * sebelumnya mati di tengah render -- skala tile dibagi dua untuk percobaan
 * berikutnya. Skala yang berhasil (termasuk yang dikecilkan worker setelah
 * GPU kehabisan memori) disimpan, jadi tiap perangkat menemukan ukuran tile
 * yang muat di GPU-nya sendiri.
 */
import { MIN_EXPORT_TILE_SCALE, clampTileScale } from '../../io/budget';

export const EXPORT_TILES_KEY = 'dichroic.exportTiles.v1';

interface TileState {
  scale: number;
  pending: boolean;
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
    return { scale: clampTileScale(typeof parsed.scale === 'number' ? parsed.scale : undefined), pending: parsed.pending === true };
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

/** Mulai Develop: kembalikan skala tile awal (dibagi dua bila Develop sebelumnya mati). */
export function startExportTiles(store = defaultStore()): number {
  const state = read(store);
  let { scale } = state;
  if (state.pending && active === 0) scale = Math.max(MIN_EXPORT_TILE_SCALE, scale / 2);
  active += 1;
  write(store, { scale, pending: true });
  return scale;
}

/** Develop selesai (berhasil, gagal, atau tersalip): hapus penanda bila tak ada lagi yang berjalan. */
export function finishExportTiles(store = defaultStore()): void {
  active = Math.max(0, active - 1);
  if (active === 0) write(store, { ...read(store), pending: false });
}

/** Simpan skala yang berhasil dipakai worker. */
export function rememberExportTiles(scale: number, store = defaultStore()): void {
  const state = read(store);
  write(store, { ...state, scale: clampTileScale(scale) });
}
