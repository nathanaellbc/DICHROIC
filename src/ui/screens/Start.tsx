/**
 * Layar awal (buka foto), kartu "sedang membuka", dan layar bila WebGPU tidak
 * tersedia. Tombol utama di bawah, dalam jangkauan jempol (DESIGN.md: iOS).
 */
import { AnimatePresence, motion } from 'motion/react';
import { Icon } from '../components/Icon';
import type { UiIconName } from '../components/Icon';
import { PressButton } from '../components/controls';
import { Spinner } from '../components/Overlays';
import { popSpring } from '../motion';
import { useEffect, useRef } from 'react';
import { activateModal } from '../modalFocus';

const KINDS: ReadonlyArray<{ icon: UiIconName; color: string; title: string; detail: string }> = [
  { icon: 'photo', color: '#0091ff', title: 'Photos', detail: 'JPEG, PNG' },
  { icon: 'hdr', color: '#6d7cff', title: 'High dynamic range', detail: 'TIFF (8, 16, 32-bit), OpenEXR' },
  { icon: 'camera', color: '#ff9230', title: 'Camera RAW', detail: 'DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2 and more' },
];

export function StartScreen({ onChoose, wide, engineReady, engineFailed, enginePaused }: { onChoose: () => void; wide: boolean; engineReady: boolean; engineFailed?: boolean; enginePaused?: boolean }) {
  return (
    <div
      style={{
        position: 'absolute', inset: 0, overflowY: 'auto', display: 'flex', justifyContent: 'center',
        padding: `calc(var(--safe-top) + ${wide ? 64 : 44}px) calc(var(--safe-right) + 16px) calc(var(--safe-bottom) + 16px) calc(var(--safe-left) + 16px)`,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ width: '100%', maxWidth: 560, minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '0 4px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="t-footnote secondary" style={{ letterSpacing: '0.16em', fontWeight: 600 }}>DICHROIC</span>
          <h1 className="t-large-title" style={{ margin: 0 }}>Open a Photo</h1>
          <p className="t-body secondary" style={{ margin: 0 }}>Develop it through real film and print stocks, simulated spectrally.</p>
        </div>

        <section className="list-section" style={{ marginTop: 24 }}>
          <h2 className="list-header">Supported files</h2>
          <div className="list on-bg">
            {KINDS.map((k) => (
              <div key={k.title} className="row-static" style={{ minHeight: 60 }}>
                <span aria-hidden="true" style={{ alignSelf: 'center', width: 32, height: 32, borderRadius: 9, background: k.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginRight: 14 }}>
                  <Icon name={k.icon} size={18} color="#fff" />
                </span>
                <span className="row-body">
                  <span className="row-text">
                    <span className="t-body">{k.title}</span>
                    <span className="t-subhead secondary">{k.detail}</span>
                  </span>
                </span>
              </div>
            ))}
          </div>
          <p className="list-footer t-footnote">Photos are decoded and developed on this device. Nothing is uploaded.{wide ? ' You can also drop a file anywhere in this window.' : ''}</p>
        </section>

        <div style={{ flexGrow: 1, minHeight: 32 }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <PressButton className="capsule prominent large" onClick={onChoose}>
            <Icon name="photo" size={20} strokeWidth={2.2} /> Choose Photo
          </PressButton>
          <p className="t-footnote secondary" style={{ margin: 0, textAlign: 'center' }}>
            {enginePaused ? 'Darkroom paused until you choose a photo.' : engineFailed ? 'Darkroom stopped. Choose a photo to retry.' : engineReady ? 'Darkroom ready.' : 'Preparing the darkroom…'} Requires WebGPU.
          </p>
        </div>
      </div>
    </div>
  );
}

export function OpeningCard({ opening, onCancel }: { opening?: { name: string; stage: string }; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const open = opening !== undefined;
  useEffect(() => { if (open && ref.current) return activateModal(ref.current); }, [open]);
  return (
    <AnimatePresence>
      {opening && (
        <>
          <motion.div className="alert-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden="true" />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-label="Opening photo"
            aria-live="polite"
            className="alert"
            style={{ x: '-50%', y: '-50%', width: 270, alignItems: 'center', padding: '24px 20px 20px', gap: 14 }}
            initial={{ opacity: 0, scale: 1.1 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
            transition={popSpring}
            onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
          >
            <span style={{ color: '#0091ff' }}><Spinner size={44} /></span>
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
        <span style={{ color: '#ff9230' }}><Icon name="warning" size={44} strokeWidth={1.8} /></span>
        <h1 className="t-title2" style={{ margin: 0 }}>WebGPU Isn’t Available</h1>
        <p className="t-body secondary" style={{ margin: 0 }}>
          DICHROIC develops every photo on your GPU. Open it in Safari on iOS 26 or later, or in a current version of Chrome, Edge or Firefox.
        </p>
      </div>
    </div>
  );
}
