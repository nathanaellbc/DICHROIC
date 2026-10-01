/**
 * Sheet iOS (DESIGN.md: Sheets). Di layar compact: muncul dari bawah, punya
 * grabber, berhenti di detent (`medium` ≈ setengah layar, `large` ≈ tinggi
 * penuh), bisa diseret untuk berpindah detent atau ditutup. Di layar lebar:
 * kartu di tengah di atas latar yang diredupkan (sheet macOS/iPadOS).
 *
 * Seret hanya dari grabber dan bar judul, supaya konten di dalamnya tetap
 * bisa digulir. Escape menutup dari mana saja dan Tab tidak keluar dari
 * sheet; fokus dipindah ke sheet saat dibuka dan dikembalikan saat ditutup.
 */
import { AnimatePresence, animate, motion, useDragControls, useMotionValue, usePresence, useTransform } from 'motion/react';
import type { MotionValue, PanInfo } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useDialogKeys } from '../hooks';
import { scrimBlurFor, scrimMotion, sheetSpring } from '../motion';
import { activateModal } from '../modalFocus';

export type Detent = 'medium' | 'large';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  detents?: readonly Detent[];
  /** Tinggi `medium` sebagai pecahan tinggi layar. */
  mediumFraction?: number;
  /** Redupkan latar pada detent medium (bawaan: hanya di large). */
  dimAtMedium?: boolean;
  centered?: boolean;
  /** Backdrop blur multiplier; dimming remains independent. */
  blurIntensity?: number;
}

function useViewportHeight(): number {
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setH(window.visualViewport?.height ?? window.innerHeight);
    onResize();
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, []);
  return h;
}

/** `env(safe-area-inset-top)` dalam px (variabel CSS env() tidak bisa dibaca langsung). */
function safeAreaTop(): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;top:0;height:0;padding-top:env(safe-area-inset-top);visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const value = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return value;
}

export function Sheet(props: SheetProps) {
  return <AnimatePresence>{props.open && (props.centered ? <CenteredSheet {...props} /> : <BottomSheet {...props} />)}</AnimatePresence>;
}

function useFocusReturn(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (ref.current) return activateModal(ref.current);
  }, [ref]);
}

function SheetBar({ title, leading, trailing, titleId }: { title: string; leading?: ReactNode; trailing?: ReactNode; titleId: string }) {
  return (
    <div className="sheet-bar">
      <div>{leading}</div>
      <h2 id={titleId} className="sheet-title t-headline">{title}</h2>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>{trailing}</div>
    </div>
  );
}

function BottomSheet({ onClose, title, leading, trailing, children, detents = ['large'], mediumFraction = 0.55, dimAtMedium = false, blurIntensity = 1 }: SheetProps) {
  const vh = useViewportHeight();
  const ref = useRef<HTMLDivElement>(null);
  const controls = useDragControls();
  const titleId = `sheet-${title.replace(/\W+/g, '-').toLowerCase()}`;

  const [safeTop] = useState(safeAreaTop);
  const fullHeight = Math.max(320, vh - Math.max(safeTop, 20) - 10);
  const offsets: Record<Detent, number> = { large: 0, medium: Math.max(0, fullHeight - vh * mediumFraction) };
  const initial: Detent = detents[0]!;
  const [detent, setDetent] = useState<Detent>(initial);

  const y = useMotionValue(fullHeight);
  // Keep the content's bottom at the viewport edge throughout the drag,
  // rather than retaining the previous detent's empty reserved space.
  const bottomInset = useTransform(y, (value) => Math.max(0, Math.min(fullHeight, value)));
  const dim = useTransform(y, [offsets.medium, 0], dimAtMedium || !detents.includes('medium') ? [1, 1] : [0.35, 1]);


  useLayoutEffect(() => {
    const controlsAnim = animate(y, offsets[detent], sheetSpring);
    return () => controlsAnim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- menganimasikan saat detent/tinggi berubah
  }, [detent, fullHeight, offsets.medium]);

  useFocusReturn(ref);
  useDialogKeys(ref, onClose, false);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const projected = y.get() + info.velocity.y * 0.2;
    const candidates = detents.map((d) => ({ d, off: offsets[d] }));
    const lowest = Math.max(...candidates.map((c) => c.off));
    if (projected > lowest + (fullHeight - lowest) * 0.35 || info.velocity.y > 1100) {
      onClose();
      return;
    }
    const nearest = candidates.reduce((a, b) => (Math.abs(b.off - projected) < Math.abs(a.off - projected) ? b : a));
    if (nearest.d === detent) animate(y, nearest.off, sheetSpring);
    else setDetent(nearest.d);
  };

  const cycleDetent = () => {
    if (detents.length < 2) return;
    setDetent(detents[(detents.indexOf(detent) + 1) % detents.length]!);
  };

  return (
    <>
      <SheetBackdrop dim={dim} onClose={onClose} blurIntensity={blurIntensity} />
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="sheet"
        style={{ y, height: fullHeight, paddingBottom: bottomInset, outline: 'none' }}
        exit={{ y: fullHeight, transition: sheetSpring }}
        drag="y"
        dragControls={controls}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: fullHeight }}
        dragElastic={{ top: 0.08, bottom: 0.6 }}
        dragMomentum={false}
        onDragEnd={onDragEnd}
      >
        <div onPointerDown={(e) => controls.start(e)} style={{ touchAction: 'none', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          <button type="button" className="sheet-grabber-hit" aria-label={detents.length > 1 ? 'Resize sheet' : 'Sheet handle'} onClick={cycleDetent}>
            <span className="sheet-grabber" />
          </button>
          <SheetBar title={title} leading={leading} trailing={trailing} titleId={titleId} />
        </div>
        <div className="sheet-content" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {children}
        </div>
      </motion.div>
    </>
  );
}

/**
 * Latar sheet HP: redup DAN blur naik bertahap bersama kemunculan, dan
 * mengikuti seretan (`dim`). Kemunculan/kepergian satu nilai (`appear`)
 * lewat usePresence: elemen dilepas eksplisit setelah animasi keluar selesai
 * (animasi exit pada opacity turunan tidak pernah selesai, sheet tertinggal).
 */
function SheetBackdrop({ dim, onClose, blurIntensity }: { dim: MotionValue<number>; onClose: () => void; blurIntensity: number }) {
  const [isPresent, safeToRemove] = usePresence();
  const appear = useMotionValue(0);
  useEffect(() => {
    const controls = isPresent
      ? animate(appear, 1, { duration: 0.32, ease: [0.23, 1, 0.32, 1] })
      : animate(appear, 0, { duration: 0.22, ease: [0.4, 0, 0.2, 1] });
    if (!isPresent) void controls.then(() => safeToRemove?.());
    return () => controls.stop();
  }, [isPresent, appear, safeToRemove]);
  const level = useTransform([dim, appear], ([d, a]: number[]) => d! * a!);
  const blur = useTransform(level, (v) => scrimBlurFor(v * blurIntensity).backdropFilter ?? 'none');
  return <motion.div className="backdrop" style={{ opacity: level, backdropFilter: blur, WebkitBackdropFilter: blur }} onClick={onClose} aria-hidden="true" />;
}

function CenteredSheet({ onClose, title, leading, trailing, children, blurIntensity = 1 }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = `sheet-${title.replace(/\W+/g, '-').toLowerCase()}`;
  useFocusReturn(ref);
  useDialogKeys(ref, onClose, false);
  return (
    <>
      <motion.div className="backdrop" {...scrimMotion(blurIntensity)} onClick={onClose} aria-hidden="true" />
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="sheet centered"
        style={{ x: '-50%', y: '-50%', maxHeight: 'min(760px, calc(100dvh - 48px))', outline: 'none' }}
        // Dialog macOS: muncul cepat dan tenang, tanpa pantulan.
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.99, transition: { duration: 0.12, ease: 'easeIn' } }}
        transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
      >
        <div>
          <SheetBar title={title} leading={leading} trailing={trailing} titleId={titleId} />
        </div>
        <div className="sheet-content" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {children}
        </div>
      </motion.div>
    </>
  );
}
