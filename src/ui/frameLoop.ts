/**
 * Satu loop requestAnimationFrame bersama dengan urutan tetap per frame.
 * Dipakai layar intro supaya simulasi stiker (0) selalu jalan sebelum kanvas
 * latar kaca (1) dan glow cincin (2) -- keduanya menggambar posisi stiker
 * frame yang sama, bukan frame sebelumnya.
 */
type Entry = { callback: (now: number) => void; order: number };

const entries: Entry[] = [];
let raf = 0;

const tick = (now: number) => {
  raf = requestAnimationFrame(tick);
  [...entries].forEach((entry) => entry.callback(now));
};

export function onFrame(callback: (now: number) => void, order: number) {
  const entry = { callback, order };
  entries.push(entry);
  entries.sort((a, b) => a.order - b.order);
  if (!raf) raf = requestAnimationFrame(tick);
  return () => {
    const i = entries.indexOf(entry);
    if (i >= 0) entries.splice(i, 1);
    if (!entries.length && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
}

/** Urutan di layar intro. */
export const FRAME_ORDER = { orb: -1, stickers: 0, backdrop: 1, bloom: 2 } as const;
