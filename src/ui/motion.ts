/**
 * Preset gerak. DESIGN.md (Motion): gerak bertujuan, singkat, bisa dibatalkan,
 * dan tidak mengganggu interaksi yang sering. Semuanya pegas (tanpa durasi
 * tetap) supaya gestur yang terputus berlanjut dengan kecepatan yang sama;
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

/** Pergantian layar: pudar singkat. */
export const fade: Transition = { duration: 0.28, ease: [0.25, 0.1, 0.25, 1] };

/** Umpan balik tekan: singkat dan presisi. */
export const pressScale = 0.94;
