import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PointerEvent } from 'react';
import { PressButton, Slider } from '../components/controls';
import { Icon } from '../components/Icon';
import { engine } from '../engine/engine';
import type { Frame } from '../engine/display';
import type { RemovalCrop } from '../../retouch/patch';
import { removalSample } from '../../retouch/patch';

type Stroke = { radius: number; points: Array<{ x: number; y: number }> };
export function RemoveContent({ original, sourceSize, previewTarget, controlsTarget, onClose }: { original: Frame; sourceSize: { width: number; height: number }; previewTarget: HTMLElement; controlsTarget: HTMLElement; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const worker = useRef<Worker | null>(null);
  const mounted = useRef(true);
  const paintFrame = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const active = useRef<Stroke | null>(null);
  const [size, setSize] = useState(32);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Brush over the object, then choose Remove.');
  const [result, setResult] = useState<{ crop: RemovalCrop; output: Float32Array } | null>(null);
  const [before, setBefore] = useState(false);
  const [canUndo, setCanUndo] = useState(engine.canUndoRemoval);
  const [error, setError] = useState('');
  const paintMask = (items: Stroke[]) => {
    const mask = document.createElement('canvas'); mask.width = original.width; mask.height = original.height;
    const ctx = mask.getContext('2d')!;
    ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const stroke of items) {
      ctx.lineWidth = stroke.radius * 2;
      const p = stroke.points[0]!; ctx.beginPath(); ctx.arc(p.x, p.y, stroke.radius, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(p.x, p.y); for (const point of stroke.points) ctx.lineTo(point.x, point.y); ctx.stroke();
    }
    return mask;
  };
  const draw = (items = strokes) => {
    const el = canvas.current; if (!el) return;
    if (result && result.output.length === 0) return; // Buffer is transferring during Apply.
    const ctx = el.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(original.pixels), original.width, original.height, { colorSpace: original.colorSpace }), 0, 0);
    if (result && !before) {
      const { crop, output } = result, pixels = ctx.getImageData(0, 0, el.width, el.height);
      for (let y = 0; y < el.height; y++) for (let x = 0; x < el.width; x++) {
        const sx = x * sourceSize.width / el.width, sy = y * sourceSize.height / el.height;
        if (sx < crop.x || sy < crop.y || sx >= crop.x + crop.width || sy >= crop.y + crop.height) continue;
        const mx = Math.min(511, Math.floor((sx - crop.x) * 512 / crop.width)), my = Math.min(511, Math.floor((sy - crop.y) * 512 / crop.height)), at = my * 512 + mx;
        if (!crop.mask[at]) continue;
        let alpha = 1;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) if (!crop.mask[Math.max(0, Math.min(511, my + dy!)) * 512 + Math.max(0, Math.min(511, mx + dx!))]) alpha = 0.5;
        for (let c = 0; c < 3; c++) {
          const i = (y * el.width + x) * 4 + c;
          pixels.data[i] = pixels.data[i]! * (1 - alpha) + removalSample(output, c, (sx - crop.x) * 512 / crop.width - 0.5, (sy - crop.y) * 512 / crop.height - 0.5) * 255 * alpha;
        }
      }
      ctx.putImageData(pixels, 0, 0);
    } else if (!result) {
      const mask = paintMask(items), m = mask.getContext('2d')!, pixels = m.getImageData(0, 0, mask.width, mask.height);
      for (let i = 0; i < pixels.data.length; i += 4) { pixels.data[i] = 255; pixels.data[i + 1] = 70; pixels.data[i + 2] = 80; pixels.data[i + 3] = pixels.data[i + 3]! * 0.45; }
      m.putImageData(pixels, 0, 0); ctx.drawImage(mask, 0, 0);
    }
  };
  useEffect(() => { draw(); });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; worker.current?.terminate(); clearTimeout(timer.current); cancelAnimationFrame(paintFrame.current); }; }, []);
  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(original.width, (e.clientX - box.left) * original.width / box.width)), y: Math.max(0, Math.min(original.height, (e.clientY - box.top) * original.height / box.height)) };
  };
  const finish = () => { if (active.current) { setStrokes([...strokes, active.current]); active.current = null; } };
  const remove = async () => {
    setBusy(true); setError(''); setStatus('Preparing the selected area…');
    try {
      const mask = paintMask(strokes), pixels = mask.getContext('2d')!.getImageData(0, 0, mask.width, mask.height).data;
      const data = Uint8Array.from({ length: mask.width * mask.height }, (_, i) => pixels[i * 4 + 3]! > 32 ? 1 : 0);
      const crop = await engine.prepareRemoval({ width: mask.width, height: mask.height, data });
      if (!mounted.current) return;
      worker.current ??= new Worker(new URL('../../retouch/lama.worker.ts', import.meta.url), { type: 'module' });
      const fail = (message: string) => { clearTimeout(timer.current); worker.current?.terminate(); worker.current = null; setBusy(false); setError(message); };
      timer.current = setTimeout(() => fail('LaMa took too long. Try again with a smaller selection.'), 180_000);
      worker.current.onerror = () => fail('LaMa could not start on this browser. Try again or use a desktop browser.');
      worker.current.onmessage = (event: MessageEvent<{ status?: string; error?: string; output?: Float32Array }>) => {
        if (event.data.status) setStatus(event.data.status);
        if (event.data.error) fail(event.data.error);
        if (event.data.output) { clearTimeout(timer.current); setResult({ crop, output: event.data.output }); setBusy(false); setStatus('Preview ready. Apply to keep this removal.'); }
      };
      const rgb = crop.rgb.slice(), selection = crop.mask.slice();
      worker.current.postMessage({ rgb, mask: selection }, [rgb.buffer, selection.buffer]);
    } catch (e) { setBusy(false); setError(e instanceof Error ? e.message : String(e)); }
  };
  const apply = async (undo = false) => {
    setBusy(true); setError(''); setStatus(undo ? 'Undoing removal…' : 'Applying removal…');
    try {
      await engine.applyRemoval(undo ? undefined : result?.crop, undo ? undefined : result?.output);
      setResult(null); setStrokes([]); setCanUndo(!undo); setBefore(false); setStatus(undo ? 'Removal undone.' : 'Applied. Film and export use the retouched photo.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <>
    {createPortal(<div className="remove-preview"><canvas ref={canvas} width={original.width} height={original.height} aria-label="Object removal brush canvas" style={{ touchAction: 'none', cursor: result ? 'default' : 'crosshair' }}
      onPointerDown={e => { if (busy || result || !e.isPrimary || e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); active.current = { radius: size * original.width / e.currentTarget.getBoundingClientRect().width / 2, points: [point(e)] }; draw([...strokes, active.current]); }}
      onPointerMove={e => { if (!active.current || !e.isPrimary) return; active.current.points.push(point(e)); if (!paintFrame.current) paintFrame.current = requestAnimationFrame(() => { paintFrame.current = 0; if (active.current) draw([...strokes, active.current]); }); }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} />
    </div>, previewTarget)}
    {createPortal(<div className="remove-controls">
      <div className="mobile-tool-heading"><div><h2 className="t-headline" style={{ margin: 0 }}>Remove Object</h2><span className="t-caption secondary">Original · grading paused</span></div><PressButton className="capsule prominent" disabled={busy} onClick={onClose}>Done</PressButton></div>
      <div className="t-footnote" style={{ display: 'flex', justifyContent: 'space-between' }}><span>Brush size</span><span className="tabular secondary">{size} px</span></div>
      <Slider label="Brush size" value={size} min={8} max={100} step={1} defaultValue={32} valueText={`${size} px`} disabled={busy || !!result} onChange={setSize} />
      <div className="remove-actions">
        <PressButton className="capsule" disabled={busy || !strokes.length || !!result} onClick={() => setStrokes(strokes.slice(0, -1))}><Icon name="undo" size={16} /> Undo brush</PressButton>
        <PressButton className="capsule" disabled={busy || (!strokes.length && !result)} onClick={() => { setStrokes([]); setResult(null); setBefore(false); }}>Clear</PressButton>
        {canUndo && <PressButton className="capsule" disabled={busy || !!result} onClick={() => void apply(true)}>Undo removal</PressButton>}
        {result ? <><PressButton className="capsule" aria-pressed={before} disabled={busy} onClick={() => setBefore(!before)}><Icon name="compare" size={16} /> {before ? 'After' : 'Before'}</PressButton><PressButton className="capsule prominent" disabled={busy} onClick={() => void apply()}>Apply</PressButton></> : <PressButton className="capsule prominent" disabled={busy || !strokes.length} onClick={() => void remove()}><Icon name={busy ? 'loader' : 'erase'} size={16} /> {busy ? 'Working…' : 'Remove'}</PressButton>}
      </div>
      <p className="t-footnote secondary" role="status" style={{ margin: 0 }}>{status}</p>
      {error && <p className="t-footnote" role="alert" style={{ color: 'var(--red-text)', margin: 0 }}>{error}</p>}
      <p className="t-caption secondary" style={{ margin: 0 }}>On-device LaMa · first use downloads 62 MB. Photos stay local.</p>
    </div>, controlsTarget)}
  </>;
}
