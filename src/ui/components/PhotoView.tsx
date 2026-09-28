/**
 * Foto: frame hasil render, dipaskan (contain) ke area yang tersedia.
 * Pembanding: garis pembagi yang bisa diseret memperlihatkan aslinya di kiri;
 * tanpa mode pembanding, tekan-tahan foto memperlihatkan aslinya (seperti
 * Photos). Frame baru langsung digambar tanpa animasi -- DESIGN.md: jangan
 * menambah gerak pada interaksi yang sering.
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

export function PhotoView({
  frame,
  original,
  compare,
  rendering,
  photoKey,
  label,
}: {
  frame?: Frame;
  original?: Frame;
  compare: boolean;
  rendering: boolean;
  /** Berganti per berkas: foto baru muncul dengan pudar singkat. */
  photoKey: string;
  label: string;
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [split, setSplit] = useState(0.5);
  const [peek, setPeek] = useState(false);
  const [slow, setSlow] = useState(false);
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

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
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

  const showOriginal = !!original && (compare || peek);
  const clip = compare ? `inset(0 ${(1 - split) * 100}% 0 0)` : 'inset(0 0 0 0)';

  return (
    <div
      ref={areaRef}
      style={{ position: 'absolute', inset: 0, touchAction: compare ? 'none' : 'manipulation', WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none' }}
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
                <div aria-hidden="true" className="glass-clear" style={{ position: 'absolute', top: '50%', left: `${split * 100}%`, width: 36, height: 36, marginLeft: -18, marginTop: -18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="compare" size={18} />
                </div>
                <span className="glass-clear t-footnote" style={{ position: 'absolute', top: 10, right: `calc(${(1 - split) * 100}% + 8px)`, padding: '4px 10px', borderRadius: 9999, fontWeight: 600, opacity: split > 0.12 ? 1 : 0 }}>Before</span>
                <span className="glass-clear t-footnote" style={{ position: 'absolute', top: 10, left: `calc(${split * 100}% + 8px)`, padding: '4px 10px', borderRadius: 9999, fontWeight: 600, opacity: split < 0.88 ? 1 : 0 }}>After</span>
              </>
            )}
            {peek && !compare && (
              <span className="glass-clear t-footnote" style={{ position: 'absolute', top: 10, left: 10, padding: '4px 10px', borderRadius: 9999, fontWeight: 600 }}>Original</span>
            )}
            <AnimatePresence>
              {slow && (
                <motion.span
                  className="glass-clear"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  style={{ position: 'absolute', right: 10, bottom: 10, width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  aria-label="Developing"
                >
                  <Spinner size={18} />
                </motion.span>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
