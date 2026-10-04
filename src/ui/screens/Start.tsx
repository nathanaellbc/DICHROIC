/**
 * Wadah buka foto di area foto editor, kartu "sedang membuka", dan layar bila
 * WebGPU tidak tersedia. Aplikasi langsung membuka editor; selama belum ada
 * foto, area fotonya berisi `DropZone`.
 */
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/Overlays';
import { overlay, pressRelease, pressScale, scrimMotion } from '../motion';
import { useEffect } from 'react';
import { activateModal } from '../modalFocus';
import { useDialogKeys } from '../hooks';

/**
 * Area foto kosong di editor (belum ada foto): wadah seret-lepas yang juga
 * membuka pemilih berkas bila diketuk. Lepasnya ditangani pendengar `drop`
 * di jendela (App); di sini hanya sorotan saat berkas diseret di atasnya.
 */
export function DropZone({ onChoose, engineReady, engineFailed, enginePaused }: { onChoose: () => void; engineReady: boolean; engineFailed?: boolean; enginePaused?: boolean }) {
  const [over, setOver] = useState(false);
  const touch = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches, []);

  // Berkas bisa dijatuhkan di mana saja di jendela (pendengar `drop` di App);
  // sorotan menyala selama berkas diseret di atas jendela mana pun.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setOver(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const reset = () => {
      depth = 0;
      setOver(false);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', reset);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', reset);
      window.removeEventListener('dragend', reset);
    };
  }, []);

  // Status darkroom hanya sebagai teks kecil; tanpa titik berdenyut.
  const status = engineFailed ? 'Darkroom stopped. Choose a photo to retry.'
    : enginePaused ? 'Darkroom resting until you choose a photo.'
      : engineReady ? null : 'Preparing the darkroom…';
  const [lead, tail] = over ? ['Drop to develop.', 'Let go anywhere.'] : ['Develop your photo', 'on real film.'];

  return (
    <div className="empty-photo start-stage" data-drag-over={over}>
      {/* Satu cahaya biru samar yang "bernapas" pelan; satu-satunya hiasan. */}
      <div className="start-glow" aria-hidden="true" />
      <div className="start-dropframe" aria-hidden="true" />
      <motion.div
        className="photo-dropzone start-content"
        data-drag-over={over}
        initial="hidden"
        animate="shown"
        variants={{ shown: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } } }}
      >
        {/* Judul dua nada ala apple.com: baris pertama putih, kedua abu-abu. */}
        <h1 className="start-title" key={lead}>
          <BlurWords text={lead} />
          <span className="start-title-tail"><BlurWords text={tail} delay={0.18} /></span>
        </h1>
        <motion.p className="start-description" variants={rise}>
          Spectral simulation of real film and print stocks, right on this device.
        </motion.p>
        <motion.div className="start-actions" variants={rise}>
          <motion.button type="button" className="start-cta" onClick={onChoose} whileTap={{ scale: pressScale }} transition={pressRelease}>
            Choose Photo
          </motion.button>
          {!touch && <span className="start-hint">or drop a file anywhere</span>}
        </motion.div>
        <motion.p className="start-footnote" variants={rise}>
          RAW, JPEG, PNG, TIFF and OpenEXR. Nothing is uploaded.
          {status && <span className="start-status" role="status" aria-live="polite">{status}</span>}
        </motion.p>
      </motion.div>
    </div>
  );
}

/** Kata per kata muncul dari blur halus (Blur Text React Bits, versi singkat). */
function BlurWords({ text, delay = 0 }: { text: string; delay?: number }) {
  return (
    <>
      {text.split(' ').map((word, i) => [
        i > 0 ? ' ' : null,
        <motion.span
          key={`${word}-${i}`}
          className="start-word"
          initial={{ opacity: 0, filter: 'blur(8px)', y: 8 }}
          animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
          transition={{ duration: 0.7, delay: delay + i * 0.06, ease: [0.22, 1, 0.36, 1] }}
        >
          {word}
        </motion.span>,
      ])}
    </>
  );
}

const rise = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
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
