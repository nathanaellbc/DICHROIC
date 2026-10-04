/**
 * Foto layar penuh: ketuk foto di editor, foto tumbuh mulus dari posisinya
 * ke layar penuh (transisi elemen bersama), lalu kembali ke tempatnya saat
 * ditutup. Tutup lewat ketukan, Escape, tombol X, atau usap ke bawah (latar
 * memudar mengikuti jari, seperti Photos di iOS).
 */
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import type { PanInfo } from 'motion/react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { activateModal } from '../modalFocus';
import { Icon } from './Icon';
import { Spinner } from './Overlays';

export interface Box { left: number; top: number; width: number; height: number }

const openSpring = { type: 'spring' as const, duration: 0.5, bounce: 0.14 };
const closeSpring = { type: 'spring' as const, duration: 0.38, bounce: 0 };
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 600;

/** Kotak `aspect` terbesar yang muat di viewport, di tengah. */
function fitBox(width: number, height: number): Box {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scale = Math.min(vw / width, vh / height);
  const w = width * scale;
  const h = height * scale;
  return { left: (vw - w) / 2, top: (vh - h) / 2, width: w, height: h };
}

export function PhotoLightbox({ open, aspect, label, source, busy = false, onClose, children }: {
  open: boolean;
  /** Ukuran piksel foto (hanya rasionya yang dipakai). */
  aspect: { width: number; height: number };
  label: string;
  /** Posisi foto di editor saat ini (layar), tujuan animasi buka/tutup. */
  source: () => Box | null;
  /** Render lebih tajam sedang berjalan. */
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return createPortal(
    <AnimatePresence>
      {open && <Lightbox key="lightbox" aspect={aspect} label={label} source={source} busy={busy} onClose={onClose}>{children}</Lightbox>}
    </AnimatePresence>,
    document.body,
  );
}

function Lightbox({ aspect, label, source, busy, onClose, children }: Omit<Parameters<typeof PhotoLightbox>[0], 'open'>) {
  const ref = useRef<HTMLDivElement>(null);
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
  const dragY = useMotionValue(0);
  const backdrop = useMotionValue(0);
  const dragFade = useTransform(dragY, [0, 360], [1, 0.15]);
  const dim = useTransform(() => backdrop.get() * dragFade.get());
  const closing = useRef(false);

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

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    const to = fromSource();
    const t = reduced ? { duration: 0 } : closeSpring;
    // Usap ke bawah: lanjut dari posisi jari, bukan melompat balik dulu.
    const offset = dragY.get();
    dragY.stop();
    dragY.set(0);
    y.set(y.get() + offset);
    Promise.all([
      animate(x, to.x, t), animate(y, to.y, t), animate(scale, to.scale, t),
      animate(backdrop, 0, reduced ? { duration: 0 } : { duration: 0.26, ease: [0.4, 0, 0.2, 1] }),
    ]).then(onClose);
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    // Di bawah ambang, batasan drag sendiri memegaskan foto kembali ke tengah.
    if (info.offset.y > DISMISS_DISTANCE || info.velocity.y > DISMISS_VELOCITY) close();
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={`${label}, full screen`}
      className="lightbox"
      // Portal tetap meneruskan event React ke PhotoView (leluhurnya di pohon
      // React); tanpa ini PhotoView menangkap pointer dan ketukan tutup hilang.
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); } }}
    >
      <motion.div className="lightbox-backdrop" style={{ opacity: dim }} aria-hidden="true" />
      <motion.div
        className="lightbox-drag"
        style={{ y: dragY }}
        drag={reduced ? false : 'y'}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.08, bottom: 0.9 }}
        dragMomentum={false}
        onDragEnd={onDragEnd}
        onTap={close}
      >
        <motion.div
          role="img"
          aria-label={label}
          className="lightbox-photo"
          style={{ left: target.left, top: target.top, width: target.width, height: target.height, x, y, scale, opacity: start.opacity === 0 ? backdrop : 1 }}
        >
          {children}
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
