/**
 * Foto layar penuh: ketuk foto di editor, foto tumbuh mulus dari posisinya
 * ke layar penuh (transisi elemen bersama), lalu kembali ke tempatnya saat
 * ditutup. Seperti Photos di iOS:
 *
 * - pinch / roda / ketuk dua kali untuk zoom; skala lewat batas melar elastis
 *   lalu memegas balik; pinch jauh di bawah pas menutup layar penuh;
 * - geser saat zoom meluncur (inersia) dan memantul di tepi;
 * - saat pas: ketuk menutup, usap ke bawah menutup (latar memudar ikut jari);
 * - keyboard: + / - / 0 untuk zoom, Escape menutup.
 */
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { activateModal } from '../modalFocus';
import { Icon } from './Icon';
import { Spinner } from './Overlays';

export interface Box { left: number; top: number; width: number; height: number }
type Point = { x: number; y: number };
type Zoom = { s: number; x: number; y: number };

const openSpring = { type: 'spring' as const, duration: 0.5, bounce: 0.14 };
const closeSpring = { type: 'spring' as const, duration: 0.38, bounce: 0 };
/** Kembali dari batas elastis (sama rasanya dengan photoReturn di editor). */
const settleSpring = { type: 'spring' as const, duration: 0.5, bounce: 0.2 };
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 0.6; // px/ms
const MAX_ZOOM = 8;
const DOUBLE_TAP_ZOOM = 2.5;
const PINCH_CLOSE = 0.72;
const TAP_SLOP = 6;
const TAP_MAX_MS = 250;
const DOUBLE_TAP_MS = 280;
const IDENTITY: Zoom = { s: 1, x: 0, y: 0 };
/** Seberapa jauh luncuran setelah lepas: jarak = kecepatan (px/ms) x ini. */
const GLIDE_MS = 220;

/** Kotak `aspect` terbesar yang muat di viewport, di tengah. */
function fitBox(width: number, height: number): Box {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scale = Math.min(vw / width, vh / height);
  const w = width * scale;
  const h = height * scale;
  return { left: (vw - w) / 2, top: (vh - h) / 2, width: w, height: h };
}

/** Pegas karet: makin jauh melewati batas, makin berat. */
function rubber(over: number, dimension: number): number {
  if (over === 0) return 0;
  const c = 0.55;
  return Math.sign(over) * (Math.abs(over) * dimension * c) / (dimension + c * Math.abs(over));
}

/** Skala di luar [1, MAX] melambat (pinch elastis). */
function elasticScale(s: number): number {
  if (s < 1) return Math.sqrt(s);
  if (s > MAX_ZOOM) return MAX_ZOOM * (s / MAX_ZOOM) ** 0.3;
  return s;
}

export function PhotoLightbox({ open, aspect, label, source, busy = false, onClose, onZoom, children }: {
  open: boolean;
  /** Ukuran piksel foto (hanya rasionya yang dipakai). */
  aspect: { width: number; height: number };
  label: string;
  /** Posisi foto di editor saat ini (layar), tujuan animasi buka/tutup. */
  source: () => Box | null;
  /** Render lebih tajam sedang berjalan. */
  busy?: boolean;
  onClose: () => void;
  /** Skala zoom setelah gestur berhenti (untuk meminta render lebih tajam). */
  onZoom?: (scale: number) => void;
  children: ReactNode;
}) {
  return createPortal(
    <AnimatePresence>
      {open && <Lightbox key="lightbox" aspect={aspect} label={label} source={source} busy={busy} onClose={onClose} onZoom={onZoom}>{children}</Lightbox>}
    </AnimatePresence>,
    document.body,
  );
}

function Lightbox({ aspect, label, source, busy, onClose, onZoom, children }: Omit<Parameters<typeof PhotoLightbox>[0], 'open'>) {
  const ref = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const target = fitBox(aspect.width, aspect.height);
  // Transformasi yang menaruh kotak layar penuh tepat di atas foto editor.
  const fromSource = () => {
    const s = source();
    if (!s || s.width === 0) return { x: 0, y: 0, scale: 0.92, opacity: 0 };
    return { x: s.left - target.left, y: s.top - target.top, scale: s.width / target.width, opacity: 1 };
  };
  const start = useRef(fromSource()).current;
  const x = useMotionValue(reduced ? 0 : start.x);
  const y = useMotionValue(reduced ? 0 : start.y);
  const scale = useMotionValue(reduced ? 1 : start.scale);
  // Zoom di dalam kotak layar penuh (asal transformasi di pojok kiri atas kotak).
  const zs = useMotionValue(1);
  const zx = useMotionValue(0);
  const zy = useMotionValue(0);
  const dragY = useMotionValue(0);
  const backdrop = useMotionValue(0);
  const dragFade = useTransform(dragY, [0, 360], [1, 0.15]);
  const pinchFade = useTransform(zs, [PINCH_CLOSE * 0.85, 1], [0.35, 1]);
  const dim = useTransform(() => backdrop.get() * dragFade.get() * Math.min(1, pinchFade.get()));
  const closing = useRef(false);
  const [zoomed, setZoomed] = useState(false);
  const animations = useRef<Array<{ stop: () => void }>>([]);

  useEffect(() => {
    const t = reduced ? { duration: 0 } : openSpring;
    const controls = [
      animate(x, 0, t), animate(y, 0, t), animate(scale, 1, t),
      animate(backdrop, 1, reduced ? { duration: 0 } : { duration: 0.32, ease: [0.22, 1, 0.36, 1] }),
    ];
    return () => controls.forEach((c) => c.stop());
    // Hanya saat terbuka: motion value stabil, `reduced` dibaca sekali.
  }, [x, y, scale, backdrop, reduced]);

  useEffect(() => (ref.current ? activateModal(ref.current) : undefined), []);

  const stopZoomAnimations = () => {
    animations.current.forEach((a) => a.stop());
    animations.current = [];
    zs.stop(); zx.stop(); zy.stop();
  };
  const current = (): Zoom => ({ s: zs.get(), x: zx.get(), y: zy.get() });

  /** Batas geser untuk skala `s` (koordinat kotak): foto menutup layar, atau di tengah bila lebih kecil. */
  const bounds = (s: number) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const cw = target.width * s, ch = target.height * s;
    const axis = (content: number, view: number, offset: number) => content <= view
      ? { min: (view - content) / 2 - offset, max: (view - content) / 2 - offset }
      : { min: view - offset - content, max: -offset };
    return { x: axis(cw, vw, target.left), y: axis(ch, vh, target.top) };
  };
  const clampZoom = (z: Zoom): Zoom => {
    const s = Math.min(MAX_ZOOM, Math.max(1, z.s));
    const b = bounds(s);
    return { s, x: Math.min(b.x.max, Math.max(b.x.min, z.x)), y: Math.min(b.y.max, Math.max(b.y.min, z.y)) };
  };
  /** Posisi melar: lewat batas dilawan pegas karet. */
  const elastic = (z: Zoom): Zoom => {
    const b = bounds(Math.min(MAX_ZOOM, Math.max(1, z.s)));
    const ax = (v: number, r: { min: number; max: number }, dim: number) =>
      v < r.min ? r.min + rubber(v - r.min, dim) : v > r.max ? r.max + rubber(v - r.max, dim) : v;
    return { s: z.s, x: ax(z.x, b.x, window.innerWidth), y: ax(z.y, b.y, window.innerHeight) };
  };
  /** Zoom ke skala `s` dengan titik layar `p` tetap di tempatnya. */
  const zoomAt = (from: Zoom, s: number, p: Point): Zoom => {
    const lx = p.x - target.left, ly = p.y - target.top;
    const ux = (lx - from.x) / from.s, uy = (ly - from.y) / from.s;
    return { s, x: lx - ux * s, y: ly - uy * s };
  };
  const apply = (z: Zoom) => { zs.set(z.s); zx.set(z.x); zy.set(z.y); };
  const settleTo = (z: Zoom, transition: object = settleSpring) => {
    stopZoomAnimations();
    const t = reduced ? { duration: 0 } : transition;
    animations.current = [animate(zs, z.s, t), animate(zx, z.x, t), animate(zy, z.y, t)];
    setZoomed(z.s > 1.01);
    onZoom?.(z.s);
  };

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    window.clearTimeout(tapTimer.current);
    stopZoomAnimations();
    const to = fromSource();
    const t = reduced ? { duration: 0 } : closeSpring;
    // Usap ke bawah: lanjut dari posisi jari, bukan melompat balik dulu.
    const offset = dragY.get();
    dragY.stop();
    dragY.set(0);
    y.set(y.get() + offset);
    Promise.all([
      animate(x, to.x, t), animate(y, to.y, t), animate(scale, to.scale, t),
      animate(zs, 1, t), animate(zx, 0, t), animate(zy, 0, t),
      animate(backdrop, 0, reduced ? { duration: 0 } : { duration: 0.26, ease: [0.4, 0, 0.2, 1] }),
    ]).then(onClose);
  };

  // ---- Gestur pointer -------------------------------------------------------
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<
    | { kind: 'pending'; start: Point; t: number; from: Zoom }
    | { kind: 'pan'; start: Point; from: Zoom }
    | { kind: 'dismiss'; start: Point }
    | { kind: 'pinch'; dist: number; mid: Point; from: Zoom; minRaw: number }
    | null
  >(null);
  const velocity = useRef({ x: 0, y: 0, t: 0, px: 0, py: 0 });
  const tapTimer = useRef(0);
  const lastTap = useRef<{ t: number; p: Point } | null>(null);
  useEffect(() => () => window.clearTimeout(tapTimer.current), []);

  const two = (): [Point, Point] => [...pointers.current.values()].slice(0, 2) as [Point, Point];
  const trackVelocity = (p: Point) => {
    const v = velocity.current;
    const now = performance.now();
    const dt = Math.max(1, now - v.t);
    // Rata-rata bergerak supaya satu sampel bising tidak melempar foto.
    v.x = v.x * 0.4 + ((p.x - v.px) / dt) * 0.6;
    v.y = v.y * 0.4 + ((p.y - v.py) / dt) * 0.6;
    v.t = now; v.px = p.x; v.py = p.y;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (closing.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, p);
    stopZoomAnimations();
    dragY.stop();
    if (pointers.current.size === 2) {
      window.clearTimeout(tapTimer.current);
      const [a, b] = two();
      dragY.set(0);
      gesture.current = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, from: current(), minRaw: zs.get() };
      return;
    }
    if (pointers.current.size > 2) return;
    velocity.current = { x: 0, y: 0, t: performance.now(), px: p.x, py: p.y };
    gesture.current = { kind: 'pending', start: p, t: performance.now(), from: current() };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = two();
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const raw = g.from.s * (dist / Math.max(1, g.dist));
      g.minRaw = Math.min(g.minRaw, raw);
      const z = zoomAt(g.from, elasticScale(raw), g.mid);
      // Zoom di titik tengah awal, lalu ikut geseran titik tengahnya.
      const moved = { s: z.s, x: z.x + mid.x - g.mid.x, y: z.y + mid.y - g.mid.y };
      apply(z.s < 1 ? moved : elastic(moved));
      return;
    }
    trackVelocity(p);
    const dx = p.x - (g as { start: Point }).start.x;
    const dy = p.y - (g as { start: Point }).start.y;
    if (g.kind === 'pending') {
      if (Math.hypot(dx, dy) < TAP_SLOP) return;
      gesture.current = g.from.s > 1.01 ? { kind: 'pan', start: g.start, from: g.from } : { kind: 'dismiss', start: g.start };
    }
    const cur = gesture.current!;
    if (cur.kind === 'pan') apply(elastic({ s: cur.from.s, x: cur.from.x + dx, y: cur.from.y + dy }));
    else if (cur.kind === 'dismiss') dragY.set(dy > 0 ? dy : rubber(dy, window.innerHeight) * 0.3);
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (pointers.current.size === 1) {
        // Satu jari tersisa: lanjut geser dari posisi sekarang.
        const rest = two()[0];
        if (g.minRaw < PINCH_CLOSE && g.from.s <= 1.01 && zs.get() < 1) { gesture.current = null; close(); return; }
        gesture.current = { kind: 'pan', start: rest, from: current() };
        velocity.current = { x: 0, y: 0, t: performance.now(), px: rest.x, py: rest.y };
        if (zs.get() <= 1.01) settleTo(clampZoom(current()));
        return;
      }
      gesture.current = null;
      if (g.minRaw < PINCH_CLOSE && g.from.s <= 1.01 && zs.get() < 1) { close(); return; }
      const z = current();
      const s = Math.min(MAX_ZOOM, Math.max(1, z.s));
      settleTo(clampZoom(zoomAt(z, s, g.mid)));
      return;
    }
    if (pointers.current.size > 0) return;
    gesture.current = null;
    if (e.type !== 'pointerup') { settleTo(clampZoom(current())); animate(dragY, 0, settleSpring); return; }

    if (g.kind === 'pending') {
      if (performance.now() - g.t > TAP_MAX_MS) return;
      const p = { x: e.clientX, y: e.clientY };
      const prev = lastTap.current;
      if (prev && performance.now() - prev.t < DOUBLE_TAP_MS && Math.hypot(p.x - prev.p.x, p.y - prev.p.y) < 40) {
        // Ketuk dua kali: zoom ke titik itu, atau kembali pas.
        lastTap.current = null;
        window.clearTimeout(tapTimer.current);
        const z = current();
        settleTo(z.s > 1.01 ? IDENTITY : clampZoom(zoomAt(z, DOUBLE_TAP_ZOOM, p)), { type: 'spring', duration: 0.42, bounce: 0.08 });
        return;
      }
      lastTap.current = { t: performance.now(), p };
      // Ketuk sekali saat pas menutup (setelah memastikan bukan ketuk dua kali).
      if (zs.get() <= 1.01) tapTimer.current = window.setTimeout(close, DOUBLE_TAP_MS);
      return;
    }
    if (g.kind === 'dismiss') {
      const v = performance.now() - velocity.current.t < 80 ? velocity.current.y : 0;
      if (dragY.get() > DISMISS_DISTANCE || v > DISMISS_VELOCITY) close();
      else animate(dragY, 0, reduced ? { duration: 0 } : settleSpring);
      return;
    }
    if (g.kind === 'pan') {
      const z = current();
      const b = bounds(z.s);
      const v = velocity.current;
      stopZoomAnimations();
      if (reduced) { settleTo(clampZoom(z)); return; }
      // Luncuran: titik henti diproyeksikan dari kecepatan lepas lalu dijepit
      // ke tepi; pegas membawa ke sana dengan kecepatan jari. Lepas di luar
      // tepi (melar) selalu kembali ke tepi.
      const glide = (value: typeof zx, speed: number, range: { min: number; max: number }) => {
        const from = value.get();
        const projected = from + speed * GLIDE_MS;
        const to = Math.min(range.max, Math.max(range.min, projected));
        const hitEdge = to !== projected && from >= range.min && from <= range.max;
        return animate(value, to, { type: 'spring', velocity: speed * 1000, duration: hitEdge ? 0.55 : 0.6, bounce: hitEdge ? 0.22 : 0 });
      };
      // Jari diam sebelum dilepas: tidak ada luncuran.
      const fresh = performance.now() - v.t < 80;
      animations.current = [glide(zx, fresh ? v.x : 0, b.x), glide(zy, fresh ? v.y : 0, b.y)];
      onZoom?.(z.s);
    }
  };

  // Roda / pinch trackpad (ctrl+roda): listener native non-pasif.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    let wheelTarget: Zoom | null = null;
    let idle = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (closing.current) return;
      window.clearTimeout(tapTimer.current);
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1);
      const from = wheelTarget ?? current();
      const s = Math.min(MAX_ZOOM, Math.max(1, from.s * Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.002))));
      wheelTarget = clampZoom(zoomAt(from, s, { x: e.clientX, y: e.clientY }));
      stopZoomAnimations();
      const t = reduced ? { duration: 0 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] };
      animations.current = [animate(zs, wheelTarget.s, t), animate(zx, wheelTarget.x, t), animate(zy, wheelTarget.y, t)];
      setZoomed(wheelTarget.s > 1.01);
      window.clearTimeout(idle);
      idle = window.setTimeout(() => { if (wheelTarget) onZoom?.(wheelTarget.s); wheelTarget = null; }, 200);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); window.clearTimeout(idle); };
    // Pendengar dipasang sekali; nilai terbaru dibaca dari motion value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const centre = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); const z = current(); settleTo(clampZoom(zoomAt(z, Math.min(MAX_ZOOM, z.s * 1.5), centre))); }
    else if (e.key === '-') { e.preventDefault(); const z = current(); settleTo(clampZoom(zoomAt(z, Math.max(1, z.s / 1.5), centre))); }
    else if (e.key === '0') { e.preventDefault(); settleTo(IDENTITY); }
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={`${label}, full screen. Pinch or use plus and minus to zoom.`}
      className="lightbox"
      // Portal tetap meneruskan event React ke PhotoView (leluhurnya di pohon
      // React); tanpa ini PhotoView ikut menangani pointer di layar penuh.
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={stop}
      onContextMenu={(e) => { e.stopPropagation(); e.preventDefault(); }}
      onKeyDown={onKeyDown}
    >
      <motion.div className="lightbox-backdrop" style={{ opacity: dim }} aria-hidden="true" />
      <motion.div
        ref={surfaceRef}
        className="lightbox-drag"
        data-zoomed={zoomed}
        style={{ y: dragY }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
      >
        <motion.div
          role="img"
          aria-label={label}
          className="lightbox-photo"
          style={{ left: target.left, top: target.top, width: target.width, height: target.height, x, y, scale, opacity: start.opacity === 0 ? backdrop : 1 }}
        >
          <motion.div className="lightbox-zoom" style={{ x: zx, y: zy, scale: zs }}>
            {children}
          </motion.div>
        </motion.div>
      </motion.div>
      <AnimatePresence>
        {busy && (
          <motion.span key="busy" className="glass-clear t-footnote photo-status-pill lightbox-busy" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ padding: '0 10px 0 7px' }}>
            <Spinner size={15} /> Developing
          </motion.span>
        )}
      </AnimatePresence>
      <motion.button
        type="button"
        className="icon-btn glass lightbox-close"
        aria-label="Close full screen"
        style={{ opacity: dim }}
        onClick={close}
      >
        <Icon name="close" size={18} strokeWidth={2.4} />
      </motion.button>
    </div>
  );
}
