/**
 * Pratinjau look (LUT film x kertas, `engine/looks.ts`) di atas foto editor:
 * tampil seketika saat resep dipilih, lalu memudar begitu render sungguhan
 * untuk resep itu selesai -- tanpa jeda "Developing" di antaranya.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EngineState } from '../engine/engine';
import type { Frame } from '../engine/display';
import type { RenderParams } from '../../params/renderParams';
import { hasLook, loadLooks, lookFor, lookRenderer } from '../engine/looks';

type Stocks = Pick<RenderParams, 'filmEnabled' | 'film' | 'paper' | 'process'>;
const keyOf = (s: Stocks) => `${s.filmEnabled ? s.film : 'off'}|${s.paper}|${s.process}`;

/**
 * Bitmap look untuk ditampilkan di atas foto, atau `undefined`.
 *
 * `wanted` = resep yang dipilih (boleh belum dikirim ke engine: mode LUT di
 * pemilih film). Look tampil selama engine belum punya frame untuk resep itu:
 * resep belum dikirim, atau frame yang tampil masih milik resep lama
 * (\`params\` berganti seketika, \`rendering\` baru menyala setelah worker
 * menerima patch).
 */
export function useLookPreview(state: EngineState, wanted: Stocks, provisional?: { frame: Frame }): ImageBitmap | undefined {
  // Membuka: look diterapkan ke foto hasil decode browser, selalu tampil.
  const original = provisional?.frame ?? state.original;
  const { frame } = state;
  const engineKey = keyOf(state.params);
  const lastKey = useRef(engineKey);
  const staleFrame = useRef<Frame | undefined>(undefined);
  if (lastKey.current !== engineKey) {
    lastKey.current = engineKey;
    staleFrame.current = frame;
  }
  const pending = keyOf(wanted) !== engineKey;
  const waiting = !!frame && frame === staleFrame.current;
  const look = lookFor(wanted);
  const show = !!original && !!look && hasLook(look) && (!!provisional || pending || waiting);

  const [bitmap, setBitmap] = useState<{ key: string; image: ImageBitmap } | undefined>();
  const [, setLoaded] = useState(false);
  useEffect(() => { void loadLooks().then(() => setLoaded(true)); }, []);
  useEffect(() => {
    if (!show || !original || !look) return;
    if (bitmap?.key === `${look}@${original.width}`) return;
    let live = true;
    const r = lookRenderer();
    r?.setSource(original);
    void r?.apply(look).then((image) => {
      if (!live || !image) return;
      setBitmap({ key: `${look}@${original.width}`, image });
    });
    return () => { live = false; };
  }, [show, original, look, bitmap?.key]);
  // Foto baru: look lama tidak berlaku.
  useEffect(() => setBitmap(undefined), [original]);
  return show && bitmap?.key === `${look}@${original?.width}` ? bitmap.image : undefined;
}

/** Lapisan look di dalam lapisan zoom foto: muncul seketika, memudar keluar. */
export function LookLayer({ image }: { image: ImageBitmap | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [shown, setShown] = useState<ImageBitmap | undefined>(image);
  useLayoutEffect(() => {
    if (image) setShown(image);
  }, [image]);
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !shown) return;
    c.width = shown.width;
    c.height = shown.height;
    c.getContext('2d')?.drawImage(shown, 0, 0);
  }, [shown]);
  if (!shown) return null;
  return (
    <canvas
      ref={canvas}
      className="look-layer"
      data-on={image ? '' : undefined}
      aria-hidden="true"
      onTransitionEnd={() => { if (!image) setShown(undefined); }}
    />
  );
}
