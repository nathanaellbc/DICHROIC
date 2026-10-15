/**
 * Intro layar mulai (referensi: onboarding "kaca cair" ala Wabi), dalam tema
 * gammā: wordmark teks SF Pro, kubah kaca dikroik di tepi bawah
 * ("Swipe up to continue" di dalam kubah), lalu kubah naik menyusut jadi gelembung lalu tombol
 * "+" (buka foto); stiker film ada di StickerField.
 *
 * Satu elemen kaca berubah bentuk lewat transform (scale/translate) -- tidak
 * ada animasi lebar/tinggi, jadi tetap 60 fps.
 */
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from 'motion/react';
import { useRef } from 'react';
import type { RefObject } from 'react';
import { Icon } from './Icon';
import GlassSurface from './reactbits/GlassSurface';

export type IntroPhase = 'splash' | 'lift' | 'bubble' | 'ready';

/** Ukuran dasar elemen kaca (px); bentuk akhir didapat dari `scale`. */
const ORB = 720;
const EASE: [number, number, number, number] = [0.23, 1, 0.32, 1];

export interface StageBox { width: number; height: number }

/** Pusat dan diameter kaca per fase, relatif terhadap panggung. */
function orbGeometry(phase: IntroPhase, box: StageBox) {
  const { width: w, height: h } = box;
  if (phase === 'splash' || phase === 'lift') {
    // Kubah: lingkaran besar yang hanya puncaknya terlihat di tepi bawah.
    const d = Math.max(w * 1.35, 620);
    const visible = Math.min(h * 0.3, 280) + (phase === 'lift' ? 36 : 0);
    return { cx: w / 2, cy: h - visible + d / 2, d };
  }
  const cy = h * 0.42;
  return phase === 'bubble' ? { cx: w / 2, cy, d: Math.min(176, w * 0.42) } : { cx: w / 2, cy, d: 64 };
}

export function GlassOrb({ phase, box, onEnter, onChoose, reduce, hint, backdrop }: {
  phase: IntroPhase; box: StageBox; onEnter: () => void; onChoose: () => void; reduce: boolean; hint: string;
  /** Kanvas latar (IntroBackdrop) yang dibiaskan kaca. */
  backdrop: RefObject<HTMLCanvasElement | null>;
}) {
  const { cx, cy, d } = orbGeometry(phase, box);
  // Petunjuk di dalam kubah: di tengah bagian kubah yang terlihat.
  const hintTop = (Math.min(box.height * 0.3, 280) * 0.4 * ORB) / d;
  const s = d / ORB;
  const ready = phase === 'ready';
  const dome = phase === 'splash' || phase === 'lift';
  const spring = reduce ? { duration: 0 } : phase === 'bubble'
    ? { type: 'spring' as const, duration: 0.85, bounce: 0.18 }
    : phase === 'ready' ? { type: 'spring' as const, duration: 0.55, bounce: 0.3 } : { duration: 0.5, ease: EASE };

  // Benda lunak: geser mengikuti jari (karet), regang searah kecepatan,
  // bergoyang saat dilepas. Semua dalam px layar; dibagi `s` di transform.
  const dxRaw = useMotionValue(0), dyRaw = useMotionValue(0), stretchRaw = useMotionValue(0);
  const dx = useSpring(dxRaw, { stiffness: 320, damping: 13, mass: 0.8 });
  const dy = useSpring(dyRaw, { stiffness: 320, damping: 13, mass: 0.8 });
  const stretch = useSpring(stretchRaw, { stiffness: 340, damping: 8, mass: 0.6 });
  const angle = useMotionValue(0);
  const transform = useTransform([dx, dy, stretch, angle], ([x, y, k, a]: number[]) => {
    const sx = 1 + k!, sy = 1 / Math.max(0.5, 1 + k!);
    return `translate(${x! / s}px, ${y! / s}px) rotate(${a}rad) scale(${sx}, ${sy}) rotate(${-a!}rad)`;
  });
  const press = useRef<{ x: number; y: number; t: number; lx: number; ly: number; lt: number; moved: number; id: number } | undefined>(undefined);
  /** Gesekan karet: makin jauh makin berat (seperti tarikan berlebih iOS). */
  const band = (v: number, r: number) => Math.sign(v) * r * (1 - 1 / (Math.abs(v) / r + 1));

  const onDown = (e: React.PointerEvent) => {
    if (reduce || phase === 'bubble' || phase === 'lift') return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or ended pointer */ }
    const now = performance.now();
    press.current = { x: e.clientX, y: e.clientY, t: now, lx: e.clientX, ly: e.clientY, lt: now, moved: 0, id: e.pointerId };
    // Tekan = remas sedikit.
    angle.set(Math.PI / 2);
    stretchRaw.set(-0.12);
  };
  const onMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) {
      // Kursor mendekat: kaca condong ke arahnya.
      if (reduce || e.pointerType !== 'mouse' || phase !== 'ready') return;
      const r = e.currentTarget.getBoundingClientRect();
      dxRaw.set(((e.clientX - (r.left + r.width / 2)) / r.width) * 10);
      dyRaw.set(((e.clientY - (r.top + r.height / 2)) / r.height) * 10);
      return;
    }
    const now = performance.now();
    const ox = e.clientX - p.x, oy = e.clientY - p.y;
    const reach = dome ? 200 : 90;
    dxRaw.set(band(ox, reach * (dome ? 0.4 : 1)));
    dyRaw.set(band(oy, reach));
    p.moved = Math.max(p.moved, Math.hypot(ox, oy));
    // Regang searah gerak, sebanding kecepatan.
    const dt = Math.max(1, now - p.lt);
    const vx = ((e.clientX - p.lx) / dt) * 1000, vy = ((e.clientY - p.ly) / dt) * 1000;
    const speed = Math.hypot(vx, vy);
    if (speed > 40) {
      angle.set(Math.atan2(vy, vx));
      stretchRaw.set(Math.min(dome ? 0.08 : 0.32, speed / (dome ? 9000 : 2600)));
    }
    p.lx = e.clientX; p.ly = e.clientY; p.lt = now;
  };
  const release = (e: React.PointerEvent, cancelled = false) => {
    const p = press.current;
    if (!p) return;
    press.current = undefined;
    // Lepas: kembali ke tempat dengan goyangan (pegas redaman rendah).
    dxRaw.set(0); dyRaw.set(0); stretchRaw.set(0);
    if (cancelled) return;
    const pulledUp = p.y - e.clientY;
    if (dome && pulledUp > 60) onEnter();
    else if (p.moved < 8) (ready ? onChoose : onEnter)();
  };
  const onLeave = () => { if (!press.current) { dxRaw.set(0); dyRaw.set(0); } };

  return (
    <>
      <motion.div
        className="intro-orb-anchor"
        style={{ width: ORB, height: ORB, left: 0, top: 0 }}
        initial={false}
        animate={{ x: cx - ORB / 2, y: cy - ORB / 2, scale: s }}
        transition={spring}
      >
        <motion.button
          type="button"
          className="intro-orb"
          data-phase={phase}
          aria-label={ready ? 'Choose Photo' : 'Enter'}
          tabIndex={ready || phase === 'splash' ? 0 : -1}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (ready ? onChoose : onEnter)(); } }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={(e) => release(e)}
          onPointerCancel={(e) => release(e, true)}
          onPointerLeave={onLeave}
          // 1 px layar dalam satuan elemen (elemen 720 px diperkecil `s`), untuk cincin gelembung.
          style={{ transform, ['--orb-px' as string]: 1 / Math.max(s, 0.001) }}
        >
          {/* Kaca: GlassSurface (React Bits) mode WebGL di semua browser, membiaskan kanvas
              latar IntroBackdrop -- tampil sama di Chrome dan Safari/iOS. */}
          <GlassSurface
            className="intro-glass"
            width={ORB}
            height={ORB}
            borderRadius={ORB / 2}
            renderer="webgl"
            backdrop={backdrop}
            distortionScale={-180}
            displace={0.5}
            backgroundOpacity={0.1}
          />
          {/* Halo dikroik yang menyapu kubah saat masuk (cincin biru, inti putih). */}
          <AnimatePresence>
            {(phase === 'lift' || phase === 'bubble') && !reduce && (
              <motion.span
                key="halo"
                className="intro-halo"
                initial={{ opacity: 0, y: dome ? 260 : 140, scale: 0.7 }}
                animate={{ opacity: 1, y: dome ? 70 : 150, scale: dome ? 1 : 1.25 }}
                exit={{ opacity: 0, scale: 1.4, transition: { duration: 0.35 } }}
                transition={{ duration: 0.6, ease: EASE }}
              />
            )}
          </AnimatePresence>
          <AnimatePresence>
            {phase === 'splash' && (
              <motion.span
                key="hint"
                className="intro-hint"
                style={{ top: hintTop, scale: 1 / Math.max(s, 0.001), x: '-50%' }}
                initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -18, filter: 'blur(6px)', transition: { duration: 0.35, ease: EASE } }}
                transition={{ duration: 0.8, delay: reduce ? 0 : 0.9, ease: EASE }}
              >
                <motion.span
                  className="intro-hint-chevron"
                  aria-hidden="true"
                  animate={reduce ? undefined : { y: [3, -5, 3], opacity: [0.35, 1, 0.35] }}
                  transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
                >
                  <Icon name="chevronUp" size={16} strokeWidth={1.6} />
                </motion.span>
                <span className="intro-hint-text">{hint}</span>
              </motion.span>
            )}
          </AnimatePresence>
          <motion.span
            className="intro-plus"
            initial={false}
            animate={{ opacity: ready ? 1 : 0 }}
            transition={{ duration: 0.25, delay: ready ? 0.15 : 0 }}
            style={{ scale: 1 / Math.max(s, 0.001) }}
          >
            <Icon name="plus" size={22} strokeWidth={2.2} />
          </motion.span>
        </motion.button>
      </motion.div>
    </>
  );
}

/** Wordmark: "gammā" dalam SF Pro, teks biasa. */
export function ChromeWordmark({ visible }: { visible: boolean; reduce: boolean }) {
  return (
    <div className="intro-wordmark">
    <AnimatePresence>
      {visible && (
        <motion.div
          key="wordmark"
          className="intro-wordmark-text"
          initial={{ opacity: 0, filter: 'blur(10px)', y: 10, scale: 0.96 }}
          animate={{ opacity: 1, filter: 'blur(0px)', y: 0, scale: 1 }}
          exit={{ opacity: 0, filter: 'blur(12px)', y: -16, transition: { duration: 0.45, ease: EASE } }}
          transition={{ duration: 0.9, ease: EASE }}
        >
          gammā
        </motion.div>
      )}
    </AnimatePresence>
    </div>
  );
}
