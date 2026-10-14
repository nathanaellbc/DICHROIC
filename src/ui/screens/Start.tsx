/**
 * Wadah buka foto di area foto editor, kartu "sedang membuka", dan layar bila
 * WebGPU tidak tersedia. Aplikasi langsung membuka editor; selama belum ada
 * foto, area fotonya berisi `DropZone`.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChromeWordmark, GlassOrb, StickerBurst } from '../components/WelcomeIntro';
import type { IntroPhase, StageBox } from '../components/WelcomeIntro';
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
  const reduce = !!useReducedMotion();
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<StageBox>({ width: 0, height: 0 });
  // Intro sekali per sesi; Reduce Motion langsung ke isi.
  const [phase, setPhase] = useState<IntroPhase>(() => (reduce || storage('session')?.getItem(WELCOMED_KEY) ? 'ready' : 'splash'));
  const timers = useRef<number[]>([]);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return undefined;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const enter = useCallback(() => {
    setPhase((current) => {
      if (current !== 'splash') return current;
      storage('session')?.setItem(WELCOMED_KEY, '1');
      // Halo menyapu kubah, kubah naik jadi gelembung, gelembung jadi "+".
      timers.current.push(window.setTimeout(() => setPhase('bubble'), 420));
      timers.current.push(window.setTimeout(() => setPhase('ready'), 1150));
      return 'lift';
    });
  }, []);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  // Masuk: geser ke atas, gulir, tombol panah/Enter/spasi, atau otomatis.
  useEffect(() => {
    if (phase !== 'splash') return undefined;
    const el = stage.current;
    let startY: number | undefined;
    const down = (e: PointerEvent) => { startY = e.clientY; };
    const up = (e: PointerEvent) => { if (startY !== undefined && startY - e.clientY > 36) enter(); startY = undefined; };
    const wheel = (e: WheelEvent) => { if (e.deltaY > 12) enter(); };
    const key = (e: KeyboardEvent) => { if (['ArrowUp', 'ArrowDown', 'PageDown', 'Enter', ' '].includes(e.key)) enter(); };
    const auto = window.setTimeout(enter, 4200);
    el?.addEventListener('pointerdown', down);
    el?.addEventListener('pointerup', up);
    el?.addEventListener('wheel', wheel, { passive: true });
    window.addEventListener('keydown', key);
    return () => {
      window.clearTimeout(auto);
      el?.removeEventListener('pointerdown', down);
      el?.removeEventListener('pointerup', up);
      el?.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', key);
    };
  }, [phase, enter]);

  // Berkas bisa dijatuhkan di mana saja di jendela (pendengar `drop` di App);
  // sorotan menyala selama berkas diseret di atas jendela mana pun.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enterDrag = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setOver(true);
      setPhase('ready');
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const reset = () => {
      depth = 0;
      setOver(false);
    };
    window.addEventListener('dragenter', enterDrag);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', reset);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragenter', enterDrag);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', reset);
      window.removeEventListener('dragend', reset);
    };
  }, []);

  // Baris terakhir judul berganti pelan (seperti referensi).
  const [line, setLine] = useState(0);
  useEffect(() => {
    if (phase !== 'ready' || reduce || over) return undefined;
    const id = window.setInterval(() => setLine((n) => (n + 1) % TAIL_LINES.length), 3200);
    return () => window.clearInterval(id);
  }, [phase, reduce, over]);

  // Status darkroom hanya sebagai teks kecil; tanpa titik berdenyut.
  const status = engineFailed ? 'Darkroom stopped. Choose a photo to retry.'
    : enginePaused ? 'Darkroom resting until you choose a photo.'
      : engineReady ? null : 'Preparing the darkroom…';
  const ready = phase === 'ready';
  // Narrow or short stages: fewer, smaller stickers.
  const compact = box.width < 560 || box.height < 600;
  const orbCenter = { x: box.width / 2, y: box.height * 0.42 };

  return (
    <div ref={stage} className="empty-photo start-stage intro-stage" data-drag-over={over} data-phase={phase}>
      <div className="intro-sky" aria-hidden="true" />
      <div className="start-dropframe" aria-hidden="true" />
      <ChromeWordmark visible={phase === 'splash' || phase === 'lift'} />
      <StickerBurst show={ready && !over} origin={orbCenter} box={box} compact={compact} reduce={reduce} />
      {box.width > 0 && <GlassOrb phase={phase} box={box} onEnter={enter} onChoose={onChoose} reduce={reduce} />}

      <AnimatePresence>
        {phase === 'splash' && (
          <motion.span
            key="swipe"
            className="intro-swipe"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            transition={{ duration: 0.6, delay: 0.7 }}
          >
            {touch ? 'Swipe up to enter' : 'Scroll or click to enter'}
          </motion.span>
        )}
      </AnimatePresence>

      {ready && (
        <motion.div
          className="photo-dropzone intro-content"
          style={{ paddingTop: orbCenter.y + (compact ? 48 : 56) }}
          data-drag-over={over}
          initial="hidden"
          animate="shown"
          variants={{ shown: { transition: { staggerChildren: 0.09, delayChildren: reduce ? 0 : 0.1 } } }}
        >
          {over ? (
            <h1 className="start-title intro-title" key="drop">
              <BlurWords text="Drop to develop." />
              <span className="start-title-tail"><BlurWords text="Let go anywhere." delay={0.12} /></span>
            </h1>
          ) : (
            <h1 className="start-title intro-title" key="title" aria-label={`Develop your photo ${TAIL_LINES[line]}`}>
              <span aria-hidden="true">
                <BlurWords text="Develop your" /> <s className="intro-strike">filter</s> <BlurWords text="photo" delay={0.2} />
              </span>
              <span className="start-title-tail" aria-hidden="true"><BlurWords key={line} text={TAIL_LINES[line]!} delay={line === 0 ? 0.3 : 0} /></span>
            </h1>
          )}
          <motion.div className="start-actions intro-actions" variants={rise}>
            <motion.button type="button" className="start-cta intro-cta" onClick={onChoose} whileTap={{ scale: pressScale }} transition={pressRelease}>
              Choose Photo
            </motion.button>
            <p className="start-footnote intro-footnote">
              {touch ? 'RAW, JPEG, PNG, TIFF and OpenEXR.' : 'Or drop a file anywhere. RAW, JPEG, PNG, TIFF and OpenEXR.'} Nothing is uploaded.
              {status && <span className="start-status" role="status" aria-live="polite">{status}</span>}
            </p>
          </motion.div>
        </motion.div>
      )}
    </div>
  );
}

const WELCOMED_KEY = 'dichroic.welcomed';
/** Baris kedua judul: film sungguhan, bukan filter. */
const TAIL_LINES = ['on real film.', 'on Kodak Portra 400.', 'printed on Kodak 2383.', 'right on this device.'];

function storage(kind: 'session'): Storage | undefined {
  try { return kind === 'session' ? window.sessionStorage : undefined; } catch { return undefined; }
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
