/** `Session` dipakai di luar urutan yang sah: render sebelum `open`, atau setelah `dispose`. */
export class SessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStateError';
  }
}

/**
 * Permintaan render yang belum sempat mulai digantikan permintaan yang lebih
 * baru (antrean "terbaru menang", spec Fase 2 §4.4). Bukan kegagalan: UI
 * cukup mengabaikannya.
 */
export class RenderSupersededError extends Error {
  constructor() {
    super('Render digantikan oleh permintaan yang lebih baru sebelum sempat dimulai.');
    this.name = 'RenderSupersededError';
  }
}
