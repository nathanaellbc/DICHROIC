/**
 * Preset gerak. DESIGN.md (Motion): gerak bertujuan, singkat, bisa dibatalkan,
 * dan tidak mengganggu interaksi yang sering. Kontrol dan sheet HP memakai
 * pegas supaya gestur yang terputus berlanjut dengan kecepatan yang sama;
 * overlay desktop memakai pudar singkat ala macOS tanpa pantulan (`overlay()`);
 * `MotionConfig reducedMotion="user"` di `main.tsx` mematikan transformasi
 * bila pengguna memilih Reduce Motion.
 */
import type { Transition } from 'motion/react';

/** Kontrol kecil: pil segmented, knob switch, pilihan. Cepat, tanpa pantulan terasa. */
export const snappy: Transition = { type: 'spring', stiffness: 560, damping: 44, mass: 0.8 };

/** Sheet dan panel besar: mengikuti jari lalu berhenti lembut di detent. */
export const sheetSpring: Transition = { type: 'spring', stiffness: 420, damping: 42, mass: 1 };

/** Photo overscroll: a soft, interruptible return after the pointer releases. */
export const photoReturn = { type: 'spring' as const, duration: 0.5, bounce: 0.2 };

/** Popover dan alert muncul dari sumbernya. */
export const popSpring: Transition = { type: 'spring', stiffness: 520, damping: 34, mass: 0.7 };

/** Overlay desktop (dialog, menu, alert, toast): cepat dan tenang, tanpa pantulan. */
export const macFade: Transition = { duration: 0.16, ease: [0.2, 0, 0, 1] };

/** Transisi overlay menurut kepadatan: pegas iOS di HP, pudar macOS di layar lebar. */
export function overlay(): Transition {
  return typeof document !== 'undefined' && document.documentElement.dataset.size === 'regular' ? macFade : popSpring;
}

/** Pergantian layar: pudar singkat. */
export const fade: Transition = { duration: 0.28, ease: [0.25, 0.1, 0.25, 1] };

/** Umpan balik tekan: singkat dan presisi. */
export const pressScale = 0.94;

/** Lepas tekan: kembali dengan pegas sedikit memantul (turunnya 0,08 s, di PressButton). */
export const pressRelease: Transition = { type: 'spring', duration: 0.34, bounce: 0.32 };

/** Blur latar modal (sheet, alert, menu), px. Sama dengan nilai lama di styles.css. */
export const SCRIM_BLUR = 8;

/** Reduce Transparency: latar tanpa blur (styles.css juga mematikannya). */
function blurAllowed(): boolean {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function' || !window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
}

/** `backdrop-filter` untuk tingkat blur 0..1 (dua nama properti: Safari butuh awalan). */
export function scrimBlur(amount: number): { backdropFilter: string; WebkitBackdropFilter: string } {
  const v = `blur(${(SCRIM_BLUR * Math.max(0, Math.min(1, amount))).toFixed(2)}px)`;
  return { backdropFilter: v, WebkitBackdropFilter: v };
}

/**
 * Latar modal yang memburam bertahap: radius blur ikut beranimasi bersama
 * opacity (0 -> 8 px masuk, 8 -> 0 keluar). Dulu hanya opacity yang
 * beranimasi di atas blur 8 px penuh, jadi terlihat seperti crossfade
 * tajam-buram, bukan blur yang menebal; latar menu bahkan muncul seketika.
 */
export function scrimMotion() {
  const blur = blurAllowed();
  const off = blur ? scrimBlur(0) : {};
  const on = blur ? scrimBlur(1) : {};
  return {
    initial: { opacity: 0, ...off },
    animate: { opacity: 1, ...on, transition: { duration: 0.32, ease: [0.23, 1, 0.32, 1] as [number, number, number, number] } },
    exit: { opacity: 0, ...off, transition: { duration: 0.22, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] } },
  };
}

/** Sheet: blur mengikuti tingkat redup yang digerakkan seretan (0..1). */
export const scrimBlurFor = (dim: number): { backdropFilter?: string; WebkitBackdropFilter?: string } => (blurAllowed() ? scrimBlur(dim) : {});
