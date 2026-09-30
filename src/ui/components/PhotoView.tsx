/**
 * Foto: frame hasil render, dipaskan (contain) ke area yang tersedia.
 * Pembanding: garis pembagi yang bisa diseret memperlihatkan aslinya di kiri;
 * tanpa mode pembanding, tekan-tahan foto memperlihatkan aslinya (seperti
 * Photos). Frame baru langsung digambar tanpa animasi -- DESIGN.md: jangan
 * menambah gerak pada interaksi yang sering.
 *
 * Keyboard: garis pembagi adalah slider (panah), dan mode pilih fokus
 * memindah bidik dengan panah lalu Enter memilih, Escape batal.
 *
 * Zoom: roda/pinch trackpad di titik kursor, pinch dua jari, klik ganda
 * (pas <-> 2,5x); seret untuk menggeser saat diperbesar. Zoom hanya transform
 * tampilan -- pratinjau yang sama diperbesar, render tidak diulang.
 */
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Frame } from '../engine/display';
import { fade } from '../motion';
import { Spinner } from './Overlays';
import { Icon } from './Icon';

function FrameCanvas({ frame, style }: { frame: Frame; style?: React.CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (canvas.width !== frame.width) canvas.width = frame.width;
    if (canvas.height !== frame.height) canvas.height = frame.height;
    const ctx = canvas.getContext('2d', { colorSpace: frame.colorSpace });
    ctx?.putImageData(new ImageData(frame.pixels as Uint8ClampedArray<ArrayBuffer>, frame.width, frame.height, { colorSpace: frame.colorSpace }), 0, 0);
  }, [frame]);
  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', ...style }} />;
}

/**
 * Titik fokus lens blur (koordinat 0..1 relatif foto). `picking`: ketukan
 * berikutnya memilih subjek (pembanding dan intip asli dimatikan selama itu).
 */
export interface FocusOverlay {
  x: number;
  y: number;
  show: boolean;
  picking: boolean;
  onPick: (x: number, y: number) => void;
  onCancel?: () => void;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const MAX_ZOOM = 8;
const DOUBLE_CLICK_ZOOM = 2.5;
/** Gerak (px) sebelum ketukan dianggap seretan. */
const DRAG_SLOP = 4;

/** Tampilan zoom: skala dan geser (px) sudut kiri-atas foto dari posisi pasnya. */
interface View {
  s: number;
  tx: number;
  ty: number;
}
const FIT: View = { s: 1, tx: 0, ty: 0 };

type Point = { x: number; y: number };

/**
 * Satu sumbu: foto yang lebih kecil dari area tetap di tengah; yang lebih
 * besar tidak boleh menyisakan celah di tepi.
 */
function clampAxis(t: number, s: number, len: number, offset: number, areaLen: number): number {
  const scaled = s * len;
  if (scaled <= areaLen) return (areaLen - scaled) / 2 - offset;
  return Math.min(-offset, Math.max(areaLen - offset - scaled, t));
}

export function PhotoView({
  frame,
  original,
  compare,
  rendering,
  photoKey,
  label,
  focus,
}: {
  frame?: Frame;
  original?: Frame;
  compare: boolean;
  rendering: boolean;
  /** Berganti per berkas: foto baru muncul dengan pudar singkat. */
  photoKey: string;
  label: string;
  focus?: FocusOverlay;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [split, setSplit] = useState(0.5);
  const [peek, setPeek] = useState(false);
  const [slow, setSlow] = useState(false);
  const [aim, setAim] = useState<{ x: number; y: number } | null>(null);
  const [view, setView] = useState<View>(FIT);
  const holdTimer = useRef(0);
  const splitDrag = useRef(false);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<
    | { kind: 'pan'; x: number; y: number; view: View; moved: boolean }
    | { kind: 'pinch'; dist: number; mid: Point; view: View }
    | { kind: 'tap'; x: number; y: number; moved: boolean }
    | null
  >(null);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      setArea({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Indikator render hanya bila lambat (> 350 ms), supaya tidak berkedip.
  useEffect(() => {
    if (!rendering) {
      setSlow(false);
      return;
    }
    const t = window.setTimeout(() => setSlow(true), 350);
    return () => window.clearTimeout(t);
  }, [rendering]);

  const shown = frame ?? original;
  let rect = { left: 0, top: 0, width: 0, height: 0 };
  if (shown && area.width > 0 && area.height > 0) {
    const scale = Math.min(area.width / shown.width, area.height / shown.height);
    const width = Math.round(shown.width * scale);
    const height = Math.round(shown.height * scale);
    rect = { left: Math.round((area.width - width) / 2), top: Math.round((area.height - height) / 2), width, height };
  }

  // Foto baru mulai dari pas.
  useEffect(() => setView(FIT), [photoKey]);

  const clampView = (v: View): View => {
    if (rect.width === 0) return FIT;
    const s = Math.min(MAX_ZOOM, Math.max(1, v.s));
    return {
      s,
      tx: clampAxis(v.tx, s, rect.width, rect.left, area.width),
      ty: clampAxis(v.ty, s, rect.height, rect.top, area.height),
    };
  };
  /** Titik area (px) -> koordinat foto 0..1, memperhitungkan zoom. */
  const toPhoto = (ax: number, ay: number, v: View = view): Point => ({
    x: (ax - rect.left - v.tx) / (v.s * rect.width),
    y: (ay - rect.top - v.ty) / (v.s * rect.height),
  });
  /** Zoom ke skala `s` dengan titik area (ax, ay) tetap di tempatnya. */
  const zoomAt = (v: View, s: number, ax: number, ay: number): View => {
    const p = toPhoto(ax, ay, v);
    const clamped = Math.min(MAX_ZOOM, Math.max(1, s));
    return clampView({ s: clamped, tx: ax - rect.left - p.x * clamped * rect.width, ty: ay - rect.top - p.y * clamped * rect.height });
  };
  const latest = useRef({ clampView, zoomAt });
  useEffect(() => {
    latest.current = { clampView, zoomAt };
  });

  const local = (clientX: number, clientY: number): Point => {
    const box = areaRef.current?.getBoundingClientRect();
    return { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) };
  };

  // Roda / pinch trackpad (ctrl+roda): listener native non-pasif supaya
  // halaman tidak ikut di-zoom browser.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      setView((v) => latest.current.zoomAt(v, v.s * factor, e.clientX - box.left, e.clientY - box.top));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Ukuran area berubah (rotasi, panel): jaga tampilan tetap sah.
  useEffect(() => {
    setView((v) => latest.current.clampView(v));
  }, [area.width, area.height, rect.width, rect.height]);

  const setSplitFrom = (clientX: number) => {
    if (rect.width === 0) return;
    setSplit(clamp01(toPhoto(local(clientX, 0).x, 0).x));
  };

  const picking = focus?.picking === true;
  // Bidik keyboard dimulai dari titik fokus sekarang tiap kali mode pilih dibuka.
  const cursor = picking && focus ? (aim ?? { x: focus.x, y: focus.y }) : null;
  useEffect(() => {
    if (!picking) {
      setAim(null);
      return;
    }
    areaRef.current?.focus({ preventScroll: true });
  }, [picking]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!picking || !focus || !cursor) return;
    const step = e.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      setAim({ x: clamp01(cursor.x + move[0]), y: clamp01(cursor.y + move[1]) });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      focus.onPick(Number(cursor.x.toFixed(4)), Number(cursor.y.toFixed(4)));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      focus.onCancel?.();
    }
  };

  const twoPointers = (): [Point, Point] => [...pointers.current.values()].slice(0, 2) as [Point, Point];

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = local(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      // Pinch dua jari: batalkan seret/intip/pembagi yang sempat dimulai.
      const [a, b] = twoPointers();
      window.clearTimeout(holdTimer.current);
      setPeek(false);
      splitDrag.current = false;
      gesture.current = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view };
      return;
    }
    if (pointers.current.size > 2) return;
    if (picking) {
      // Fokus dipilih saat dilepas, kecuali ternyata menggeser foto yang diperbesar.
      gesture.current = view.s > 1 ? { kind: 'pan', x: p.x, y: p.y, view, moved: false } : { kind: 'tap', x: p.x, y: p.y, moved: false };
      return;
    }
    if (compare) {
      splitDrag.current = true;
      setSplitFrom(e.clientX);
      return;
    }
    if (view.s > 1) gesture.current = { kind: 'pan', x: p.x, y: p.y, view, moved: false };
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => setPeek(true), 220);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (g?.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = twoPointers();
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Zoom di titik tengah awal, lalu ikut geseran titik tengahnya.
      const next = zoomAt(g.view, g.view.s * (dist / Math.max(g.dist, 1)), g.mid.x, g.mid.y);
      setView(clampView({ ...next, tx: next.tx + mid.x - g.mid.x, ty: next.ty + mid.y - g.mid.y }));
      return;
    }
    if (splitDrag.current) {
      setSplitFrom(e.clientX);
      return;
    }
    if (g?.kind === 'pan' || g?.kind === 'tap') {
      const dx = p.x - g.x;
      const dy = p.y - g.y;
      if (!g.moved && Math.hypot(dx, dy) > DRAG_SLOP) {
        g.moved = true;
        window.clearTimeout(holdTimer.current);
        setPeek(false);
      }
      if (g.kind === 'pan' && g.moved) setView(clampView({ s: g.view.s, tx: g.view.tx + dx, ty: g.view.ty + dy }));
    }
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const tracked = pointers.current.delete(e.pointerId);
    if (tracked && picking && focus && (g?.kind === 'tap' || g?.kind === 'pan') && !g.moved) {
      const p = toPhoto(g.x, g.y);
      // Ketukan di luar foto (di bingkai hitam) tidak memilih apa pun.
      if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) focus.onPick(Number(p.x.toFixed(4)), Number(p.y.toFixed(4)));
    }
    // Pinch yang tinggal satu jari berhenti; gestur satu jari berakhir saat dilepas.
    if (g?.kind !== 'pinch' || pointers.current.size < 2) gesture.current = null;
    splitDrag.current = false;
    window.clearTimeout(holdTimer.current);
    setPeek(false);
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, [role=slider]')) return;
    const p = local(e.clientX, e.clientY);
    setView(view.s > 1.01 ? clampView(FIT) : zoomAt(view, DOUBLE_CLICK_ZOOM, p.x, p.y));
  };
  const zoomed = view.s > 1.01;
  /** Posisi (px, relatif kotak foto pas) dari koordinat foto 0..1. */
  const sx = (u: number) => view.tx + u * view.s * rect.width;
  const sy = (v: number) => view.ty + v * view.s * rect.height;

  const showOriginal = !!original && !picking && (compare || peek);
  const clip = compare ? `inset(0 ${(1 - split) * 100}% 0 0)` : 'inset(0 0 0 0)';

  return (
    <div
      ref={areaRef}
      tabIndex={picking ? 0 : -1}
      role={picking ? 'application' : undefined}
      aria-label={picking ? 'Focus point. Arrow keys move it, Enter picks the subject, Escape cancels.' : undefined}
      onKeyDown={onKeyDown}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', outline: 'none', touchAction: 'none', cursor: picking ? 'crosshair' : zoomed && !compare ? 'grab' : undefined, WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <AnimatePresence mode="popLayout">
        {shown && (
          <motion.div
            key={photoKey}
            role="img"
            aria-label={label}
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={fade}
            style={{ position: 'absolute', left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          >
            <div style={{ position: 'absolute', inset: 0, transformOrigin: '0 0', transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`, imageRendering: view.s >= 2 ? 'pixelated' : undefined }}>
              {frame && <FrameCanvas key={frame.colorSpace} frame={frame} />}
              {showOriginal && original && (
                <motion.div
                  initial={{ opacity: compare ? 1 : 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.12 }}
                  style={{ position: 'absolute', inset: 0, clipPath: clip }}
                >
                  <FrameCanvas frame={original} />
                </motion.div>
              )}
            </div>
            {compare && (
              <>
                <div aria-hidden="true" style={{ position: 'absolute', top: sy(0), height: rect.height * view.s, left: sx(split), width: 2, marginLeft: -1, background: 'rgba(255,255,255,0.92)' }} />
                <div
                  className="glass-clear split-handle"
                  role="slider"
                  tabIndex={0}
                  aria-label="Before and after divider"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(split * 100)}
                  aria-valuetext={`${Math.round(split * 100)}% original`}
                  onKeyDown={(e) => {
                    const step = e.shiftKey ? 0.1 : 0.02;
                    const next: Record<string, number> = { ArrowLeft: split - step, ArrowDown: split - step, ArrowRight: split + step, ArrowUp: split + step, Home: 0, End: 1 };
                    if (!(e.key in next)) return;
                    e.preventDefault();
                    setSplit(clamp01(next[e.key]!));
                  }}
                  style={{ position: 'absolute', top: Math.min(Math.max(sy(0.5), 18), rect.height - 18), left: sx(split), width: 36, height: 36, marginLeft: -18, marginTop: -18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name="compare" size={18} />
                </div>
                <span className="glass-clear t-footnote" style={{ position: 'absolute', top: 10, right: rect.width - sx(split) + 8, padding: '4px 10px', borderRadius: 6, fontWeight: 600, opacity: split > 0.12 ? 1 : 0 }}>Before</span>
                <span className="glass-clear t-footnote" style={{ position: 'absolute', top: 10, left: sx(split) + 8, padding: '4px 10px', borderRadius: 6, fontWeight: 600, opacity: split < 0.88 ? 1 : 0 }}>After</span>
              </>
            )}
            {focus && (focus.show || picking) && (
              // Penanda fokus seperti EMULSION: lingkaran 30 px bertepi putih
              // dengan titik tengah, berpindah dengan pegas ke titik ketukan.
              <motion.div
                aria-hidden="true"
                initial={false}
                animate={{ left: sx((cursor ?? focus).x), top: sy((cursor ?? focus).y) }}
                transition={{ type: 'spring', stiffness: 520, damping: 40, mass: 0.6 }}
                style={{
                  position: 'absolute', width: 30, height: 30, marginLeft: -15, marginTop: -15, boxSizing: 'border-box',
                  border: '1.5px solid #fff', borderRadius: '50%', pointerEvents: 'none',
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.35)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.45)' }} />
              </motion.div>
            )}
            {picking && (
              <span className="glass-clear t-footnote" role="status" style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', padding: '4px 12px', borderRadius: 6, fontWeight: 600, whiteSpace: 'nowrap' }}>
                Tap to focus · grey is outside the depth of field
              </span>
            )}
            {peek && !compare && !picking && (
              <span className="glass-clear t-footnote" style={{ position: 'absolute', top: 10, left: 10, padding: '4px 10px', borderRadius: 6, fontWeight: 600 }}>Original</span>
            )}
            <AnimatePresence>
              {slow && (
                <motion.span
                  className="glass-clear t-footnote"
                  role="status"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  style={{ position: 'absolute', right: 10, bottom: 10, height: 30, padding: '0 12px 0 8px', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}
                >
                  <Spinner size={16} /> Developing
                </motion.span>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
      {zoomed && (
        <button
          type="button"
          className="glass-clear t-footnote tabular"
          title="Fit to view (double-click)"
          onClick={() => setView(FIT)}
          style={{ position: 'absolute', top: 10, right: 10, height: 28, padding: '0 10px', borderRadius: 6, border: 0, color: '#fff', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {Math.round(view.s * 100)}% <span className="secondary">· Fit</span>
        </button>
      )}
    </div>
  );
}
