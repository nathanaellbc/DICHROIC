/**
 * Intro layar mulai (referensi: onboarding "kaca cair" ala Wabi), dalam tema
 * gammā: wordmark teks SF Pro, kubah kaca di tepi bawah ("Swipe up to
 * continue" di dalamnya) yang berubah jadi tombol "+" (buka foto); stiker film
 * ada di StickerField.
 *
 * Perubahan kubah -> "+" sepenuhnya dikendalikan pengguna, tanpa timer: satu
 * nilai `progress` (0 = kubah, 1 = "+") menentukan posisi dan diameter kaca.
 * Swipe ke atas di mana saja mengisinya sebanding jarak (ditahan di tengah =
 * diam di tengah); dilepas, kaca menetap ke ujung terdekat (memperhitungkan
 * kecepatan). Satu elemen kaca berubah bentuk lewat transform saja; semua
 * transform kaca ditulis di frameLoop yang sama dengan glow cincin (RingBloom),
 * jadi glow selalu menempel di tepi kaca.
 */
import { AnimatePresence, animate, motion, useMotionValue, useSpring, useTransform } from 'motion/react';
import type { MotionValue } from 'motion/react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Icon } from './Icon';
import GlassSurface from './reactbits/GlassSurface';
import { flareGlow, provideOrbShape } from './RingBloom';
import { haptic } from '../haptics';
import type { OrbShape } from './RingBloom';
import { FRAME_ORDER, onFrame } from '../frameLoop';

export type IntroPhase = 'splash' | 'ready';

/** Ukuran dasar elemen kaca (px); bentuk akhir didapat dari `scale`. */
const ORB = 720;
/** Lebar cahaya tepi kaca (px layar). */
const GLOW = 14;
/**
 * Stabilisasi tarikan kubah (s): posisi dan progres mengejar jari lewat tiga
 * filter eksponensial berderet (masing-masing sepertiganya; halus tanpa
 * memantul), regang lewat satu.
 */
const DOME_SMOOTHING = 0.15;
/** Diameter tombol "+" (px). */
const BUTTON = 64;
const EASE: [number, number, number, number] = [0.23, 1, 0.32, 1];

export interface StageBox { width: number; height: number }

/** Jarak swipe untuk transisi penuh kubah -> "+" (px). */
const swipeLength = (box: StageBox) => Math.min(360, box.height * 0.45);

/**
 * Pusat dan diameter kaca pada progres p (0 = kubah, 1 = "+"): puncak kaca naik
 * lurus, diameter menyusut eksponensial (kubah besar -> gelembung -> "+").
 */
function orbGeometry(p: number, box: StageBox) {
  const { width: w, height: h } = box;
  const t = Math.min(1.1, Math.max(-0.1, p));
  const d0 = Math.max(w * 1.35, 620), top0 = h - Math.min(h * 0.3, 280);
  const top1 = h * 0.42 - BUTTON / 2;
  const d = d0 * (BUTTON / d0) ** t;
  const top = top0 + (top1 - top0) * t;
  return { cx: w / 2, cy: top + d / 2, d };
}

export function GlassOrb({ phase, progress, box, onCommit, onChoose, reduce, hint, backdrop }: {
  phase: IntroPhase;
  /** 0 = kubah, 1 = tombol "+"; dikendalikan gesture pengguna. */
  progress: MotionValue<number>;
  box: StageBox; onCommit: () => void; onChoose: () => void; reduce: boolean; hint: string;
  /** Kanvas latar (IntroBackdrop) yang dibiaskan kaca. */
  backdrop: RefObject<HTMLCanvasElement | null>;
}) {
  const ready = phase === 'ready';
  const dome0 = orbGeometry(0, box), button = orbGeometry(1, box);
  // Petunjuk di dalam kubah: di tengah bagian kubah yang terlihat (satuan elemen kubah).
  const hintTop = (Math.min(box.height * 0.3, 280) * 0.4 * ORB) / dome0.d;
  const live = useRef({ box, ready, onCommit, onChoose, reduce });
  live.current = { box, ready, onCommit, onChoose, reduce };

  // Benda lunak: geser mengikuti jari (karet), regang searah kecepatan,
  // bergoyang saat dilepas. Semua dalam px layar.
  const dxRaw = useMotionValue(0), dyRaw = useMotionValue(0), stretchRaw = useMotionValue(0);
  const dx = useSpring(dxRaw, { stiffness: 320, damping: 13, mass: 0.8 });
  const dy = useSpring(dyRaw, { stiffness: 320, damping: 13, mass: 0.8 });
  const stretch = useSpring(stretchRaw, { stiffness: 340, damping: 8, mass: 0.6 });
  const angle = useMotionValue(0);
  // Wordmark, petunjuk, dan "+" mengikuti progres; "+" muncul bertahap
  // sepanjang swipe, bukan baru di ujung.
  const hintOpacity = useTransform(progress, [0, 0.2], [1, 0]);
  const plusOpacity = useTransform(progress, [0.1, 0.85], [0, 1]);

  const anchor = useRef<HTMLDivElement>(null);
  const orb = useRef<HTMLButtonElement>(null);
  const ring = useRef<SVGSVGElement>(null);
  const glow = useRef<SVGRadialGradientElement>(null);
  const glowDisc = useRef<SVGCircleElement>(null);
  const glowId = useId();
  const shape = useRef<OrbShape | undefined>(undefined);

  /**
   * Tulis transform kaca untuk progres dan benda lunak saat ini, dan simpan
   * bentuknya untuk glow (frame yang sama, angka yang sama).
   * --orb-px = 1 px layar dalam satuan elemen 720 px yang diperkecil.
   */
  const render = () => {
    const el = anchor.current, stage = el?.parentElement;
    if (!el || !stage) return;
    const origin = stage.getBoundingClientRect();
    const { cx, cy, d } = orbGeometry(progress.get(), live.current.box);
    const s = d / ORB, k = 1 / Math.max(s, 0.001);
    el.style.transform = `translate(${cx - ORB / 2}px, ${cy - ORB / 2}px) scale(${s})`;
    el.style.setProperty('--orb-px', String(k));
    const R = ORB / 2, outer = R + GLOW * k, inner = Math.max(0, R - GLOW * 0.6 * k);
    glow.current?.setAttribute('r', String(outer));
    glowDisc.current?.setAttribute('r', String(outer));
    const stops = glow.current?.children;
    stops?.[0]?.setAttribute('offset', String(inner / outer));
    stops?.[1]?.setAttribute('offset', String(R / outer));
    const x = dx.get(), y = dy.get(), a = angle.get(), st = stretch.get();
    const sx = 1 + st, sy = 1 / Math.max(0.5, 1 + st);
    const transform = `translate(${x * k}px, ${y * k}px) rotate(${a}rad) scale(${sx}, ${sy}) rotate(${-a}rad)`;
    if (orb.current) orb.current.style.transform = transform;
    if (ring.current) ring.current.style.transform = transform;
    // Matahari terbit hanya di kubah; memudar saat kaca jadi tombol +.
    const sun = Math.min(1, Math.max(0, 1 - progress.get() * 1.6));
    shape.current = { cx: origin.left + cx + x, cy: origin.top + cy + y, rx: (d / 2) * sx, ry: (d / 2) * sy, angle: a, sun };
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(render, []);
  useEffect(() => provideOrbShape(() => shape.current), []);

  // Stabilisasi tarikan (seperti smooth scroll): selama ditekan, posisi dan progres
  // mengejar target jari, regang mengikuti kecepatan jari yang dihaluskan per frame
  // sebagai vektor sudut ganda (sumbu regang tak berarah) -- tanpa lompatan. Pegas
  // goyang dilewati (jump) selama ditekan; saat dilepas pegas itu membawa kaca kembali.
  const goal = useRef<{ x: number; y: number; fx: number; fy: number; p: number } | undefined>(undefined);
  const drag = useRef({ x1: 0, y1: 0, x2: 0, y2: 0, x: 0, y: 0, p1: 0, p2: 0, p: 0, vx: 0, vy: 0, px: 0, py: 0, sx: 0, sy: 0, fresh: true });
  useEffect(() => {
    let last = performance.now();
    return onFrame((now) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      const g = goal.current, m = drag.current;
      if (!g) m.fresh = true;
      else {
        if (m.fresh) {
          // Awal tekan: mulai dari keadaan sekarang, tetap bulat.
          const x = dx.get(), y = dy.get(), p = progress.get();
          Object.assign(m, { x1: x, y1: y, x2: x, y2: y, x, y, p1: p, p2: p, p, vx: 0, vy: 0, px: g.fx, py: g.fy, sx: 0, sy: 0, fresh: false });
        }
        const follow = 1 - Math.exp(-dt / DOME_SMOOTHING);
        const stage = 1 - Math.exp(-dt / (DOME_SMOOTHING / 3));
        m.x1 += (g.x - m.x1) * stage; m.y1 += (g.y - m.y1) * stage; m.p1 += (g.p - m.p1) * stage;
        m.x2 += (m.x1 - m.x2) * stage; m.y2 += (m.y1 - m.y2) * stage; m.p2 += (m.p1 - m.p2) * stage;
        m.x += (m.x2 - m.x) * stage; m.y += (m.y2 - m.y) * stage; m.p += (m.p2 - m.p) * stage;
        // Kecepatan jari per frame, dihaluskan (0.08 s); berhenti -> mereda ke nol.
        const blend = 1 - Math.exp(-dt / 0.08);
        m.vx += ((g.fx - m.px) / dt - m.vx) * blend;
        m.vy += ((g.fy - m.py) / dt - m.vy) * blend;
        m.px = g.fx; m.py = g.fy;
        const speed = Math.hypot(m.vx, m.vy);
        // Regang tipis searah gerak saja (sudut ganda), maksimum 3 %: dulu remas
        // tekan 0.12 mendatar bertahan sepanjang tarikan dan kubah tampak gepeng.
        const k = Math.min(0.03, speed / 24000), theta = Math.atan2(m.vy, m.vx);
        m.sx += (k * Math.cos(2 * theta) - m.sx) * follow;
        m.sy += (k * Math.sin(2 * theta) - m.sy) * follow;
        const amount = Math.hypot(m.sx, m.sy);
        dxRaw.set(m.x); dx.jump(m.x);
        dyRaw.set(m.y); dy.jump(m.y);
        stretchRaw.set(amount); stretch.jump(amount);
        angle.set(Math.atan2(m.sy, m.sx) / 2);
        progress.set(m.p);
      }
      render();
    }, FRAME_ORDER.orb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dx, dy, stretch, dxRaw, dyRaw, stretchRaw, angle, progress]);

  // Impact saat kaca mendarat jadi "+": squash jelly, gelombang kejut, kilatan glow;
  // isi (judul, stiker) langsung muncul di momen yang sama.
  const [shock, setShock] = useState(0);
  const impact = () => {
    angle.set(Math.PI / 2);
    stretchRaw.set(0);
    // Gencet seketika lalu pegas memantul kembali ke bulat. `stretchRaw`
    // sudah 0, jadi pegas harus diarahkan eksplisit -- dulu tidak ada yang
    // memicunya dan tombol + tetap gepeng (x1.32, y0.76).
    stretch.jump(-0.24);
    stretch.set(0);
    setShock((n) => n + 1);
    flareGlow();
    live.current.onCommit();
  };

  /** Selesaikan transisi ke ujung `target` (1 = "+", 0 = kembali ke kubah). */
  const settle = (target: 0 | 1, velocity = 0) => {
    if (live.current.reduce) {
      progress.set(target);
      if (target === 1) live.current.onCommit();
      return;
    }
    let landed = false;
    void animate(progress, target, {
      // Ke "+": pegas membal (sedikit kelewatan lalu memantul); kembali ke kubah: lembut.
      ...(target === 1 ? { stiffness: 260, damping: 17 } : { stiffness: 210, damping: 26 }),
      type: 'spring', velocity,
      onUpdate: (v) => { if (target === 1 && !landed && v >= 0.97) { landed = true; impact(); } },
      onComplete: () => { if (target === 1 && !landed) { landed = true; impact(); } },
    });
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;

  // Fase berubah dari luar (mis. berkas diseret ke layar): kaca ikut jadi "+".
  useEffect(() => {
    if (phase === 'ready' && progress.get() < 1 && !progress.isAnimating()) settleRef.current(1);
  }, [phase, progress]);

  /** Gesekan karet: makin jauh makin berat (seperti tarikan berlebih iOS). */
  const band = (v: number, r: number) => Math.sign(v) * r * (1 - 1 / (Math.abs(v) / r + 1));

  // Kubah: swipe di mana saja di panggung menggerakkan progres; roda gulir dan
  // tombol panah/Enter/spasi juga.
  useEffect(() => {
    if (phase !== 'splash') return undefined;
    const stage = anchor.current?.parentElement;
    if (!stage) return undefined;
    let press: { id: number; x: number; y: number; p0: number; moved: number; onOrb: boolean } | undefined;
    const down = (e: PointerEvent) => {
      if (press || (e.pointerType === 'mouse' && e.button !== 0)) return;
      try { stage.setPointerCapture(e.pointerId); } catch { /* pointer sintetis */ }
      progress.stop();
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, p0: progress.get(), moved: 0, onOrb: !!orb.current?.contains(e.target as Node) };
      goal.current = { x: dx.get(), y: dy.get(), fx: 0, fy: 0, p: press.p0 };
    };
    const move = (e: PointerEvent) => {
      const g = goal.current;
      if (!press || !g || e.pointerId !== press.id) return;
      const ox = e.clientX - press.x, oy = e.clientY - press.y;
      press.moved = Math.max(press.moved, Math.hypot(ox, oy));
      const p = press.p0 - oy / swipeLength(live.current.box);
      g.p = Math.min(1, Math.max(0, p));
      // Tarik ke bawah dari kubah: karet; ke samping: karet ringan.
      g.y = p < 0 ? band(-p * swipeLength(live.current.box), 200) : 0;
      g.x = band(ox, 80);
      g.fx = ox; g.fy = oy;
    };
    const up = (e: PointerEvent, cancelled = false) => {
      if (!press || e.pointerId !== press.id) return;
      const tap = press.moved < 8 && press.onOrb && !cancelled;
      press = undefined;
      const vy = drag.current.vy;
      goal.current = undefined;
      dxRaw.set(0); dyRaw.set(0); stretchRaw.set(0);
      const p = progress.get();
      const target = tap || vy < -500 || (vy <= 500 && p > 0.5) ? 1 : 0;
      if (target === 1) haptic();
      settleRef.current(target, (-vy / swipeLength(live.current.box)) || 0);
    };
    const cancel = (e: PointerEvent) => up(e, true);
    let wheelEnd = 0;
    const wheel = (e: WheelEvent) => {
      progress.stop();
      progress.set(Math.min(1, Math.max(0, progress.get() + e.deltaY / (swipeLength(live.current.box) * 1.5))));
      window.clearTimeout(wheelEnd);
      wheelEnd = window.setTimeout(() => settleRef.current(progress.get() > 0.5 ? 1 : 0), 160);
    };
    const key = (e: KeyboardEvent) => { if (['ArrowUp', 'ArrowDown', 'PageDown', 'Enter', ' '].includes(e.key)) { haptic(); settleRef.current(1); } };
    stage.addEventListener('pointerdown', down);
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', cancel);
    stage.addEventListener('wheel', wheel, { passive: true });
    window.addEventListener('keydown', key);
    return () => {
      window.clearTimeout(wheelEnd);
      stage.removeEventListener('pointerdown', down);
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      stage.removeEventListener('pointercancel', cancel);
      stage.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', key);
      goal.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Tombol "+": tekan = remas, geser = karet, ketuk = buka foto.
  const press = useRef<{ x: number; y: number; lx: number; ly: number; lt: number; moved: number } | undefined>(undefined);
  const onDown = (e: React.PointerEvent) => {
    if (reduce || !ready) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer sintetis */ }
    const now = performance.now();
    press.current = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, lt: now, moved: 0 };
    angle.set(Math.PI / 2);
    stretchRaw.set(-0.12);
  };
  const onMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) {
      // Kursor mendekat: kaca condong ke arahnya.
      if (reduce || e.pointerType !== 'mouse' || !ready) return;
      const r = e.currentTarget.getBoundingClientRect();
      dxRaw.set(((e.clientX - (r.left + r.width / 2)) / r.width) * 10);
      dyRaw.set(((e.clientY - (r.top + r.height / 2)) / r.height) * 10);
      return;
    }
    const now = performance.now();
    const ox = e.clientX - p.x, oy = e.clientY - p.y;
    p.moved = Math.max(p.moved, Math.hypot(ox, oy));
    dxRaw.set(band(ox, 90)); dyRaw.set(band(oy, 90));
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
  const release = (cancelled = false) => {
    const p = press.current;
    if (!p) return;
    press.current = undefined;
    // Lepas: kembali ke tempat dengan goyangan (pegas redaman rendah).
    dxRaw.set(0); dyRaw.set(0); stretchRaw.set(0);
    if (!cancelled && p.moved < 8) onChoose();
  };
  const onLeave = () => { if (!press.current && ready) { dxRaw.set(0); dyRaw.set(0); } };

  return (
    <>
      <div ref={anchor} className="intro-orb-anchor" style={{ width: ORB, height: ORB, left: 0, top: 0 }}>
        <button
          ref={orb}
          type="button"
          className="intro-orb"
          data-phase={phase}
          aria-label={ready ? 'Choose Photo' : 'Enter'}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (ready) onChoose(); else settle(1); } }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={() => release()}
          onPointerCancel={() => release(true)}
          onPointerLeave={onLeave}
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
          <AnimatePresence>
            {phase === 'splash' && (
              <motion.span
                key="hint"
                className="intro-hint"
                style={{ top: hintTop, scale: ORB / dome0.d, x: '-50%' }}
                initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
                // Filter dilepas setelah masuk: blur(0px) yang menempel tetap memaksa lapisan offscreen.
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
                exit={{ opacity: 0, transition: { duration: 0.2 } }}
                transition={{ duration: 0.8, delay: reduce ? 0 : 0.9, ease: EASE }}
              >
                {/* Memudar mengikuti progres swipe. */}
                <motion.span className="intro-hint-body" style={{ opacity: hintOpacity }}>
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
              </motion.span>
            )}
          </AnimatePresence>
          <motion.span className="intro-plus" style={{ opacity: plusOpacity, scale: ORB / button.d }}>
            <Icon name="plus" size={22} strokeWidth={2.2} />
          </motion.span>
        </button>
        {/* Cincin terang + cahaya lembut di tepi, di atas kaca dan ikut bentuk lunaknya. */}
        <svg ref={ring} className="intro-ring" viewBox={`0 0 ${ORB} ${ORB}`} aria-hidden="true">
          <defs>
            <radialGradient ref={glow} id={glowId} gradientUnits="userSpaceOnUse" cx={ORB / 2} cy={ORB / 2} r={ORB / 2}>
              <stop className="intro-ring-glow-clear" offset={0.9} />
              <stop className="intro-ring-glow-peak" offset={1} />
              <stop className="intro-ring-glow-clear" offset={1} />
            </radialGradient>
          </defs>
          <circle ref={glowDisc} className="intro-ring-glow" cx={ORB / 2} cy={ORB / 2} r={ORB / 2} fill={`url(#${CSS.escape(glowId)})`} />
          <circle className="intro-ring-line" cx={ORB / 2} cy={ORB / 2} r={ORB / 2} />
        </svg>
      </div>
      {/* Gelombang kejut saat mendarat: dua cincin tipis memancar dari "+" (transform/opacity saja). */}
      {shock > 0 && !reduce && (
        <span className="intro-shock-anchor" style={{ left: button.cx, top: button.cy }} aria-hidden="true">
          <motion.span key={`a${shock}`} className="intro-shock" initial={{ scale: 1, opacity: 0.9 }} animate={{ scale: 3.4, opacity: 0 }} transition={{ duration: 0.75, ease: [0.16, 1, 0.3, 1] }} />
          <motion.span key={`b${shock}`} className="intro-shock" initial={{ scale: 1, opacity: 0.5 }} animate={{ scale: 2.2, opacity: 0 }} transition={{ duration: 0.6, delay: 0.07, ease: [0.16, 1, 0.3, 1] }} />
        </span>
      )}
    </>
  );
}

/** Wordmark: "gammā" dalam SF Pro, teks biasa; memudar dan naik mengikuti progres swipe. */
export function ChromeWordmark({ visible, progress }: { visible: boolean; progress: MotionValue<number> }) {
  const opacity = useTransform(progress, [0, 0.45], [1, 0]);
  const y = useTransform(progress, [0, 1], [0, -40]);
  return (
    <div className="intro-wordmark">
      <motion.div style={{ opacity, y }}>
        <AnimatePresence>
          {visible && (
            <motion.div
              key="wordmark"
              className="intro-wordmark-text"
              initial={{ opacity: 0, filter: 'blur(10px)', y: 10, scale: 0.96 }}
              animate={{ opacity: 1, filter: 'blur(0px)', y: 0, scale: 1, transitionEnd: { filter: 'none' } }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={{ duration: 0.9, ease: EASE }}
            >
              gammā
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
