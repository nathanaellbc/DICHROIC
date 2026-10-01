/**
 * Wadah buka foto di area foto editor, kartu "sedang membuka", dan layar bila
 * WebGPU tidak tersedia. Aplikasi langsung membuka editor; selama belum ada
 * foto, area fotonya berisi `DropZone`.
 */
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import type { UiIconName } from '../components/Icon';
import { Spinner } from '../components/Overlays';
import { overlay, pressRelease, pressScale, scrimMotion } from '../motion';
import { useEffect } from 'react';
import { activateModal } from '../modalFocus';
import { useDialogKeys } from '../hooks';

const KINDS: ReadonlyArray<{ icon: UiIconName; title: string; detail: string }> = [
  { icon: 'photo', title: 'Photos', detail: 'JPEG, PNG' },
  { icon: 'hdr', title: 'High dynamic range', detail: 'TIFF (8, 16, 32-bit), OpenEXR' },
  { icon: 'camera', title: 'Camera RAW', detail: 'DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2 and more' },
];

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

  return (
    <div className="empty-photo" style={{ position: 'absolute', inset: 0, padding: 16, boxSizing: 'border-box', display: 'flex' }}>
      <motion.button
        type="button"
        className="photo-dropzone"
        data-drag-over={over}
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
        animate={{ scale: over ? 1.01 : 1 }}
        transition={overlay()}
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto', margin: 0, cursor: 'pointer', font: 'inherit', color: 'inherit', textAlign: 'center',
          borderRadius: 'var(--r-dialog)',
          border: `1.5px dashed ${over ? 'var(--blue)' : 'rgba(255,255,255,0.2)'}`,
          background: over ? 'var(--blue-wash)' : 'rgba(255,255,255,0.02)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 20,
          transition: 'border-color 0.15s, background-color 0.15s',
        }}
      >
        <span aria-hidden="true" style={{ width: 52, height: 52, borderRadius: 'var(--r-list)', background: over ? 'var(--blue-fill)' : 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'background-color 0.15s' }}>
          <Icon name="photo" size={28} strokeWidth={2} color="#fff" />
        </span>
        <span className="dropzone-heading" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="t-title3 dropzone-desktop" style={{ fontWeight: 600 }}>{touch ? 'Tap to Choose a Photo' : over ? 'Drop to Open' : 'Drag and Drop Your Image'}</span>
          <span className="dropzone-mobile dropzone-title">Start with a photo</span>
          <span className="t-subhead secondary dropzone-desktop">Developed through real film and print stocks{touch ? '' : ', or click to browse your files'}</span>
          <span className="dropzone-mobile secondary dropzone-description">Real film. Your own darkroom.</span>
        </span>
        <motion.span className="dropzone-mobile dropzone-cta" whileTap={{ scale: pressScale }} transition={pressRelease}><Icon name="open" size={18} /> Choose Photo</motion.span>
        <span className="dropzone-mobile dropzone-formats secondary">RAW · JPEG · PNG · TIFF · OpenEXR</span>
        <span className="dropzone-desktop" style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch', width: '100%', maxWidth: 340 }}>
          <span className="t-footnote secondary" style={{ fontWeight: 600 }}>Supported files</span>
          {KINDS.map((k) => (
            <span key={k.title} style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left' }}>
              <span aria-hidden="true" style={{ width: 24, height: 24, borderRadius: 'var(--r-control)', background: 'var(--fill)', color: 'var(--label-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon name={k.icon} size={14} />
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span className="t-footnote" style={{ fontWeight: 600 }}>{k.title}</span>
                <span className="t-caption secondary">{k.detail}</span>
              </span>
            </span>
          ))}
        </span>
        <span className="t-caption secondary dropzone-desktop">
          Nothing is uploaded. {enginePaused ? 'Darkroom paused until you choose a photo.' : engineFailed ? 'Darkroom stopped. Choose a photo to retry.' : engineReady ? 'Darkroom ready.' : 'Preparing the darkroom…'}
        </span>
        <span className="dropzone-mobile dropzone-privacy secondary">Photos stay on this device.<span>{engineFailed ? 'Choose a photo to retry.' : !engineReady && !enginePaused ? 'Preparing the darkroom…' : ''}</span></span>
      </motion.button>
    </div>
  );
}

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
