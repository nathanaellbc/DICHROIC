/**
 * Foto: frame hasil render, dipaskan (contain) ke area yang tersedia.
 * Pembanding: garis pembagi yang bisa diseret memperlihatkan aslinya di kiri;
 * tanpa mode pembanding, tekan-tahan foto memperlihatkan aslinya (seperti
 * Photos). Frame baru langsung digambar tanpa animasi -- DESIGN.md: jangan
 * menambah gerak pada interaksi yang sering.
 *
 * Keyboard: garis pembagi adalah slider (panah); pin fokus dapat dipindah
 * dengan panah, Escape membatalkan seretan fokus yang aktif.
 *
 * Zoom: roda/pinch trackpad di titik kursor, pinch dua jari, klik ganda
 * (pas <-> 2,5x); seret elastis pada skala pas maupun saat diperbesar. Zoom hanya transform
 * tampilan -- pratinjau yang sama diperbesar, render tidak diulang.
 */
import { AnimatePresence, animate, motion, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ReactNode } from 'react';
import type { Frame } from '../engine/display';
import { fade, photoReturn } from '../motion';

/** Fit / ketuk dua kali: mendarat lembut tanpa pantulan (tidak lompat). */
const viewSpring = { type: 'spring' as const, duration: 0.42, bounce: 0 };
/** Pil status kanan atas. */
const statusSpring = { type: 'spring' as const, duration: 0.3, bounce: 0.15 };
import { Spinner } from './Overlays';
import { Icon } from './Icon';
import { PhotoLightbox } from './PhotoLightbox';
import type { Box } from './PhotoLightbox';
import { previewPixelBudget } from '../../io/budget';

function FrameCanvas({ frame, style }: { frame: Frame; style?: React.CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (canvas.width !== frame.width) canvas.width = frame.width;
    if (canvas.height !== frame.height) canvas.height = frame.height;
    const ctx = canvas.getContext('2d', { colorSpace: frame.colorSpace });
    ctx?.putImageData(new ImageData(frame.pixels as Uint8ClampedArray<ArrayBuffer>, frame.width, frame.height, { colorSpace: frame.colorSpace }), 0, 0);
  }, [frame]);
  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', ...style }} />;
}

/**
 * Titik fokus lens blur (koordinat 0..1 relatif foto). `picking`: tahan dan
 * seret memilih subjek secara langsung; pembanding/intip asli dimatikan.
 */
export interface FocusOverlay {
  x: number;
  y: number;
  show: boolean;
  picking: boolean;
  onStart: () => void;
  onPick: (x: number, y: number) => void;
  /** Cheap provisional mask update, without committing a GPU render. */
  onPreview?: (x: number, y: number) => void;
  onPreviewCancel?: () => void;
  onCancel?: () => void;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const MAX_ZOOM = 8;
const DOUBLE_CLICK_ZOOM = 2.5;
/** Gerak (px) sebelum ketukan dianggap seretan. */
const DRAG_SLOP = 4;
/** Sapuan develop terakhir yang sudah diputar (pasang ulang karena rotasi tidak memutar ulang). */
let lastReveal = 0;
/** Ketukan lebih lama dari ini adalah tahan (intip asli), bukan buka layar penuh. */
const TAP_MAX_MS = 220;
/** Jeda menunggu ketukan kedua (zoom) sebelum membuka layar penuh. */
const DOUBLE_TAP_MS = 240;
/** Render tajam layar penuh dimulai setelah animasi buka (frame baru di-decode di thread utama). */
const FULLSCREEN_RENDER_DELAY_MS = 520;

/** Tampilan zoom: skala dan geser (px) sudut kiri-atas foto dari posisi pasnya. */
interface View {
  s: number;
  tx: number;
  ty: number;
}
const FIT: View = { s: 1, tx: 0, ty: 0 };

type Point = { x: number; y: number };

/**
 * Satu sumbu: foto yang lebih kecil dari area tetap di tengah; yang lebih
 * besar tidak boleh menyisakan celah di tepi.
 */
function clampAxis(t: number, s: number, len: number, offset: number, areaLen: number): number {
  const scaled = s * len;
  if (scaled <= areaLen) return (areaLen - scaled) / 2 - offset;
  return Math.min(-offset, Math.max(areaLen - offset - scaled, t));
}

/** Rubber-band distance approaches a quarter viewport, never a hard wall. */
function elasticOffset(distance: number, extent: number): number {
  const limit = Math.max(1, extent / 4);
  return Math.sign(distance) * limit * (Math.abs(distance) * 0.55) / (limit + Math.abs(distance) * 0.55);
}

/** Recover the raw gesture origin when a new drag interrupts an elastic return. */
function rawOffset(distance: number, extent: number): number {
  const limit = Math.max(1, extent / 4);
  const magnitude = Math.min(Math.abs(distance), limit - 0.001);
  return Math.sign(distance) * magnitude * limit / (0.55 * (limit - magnitude));
}

export function PhotoView({
  frame,
  original,
  compare,
  rendering,
  photoKey,
  label,
  focus,
  focusMask,
  sourceSize,
  onResolutionChange,
  content,
  brush,
  fitInsets,
  reveal,
}: {
  frame?: Frame;
  original?: Frame;
  compare: boolean;
  rendering: boolean;
  /** Berganti per berkas: foto baru muncul dengan pudar singkat. */
  photoKey: string;
  label: string;
  focus?: FocusOverlay;
  focusMask?: Frame;
  sourceSize?: { width: number; height: number };
  onResolutionChange?: (longEdge: number) => void;
  /** Source retouching shares the same zoom/pan transform as the main preview. */
  content?: ReactNode;
  /** Keep the fitted photo centered in the unobscured part of an overlay viewport. */
  fitInsets?: { bottom?: number; right?: number };
  /**
   * Naik = putar sapuan "develop": garis cahaya tipis menyapu dari atas ke
   * bawah, mengganti foto asli (`original`) dengan hasil film. Dipakai saat
   * kembali dari Remove Object, yang memperlihatkan foto asli tanpa grading.
   */
  reveal?: number;
  brush?: {
    enabled: boolean;
    onStart: (point: Point, displayedWidth: number) => void;
    onMove: (point: Point) => void;
    onEnd: (cancel: boolean) => void;
  };
}) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [split, setSplit] = useState(0.5);
  const [peek, setPeek] = useState(false);
  const [slow, setSlow] = useState(false);
  const [aim, setAim] = useState<{ x: number; y: number } | null>(null);
  const [view, setView] = useState<View>(FIT);
  const [fullscreen, setFullscreen] = useState(false);
  /** Zoom di layar penuh (1 = pas layar), untuk meminta render lebih tajam. */
  const [fullscreenZoom, setFullscreenZoom] = useState(1);
  const tapTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(tapTimer.current), []);
  const reducedMotion = useReducedMotion();
  // Sapuan develop: dipasang sebelum frame pertama (layout effect) supaya
  // hasil film tidak sempat tampil dulu lalu tertimpa foto asli.
  const [sweep, setSweep] = useState(0);
  useLayoutEffect(() => {
    if (!reveal || reveal <= lastReveal) return;
    lastReveal = reveal;
    // Reduce Motion: pudar singkat sebagai ganti sapuan (bukan tanpa transisi).
    setSweep(reveal);
  }, [reveal]);
  const returnAnimation = useRef<{ stop: () => void } | null>(null);
  const wheelFrame = useRef(0);
  const wheelTarget = useRef<View | null>(null);
  const stopReturn = () => {
    returnAnimation.current?.stop();
    returnAnimation.current = null;
    cancelAnimationFrame(wheelFrame.current);
    wheelFrame.current = 0;
    wheelTarget.current = null;
  };
  useEffect(() => () => {
    returnAnimation.current?.stop();
    cancelAnimationFrame(wheelFrame.current);
  }, []);
  const holdTimer = useRef(0);
  const splitDrag = useRef(false);
  const pointers = useRef(new Map<number, Point>());
  const focusFrame = useRef(0);
  const pendingFocus = useRef<{ point: Point; pick: FocusOverlay['onPick'] } | null>(null);
  const gesture = useRef<
    | { kind: 'focus'; pointerId: number; offset: Point }
    | { kind: 'pan'; x: number; y: number; view: View; moved: boolean; t: number }
    | { kind: 'pinch'; dist: number; mid: Point; view: View }
    | { kind: 'tap'; x: number; y: number; moved: boolean }
    | { kind: 'brush'; pointerId: number }
    | null
  >(null);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    // Ukur sebelum frame pertama tergambar: tanpa ini, foto yang dipasang ulang
    // (mis. kembali dari Remove Object) berukuran nol satu frame = kedipan hitam.
    setArea({ width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      setArea({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Indikator render hanya bila lambat (> 350 ms), supaya tidak berkedip.
  useEffect(() => {
    if (!rendering) {
      setSlow(false);
      return;
    }
    const t = window.setTimeout(() => setSlow(true), 350);
    return () => window.clearTimeout(t);
  }, [rendering]);

  const shown = frame ?? original;
  const fitWidth = Math.max(1, area.width - (fitInsets?.right ?? 0));
  const fitHeight = Math.max(1, area.height - (fitInsets?.bottom ?? 0));
  let rect = { left: 0, top: 0, width: 0, height: 0 };
  if (shown && area.width > 0 && area.height > 0) {
    const scale = Math.min(fitWidth / shown.width, fitHeight / shown.height);
    const width = Math.round(shown.width * scale);
    const height = Math.round(shown.height * scale);
    rect = { left: Math.round((fitWidth - width) / 2), top: Math.round((fitHeight - height) / 2), width, height };
  }

  // Foto baru mulai dari pas.
  useEffect(() => {
    if (!onResolutionChange || !sourceSize || rect.width === 0) return;
    const nativeEdge = Math.max(sourceSize.width, sourceSize.height);
    const dpr = window.devicePixelRatio || 1;
    let shownEdge = Math.max(rect.width, rect.height) * view.s;
    // Layar penuh: render ulang setajam layar (sisi panjang kotak layar penuh x DPR).
    if (fullscreen) {
      const fit = Math.min(window.innerWidth / sourceSize.width, window.innerHeight / sourceSize.height);
      shownEdge = Math.max(shownEdge, nativeEdge * fit * fullscreenZoom);
    }
    const needed = Math.ceil(shownEdge * dpr / 256) * 256;
    const maxPixels = previewPixelBudget();
    const memoryEdge = Math.floor(Math.sqrt(maxPixels * nativeEdge / Math.min(sourceSize.width, sourceSize.height)));
    const timer = window.setTimeout(() => onResolutionChange(Math.min(nativeEdge, needed, memoryEdge)), fullscreen ? FULLSCREEN_RENDER_DELAY_MS : 180);
    return () => window.clearTimeout(timer);
  }, [onResolutionChange, sourceSize, rect.width, rect.height, view.s, photoKey, fullscreen, fullscreenZoom]);

  useEffect(() => {
    stopReturn();
    setView(FIT);
  }, [photoKey]);

  const clampView = (v: View): View => {
    if (rect.width === 0) return FIT;
    const s = Math.min(MAX_ZOOM, Math.max(1, v.s));
    return {
      s,
      tx: clampAxis(v.tx, s, rect.width, rect.left, fitWidth),
      ty: clampAxis(v.ty, s, rect.height, rect.top, fitHeight),
    };
  };
  const elasticView = (v: View): View => {
    const edge = clampView(v);
    return { ...edge, tx: edge.tx + elasticOffset(v.tx - edge.tx, area.width), ty: edge.ty + elasticOffset(v.ty - edge.ty, area.height) };
  };
  const dragOrigin = (): View => {
    const edge = clampView(view);
    return { ...view, tx: edge.tx + rawOffset(view.tx - edge.tx, area.width), ty: edge.ty + rawOffset(view.ty - edge.ty, area.height) };
  };
  const settleView = () => {
    stopReturn();
    const edge = clampView(view);
    if (reducedMotion || (edge.tx === view.tx && edge.ty === view.ty)) {
      setView(edge);
      return;
    }
    returnAnimation.current = animate(0, 1, {
      ...photoReturn,
      onUpdate: (progress) => setView({ s: edge.s, tx: view.tx + (edge.tx - view.tx) * progress, ty: view.ty + (edge.ty - view.ty) * progress }),
      onComplete: () => { returnAnimation.current = null; setView(edge); },
    });
  };
  /**
   * Pindah ke tampilan lain dengan pegas (Fit, ketuk dua kali), bukan lompat.
   * Zoom diinterpolasi logaritmik supaya laju perbesaran terasa rata dari
   * 4x ke 1x; geser ikut linear. Bisa disela gestur berikutnya (stopReturn).
   */
  const animateView = (target: View) => {
    stopReturn();
    const from = view;
    if (reducedMotion || (from.s === target.s && from.tx === target.tx && from.ty === target.ty)) {
      setView(target);
      return;
    }
    const ls0 = Math.log(from.s), ls1 = Math.log(target.s);
    returnAnimation.current = animate(0, 1, {
      ...viewSpring,
      onUpdate: (t) => setView({
        s: Math.exp(ls0 + (ls1 - ls0) * t),
        tx: from.tx + (target.tx - from.tx) * t,
        ty: from.ty + (target.ty - from.ty) * t,
      }),
      onComplete: () => { returnAnimation.current = null; setView(target); },
    });
  };
  /** Titik area (px) -> koordinat foto 0..1, memperhitungkan zoom. */
  const toPhoto = (ax: number, ay: number, v: View = view): Point => ({
    x: (ax - rect.left - v.tx) / (v.s * rect.width),
    y: (ay - rect.top - v.ty) / (v.s * rect.height),
  });
  /** Zoom ke skala `s` dengan titik area (ax, ay) tetap di tempatnya. */
  const zoomAt = (v: View, s: number, ax: number, ay: number): View => {
    const p = toPhoto(ax, ay, v);
    const clamped = Math.min(MAX_ZOOM, Math.max(1, s));
    return clampView({ s: clamped, tx: ax - rect.left - p.x * clamped * rect.width, ty: ay - rect.top - p.y * clamped * rect.height });
  };
  const latest = useRef({ clampView, zoomAt, view, reducedMotion });
  useLayoutEffect(() => {
    latest.current = { clampView, zoomAt, view, reducedMotion };
  });

  const local = (clientX: number, clientY: number): Point => {
    const box = areaRef.current?.getBoundingClientRect();
    return { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) };
  };

  // Roda / pinch trackpad (ctrl+roda): listener native non-pasif supaya
  // halaman tidak ikut di-zoom browser.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    let previousTime = 0;
    const advance = (now: number) => {
      const target = wheelTarget.current;
      if (!target) { wheelFrame.current = 0; return; }
      const from = latest.current.view;
      // Frame-rate-independent easing, retargeted from the current displayed
      // view. A wheel notch changes the destination, never jumps the photo.
      const dt = Math.min(64, Math.max(1, now - previousTime));
      previousTime = now;
      const amount = 1 - Math.exp(-dt / 70);
      const settled = Math.abs(target.s - from.s) < 0.0001 && Math.abs(target.tx - from.tx) < 0.05 && Math.abs(target.ty - from.ty) < 0.05;
      const next = settled ? target : {
        s: from.s + (target.s - from.s) * amount,
        tx: from.tx + (target.tx - from.tx) * amount,
        ty: from.ty + (target.ty - from.ty) * amount,
      };
      latest.current.view = next;
      setView(next);
      if (settled) { wheelTarget.current = null; wheelFrame.current = 0; }
      else wheelFrame.current = requestAnimationFrame(advance);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      returnAnimation.current?.stop();
      returnAnimation.current = null;
      const box = el.getBoundingClientRect();
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
      const factor = Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.002));
      const from = wheelTarget.current ?? latest.current.view;
      const target = latest.current.zoomAt(from, from.s * factor, e.clientX - box.left, e.clientY - box.top);
      if (latest.current.reducedMotion) {
        latest.current.view = target;
        setView(target);
        return;
      }
      wheelTarget.current = target;
      if (!wheelFrame.current) {
        previousTime = performance.now();
        wheelFrame.current = requestAnimationFrame(advance);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); cancelAnimationFrame(wheelFrame.current); };
  }, []);

  // Ukuran area berubah (rotasi, panel): jaga tampilan tetap sah.
  useEffect(() => {
    stopReturn();
    setView((v) => latest.current.clampView(v));
  }, [area.width, area.height, rect.width, rect.height]);

  const setSplitFrom = (clientX: number) => {
    if (rect.width === 0) return;
    setSplit(clamp01(toPhoto(local(clientX, 0).x, 0).x));
  };

  const picking = focus?.picking === true;
  const cancelFocusUpdate = () => {
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = 0;
    pendingFocus.current = null;
  };
  const flushFocusUpdate = () => {
    const pending = pendingFocus.current;
    cancelFocusUpdate();
    if (pending) pending.pick(pending.point.x, pending.point.y);
  };
  const pickAt = (p: Point) => {
    if (!focus) return;
    const offset = gesture.current?.kind === 'focus' ? gesture.current.offset : { x: 0, y: 0 };
    const uv = toPhoto(p.x - offset.x, p.y - offset.y);
    const point = { x: Number(clamp01(uv.x).toFixed(4)), y: Number(clamp01(uv.y).toFixed(4)) };
    setAim(point);
    // Coalesce pointer samples: depth selection and render parameters update
    // together once per display frame, with the last position flushed on release.
    pendingFocus.current = { point, pick: focus.onPreview ?? focus.onPick };
    if (!focusFrame.current) focusFrame.current = requestAnimationFrame(flushFocusUpdate);
  };
  useEffect(() => () => {
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = 0;
    pendingFocus.current = null;
  }, [photoKey]);
  // Posisi sementara hanya selama pin ditahan.
  const cursor = picking && focus ? (aim ?? { x: focus.x, y: focus.y }) : null;
  useEffect(() => {
    if (!picking) {
      setAim(null);
      return;
    }
  }, [picking]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!focus?.show) return;
    const point = cursor ?? focus;
    const step = e.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      if (!picking) focus.onPick(Number(clamp01(point.x + move[0]).toFixed(4)), Number(clamp01(point.y + move[1]).toFixed(4)));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelFocusUpdate();
      gesture.current = null;
      focus.onPreviewCancel?.();
      focus.onCancel?.();
    }
  };

  const twoPointers = (): [Point, Point] => [...pointers.current.values()].slice(0, 2) as [Point, Point];

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    stopReturn();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = local(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      if (gesture.current?.kind === 'brush') brush?.onEnd(true);
      cancelFocusUpdate();
      focus?.onPreviewCancel?.();
      setAim(null);
      // Pinch dua jari: batalkan seret/intip/pembagi yang sempat dimulai.
      const [a, b] = twoPointers();
      window.clearTimeout(holdTimer.current);
      setPeek(false);
      splitDrag.current = false;
      gesture.current = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view };
      return;
    }
    if (pointers.current.size > 2) return;
    if (brush?.enabled && e.button === 0) {
      const uv = toPhoto(p.x, p.y);
      if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return;
      gesture.current = { kind: 'brush', pointerId: e.pointerId };
      brush.onStart(uv, rect.width * view.s);
      return;
    }
    if (focus?.show && (e.target as HTMLElement).closest('[data-focus-pin]')) {
      window.clearTimeout(holdTimer.current);
      setPeek(false);
      gesture.current = { kind: 'focus', pointerId: e.pointerId, offset: {
        x: p.x - rect.left - view.tx - focus.x * view.s * rect.width,
        y: p.y - rect.top - view.ty - focus.y * view.s * rect.height,
      } };
      setAim({ x: focus.x, y: focus.y });
      focus.onStart();
      return;
    }
    if (compare) {
      splitDrag.current = true;
      setSplitFrom(e.clientX);
      return;
    }
    gesture.current = { kind: 'pan', x: p.x, y: p.y, view: dragOrigin(), moved: false, t: performance.now() };
    window.clearTimeout(holdTimer.current);
    if (!brush) holdTimer.current = window.setTimeout(() => setPeek(true), 220);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (g?.kind === 'brush' && g.pointerId === e.pointerId) {
      const uv = toPhoto(p.x, p.y);
      brush?.onMove({ x: clamp01(uv.x), y: clamp01(uv.y) });
      return;
    }
    if (g?.kind === 'focus' && g.pointerId === e.pointerId) {
      pickAt(p);
      return;
    }
    if (g?.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = twoPointers();
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Zoom di titik tengah awal, lalu ikut geseran titik tengahnya.
      const next = zoomAt(g.view, g.view.s * (dist / Math.max(g.dist, 1)), g.mid.x, g.mid.y);
      setView(elasticView({ ...next, tx: next.tx + mid.x - g.mid.x, ty: next.ty + mid.y - g.mid.y }));
      return;
    }
    if (splitDrag.current) {
      setSplitFrom(e.clientX);
      return;
    }
    if (g?.kind === 'pan' || g?.kind === 'tap') {
      const dx = p.x - g.x;
      const dy = p.y - g.y;
      if (!g.moved && Math.hypot(dx, dy) > DRAG_SLOP) {
        g.moved = true;
        window.clearTimeout(holdTimer.current);
        setPeek(false);
      }
      if (g.kind === 'pan' && g.moved) setView(elasticView({ s: g.view.s, tx: g.view.tx + dx, ty: g.view.ty + dy }));
    }
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    const tracked = pointers.current.delete(e.pointerId);
    if (tracked && g?.kind === 'brush' && g.pointerId === e.pointerId) brush?.onEnd(e.type !== 'pointerup');
    if (tracked && g?.kind === 'focus' && g.pointerId === e.pointerId) {
      if (e.type === 'pointerup') {
        pickAt(local(e.clientX, e.clientY));
        const finalPoint = pendingFocus.current!.point;
        flushFocusUpdate();
        if (focus?.onPreview) focus.onPick(finalPoint.x, finalPoint.y);
      } else {
        cancelFocusUpdate();
        focus?.onPreviewCancel?.();
        setAim(null);
      }
    }
    // Ketukan singkat tanpa geser membuka layar penuh, ditunda sebentar supaya
    // ketuk/klik dua kali tetap berarti zoom.
    if (tracked && e.type === 'pointerup' && g?.kind === 'pan' && !g.moved && pointers.current.size === 0
        && performance.now() - g.t < TAP_MAX_MS && canFullscreen) {
      window.clearTimeout(tapTimer.current);
      tapTimer.current = window.setTimeout(() => setFullscreen(true), DOUBLE_TAP_MS);
    }
    // Pinch yang tinggal satu jari berhenti; gestur satu jari berakhir saat dilepas.
    if (g?.kind !== 'pinch' || pointers.current.size < 2) gesture.current = null;
    splitDrag.current = false;
    window.clearTimeout(holdTimer.current);
    setPeek(false);
    if (tracked && pointers.current.size === 0) settleView();
  };
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    window.clearTimeout(tapTimer.current);
    if (picking || brush?.enabled || (e.target as HTMLElement).closest('button, [role=slider]')) return;
    const p = local(e.clientX, e.clientY);
    animateView(view.s > 1.01 ? clampView(FIT) : zoomAt(view, DOUBLE_CLICK_ZOOM, p.x, p.y));
  };
  const zoomed = view.s > 1.01;
  /** Posisi (px, relatif kotak foto pas) dari koordinat foto 0..1. */
  const sx = (u: number) => view.tx + u * view.s * rect.width;
  const sy = (v: number) => view.ty + v * view.s * rect.height;

  const showOriginal = !!original && !picking && (compare || peek);
  const canFullscreen = !!frame && !content && !brush && !compare && !picking;
  /** Posisi foto di layar sekarang (ikut zoom/geser): titik awal/akhir animasi layar penuh. */
  const photoBox = (): Box | null => {
    const box = areaRef.current?.getBoundingClientRect();
    if (!box || rect.width === 0) return null;
    return { left: box.left + rect.left + view.tx, top: box.top + rect.top + view.ty, width: rect.width * view.s, height: rect.height * view.s };
  };
  const clip = compare ? `inset(0 ${(1 - split) * 100}% 0 0)` : 'inset(0 0 0 0)';

  return (
    <div
      ref={areaRef}
      tabIndex={picking ? 0 : -1}
      role={picking ? 'application' : undefined}
      aria-label={picking ? 'Focus point. Hold and drag to select. Arrow keys move it, Enter picks the subject, Escape cancels.' : undefined}
      onKeyDown={onKeyDown}
      style={{ position: 'absolute', inset: 0, overflow: brush ? 'hidden' : 'visible', outline: 'none', touchAction: 'none', cursor: picking || brush?.enabled ? 'crosshair' : shown && !compare ? 'grab' : undefined, WebkitUserSelect: 'none', userSelect: 'none', WebkitTouchCallout: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* initial={false}: foto yang sudah ada saat dipasang (ganti mode) tampil langsung;
          hanya foto baru (photoKey berganti) yang memudar masuk. */}
      <AnimatePresence mode="popLayout" initial={false}>
        {shown && (
          <motion.div
            key={photoKey}
            role="img"
            aria-label={label}
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={fade}
            // Selama layar penuh (termasuk animasi buka/tutup) salinan di editor
            // disembunyikan, supaya tidak tampak dua foto di balik latar yang memudar.
            style={{ position: 'absolute', left: rect.left, top: rect.top, width: rect.width, height: rect.height, visibility: fullscreen ? 'hidden' : undefined }}
          >
            <div style={{ position: 'absolute', inset: 0, transformOrigin: '0 0', transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s})` }}>
              {content ?? (frame && <FrameCanvas key={frame.colorSpace} frame={frame} />)}
              {picking && focusMask && <FrameCanvas frame={focusMask} style={{ pointerEvents: 'none' }} />}
              {showOriginal && original && (
                <motion.div
                  initial={{ opacity: compare ? 1 : 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.12 }}
                  style={{ position: 'absolute', inset: 0, clipPath: clip }}
                >
                  <FrameCanvas frame={original} />
                </motion.div>
              )}
              {sweep > 0 && original && (
                // Animasi CSS transform (compositor): tetap mulus walau thread
                // utama sibuk memasang foto resolusi tinggi saat kembali dari
                // Remove. Pembungkus turun sementara isinya naik sama jauh, jadi
                // foto asli diam dan tepi atasnya menyingkap hasil film.
                <div key={`reveal-${sweep}`} aria-hidden="true" className={`photo-reveal${reducedMotion ? ' is-fade' : ''}`}>
                  <div
                    className="photo-reveal-cover"
                    onAnimationEnd={(e) => { if (e.target === e.currentTarget) setSweep(0); }}
                  >
                    <div className="photo-reveal-photo"><FrameCanvas frame={original} /></div>
                  </div>
                  {!reducedMotion && <div className="photo-reveal-scan"><div className="photo-reveal-line" /></div>}
                </div>
              )}
            </div>
            {compare && !picking && (
              <>
                <div aria-hidden="true" style={{ position: 'absolute', top: sy(0), height: rect.height * view.s, left: sx(split), width: 2, marginLeft: -1, background: 'rgba(255,255,255,0.92)' }} />
                <div
                  className="glass-clear split-handle"
                  role="slider"
                  tabIndex={0}
                  aria-label="Before and after divider"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(split * 100)}
                  aria-valuetext={`${Math.round(split * 100)}% original`}
                  onKeyDown={(e) => {
                    const step = e.shiftKey ? 0.1 : 0.02;
                    const next: Record<string, number> = { ArrowLeft: split - step, ArrowDown: split - step, ArrowRight: split + step, ArrowUp: split + step, Home: 0, End: 1 };
                    if (!(e.key in next)) return;
                    e.preventDefault();
                    setSplit(clamp01(next[e.key]!));
                  }}
                  style={{ position: 'absolute', top: Math.min(Math.max(sy(0.5), 18), rect.height - 18), left: sx(split), width: 36, height: 36, marginLeft: -18, marginTop: -18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Icon name="compare" size={18} />
                </div>
                <span className="glass-clear t-footnote" style={{ position: 'absolute', top: 10, right: rect.width - sx(split) + 8, padding: '4px 10px', borderRadius: 'var(--r-control)', fontWeight: 600, opacity: split > 0.12 ? 1 : 0 }}>Before</span>
                <span className="glass-clear t-footnote" style={{ position: 'absolute', top: 10, left: sx(split) + 8, padding: '4px 10px', borderRadius: 'var(--r-control)', fontWeight: 600, opacity: split < 0.88 ? 1 : 0 }}>After</span>
              </>
            )}
            {focus && (focus.show || picking) && (
              // Penanda fokus seperti EMULSION: lingkaran 30 px bertepi putih
              // dengan titik tengah. Saat memilih, langsung mengikuti pointer.
              <motion.div
                data-focus-pin=""
                role="button"
                tabIndex={0}
                aria-label="Focus point. Drag to focus, or use arrow keys."
                onKeyDown={(e) => { e.stopPropagation(); onKeyDown(e); }}
                initial={false}
                animate={{ transform: `translate(${sx((cursor ?? focus).x) - 22}px, ${sy((cursor ?? focus).y) - 22}px)` }}
                transition={{ duration: 0 }}
                style={{
                  position: 'absolute', left: 0, top: 0, width: 44, height: 44, borderRadius: '50%',
                  cursor: picking ? 'grabbing' : 'grab', touchAction: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <span style={{ position: 'absolute', width: 30, height: 30, boxSizing: 'border-box', border: '1.5px solid #fff', borderRadius: '50%', boxShadow: '0 0 0 1px rgba(0,0,0,0.55)', pointerEvents: 'none' }} />
                <span style={{ width: 4, height: 4, borderRadius: '50%', background: '#fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.45)' }} />
              </motion.div>
            )}
            {picking && (
              <span className="glass-clear t-footnote" role="status" style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', padding: '4px 12px', borderRadius: 'var(--r-control)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                Hold & drag to focus · grey is outside focus
              </span>
            )}
            {peek && !compare && !picking && (
              <span className="glass-clear t-footnote" style={{ position: 'absolute', top: 10, left: 10, padding: '4px 10px', borderRadius: 'var(--r-control)', fontWeight: 600 }}>Original</span>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {/* Status di kanan atas: Developing di sebelah zoom; geser mulus saat zoom muncul/hilang. */}
      <div className="photo-status" style={fitInsets?.right ? { right: fitInsets.right + 10 } : undefined}>
        <AnimatePresence initial={false} mode="popLayout">
          {slow && (
            <motion.span
              key="developing"
              layout
              className="glass-clear t-footnote photo-status-pill"
              role="status"
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              transition={statusSpring}
              style={{ padding: '0 10px 0 7px' }}
            >
              <Spinner size={15} /> Developing
            </motion.span>
          )}
          {zoomed && (
            <motion.button
              key="zoom"
              layout
              type="button"
              className="glass-clear t-footnote tabular photo-status-pill"
              title="Fit to view (double-click)"
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92 }}
              whileTap={{ scale: 0.94 }}
              transition={statusSpring}
              onClick={() => animateView(clampView(FIT))}
              style={{ padding: '0 10px', border: 0, color: '#fff', cursor: 'pointer' }}
            >
              {Math.round(view.s * 100)}% <span className="secondary">· Fit</span>
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      {frame && (
        <PhotoLightbox
          open={fullscreen && canFullscreen}
          aspect={frame}
          label={label}
          source={photoBox}
          busy={slow}
          onClose={() => { setFullscreen(false); setFullscreenZoom(1); }}
          onZoom={setFullscreenZoom}
          original={original && <FrameCanvas key={`o-${original.colorSpace}`} frame={original} />}
        >
          <FrameCanvas key={frame.colorSpace} frame={frame} />
        </PhotoLightbox>
      )}
    </div>
  );
}
