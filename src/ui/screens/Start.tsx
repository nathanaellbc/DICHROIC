/**
 * Wadah buka foto di area foto editor, kartu "sedang membuka", dan layar bila
 * WebGPU tidak tersedia. Aplikasi langsung membuka editor; selama belum ada
 * foto, area fotonya berisi `DropZone`.
 */
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
import { DotField } from '../components/DotField';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/Overlays';
import { overlay, pressRelease, pressScale, scrimMotion } from '../motion';
import { useEffect } from 'react';
import { activateModal } from '../modalFocus';
import { useDialogKeys } from '../hooks';

const FORMATS: ReadonlyArray<{ label: string; detail: string }> = [
  { label: 'RAW', detail: 'DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2 and more' },
  { label: 'JPEG', detail: 'JPEG photos' },
  { label: 'PNG', detail: 'PNG images' },
  { label: 'TIFF', detail: 'TIFF, 8, 16 or 32-bit' },
  { label: 'OpenEXR', detail: 'High dynamic range OpenEXR' },];

/**
 * Area foto kosong di editor (belum ada foto): wadah seret-lepas yang juga
 * membuka pemilih berkas bila diketuk. Lepasnya ditangani pendengar `drop`
 * di jendela (App); di sini hanya sorotan saat berkas diseret di atasnya.
 */
export function DropZone({ onChoose, engineReady, engineFailed, enginePaused }: { onChoose: () => void; engineReady: boolean; engineFailed?: boolean; enginePaused?: boolean }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const touch = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches, []);
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');

  const status: { state: 'ready' | 'busy' | 'idle' | 'failed'; text: string } = engineFailed
    ? { state: 'failed', text: 'Darkroom stopped · choose a photo to retry' }
    : enginePaused
      ? { state: 'idle', text: 'Darkroom resting until you choose a photo' }
      : engineReady
        ? { state: 'ready', text: 'Darkroom ready' }
        : { state: 'busy', text: 'Warming up the darkroom…' };
  const title = touch ? 'Start with a photo' : over ? 'Drop to develop' : 'Drop in a photo';

  return (
    <div className="empty-photo start-stage" data-drag-over={over}>
      <div className="start-rays" aria-hidden="true" />
      <DotField className="start-dots" active={over} />
      <div className="start-dropframe" aria-hidden="true" />
      <motion.button
        type="button"
        className="photo-dropzone start-content"
        data-drag-over={over}
        aria-label={`${title}. Choose Photo`}
        initial="hidden"
        animate="shown"
        variants={{ shown: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } } }}
        onClick={onChoose}
        onDragEnter={(e) => {
          if (!hasFiles(e)) return;
          depth.current += 1;
          setOver(true);
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setOver(false);
        }}
        onDrop={() => {
          depth.current = 0;
          setOver(false);
        }}
      >
        <motion.span className="start-emblem" aria-hidden="true" variants={rise}>
          <span className="start-emblem-core"><Icon name="photo" size={30} strokeWidth={1.8} color="#fff" /></span>
        </motion.span>
        <motion.span className="start-status" data-state={status.state} variants={rise} role="status" aria-live="polite">
          <span className="start-status-dot" aria-hidden="true" />
          {status.text}
        </motion.span>
        <span className="start-heading">
          <span className="start-title" key={title}>
            {title.split(' ').map((word, i, words) => [
              i > 0 ? ' ' : null,
              <motion.span
                key={`${word}-${i}`}
                className={i === words.length - 1 ? 'start-word start-shine' : 'start-word'}
                initial={{ opacity: 0, filter: 'blur(10px)', y: 14 }}
                animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
                transition={{ duration: 0.55, delay: 0.12 + i * 0.08, ease: [0.22, 1, 0.36, 1] }}
              >
                {word}
              </motion.span>,
            ])}
          </span>
          <motion.span className="start-description" variants={rise}>
            Real film, simulated spectrally.{touch ? '' : ' Drag a file here, or click to browse.'}
          </motion.span>
        </span>
        <motion.span className="start-cta-wrap" variants={rise}>
          <span className="start-cta-glow" aria-hidden="true" />
          <motion.span className="dropzone-cta start-cta" whileTap={{ scale: pressScale }} transition={pressRelease}>
            <span className="start-cta-label"><Icon name="open" size={18} /> Choose Photo</span>
          </motion.span>
        </motion.span>
        <motion.span className="start-chips" variants={rise}>
          {FORMATS.map((f) => <span key={f.label} className="start-chip" title={f.detail}>{f.label}</span>)}
        </motion.span>
        <motion.span className="start-privacy" variants={rise}>
          <Icon name="lock" size={13} /> Developed on this device. Nothing is uploaded.
        </motion.span>
      </motion.button>
    </div>
  );
}

const rise = {
  hidden: { opacity: 0, y: 10 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

export function OpeningCard({ opening, onCancel }: { opening?: { name: string; stage: string }; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const open = opening !== undefined;
  useDialogKeys(ref, onCancel, false, open);
  useEffect(() => { if (open && ref.current) return activateModal(ref.current); }, [open]);
  return (
    <AnimatePresence>
      {opening && (
        <>
          <motion.div className="alert-scrim" {...scrimMotion()} aria-hidden="true" />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label="Opening photo"
            aria-live="polite"
            className="alert"
            style={{ x: '-50%', y: '-50%', width: 270, alignItems: 'center', padding: '24px var(--inset-alert) var(--inset-alert)', gap: 14 }}
            initial={{ opacity: 0, scale: 1.1 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
            transition={overlay()}
            onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
          >
            <span style={{ color: 'var(--blue)' }}><Spinner size={36} /></span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span className="t-headline" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 230 }}>Opening {opening.name}</span>
              <span className="t-subhead secondary">{opening.stage}</span>
            </div>
            <button type="button" className="capsule" style={{ width: '100%' }} onClick={onCancel}>Cancel</button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export function UnsupportedScreen() {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, boxSizing: 'border-box', textAlign: 'center' }}>
      <div style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
        <span style={{ color: 'var(--orange)' }}><Icon name="warning" size={40} strokeWidth={1.8} /></span>
        <h1 className="t-title2" style={{ margin: 0 }}>WebGPU Isn’t Available</h1>
        <p className="t-body secondary" style={{ margin: 0 }}>
          DICHROIC develops every photo on your GPU. Open it in Safari on iOS 26 or later, or in a current version of Chrome, Edge or Firefox.
        </p>
      </div>
    </div>
  );
}
