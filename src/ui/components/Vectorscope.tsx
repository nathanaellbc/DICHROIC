/**
 * Vectorscope gaya DaVinci Resolve: trace Cb/Cr dari frame pratinjau (sinyal
 * yang tampil), graticule lingkaran dengan centang 10 derajat, kotak target
 * 75 % atau 100 % berlabel R/Mg/B/Cy/G/Yl, garis skin tone 123 derajat, zoom 2x.
 * Matematika di `model/vectorscope.ts`.
 *
 * Trace dihitung ulang paling banyak sekali per frame animasi saat frame
 * berganti (slider digeser), di kanvas resolusi perangkat; graticule SVG
 * supaya garisnya tetap tajam di skala apa pun.
 */
import { useEffect, useRef } from 'react';
import type { Frame } from '../engine/display';
import { SKIN_TONE_ANGLE_DEG, accumulateScope, scopeTargets, shadeScope } from '../model/vectorscope';
import type { ScopePrefs } from '../model/vectorscope';

/**
 * Jari-jari lingkaran graticule (|C| 0.5) sebagai pecahan setengah sisi: 0.8
 * menyisakan tempat untuk target 100 % Mg/G Rec.709 (|C| 0.596).
 */
const RADIUS_FRACTION = 0.8;

export function Vectorscope({ frame, prefs, size, onToggleZoom }: { frame?: Frame; prefs: ScopePrefs; size: number; onToggleZoom?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = requestAnimationFrame(() => {
      raf = 0;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const px = Math.max(64, Math.round(size * dpr));
      if (canvas.width !== px) canvas.width = px;
      if (canvas.height !== px) canvas.height = px;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, px, px);
      if (!frame) return;
      const trace = accumulateScope(frame.pixels, frame.width, frame.height, px, (px / 2) * RADIUS_FRACTION, prefs.zoom);
      ctx.putImageData(new ImageData(shadeScope(trace, prefs.colorize) as Uint8ClampedArray<ArrayBuffer>, px, px), 0, 0);
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [frame, prefs.zoom, prefs.colorize, size]);

  const c = 50;
  const R = 50 * RADIUS_FRACTION;
  const scale = (R * prefs.zoom) / 0.5;
  const targets = scopeTargets(prefs.targets === 75 ? 0.75 : 1);
  const ticks = Array.from({ length: 36 }, (_, i) => i * 10);
  const skin = (SKIN_TONE_ANGLE_DEG * Math.PI) / 180;
  const box = 0.03 * scale;

  return (
    <div
      className="vectorscope"
      role="img"
      aria-label={`Vectorscope, Rec.709, ${prefs.targets}% targets${prefs.zoom === 2 ? ', 2x zoom' : ''}${prefs.skinTone ? ', skin tone line' : ''}`}
      style={{ width: size, height: size }}
      onDoubleClick={onToggleZoom}
    >
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      <svg viewBox="0 0 100 100" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }} aria-hidden="true">
        <defs>
          <clipPath id="vectorscope-clip">
            <rect x={0} y={0} width={100} height={100} />
          </clipPath>
        </defs>
        <circle cx={c} cy={c} r={R} fill="none" stroke="rgba(255,255,255,0.32)" strokeWidth={0.5} />
        {ticks.map((deg) => {
          const a = (deg * Math.PI) / 180;
          const long = deg % 30 === 0;
          const r0 = R - (long ? 2.2 : 1.2);
          return <line key={deg} x1={c + Math.cos(a) * r0} y1={c - Math.sin(a) * r0} x2={c + Math.cos(a) * R} y2={c - Math.sin(a) * R} stroke="rgba(255,255,255,0.32)" strokeWidth={0.4} />;
        })}
        <line x1={c - R} y1={c} x2={c + R} y2={c} stroke="rgba(255,255,255,0.14)" strokeWidth={0.35} />
        <line x1={c} y1={c - R} x2={c} y2={c + R} stroke="rgba(255,255,255,0.14)" strokeWidth={0.35} />
        <g clipPath="url(#vectorscope-clip)">
          {prefs.skinTone && (
            <line x1={c} y1={c} x2={c + Math.cos(skin) * R * 1.05} y2={c - Math.sin(skin) * R * 1.05} stroke="rgba(255,196,150,0.85)" strokeWidth={0.55} />
          )}
          {targets.map((t) => {
            const x = c + t.cb * scale;
            const y = c - t.cr * scale;
            return (
              <g key={t.label}>
                <rect x={x - box} y={y - box} width={box * 2} height={box * 2} fill="none" stroke={t.color} strokeOpacity={0.9} strokeWidth={0.5} />
                <text x={x + (t.cb >= 0 ? box + 1.2 : -box - 1.2)} y={y + (t.cr >= 0 ? -box - 0.6 : box + 3.2)} textAnchor={t.cb >= 0 ? 'start' : 'end'} fontSize={4.2} fontWeight={600} fill={t.color} fillOpacity={0.9}>
                  {t.label}
                </text>
              </g>
            );
          })}
        </g>
        <circle cx={c} cy={c} r={0.5} fill="rgba(255,255,255,0.5)" />
      </svg>
    </div>
  );
}
