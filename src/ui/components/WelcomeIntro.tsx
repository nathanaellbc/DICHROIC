/**
 * Intro layar mulai (referensi: onboarding "kaca cair" ala Wabi), dalam tema
 * DICHROIC: wordmark krom di atas hitam, kubah kaca dikroik di tepi bawah
 * ("Swipe up to enter"), lalu kubah naik menyusut jadi gelembung lalu tombol
 * "+" (buka foto), dan stiker film menyembur keluar dari gelembung.
 *
 * Satu elemen kaca berubah bentuk lewat transform (scale/translate) -- tidak
 * ada animasi lebar/tinggi, jadi tetap 60 fps.
 */
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import type { UiIconName } from './Icon';
import { useGlassFilter } from './LiquidGlass';

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

export function GlassOrb({ phase, box, onEnter, onChoose, reduce }: {
  phase: IntroPhase; box: StageBox; onEnter: () => void; onChoose: () => void; reduce: boolean;
}) {
  const glass = useGlassFilter(ORB, { bezel: 0.14, strength: 0.16 });
  const { cx, cy, d } = orbGeometry(phase, box);
  const s = d / ORB;
  const ready = phase === 'ready';
  const dome = phase === 'splash' || phase === 'lift';
  const spring = reduce ? { duration: 0 } : phase === 'bubble'
    ? { type: 'spring' as const, duration: 0.85, bounce: 0.18 }
    : phase === 'ready' ? { type: 'spring' as const, duration: 0.55, bounce: 0.3 } : { duration: 0.5, ease: EASE };
  return (
    <>
      {glass.svg}
      <motion.button
        type="button"
        className="intro-orb"
        data-phase={phase}
        data-refract={glass.refract || undefined}
        aria-label={ready ? 'Choose Photo' : 'Enter'}
        tabIndex={ready || phase === 'splash' ? 0 : -1}
        onClick={ready ? onChoose : onEnter}
        style={{ width: ORB, height: ORB, left: 0, top: 0, ...glass.style }}
        initial={false}
        animate={{ x: cx - ORB / 2, y: cy - ORB / 2, scale: s }}
        transition={spring}
        whileTap={ready ? { scale: s * 0.92 } : undefined}
      >
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
    </>
  );
}

/** Wordmark krom: kilap specular dari tepi huruf yang diburamkan. */
export function ChromeWordmark({ visible }: { visible: boolean }) {
  return (
    <div className="intro-wordmark">
    <AnimatePresence>
      {visible && (
        <motion.div
          key="wordmark"
          initial={{ opacity: 0, filter: 'blur(10px)', y: 10 }}
          animate={{ opacity: 1, filter: 'blur(0px)', y: 0 }}
          exit={{ opacity: 0, filter: 'blur(12px)', y: -16, transition: { duration: 0.45, ease: EASE } }}
          transition={{ duration: 0.9, ease: EASE }}
        >
          <svg viewBox="0 0 640 140" role="img" aria-label="DICHROIC">
            <defs>
              <linearGradient id="chrome-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style={{ stopColor: "var(--chrome-1)" }} />
                <stop offset="0.48" style={{ stopColor: "var(--chrome-2)" }} />
                <stop offset="0.52" style={{ stopColor: "var(--chrome-3)" }} />
                <stop offset="1" style={{ stopColor: "var(--chrome-4)" }} />
              </linearGradient>
              <filter id="chrome-bevel" x="-10%" y="-30%" width="120%" height="160%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="3.2" result="soft" />
                <feSpecularLighting in="soft" surfaceScale="7" specularConstant="1.15" specularExponent="26" lightingColor="#ffffff" result="spec">
                  <fePointLight x="120" y="-220" z="300" />
                </feSpecularLighting>
                <feComposite in="spec" in2="SourceAlpha" operator="in" result="shine" />
                <feComposite in="SourceGraphic" in2="shine" operator="arithmetic" k1="0" k2="1" k3="0.85" k4="0" result="lit" />
                <feDropShadow dx="0" dy="6" stdDeviation="10" floodColor="rgba(0, 120, 255, 0.35)" />
              </filter>
            </defs>
            <text x="320" y="102" textAnchor="middle" className="intro-wordmark-text" fill="url(#chrome-fill)" filter="url(#chrome-bevel)">DICHROIC</text>
          </svg>
        </motion.div>
      )}
    </AnimatePresence>
    </div>
  );
}

type Sticker =
  | { kind: 'stock'; label: string; sub: string; tone: string }
  | { kind: 'icon'; icon: UiIconName }
  | { kind: 'quote'; text: string }
  | { kind: 'frame'; hue: number };

/**
 * Stiker isi aplikasi: nama stok film (warna kotak filmnya -- isi, bukan
 * aksen UI), ikon kamar gelap, potongan bingkai film, dan kutipan pendek.
 * Posisi akhir dalam pecahan ruang di atas gelembung: nx -1..1 (kiri-kanan),
 * ny 0..1 (dari gelembung ke atas); r = rotasi. Seimbang kiri dan kanan.
 */
const STICKERS: ReadonlyArray<{ s: Sticker; nx: number; ny: number; r: number; small?: boolean }> = [
  { s: { kind: 'stock', label: 'Portra 400', sub: 'Kodak', tone: '#e8b04a' }, nx: -0.6, ny: 0.6, r: -9 },
  { s: { kind: 'stock', label: 'Velvia 50', sub: 'Fujifilm', tone: '#2f9e5b' }, nx: 0.62, ny: 0.56, r: 7 },
  { s: { kind: 'frame', hue: 28 }, nx: 0.02, ny: 0.8, r: 6 },
  { s: { kind: 'quote', text: 'Shot on real film' }, nx: 0.5, ny: 0.92, r: 6 },
  { s: { kind: 'icon', icon: 'aperture' }, nx: -0.3, ny: 0.26, r: -14 },
  { s: { kind: 'stock', label: 'Vision3 500T', sub: 'Kodak', tone: '#d1452f' }, nx: 0.04, ny: 0.48, r: 4 },
  { s: { kind: 'icon', icon: 'print' }, nx: 0.32, ny: 0.2, r: 10 },
  { s: { kind: 'quote', text: 'Printed on 2383' }, nx: -0.5, ny: 0.96, r: -5 },
  { s: { kind: 'icon', icon: 'format' }, nx: -0.66, ny: 0.3, r: 12, small: true },
  { s: { kind: 'frame', hue: 205 }, nx: -0.12, ny: 1.0, r: -12, small: true },
  { s: { kind: 'icon', icon: 'grain' }, nx: 0.7, ny: 0.2, r: -8, small: true },
  { s: { kind: 'stock', label: 'HP5 Plus', sub: 'Ilford', tone: '#2b2b2e' }, nx: -0.78, ny: 0.28, r: 6, small: true },
];

function StickerFace({ s }: { s: Sticker }): ReactNode {
  switch (s.kind) {
    case 'stock':
      return <span className="sticker sticker-stock" style={{ ['--tone' as string]: s.tone }}><b>{s.label}</b><small>{s.sub}</small></span>;
    case 'icon':
      return <span className="sticker sticker-icon"><Icon name={s.icon} size={20} strokeWidth={2} /></span>;
    case 'quote':
      return <span className="sticker sticker-quote">{s.text}</span>;
    case 'frame':
      return <span className="sticker sticker-frame" style={{ ['--hue' as string]: s.hue }} />;
  }
}

/** Stiker menyembur dari gelembung (pegas, berselang 35 ms), lalu melayang pelan. */
export function StickerBurst({ show, origin, box, compact, reduce }: {
  show: boolean; origin: { x: number; y: number }; box: StageBox; compact: boolean; reduce: boolean;
}) {
  const items = compact ? STICKERS.filter((item) => !item.small) : STICKERS;
  // Sebaran: lebar terbatas (stiker tidak menyentuh tepi), tinggi = ruang di atas gelembung.
  const spreadX = Math.min(box.width / 2 - (compact ? 52 : 90), 320);
  const spreadY = Math.max(120, origin.y - (compact ? 96 : 110) - 40);
  return (
    <div className="intro-stickers" aria-hidden="true">
      <AnimatePresence>
        {show && items.map((item, i) => {
          const x = item.nx * spreadX, y = -(46 + item.ny * spreadY);
          return (
            <motion.div
              key={i}
              className="intro-sticker"
              style={{ left: origin.x, top: origin.y }}
              initial={reduce ? { opacity: 0, x, y, rotate: item.r } : { opacity: 0, x: 0, y: 0, scale: 0.2, rotate: 0 }}
              animate={{ opacity: 1, x, y, scale: (item.small ? 0.84 : 1) * (compact ? 0.9 : 1), rotate: item.r }}
              exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.2 } }}
              transition={reduce ? { duration: 0.3 } : { type: 'spring', duration: 0.9, bounce: 0.32, delay: 0.05 + i * 0.035 }}
            >
              <motion.div
                animate={reduce ? undefined : { y: [0, -5, 0] }}
                transition={{ duration: 4 + (i % 4), repeat: Infinity, ease: 'easeInOut', delay: 1 + i * 0.2 }}
              >
                <StickerFace s={item.s} />
              </motion.div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
