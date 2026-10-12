import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { PressButton, Slider } from '../components/controls';
import { PhotoView } from '../components/PhotoView';
import { Icon } from '../components/Icon';
import { engine } from '../engine/engine';
import type { RefineResult } from '../engine/engine';
import type { Frame } from '../engine/display';
import { DepthCancelledError, DepthNotCachedError } from '../../depth/estimate';
import { MATTE_MODEL } from '../../depth/model';

/**
 * Refine Edge (seperti Refine Edge Brush After Effects): sapu tepi rambut,
 * ViTMatte menghitung matte di pita sapuan, dan lens blur memisahkan helai
 * tajam dari latar yang blur. Tampilan Matte menunjukkan hasilnya hitam-putih
 * di dalam pita, seperti overlay AE.
 */
type Stroke = { radius: number; erase: boolean; points: Array<{ x: number; y: number }> };

export function RefineEdgeContent({ original, previewTarget, controlsTarget, compact = false, landscape = false, onClose }: { original: Frame; previewTarget: HTMLElement; controlsTarget: HTMLElement; compact?: boolean; landscape?: boolean; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const paintFrame = useRef(0);
  const mounted = useRef(true);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const active = useRef<Stroke | null>(null);
  const [size, setSize] = useState(40);
  const [mode, setMode] = useState<'brush' | 'erase' | 'move'>('brush');
  const [busy, setBusy] = useState(false);
  const [needsDownload, setNeedsDownload] = useState(false);
  const [status, setStatus] = useState(engine.refine ? 'Refine Edge is on. Brush again to redo it.' : 'Brush along the hair or edge, then choose Refine.');
  const [error, setError] = useState('');
  const [result, setResult] = useState<RefineResult | undefined>(engine.refine);
  const [showMatte, setShowMatte] = useState(!!engine.refine);
  const [fitInsets, setFitInsets] = useState<{ bottom?: number; right?: number }>({});

  useLayoutEffect(() => {
    if (!compact) return;
    const panel = controlsTarget.closest('.mobile-adjustments');
    if (!panel) return;
    const measure = () => {
      const preview = previewTarget.getBoundingClientRect();
      const controls = panel.getBoundingClientRect();
      const next: { bottom?: number; right?: number } = landscape
        ? { right: Math.max(0, Math.round(preview.right - controls.left + 12)) }
        : { bottom: Math.max(0, Math.round(preview.bottom - controls.top + 12)) };
      setFitInsets(previous => previous.bottom === next.bottom && previous.right === next.right ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(previewTarget);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [compact, landscape, previewTarget, controlsTarget]);

  const paintMask = (items: Stroke[]) => {
    const mask = document.createElement('canvas'); mask.width = original.width; mask.height = original.height;
    const ctx = mask.getContext('2d')!;
    ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const stroke of items) {
      ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
      ctx.lineWidth = stroke.radius * 2;
      const p = stroke.points[0]!; ctx.beginPath(); ctx.arc(p.x, p.y, stroke.radius, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(p.x, p.y); for (const point of stroke.points) ctx.lineTo(point.x, point.y); ctx.stroke();
    }
    return mask;
  };

  const draw = (items = strokes) => {
    const el = canvas.current; if (!el) return;
    const ctx = el.getContext('2d', { colorSpace: original.colorSpace })!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(original.pixels), original.width, original.height, { colorSpace: original.colorSpace }), 0, 0);
    if (showMatte && result && items.length === 0) {
      // Matte hitam-putih di dalam pita (seperti overlay AE), foto di luarnya.
      const { rect, width, height, alpha, band } = result;
      const pixels = ctx.getImageData(0, 0, el.width, el.height, { colorSpace: original.colorSpace });
      const x0 = Math.floor(rect.x * el.width), x1 = Math.ceil((rect.x + rect.w) * el.width);
      const y0 = Math.floor(rect.y * el.height), y1 = Math.ceil((rect.y + rect.h) * el.height);
      for (let y = Math.max(0, y0); y < Math.min(el.height, y1); y += 1) {
        const my = Math.min(height - 1, Math.floor(((y + 0.5) / el.height - rect.y) / rect.h * height));
        for (let x = Math.max(0, x0); x < Math.min(el.width, x1); x += 1) {
          const mx = Math.min(width - 1, Math.floor(((x + 0.5) / el.width - rect.x) / rect.w * width));
          if (mx < 0 || my < 0) continue;
          const m = my * width + mx;
          if (!band[m]) continue;
          const v = alpha[m]! * 255, i = (y * el.width + x) * 4;
          pixels.data[i] = v; pixels.data[i + 1] = v; pixels.data[i + 2] = v;
        }
      }
      ctx.putImageData(pixels, 0, 0);
      return;
    }
    const mask = paintMask(items), m = mask.getContext('2d')!, pixels = m.getImageData(0, 0, mask.width, mask.height);
    for (let i = 0; i < pixels.data.length; i += 4) { pixels.data[i] = 120; pixels.data[i + 1] = 200; pixels.data[i + 2] = 255; pixels.data[i + 3] = pixels.data[i + 3]! * 0.5; }
    m.putImageData(pixels, 0, 0); ctx.drawImage(mask, 0, 0);
  };
  useLayoutEffect(() => { draw(); });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelAnimationFrame(paintFrame.current); }; }, []);

  const point = (uv: { x: number; y: number }) => ({ x: uv.x * original.width, y: uv.y * original.height });
  const finish = (cancel: boolean) => {
    cancelAnimationFrame(paintFrame.current); paintFrame.current = 0;
    const stroke = active.current;
    if (stroke && !cancel) setStrokes(items => [...items, stroke]);
    active.current = null;
    draw(strokes);
  };

  const refine = async (allowDownload: boolean) => {
    setBusy(true); setError(''); setNeedsDownload(false); setStatus('Preparing the edge…');
    try {
      const mask = paintMask(strokes), pixels = mask.getContext('2d')!.getImageData(0, 0, mask.width, mask.height).data;
      const data = Uint8Array.from({ length: mask.width * mask.height }, (_, i) => pixels[i * 4 + 3]! > 32 ? 1 : 0);
      const next = await engine.refineEdges({ width: mask.width, height: mask.height, data }, {
        allowDownload,
        onProgress: (p) => {
          if (!mounted.current) return;
          const pct = p.total > 0 ? ` ${Math.round((100 * p.loaded) / p.total)}%` : '';
          setStatus(p.phase === 'model' ? `Downloading ${MATTE_MODEL.name}…${pct}` : p.phase === 'compile' ? 'Preparing the matting model…' : `Refining the edge…${pct}`);
        },
      });
      if (!mounted.current) return;
      setResult(next); setStrokes([]); setShowMatte(true);
      setStatus('Done. White is kept sharp, black is blurred. Brush again to redo.');
    } catch (e) {
      if (!mounted.current || e instanceof DepthCancelledError) return;
      if (e instanceof DepthNotCachedError) { setNeedsDownload(true); setStatus(''); return; }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try { await engine.clearRefine(); setResult(undefined); setStrokes([]); setShowMatte(false); setStatus('Refine Edge removed.'); }
    finally { setBusy(false); }
  };

  const brushing = mode !== 'move' && !busy;
  return <>
    {createPortal(<div className="remove-preview"><PhotoView frame={original} compare={false} rendering={false} photoKey="refine-edge" label="Photo for Refine Edge" fitInsets={fitInsets}
      content={<canvas ref={canvas} width={original.width} height={original.height} aria-label="Refine Edge brush canvas" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', maxHeight: 'none' }} />}
      brush={{ enabled: brushing,
        onStart: (uv, width) => { setShowMatte(false); active.current = { radius: size * original.width / width / 2, erase: mode === 'erase', points: [point(uv)] }; draw([...strokes, active.current]); },
        onMove: uv => { if (!active.current) return; active.current.points.push(point(uv)); if (!paintFrame.current) paintFrame.current = requestAnimationFrame(() => { paintFrame.current = 0; if (active.current) draw([...strokes, active.current]); }); },
        onEnd: finish,
      }} />
    </div>, previewTarget)}
    {createPortal(<div className={`remove-controls${compact ? ' is-compact' : ''}`}>
      <div className="mobile-tool-heading"><div><h2 className="t-headline" style={{ margin: 0 }}>Refine Edge</h2><span className="t-caption secondary">Lens blur · hair and fine edges</span></div><PressButton className="capsule prominent" disabled={busy} onClick={onClose}>Done</PressButton></div>
      <div className="remove-brush">
        <div className="t-footnote" style={{ display: 'flex', justifyContent: 'space-between' }}><span>Brush size</span><span className="tabular secondary">{size} px</span></div>
        <Slider label="Brush size" value={size} min={8} max={160} step={1} defaultValue={40} valueText={`${size} px`} disabled={busy} onChange={setSize} />
      </div>
      <div className="remove-actions">
        <PressButton className="capsule" aria-pressed={mode === 'brush'} disabled={busy} onClick={() => setMode('brush')}><Icon name="erase" size={16} /> Brush</PressButton>
        <PressButton className="capsule" aria-pressed={mode === 'erase'} disabled={busy} onClick={() => setMode('erase')}>Erase</PressButton>
        <PressButton className="capsule" aria-pressed={mode === 'move'} onClick={() => setMode('move')}><Icon name="move" size={16} /> Move</PressButton>
        <PressButton className="capsule" disabled={busy || !strokes.length} onClick={() => setStrokes(strokes.slice(0, -1))}><Icon name="undo" size={16} /> Undo</PressButton>
        {result && !strokes.length && <PressButton className="capsule" aria-pressed={showMatte} disabled={busy} onClick={() => setShowMatte(!showMatte)}>{showMatte ? 'Photo' : 'Matte'}</PressButton>}
        {result && <PressButton className="capsule" disabled={busy} onClick={() => void clear()}>Remove</PressButton>}
        {needsDownload
          ? <PressButton className="capsule prominent" disabled={busy} onClick={() => void refine(true)}>Download · {Math.round(MATTE_MODEL.bytes / 1e6)} MB</PressButton>
          : <PressButton className="capsule prominent" disabled={busy || !strokes.length} onClick={() => void refine(false)}><Icon name={busy ? 'loader' : 'lens'} size={16} /> {busy ? 'Working…' : 'Refine'}</PressButton>}
      </div>
      {needsDownload && <p className="t-footnote" style={{ margin: 0 }}>Refine Edge needs a one-time download of {MATTE_MODEL.name}. It stays on this device; photos never leave it.</p>}
      {status && <p className="t-footnote secondary" role="status" style={{ margin: 0 }}>{status}</p>}
      {error && <p className="t-footnote" role="alert" style={{ color: 'var(--red-text)', margin: 0 }}>{error}</p>}
      <p className={compact ? 'sr-only' : 't-caption secondary'} style={{ margin: 0 }}>Cover the whole soft edge with the brush: inside the stroke the edge is worked out from the photo, outside it nothing changes. Pinch or scroll to zoom.</p>
    </div>, controlsTarget)}
  </>;
}
