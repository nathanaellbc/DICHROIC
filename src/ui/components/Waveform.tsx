/**
 * Waveform (Y' Rec.709) dan RGB parade gaya DaVinci Resolve. Trace kanvas
 * resolusi perangkat dari frame pratinjau (sinyal yang tampil); graticule
 * SVG pada level 10-bit 0, 128, ... 1023 dengan label di kiri seperti
 * Resolve. Matematika di `model/waveform.ts`.
 */
import { useEffect, useRef } from 'react';
import type { Frame } from '../engine/display';
import { WAVEFORM_LINES_10BIT, accumulateWaveform, paradeGap, shadeWaveform } from '../model/waveform';

/** Lebar kolom label skala (px CSS); 0 tanpa label (overlay HP). */
const GUTTER = 28;

export function Waveform({ frame, parade, width, height, labels = true }: { frame?: Frame; parade: boolean; width: number; height: number; labels?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gutter = labels ? GUTTER : 0;
  const plotWidth = Math.max(32, width - gutter);
  const pad = 4;
  const plotHeight = Math.max(32, height - pad * 2);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = requestAnimationFrame(() => {
      raf = 0;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(plotWidth * dpr);
      const h = Math.round(plotHeight * dpr);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      if (!frame) return;
      const trace = accumulateWaveform(frame.pixels, frame.width, frame.height, w, h, parade);
      ctx.putImageData(new ImageData(shadeWaveform(trace) as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [frame, parade, plotWidth, plotHeight]);

  const yOf = (code: number) => pad + (1 - code / 1023) * (plotHeight - 1) + 0.5;
  const gapCss = parade ? paradeGap(plotWidth) : 0;
  const lane = parade ? (plotWidth - 2 * gapCss) / 3 : plotWidth;

  return (
    <div
      className="waveform"
      role="img"
      aria-label={parade ? 'RGB parade, Rec.709, 10-bit scale' : "Waveform, luma Y' Rec.709, 10-bit scale"}
      style={{ width, height }}
    >
      <canvas ref={canvasRef} style={{ position: 'absolute', left: gutter, top: pad, width: plotWidth, height: plotHeight }} />
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }} aria-hidden="true">
        {WAVEFORM_LINES_10BIT.map((code) => (
          <g key={code}>
            <line x1={gutter} x2={width} y1={yOf(code)} y2={yOf(code)} stroke={code === 0 || code === 1023 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.13)'} strokeWidth={1} />
            {labels && (code % 256 === 0 || code === 1023) && (
              <text x={gutter - 4} y={yOf(code) + 3} textAnchor="end" fontSize={9} fill="rgba(255,255,255,0.5)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {code}
              </text>
            )}
          </g>
        ))}
        {parade && [1, 2].map((i) => {
          const x = gutter + i * lane + (i - 0.5) * gapCss;
          return <line key={i} x1={x} x2={x} y1={pad} y2={pad + plotHeight} stroke="rgba(255,255,255,0.18)" strokeWidth={1} />;
        })}
      </svg>
    </div>
  );
}
