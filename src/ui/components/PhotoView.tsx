/**
 * Foto: frame hasil render, dipaskan (contain) ke area yang tersedia.
 * Pembanding: garis pembagi yang bisa diseret memperlihatkan aslinya di kiri;
 * tanpa mode pembanding, tekan-tahan foto memperlihatkan aslinya (seperti
 * Photos). Frame baru langsung digambar tanpa animasi -- DESIGN.md: jangan
 * menambah gerak pada interaksi yang sering.
 *
 * Keyboard: garis pembagi adalah slider (panah), dan mode pilih fokus
 * memindah bidik dengan panah lalu Enter memilih, Escape batal.
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
  const holdTimer = useRef(0);
  const splitDrag = useRef(false);

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

  const setSplitFrom = (clientX: number) => {
    const box = areaRef.current?.getBoundingClientRect();
    if (!box || rect.width === 0) return;
    setSplit(Math.min(1, Math.max(0, (clientX - box.left - rect.left) / rect.width)));
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

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (picking && focus) {
      const box = areaRef.current?.getBoundingClientRect();
      if (!box || rect.width === 0 || rect.height === 0) return;
      const x = (e.clientX - box.left - rect.left) / rect.width;
      const y = (e.clientY - box.top - rect.top) / rect.height;
      // Ketukan di luar foto (di bingkai hitam) tidak memilih apa pun.
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      focus.onPick(Number(x.toFixed(4)), Number(y.toFixed(4)));
      return;
    }
    if (compare) {
      splitDrag.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setSplitFrom(e.clientX);
      return;
    }
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => setPeek(true), 220);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (splitDrag.current) setSplitFrom(e.clientX);
  };
  const onPointerEnd = () => {
    splitDrag.current = false;
    window.clearTimeout(holdTimer.current);
    setPeek(false);
  };

  const showOriginal = !!original && !picking && (compare || peek);
  const clip = compare ? `inset(0 ${(1 - split) * 100}% 0 0)` : 'inset(0 0 0 0)';

  return (
    <div
      ref={areaRef}
      tabIndex={picking ? 0 : -1}
      role={picking ? 'application' : undefined}
      aria-label={picking ? 'Focus point. Arrow keys move it, Enter picks the subject, Escape cancels.' : undefined}
      onKeyDown={onKeyDown}
      style={{ position: 'absolute', inset: 0, outline: 'none', touchAction: compare || picking ? 'none' : 'manipulation', cursor: picking ? 'crosshair' : undefined, WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onPointerLeave={onPointerEnd}
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
            {compare && (
              <>
                <div aria-hidden="true" style={{ position: 'absolute', top: 0, bottom: 0, left: `${split * 100}%`, width: 2, marginLeft: -1, background: 'rgba(255,255,255,0.92)' }} />
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
                  style={{ position: 'absolute', top: '50%', left: `${split * 100}%`, width: 36, height: 36, marginLeft: -18, marginTop: -18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name="compare" size={18} />
                </div>
                <span className="glass-clear t-footnote" style={{ position: 'absolute', top: 10, right: `calc(${(1 - split) * 100}% + 8px)`, padding: '4px 10px', borderRadius: 6, fontWeight: 600, opacity: split > 0.12 ? 1 : 0 }}>Before</span>
                <span className="glass-clear t-footnote" style={{ position: 'absolute', top: 10, left: `calc(${split * 100}% + 8px)`, padding: '4px 10px', borderRadius: 6, fontWeight: 600, opacity: split < 0.88 ? 1 : 0 }}>After</span>
              </>
            )}
            {focus && (focus.show || picking) && (
              // Penanda fokus seperti EMULSION: lingkaran 30 px bertepi putih
              // dengan titik tengah, berpindah dengan pegas ke titik ketukan.
              <motion.div
                aria-hidden="true"
                initial={false}
                animate={{ left: `${(cursor ?? focus).x * 100}%`, top: `${(cursor ?? focus).y * 100}%` }}
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
    </div>
  );
}
