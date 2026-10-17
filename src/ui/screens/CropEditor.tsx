/**
 * Crop & Rotate seperti galeri HP: kotak potong dengan sudut/tepi yang bisa
 * diseret, foto digeser bebas di bawahnya, cubit untuk memperbesar, rasio
 * (Free, Original, persegi, 4:5 ...), luruskan +-45 derajat dengan penggaris,
 * putar 90 derajat, cermin, Reset. Foto di luar kotak tetap terlihat redup.
 *
 * Geometri di `io/geometry.ts` (satuan lebar foto = 1); di sini hanya
 * tampilan dan gesture. Selama seretan skala tampilan dibekukan; setelah
 * dilepas, kotak dipaskan lagi ke area (beranimasi).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Frame } from '../engine/display';
import { cropFits, fitCrop, identityCrop, isIdentityCrop, rotateQuarter, totalAngle, withAspect } from '../../io/geometry';
import type { Crop } from '../../io/geometry';
import { Icon } from '../components/Icon';
import { PressButton } from '../components/controls';
import { RulerSlider } from '../components/RulerSlider';
import { haptic } from '../haptics';

const ASPECTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'free', label: 'Free' },
  { id: 'original', label: 'Original' },
  { id: '1:1', label: 'Square' },
  { id: '4:5', label: '4:5' },
  { id: '5:4', label: '5:4' },
  { id: '3:4', label: '3:4' },
  { id: '4:3', label: '4:3' },
  { id: '2:3', label: '2:3' },
  { id: '3:2', label: '3:2' },
  { id: '9:16', label: '9:16' },
  { id: '16:9', label: '16:9' },
];

/** Jangkauan sentuh sudut/tepi (px), potongan terkecil (px tampilan / bagian lebar foto). */
const HANDLE = 28;
const MIN_BOX = 56;
const MIN_CROP = 0.04;
const RAD = Math.PI / 180;

type Edge = { l: boolean; r: boolean; t: boolean; b: boolean };
type Gesture =
  | { kind: 'pan'; x: number; y: number; start: Crop }
  | { kind: 'resize'; x: number; y: number; start: Crop; edge: Edge }
  | { kind: 'pinch'; dist: number; start: Crop; k: number };

/** Ukuran tampilan potongan (W-unit -> px) agar pas di area. */
function fitScale(c: Crop, area: { width: number; height: number }): number {
  return Math.max(1e-3, Math.min(area.width / c.w, area.height / c.h));
}

/** Geser pusat potongan sejauh `d` (W-unit, ruang tampilan) -> ruang sumber. */
function displayToSource(c: Crop, dx: number, dy: number): { x: number; y: number } {
  const x = c.flip ? -dx : dx;
  const phi = totalAngle(c) * RAD, cos = Math.cos(phi), sin = Math.sin(phi);
  return { x: x * cos + dy * sin, y: -x * sin + dy * cos };
}

/** Bagian terjauh dari `from` ke `to` yang masih muat di foto (bisect). */
function furthestFitting(from: Crop, to: Crop, a: number): Crop {
  if (cropFits(to, a)) return to;
  const mix = (t: number): Crop => ({ ...to, cx: from.cx + (to.cx - from.cx) * t, cy: from.cy + (to.cy - from.cy) * t, w: from.w + (to.w - from.w) * t, h: from.h + (to.h - from.h) * t });
  let lo = 0, hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (cropFits(mix(mid), a)) lo = mid; else hi = mid;
  }
  return mix(lo);
}

export function CropEditor({ frame, sourceWidth, initial, onCancel, onDone }: {
  frame: Frame;
  /** Lebar foto asli (px) untuk ukuran keluaran. */
  sourceWidth: number;
  initial: Crop | undefined;
  onCancel: () => void;
  onDone: (crop: Crop | undefined) => void;
}) {
  const a = frame.height / frame.width;
  const [crop, setCrop] = useState<Crop>(() => initial ?? identityCrop(a));
  const areaRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  /** Skala tampilan beku selama gesture (kotak tidak dipaskan ulang di tengah seretan). */
  const [frozenK, setFrozenK] = useState<number | undefined>();
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** Potongan saat penggaris luruskan mulai diseret: meluruskan bisa dibalik tanpa menyusutkan permanen. */
  const straightenBase = useRef<Crop | null>(null);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const measure = () => setArea({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = frame.width;
    c.height = frame.height;
    c.getContext('2d', { colorSpace: frame.colorSpace })?.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height, { colorSpace: frame.colorSpace }), 0, 0);
  }, [frame]);

  // Ruang di sekitar kotak untuk pegangan.
  const pad = 22;
  const inner = { width: Math.max(1, area.width - pad * 2), height: Math.max(1, area.height - pad * 2) };
  const k = frozenK ?? fitScale(crop, inner);
  const box = { width: crop.w * k, height: crop.h * k };
  const center = { x: area.width / 2, y: area.height / 2 };
  const boxLeft = center.x - box.width / 2, boxTop = center.y - box.height / 2;
  // Animasi pas-ulang hanya setelah tata letak pertama (tanpa animasi dari ukuran nol saat dibuka).
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    if (area.width === 0 || placed) return undefined;
    const id = requestAnimationFrame(() => setPlaced(true));
    return () => cancelAnimationFrame(id);
  }, [area.width, placed]);
  const settling = frozenK === undefined && placed;

  const local = (e: { clientX: number; clientY: number }) => {
    const r = areaRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const edgeAt = (p: { x: number; y: number }): Edge | null => {
    const l = Math.abs(p.x - boxLeft) < HANDLE, r = Math.abs(p.x - (boxLeft + box.width)) < HANDLE;
    const t = Math.abs(p.y - boxTop) < HANDLE, b = Math.abs(p.y - (boxTop + box.height)) < HANDLE;
    const inX = p.x > boxLeft - HANDLE && p.x < boxLeft + box.width + HANDLE;
    const inY = p.y > boxTop - HANDLE && p.y < boxTop + box.height + HANDLE;
    const edge = { l: l && inY, r: r && !l && inY, t: t && inX, b: b && !t && inX };
    return edge.l || edge.r || edge.t || edge.b ? edge : null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* event sintetis */ }
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    setFrozenK(k);
    if (pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()];
      gesture.current = { kind: 'pinch', dist: Math.hypot(p1!.x - p2!.x, p1!.y - p2!.y), start: crop, k };
      return;
    }
    const edge = edgeAt(p);
    gesture.current = edge ? { kind: 'resize', x: p.x, y: p.y, start: crop, edge } : { kind: 'pan', x: p.x, y: p.y, start: crop };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch') {
      const [p1, p2] = [...pointers.current.values()];
      if (!p1 || !p2) return;
      const s = Math.max(0.2, Math.hypot(p1.x - p2.x, p1.y - p2.y) / g.dist);
      // Cubit memperbesar foto: potongan mengecil, kotak di layar tetap.
      const scale = Math.min(8, Math.max(MIN_CROP / Math.min(g.start.w, g.start.h), 1 / s));
      const next = fitCrop({ ...g.start, w: g.start.w * scale, h: g.start.h * scale }, a);
      setFrozenK(g.k * (g.start.w / next.w));
      setCrop(next);
      return;
    }
    const kk = frozenK ?? k;
    const dx = (p.x - g.x) / kk, dy = (p.y - g.y) / kk;
    if (g.kind === 'pan') {
      // Foto mengikuti jari: pusat potongan bergerak berlawanan.
      const d = displayToSource(g.start, -dx, -dy);
      setCrop(fitCrop({ ...g.start, cx: g.start.cx + d.x, cy: g.start.cy + d.y }, a));
      return;
    }
    // Ubah ukuran: tepi seberang diam.
    const s = g.start, e2 = g.edge;
    let left = -s.w / 2, right = s.w / 2, top = -s.h / 2, bottom = s.h / 2;
    const min = MIN_BOX / kk;
    if (e2.l) left = Math.min(right - min, left + dx);
    if (e2.r) right = Math.max(left + min, right + dx);
    if (e2.t) top = Math.min(bottom - min, top + dy);
    if (e2.b) bottom = Math.max(top + min, bottom + dy);
    const ratio = s.aspect === 'free' ? undefined : s.w / s.h;
    if (ratio) {
      // Rasio terkunci: sisi yang digeser menentukan; sisi lain mengikuti dari tengah/sudut seberang.
      let w = right - left, h = bottom - top;
      const horizontal = (e2.l || e2.r) && (!(e2.t || e2.b) || Math.abs(dx) >= Math.abs(dy));
      if (horizontal) h = w / ratio; else w = h * ratio;
      if (e2.l && !e2.r) left = right - w; else if (e2.r) right = left + w; else { left = -w / 2; right = w / 2; }
      if (e2.t && !e2.b) top = bottom - h; else if (e2.b) bottom = top + h; else { top = -h / 2; bottom = h / 2; }
    }
    const shift = displayToSource(s, (left + right) / 2, (top + bottom) / 2);
    const next: Crop = { ...s, w: right - left, h: bottom - top, cx: s.cx + shift.x, cy: s.cy + shift.y };
    setCrop(furthestFitting(s, next, a));
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) {
      // Cubit selesai dengan satu jari tersisa: lanjut geser dari sini.
      const [rest] = [...pointers.current.values()];
      if (rest && gesture.current?.kind === 'pinch') gesture.current = { kind: 'pan', x: rest.x, y: rest.y, start: crop };
      return;
    }
    gesture.current = null;
    setFrozenK(undefined);
  };

  const straighten = (angle: number) => {
    const base = straightenBase.current ?? crop;
    setCrop(fitCrop({ ...base, angle }, a));
  };

  const setAspect = (id: string) => {
    haptic();
    setCrop((c) => withAspect({ ...c, aspect: id }, id, a));
  };

  const modified = !isIdentityCrop(crop, a) || crop.aspect !== 'free';
  const phi = totalAngle(crop);
  // Foto penuh di tampilan: pusat potongan di tengah area.
  const imageStyle: React.CSSProperties = {
    position: 'absolute', left: center.x, top: center.y, width: k, height: k * a,
    transformOrigin: '0 0',
    transform: `${crop.flip ? 'scaleX(-1) ' : ''}rotate(${phi}deg) translate(${-crop.cx * k}px, ${-crop.cy * k}px)`,
    transition: settling ? 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1), width 0.3s cubic-bezier(0.25, 1, 0.5, 1), height 0.3s cubic-bezier(0.25, 1, 0.5, 1), left 0.3s, top 0.3s' : 'none',
  };
  const boxStyle: React.CSSProperties = {
    left: boxLeft, top: boxTop, width: box.width, height: box.height,
    transition: settling ? 'all 0.3s cubic-bezier(0.25, 1, 0.5, 1)' : 'none',
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onDone(isIdentityCrop(crop, a) ? undefined : crop);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [crop, a, onCancel, onDone]);

  return (
    <div className="crop-editor" role="dialog" aria-modal="true" aria-label="Crop and rotate">
      <div className="crop-top">
        <button type="button" className="crop-text-btn" onClick={onCancel}>Cancel</button>
        <span className="crop-title">{modified ? 'Crop' : 'Crop & Rotate'}</span>
        <button type="button" className="crop-text-btn is-done" onClick={() => onDone(isIdentityCrop(crop, a) ? undefined : crop)}>Done</button>
      </div>

      <div
        ref={areaRef}
        className="crop-area"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onWheel={(e) => {
          // Roda/pinch trackpad: perbesar foto di dalam kotak.
          const scale = Math.exp(e.deltaY * 0.002);
          setCrop((c) => {
            const s = Math.max(MIN_CROP / Math.min(c.w, c.h), scale);
            return fitCrop({ ...c, w: c.w * s, h: c.h * s }, a);
          });
        }}
      >
        <canvas ref={canvasRef} className="crop-image" style={imageStyle} />
        <div className="crop-box" data-active={frozenK === undefined ? undefined : ''} style={boxStyle}>
          <i className="crop-grid" />
          <span className="crop-corner tl" /><span className="crop-corner tr" /><span className="crop-corner bl" /><span className="crop-corner br" />
        </div>
      </div>

      <div className="crop-controls">
        <div className="crop-straighten">
          <span className="crop-angle tabular">{crop.angle === 0 ? 'Straighten' : `${crop.angle > 0 ? '+' : ''}${crop.angle.toFixed(1)}°`}</span>
          <RulerSlider
            value={crop.angle}
            min={-45}
            max={45}
            step={0.1}
            defaultValue={0}
            label="Straighten"
            valueText={`${crop.angle.toFixed(1)} degrees`}
            onChange={straighten}
            onInteractionChange={(active) => { straightenBase.current = active ? crop : null; }}
          />
        </div>
        <div className="crop-aspects" role="radiogroup" aria-label="Aspect ratio">
          {ASPECTS.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={crop.aspect === x.id} className="crop-aspect" onClick={() => setAspect(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <div className="crop-actions">
          <PressButton className="icon-btn glass float-btn" aria-label="Rotate 90°" title="Rotate 90°" onClick={() => { haptic(); setCrop((c) => rotateQuarter(c, a)); }}>
            <Icon name="rotate" size={19} />
          </PressButton>
          <PressButton className="icon-btn glass float-btn" aria-label="Flip horizontally" title="Flip" aria-pressed={crop.flip} onClick={() => { haptic(); setCrop((c) => ({ ...c, flip: !c.flip })); }}>
            <Icon name="flip" size={19} />
          </PressButton>
          <span className="crop-readout secondary">{`${Math.round(crop.w * sourceWidth)} × ${Math.round(crop.h * sourceWidth)}`}</span>
          <button type="button" className="crop-text-btn" disabled={!modified} onClick={() => { haptic(); setCrop(identityCrop(a)); }}>Reset</button>
        </div>
      </div>
    </div>
  );
}
