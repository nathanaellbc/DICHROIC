// The iOS host converts each developed frame natively (NativeDisplay.swift),
// because JavaScriptCore has no JIT in apps. This mirrors that Swift loop,
// operation for operation (rounding modes included), and requires it to give
// exactly the bytes of the canonical rgbToCanvas.
import { describe, expect, it } from 'vitest';
import { applyDisplayTransform, displayTransform, rgbToCanvas } from '../src/io/display';
import type { DisplayTransform } from '../src/io/display';
import { outputColorSpaces } from '../public/data/manifest.json';

/** Swift `rounded(.toNearestOrEven)`. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Literal transcription of NativeDisplay.convert. */
function swiftConvert(rgb: Float32Array, width: number, height: number, t: DisplayTransform & { stride?: number }): Uint8Array {
  const n = width * height, out = new Uint8Array(n * 4), stride = t.stride === 4 ? 4 : 3;
  if (t.kind === 'quantize') {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const v = rgb[i * stride + c]!;
        out[i * 4 + c] = v > 0 ? (v >= 1 ? 255 : Math.round(v * 255)) : 0;
      }
      out[i * 4 + 3] = 255;
    }
    return out;
  }
  const { m, encoding, gamma } = t;
  const decode = encoding === 'linear' ? (v: number) => v
    : encoding === 'srgb' ? (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
      : encoding === 'romm' ? (v: number) => (v < 1 / 32 ? v / 16 : Math.pow(v, 1.8))
        : (v: number) => Math.pow(Math.max(0, v), gamma);
  const store = (v: number) => {
    const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
    const e = (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255;
    if (!Number.isFinite(e) || !(e > 0)) return 0;
    return e >= 255 ? 255 : roundHalfEven(e);
  };
  for (let i = 0; i < n; i++) {
    const r = decode(rgb[i * stride]!), g = decode(rgb[i * stride + 1]!), b = decode(rgb[i * stride + 2]!);
    out[i * 4] = store(m[0]! * r + m[1]! * g + m[2]! * b);
    out[i * 4 + 1] = store(m[3]! * r + m[4]! * g + m[5]! * b);
    out[i * 4 + 2] = store(m[6]! * r + m[7]! * g + m[8]! * b);
    out[i * 4 + 3] = 255;
  }
  return out;
}

describe('native display conversion (iOS)', () => {
  // Every 8-bit level and its half steps, out-of-range values, NaN.
  const values = [...Array.from({ length: 511 }, (_, i) => i / 510), -0.2, 1.3, Number.NaN, 0.5 / 255, 254.5 / 255];
  const rgb = new Float32Array(values.length * 3);
  values.forEach((v, i) => rgb.set([v, values[(i * 7) % values.length]!, values[(i * 13) % values.length]!], i * 3));

  const labels = [...Object.keys(outputColorSpaces), 'Linear Rec.709'];
  for (const label of labels) {
    for (const target of ['srgb', 'display-p3'] as const) {
      it(`${label} -> ${target}`, () => {
        const t = displayTransform(label, target);
        expect(applyDisplayTransform(rgb, values.length, 1, t)).toEqual(rgbToCanvas(rgb, values.length, 1, label, target));
        // The transform crosses the bridge as JSON.
        const native = swiftConvert(rgb, values.length, 1, JSON.parse(JSON.stringify(t)) as DisplayTransform);
        expect(Array.from(native)).toEqual(Array.from(rgbToCanvas(rgb, values.length, 1, label, target)));
        // RGBA readback straight from the GPU (alpha ignored): same bytes.
        const rgba = new Float32Array(values.length * 4);
        for (let i = 0; i < values.length; i++) rgba.set([rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!, 0.25], i * 4);
        expect(Array.from(swiftConvert(rgba, values.length, 1, { ...t, stride: 4 }))).toEqual(Array.from(native));
      });
    }
  }
});
