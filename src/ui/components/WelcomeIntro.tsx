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
import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Icon } from './Icon';
import GlassSurface from './reactbits/GlassSurface';
import { provideOrbShape } from './RingBloom';
import { FRAME_ORDER, onFrame } from '../frameLoop';

export type IntroPhase = 'splash' | 'lift' | 'bubble' | 'ready';

/** Ukuran dasar elemen kaca (px); bentuk akhir didapat dari `scale`. */
const ORB = 720;
/** Lebar cahaya tepi kaca (px layar). */
const GLOW = 14;
/**
 * Stabilisasi tarikan kubah (s): posisi mengejar jari lewat tiga filter eksponensial
 * berderet (masing-masing sepertiganya; halus tanpa memantul), regang lewat satu.
 */
const DOME_SMOOTHING = 0.15;
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
  // --orb-px = 1 px layar dalam satuan elemen (720 px diperkecil), dari skala
  // animasi yang sedang berjalan: cincin tetap setipis 1.5 px di semua fase.
  const anchor = useRef<HTMLDivElement>(null);
  const glow = useRef<SVGRadialGradientElement>(null);
  const glowDisc = useRef<SVGCircleElement>(null);
  const glowId = useId();
  const setPx = (scale: number) => {
    const k = 1 / Math.max(scale, 0.001);
    anchor.current?.style.setProperty('--orb-px', String(k));
    // Cahaya tepi: gradien radial selebar GLOW px layar di kedua sisi tepi kaca.
    const R = ORB / 2, outer = R + GLOW * k, inner = Math.max(0, R - GLOW * 0.6 * k);
    glow.current?.setAttribute('r', String(outer));
    glowDisc.current?.setAttribute('r', String(outer));
    const stops = glow.current?.children;
    stops?.[0]?.setAttribute('offset', String(inner / outer));
    stops?.[1]?.setAttribute('offset', String(R / outer));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (!anchor.current?.style.getPropertyValue('--orb-px')) setPx(s); }, []);
  // Bentuk kaca untuk cincin glow: lingkaran dari jangkar (geser + skala saja),
  // lalu geser, regang, dan sudut benda lunaknya -- sama dengan transform tombol.
  useEffect(() => provideOrbShape(() => {
    const box = anchor.current?.getBoundingClientRect();
    if (!box) return undefined;
    const k = stretch.get(), r = box.width / 2;
    return {
      cx: box.left + r + dx.get(), cy: box.top + box.height / 2 + dy.get(),
      rx: r * (1 + k), ry: r / Math.max(0.5, 1 + k), angle: angle.get(),
    };
  }), [dx, dy, stretch, angle]);
  // Stabilisasi tarikan kubah (seperti smooth scroll): selama ditekan, posisi mengejar
  // target jari secara eksponensial, dan regangan mengikuti kecepatan jari yang
  // dihaluskan per frame -- sebagai vektor sudut ganda (sumbu regang tak berarah), jadi
  // sumbunya tidak meloncat-loncat. Pegas goyang dilewati (jump) selama ditekan supaya
  // tidak bergetar; saat dilepas pegas itu yang membawa kubah kembali.
  const goal = useRef<{ x: number; y: number; fx: number; fy: number } | undefined>(undefined);
  useEffect(() => {
    let last = performance.now();
    const drag = { x1: 0, y1: 0, x2: 0, y2: 0, x: 0, y: 0, vx: 0, vy: 0, px: 0, py: 0, sx: 0, sy: 0, fresh: true };
    return onFrame((now) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      const g = goal.current;
      if (!g) { drag.fresh = true; return; }
      if (drag.fresh) {
        // Awal tekan: mulai dari keadaan sekarang; remas sedikit (regang mendatar).
        const x = dx.get(), y = dy.get();
        Object.assign(drag, { x1: x, y1: y, x2: x, y2: y, x, y, vx: 0, vy: 0, px: g.fx, py: g.fy, sx: 0.12, sy: 0, fresh: false });
      }
      const follow = 1 - Math.exp(-dt / DOME_SMOOTHING);
      const stage = 1 - Math.exp(-dt / (DOME_SMOOTHING / 3));
      drag.x1 += (g.x - drag.x1) * stage; drag.y1 += (g.y - drag.y1) * stage;
      drag.x2 += (drag.x1 - drag.x2) * stage; drag.y2 += (drag.y1 - drag.y2) * stage;
      drag.x += (drag.x2 - drag.x) * stage; drag.y += (drag.y2 - drag.y) * stage;
      // Kecepatan jari per frame, dihaluskan (0.08 s); berhenti -> mereda ke nol.
      const blend = 1 - Math.exp(-dt / 0.08);
      drag.vx += ((g.fx - drag.px) / dt - drag.vx) * blend;
      drag.vy += ((g.fy - drag.py) / dt - drag.vy) * blend;
      drag.px = g.fx; drag.py = g.fy;
      const speed = Math.hypot(drag.vx, drag.vy);
      const k = Math.min(0.08, speed / 9000), theta = Math.atan2(drag.vy, drag.vx);
      // Target regang = remas tekan (0.12 mendatar) + regang searah gerak, dalam sudut ganda.
      const tx = 0.12 + k * Math.cos(2 * theta), ty = k * Math.sin(2 * theta);
      drag.sx += (tx - drag.sx) * follow;
      drag.sy += (ty - drag.sy) * follow;
      const amount = Math.hypot(drag.sx, drag.sy);
      dxRaw.set(drag.x); dx.jump(drag.x);
      dyRaw.set(drag.y); dy.jump(drag.y);
      stretchRaw.set(amount); stretch.jump(amount);
      angle.set(Math.atan2(drag.sy, drag.sx) / 2);
    }, FRAME_ORDER.orb);
  }, [dx, dy, stretch, dxRaw, dyRaw, stretchRaw, angle]);
  const press = useRef<{ x: number; y: number; t: number; lx: number; ly: number; lt: number; moved: number; id: number } | undefined>(undefined);
  /** Gesekan karet: makin jauh makin berat (seperti tarikan berlebih iOS). */
  const band = (v: number, r: number) => Math.sign(v) * r * (1 - 1 / (Math.abs(v) / r + 1));

  const onDown = (e: React.PointerEvent) => {
    if (reduce || phase === 'bubble' || phase === 'lift') return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or ended pointer */ }
    const now = performance.now();
    press.current = { x: e.clientX, y: e.clientY, t: now, lx: e.clientX, ly: e.clientY, lt: now, moved: 0, id: e.pointerId };
    // Tekan = remas sedikit (kubah: lewat stabilisasi di loop frame).
    if (dome) { goal.current = { x: dx.get(), y: dy.get(), fx: 0, fy: 0 }; return; }
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
    p.moved = Math.max(p.moved, Math.hypot(ox, oy));
    const g = goal.current;
    if (g) {
      // Kubah: hanya catat jari; posisi dan regang dihitung halus di loop frame.
      g.x = band(ox, reach * 0.4); g.y = band(oy, reach); g.fx = ox; g.fy = oy;
      return;
    }
    dxRaw.set(band(ox, reach)); dyRaw.set(band(oy, reach));
    // Regang searah gerak, sebanding kecepatan.
    const dt = Math.max(1, now - p.lt);
    const vx = ((e.clientX - p.lx) / dt) * 1000, vy = ((e.clientY - p.ly) / dt) * 1000;
    const speed = Math.hypot(vx, vy);
    if (speed > 40) {
      angle.set(Math.atan2(vy, vx));
      stretchRaw.set(Math.min(0.32, speed / 2600));
    }
    p.lx = e.clientX; p.ly = e.clientY; p.lt = now;
  };
  const release = (e: React.PointerEvent, cancelled = false) => {
    const p = press.current;
    if (!p) return;
    press.current = undefined;
    goal.current = undefined;
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
        ref={anchor}
        className="intro-orb-anchor"
        style={{ width: ORB, height: ORB, left: 0, top: 0 }}
        initial={false}
        animate={{ x: cx - ORB / 2, y: cy - ORB / 2, scale: s }}
        transition={spring}
        onUpdate={(latest) => { if (typeof latest.scale === 'number') setPx(latest.scale); }}
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
          style={{ transform }}
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
          {/* Isi kaca (putih tipis): lingkaran SVG, bukan border-radius -- Safari menggambar
              border-radius elemen yang diperkecil jauh jadi bersudut. */}
          <svg className="intro-fill" viewBox={`0 0 ${ORB} ${ORB}`} aria-hidden="true">
            <circle cx={ORB / 2} cy={ORB / 2} r={ORB / 2} />
          </svg>
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
                // Filter dilepas setelah masuk: blur(0px) yang menempel tetap memaksa lapisan offscreen.
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
                exit={{ opacity: 0, y: -18, filter: 'blur(6px)', transition: { duration: 0.35, ease: EASE } }}
                transition={{ duration: 0.8, delay: reduce ? 0 : 0.9, ease: EASE }}
              >
                {/* Chevron dan kilau teks: animasi CSS transform/opacity saja (jalan di
                    compositor, tanpa repaint, tetap 60 fps saat main thread sibuk). */}
                <span className="intro-hint-chevron" aria-hidden="true">
                  <Icon name="chevronUp" size={16} strokeWidth={1.6} />
                </span>
                <span className="intro-hint-text">
                  {hint}
                  <span className="intro-hint-shine" aria-hidden="true"><span>{hint}</span></span>
                </span>
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
        {/* Cincin terang + cahaya lembut di tepi, di atas kaca dan ikut bentuk lunaknya. */}
        <motion.svg className="intro-ring" viewBox={`0 0 ${ORB} ${ORB}`} style={{ transform }} aria-hidden="true">
          <defs>
            <radialGradient ref={glow} id={glowId} gradientUnits="userSpaceOnUse" cx={ORB / 2} cy={ORB / 2} r={ORB / 2}>
              <stop className="intro-ring-glow-clear" offset={0.9} />
              <stop className="intro-ring-glow-peak" offset={1} />
              <stop className="intro-ring-glow-clear" offset={1} />
            </radialGradient>
          </defs>
          <circle ref={glowDisc} className="intro-ring-glow" cx={ORB / 2} cy={ORB / 2} r={ORB / 2} fill={`url(#${CSS.escape(glowId)})`} />
          <circle className="intro-ring-line" cx={ORB / 2} cy={ORB / 2} r={ORB / 2} />
        </motion.svg>
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
          animate={{ opacity: 1, filter: 'blur(0px)', y: 0, scale: 1, transitionEnd: { filter: 'none' } }}
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
