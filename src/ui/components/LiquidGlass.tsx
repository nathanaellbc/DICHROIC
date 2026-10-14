/**
 * Kaca cair untuk layar mulai: peta displacement dari normal tepi bentuk
 * (lingkaran = bola kaca), dipakai lewat `backdrop-filter: url(#…)` supaya
 * latar membias di pinggiran, dengan tiga kanal dibiaskan sedikit berbeda --
 * pemisahan warna kaca dikroik, asal nama aplikasi.
 *
 * Filter SVG di backdrop-filter hanya dirender Chromium; browser lain
 * mendapat kaca biasa (blur + pinggiran + kilap dari CSS).
 */
import { useId, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

/**
 * Peta (R = x, G = y, 128 = diam) untuk superellips berpangkat `n` (2 =
 * lingkaran) selebar `size` px, pinggiran `bezel` px: di pinggiran sampel
 * diambil ke luar sepanjang normal (kaca cembung), bagian datar tidak bergeser.
 */
function displacementMap(size: number, bezel: number, n: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const image = ctx.createImageData(size, size);
  const r = size / 2;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5 - r) / r, y = (py + 0.5 - r) / r;
      const f = Math.pow(Math.pow(Math.abs(x), n) + Math.pow(Math.abs(y), n), 1 / n);
      const i = (py * size + px) * 4;
      let dx = 0, dy = 0;
      if (f < 1 && f > 0) {
        const t = Math.min(1, ((1 - f) * r) / bezel);
        // Lengkung pinggiran: kuat di tepi, nol di bagian datar.
        const strength = Math.pow(1 - t, 2);
        let nx = Math.sign(x) * Math.pow(Math.abs(x), n - 1), ny = Math.sign(y) * Math.pow(Math.abs(y), n - 1);
        const len = Math.hypot(nx, ny) || 1;
        nx /= len; ny /= len;
        dx = nx * strength; dy = ny * strength;
      }
      image.data[i] = Math.round(128 + dx * 127);
      image.data[i + 1] = Math.round(128 + dy * 127);
      image.data[i + 2] = 128;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

export function supportsSvgBackdrop(): boolean {
  if (typeof navigator === 'undefined') return false;
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands;
  return !!brands?.some((b) => /Chromium/.test(b.brand));
}

/**
 * Filter kaca untuk elemen persegi `size` px. `svg` dirender sekali di
 * pohon; `style` dipasang di elemen kacanya (kosong bila tidak didukung).
 */
export function useGlassFilter(size: number, { bezel = 0.18, strength = 0.2, n = 2 }: { bezel?: number; strength?: number; n?: number } = {}): {
  svg: ReactNode;
  style: CSSProperties;
  refract: boolean;
} {
  const id = `glass-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [refract] = useState(supportsSvgBackdrop);
  const map = useMemo(() => (refract ? displacementMap(size, Math.round(size * bezel), n) : ''), [refract, size, bezel, n]);
  if (!refract) return { svg: null, style: {}, refract };
  const scale = Math.round(size * strength);
  const svg = (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <filter id={id} x="0" y="0" width={size} height={size} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feImage href={map} x="0" y="0" width={size} height={size} preserveAspectRatio="none" result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale={scale * 1.12} xChannelSelector="R" yChannelSelector="G" result="dr" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale={scale} xChannelSelector="R" yChannelSelector="G" result="dg" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale={scale * 0.88} xChannelSelector="R" yChannelSelector="G" result="db" />
        <feColorMatrix in="dr" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
        <feColorMatrix in="dg" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
        <feColorMatrix in="db" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
        <feBlend in="r" in2="g" mode="screen" result="rg" />
        <feBlend in="rg" in2="b" mode="screen" />
      </filter>
    </svg>
  );
  const filter = `url(#${id}) saturate(1.4)`;
  return { svg, style: { backdropFilter: filter, WebkitBackdropFilter: filter }, refract };
}
