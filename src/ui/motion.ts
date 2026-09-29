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
