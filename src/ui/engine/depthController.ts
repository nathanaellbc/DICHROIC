/**
 * Status peta kedalaman lens blur untuk foto yang terbuka. Dipisah dari
 * `Engine` (yang butuh Worker dan DOM) supaya alurnya bisa diuji di Node
 * (`test/ui/depthController.test.ts`).
 *
 * Alur: lens blur dinyalakan -> `ensure()` mencoba estimasi TANPA mengunduh.
 * Model belum di perangkat -> `needs-download` dengan ukurannya, dan unduhan
 * baru dimulai atas perintah pengguna (`download()`) -- puluhan MB tidak
 * pernah diunduh diam-diam. Hasil dikirim ke `Session` (`deliver`) SEBELUM
 * status menjadi `ready`, jadi render yang dipicu status itu sudah memakai
 * peta.
 *
 * Setiap foto punya token: hasil estimasi foto sebelumnya dibuang dan tidak
 * pernah dikirim ke foto yang baru dibuka (`Session.open` sendiri juga
 * menghapus peta lama).
 */

import { DepthCancelledError, DepthNotCachedError } from '../../depth/estimate';
import type { DepthProgress, DepthResult, Guide } from '../../depth/estimate';
import type { DepthBackend } from '../../depth/model';
import type { DepthPhase } from '../../depth/protocol';
import type { DepthMap } from '../../host/lens';

export type DepthState =
  | { status: 'idle' }
  | { status: 'needs-download'; bytes: number }
  | { status: 'working'; phase: DepthPhase; loaded: number; total: number }
  | { status: 'ready'; backend: DepthBackend; variant: 'fp16' | 'int8'; ms: number }
  | { status: 'error'; message: string };

export interface DepthDeps {
  estimate(guide: Guide, allowDownload: boolean, onProgress: (p: DepthProgress) => void): Promise<DepthResult>;
  /** Pasang peta ke `Session` (dan minta render). */
  deliver(map: DepthMap): Promise<void>;
  /** Ukuran unduhan pertama (bobot + runtime) di perangkat ini. */
  downloadBytes(): Promise<number>;
  onChange(state: DepthState): void;
}

export class DepthController {
  #state: DepthState = { status: 'idle' };
  #guide: Guide | undefined;
  #token = 0;

  constructor(private readonly deps: DepthDeps) {}

  get state(): DepthState {
    return this.#state;
  }

  /** Foto baru dibuka (atau ditutup: `undefined`). */
  reset(guide: Guide | undefined): void {
    this.#token += 1;
    this.#guide = guide;
    this.#set({ status: 'idle' });
  }

  /** Lens blur butuh peta: estimasi bila belum ada, tanpa mengunduh. */
  ensure(): void {
    if (this.#state.status === 'idle' || this.#state.status === 'error') void this.#run(false);
  }

  /** Pengguna menyetujui unduhan model. */
  download(): void {
    if (this.#state.status !== 'working' && this.#state.status !== 'ready') void this.#run(true);
  }

  #set(state: DepthState): void {
    this.#state = state;
    this.deps.onChange(state);
  }

  async #run(allowDownload: boolean): Promise<void> {
    const guide = this.#guide;
    if (!guide) return;
    const token = ++this.#token;
    const current = () => token === this.#token;
    this.#set({ status: 'working', phase: 'runtime', loaded: 0, total: 0 });
    try {
      const result = await this.deps.estimate(guide, allowDownload, (p) => {
        if (current()) this.#set({ status: 'working', phase: p.phase, loaded: p.loaded, total: p.total });
      });
      if (!current()) return;
      await this.deps.deliver({ width: result.width, height: result.height, data: result.data });
      if (!current()) return;
      this.#set({ status: 'ready', backend: result.backend, variant: result.variant, ms: result.inferMs });
    } catch (error) {
      // Yang tersalip bukan kegagalan: permintaan yang lebih baru memegang status.
      if (!current() || error instanceof DepthCancelledError) return;
      if (error instanceof DepthNotCachedError) {
        const bytes = await this.deps.downloadBytes();
        if (current()) this.#set({ status: 'needs-download', bytes });
        return;
      }
      this.#set({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
}
