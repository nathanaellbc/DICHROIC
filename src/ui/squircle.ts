/**
 * Sudut kontinu bergaya Apple untuk semua permukaan non-lingkaran.
 *
 * Sudut kontinu iOS dengan radius nominal r tidak berhenti di r: kurvanya
 * memanjang ~1,528 r di tiap tepi, dan titik diagonalnya jatuh di titik
 * lingkaran beradius r. Jadi kesan bulatnya sama dengan lingkaran r, tetapi
 * kelengkungannya naik dari nol (tanpa "patahan" di sambungan tepi lurus).
 *
 * Dulu: superellipse n=4 di DALAM r (CSS `squircle`). Kesan bulatnya hanya
 * setara lingkaran ~0,55 r, sehingga tombol r12 tampak hampir kotak (seperti
 * r6,5), sementara kartu besar (alert r31, setara ~r17) tampak benar.
 *
 * Kini: superellipse n = CONTINUOUS_EXPONENT sepanjang r x CONTINUOUS_EXTENT.
 * Diagonalnya = lingkaran r. Token radius dan aturan konsentris tetap
 * memakai radius nominal; skalanya diterapkan di sini, seragam.
 */
export type CornerRadii = readonly [number, number, number, number];
export const SQUIRCLE_SELECTOR = '.icon-btn, .capsule, .photo-status-pill, .popover-glide, .segmented, .segment, .segment-pill, .tabs, .tab, .tab-pill, .mobile-toolbar, .mobile-adjustments, .dropzone-cta, .list, .search-field, .callout, .sheet, .alert, .popover, .toast, .option, .nested-stock-swap, .choice-chip, .path-segment, .source-row, .step-btn, .popup select, .slider-zero, .compact-select, [style*="border-radius"]';

/** Panjang kurva sudut kontinu Apple per radius nominal. */
export const CONTINUOUS_EXTENT = 1.528665;
/** Eksponen superellipse yang diagonalnya = lingkaran r pada panjang r x EXTENT (~3,26). */
export const CONTINUOUS_EXPONENT = -1 / Math.log2(1 - (1 - Math.SQRT1_2) / CONTINUOUS_EXTENT);
/** Parameter CSS `corner-shape: superellipse(K)`, K = log2(n) (~1,70). Dipakai styles.css. */
export const CONTINUOUS_CSS_K = Math.log2(CONTINUOUS_EXPONENT);

export function fitRadii(width: number, height: number, radii: CornerRadii): CornerRadii {
  const [tl, tr, br, bl] = radii.map(r => Math.max(0, r)) as unknown as CornerRadii;
  const ratio = (span: number, sum: number) => sum > 0 ? span / sum : 1;
  const scale = Math.min(1, ratio(width, tl + tr), ratio(width, bl + br), ratio(height, tl + bl), ratio(height, tr + br));
  return [tl * scale, tr * scale, br * scale, bl * scale];
}

/** Panjang kurva per sudut untuk radius nominal, dijepit ke ukuran kotak. */
export function continuousExtents(width: number, height: number, radii: CornerRadii): CornerRadii {
  return fitRadii(width, height, radii.map(r => r * CONTINUOUS_EXTENT) as unknown as CornerRadii);
}

/**
 * Path kotak dengan sudut superellipse eksponen `exponent` sepanjang
 * `extents` (sudah dijepit oleh pemanggil, atau dijepit di sini). Tiap sudut
 * 16 kurva kubik dengan titik sampel tepat di superellipse; kontrol pertama
 * dan terakhir sejajar tepi lurus, jadi kelengkungan di sambungan nol.
 */
export function squirclePath(width: number, height: number, extents: CornerRadii, exponent = CONTINUOUS_EXPONENT): string {
  if (!(width > 0 && height > 0)) return '';
  const [tl, tr, br, bl] = fitRadii(width, height, extents);
  const n = (v: number) => Number(v.toFixed(3));
  const power = 2 / exponent;
  let path = `M ${n(tl)} 0 L ${n(width - tr)} 0`;
  const corner = (r: number, point: (s: number, c: number) => [number, number]) => {
    const steps = 16, dt = 1 / steps;
    const p = Array.from({ length: steps + 1 }, (_, i) => {
      const t = i / steps, angle = Math.PI / 2 * t * t * (3 - 2 * t);
      return point(r * Math.sin(angle) ** power, r * Math.cos(angle) ** power);
    });
    const d = p.map((_, i) => {
      const a = p[Math.max(0, i - 1)]!, b = p[Math.min(steps, i + 1)]!;
      const span = (Math.min(steps, i + 1) - Math.max(0, i - 1)) * dt;
      return [(b[0] - a[0]) / span, (b[1] - a[1]) / span];
    });
    // Sumbu normal tepi di awal/akhir sudut: sumbu yang hampir tak berubah.
    const normalAt = (a: [number, number], b: [number, number]) => (Math.abs(b[0] - a[0]) < Math.abs(b[1] - a[1]) ? 0 : 1);
    const first = normalAt(p[0]!, p[1]!), last = normalAt(p[steps]!, p[steps - 1]!);
    d[0]![first] = 0;
    d[1]![first] = 3 * (p[1]![first]! - p[0]![first]!) / dt;
    d[steps]![last] = 0;
    d[steps - 1]![last] = 3 * (p[steps]![last]! - p[steps - 1]![last]!) / dt;
    for (let i = 1; i <= steps; i++) {
      const a = p[i - 1]!, b = p[i]!, da = d[i - 1]!, db = d[i]!;
      path += ` C ${n(a[0] + da[0]! * dt / 3)} ${n(a[1] + da[1]! * dt / 3)} ${n(b[0] - db[0]! * dt / 3)} ${n(b[1] - db[1]! * dt / 3)} ${n(b[0])} ${n(b[1])}`;
    }
  };
  if (r0(tr)) corner(tr, (s, c) => [width - tr + s, tr - c]);
  path += ` L ${n(width)} ${n(height - br)}`;
  if (r0(br)) corner(br, (s, c) => [width - br + c, height - br + s]);
  path += ` L ${n(bl)} ${n(height)}`;
  if (r0(bl)) corner(bl, (s, c) => [bl - s, height - bl + c]);
  path += ` L 0 ${n(tl)}`;
  if (r0(tl)) corner(tl, (s, c) => [tl - c, tl - s]);
  return `${path} Z`;
}

const r0 = (r: number) => r > 1e-6;

/**
 * Pasang sudut kontinu pada semua elemen `SQUIRCLE_SELECTOR`. Radius nominal
 * dibaca dari CSS (token dan aturan konsentris), lalu:
 *
 * - native (`corner-shape` didukung): border-radius inline = panjang kurva
 *   (r x 1,528, dijepit), bentuknya `superellipse(K)` dari styles.css;
 * - svg (Safari/iPhone): clip-path path dari kurva yang sama, border
 *   dilukis ulang di kontur. Border-radius box = panjang kurva / 1,528
 *   (radius nominal, atau lebih kecil bila dijepit menjadi kapsul): kontur
 *   kontinu selalu di DALAM lingkaran itu (menyentuhnya hanya di diagonal,
 *   test/ui/squircle.test.ts), jadi potongan background oleh radius box
 *   tidak memotong border SVG, dan cincin fokus tetap bulat.
 */
export function installSquircleGeometry(root: HTMLElement = document.documentElement, forceFallback = false): () => void {
  const native = !forceFallback && CSS.supports('corner-shape', 'squircle');
  root.dataset.cornerGeometry = native ? 'native' : 'svg';
  type State = { key: string; clip: string; background: string; border: string; radius: string; shaped: string; origin: string; size: string; applied: string; classes: string };
  const tracked = new Map<HTMLElement, State>();
  const pending = new Set<HTMLElement>();
  let raf = 0;
  const applyShape = (el: HTMLElement, state: State) => {
    if (state.key) el.style.borderRadius = state.shaped;
    state.applied = el.getAttribute('style') ?? ''; state.classes = el.className;
  };
  const restore = (el: HTMLElement) => {
    const state = tracked.get(el)!;
    el.style.borderRadius = state.radius;
    if (!native) {
      el.style.clipPath = state.clip; el.style.backgroundImage = state.background; el.style.borderColor = state.border;
      el.style.backgroundOrigin = state.origin; el.style.backgroundSize = state.size;
      el.classList.remove('squircle-fallback');
    }
  };
  const update = (el: HTMLElement) => {
    if (!el.isConnected) return;
    const state = tracked.get(el)!;
    if (!native) el.style.borderColor = state.border;
    // Radius nominal dibaca dengan override kita dilepas (lihat `applyShape`).
    el.style.borderRadius = state.radius;
    const style = getComputedStyle(el), w = el.offsetWidth, h = el.offsetHeight;
    if (!(w > 0 && h > 0)) { applyShape(el, state); return; }
    const radius = (value: string) => value.endsWith('%') ? parseFloat(value) / 100 * Math.min(w, h) : parseFloat(value);
    const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(radius) as unknown as CornerRadii;
    // Dots, focus rings, slider thumbs and true pill tracks retain their geometry.
    if (style.borderTopLeftRadius.includes('%') || radii.every(r => r >= 999) || radii.every(r => r === 0)) {
      if (state.key) { state.key = ''; restore(el); }
      state.applied = el.getAttribute('style') ?? ''; state.classes = el.className; return;
    }
    const extents = continuousExtents(w, h, radii);
    const key = `${w},${h},${radii.join(',')},${style.borderTopWidth},${style.borderTopColor},${style.borderTopStyle}`;
    if (key === state.key) { if (!native && el.style.backgroundImage !== state.background) el.style.borderColor = 'transparent'; applyShape(el, state); return; }
    state.key = key;
    if (native) {
      state.shaped = extents.map(e => `${Number(e.toFixed(2))}px`).join(' ');
      applyShape(el, state);
      return;
    }
    // Radius efektif setelah dijepit (kapsul): lingkarannya tetap memuat kontur.
    state.shaped = extents.map(e => `${Number((e / CONTINUOUS_EXTENT).toFixed(2))}px`).join(' ');
    el.style.clipPath = `path('${squirclePath(w, h, extents)}')`;
    el.classList.add('squircle-fallback');
    // Repaint a uniform border on the actual contour rather than a circular arc.
    const border = parseFloat(style.borderTopWidth);
    if (border > 0 && ['solid', 'dashed'].includes(style.borderTopStyle)) {
      const inner = extents.map(e => Math.max(0, e - border / 2)) as unknown as CornerRadii;
      const outline = squirclePath(w - border, h - border, inner);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path transform="translate(${border / 2} ${border / 2})" d="${outline}" fill="none" stroke="${style.borderTopColor}" stroke-width="${border}" ${style.borderTopStyle === 'dashed' ? 'stroke-dasharray="6 4"' : ''}/></svg>`;
      el.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
      el.style.backgroundOrigin = 'border-box';
      el.style.backgroundSize = '100% 100%';
      el.style.borderColor = 'transparent';
    }
    applyShape(el, state);
  };
  const flush = () => { raf = 0; pending.forEach(update); pending.clear(); };
  const queue = (el: HTMLElement) => { pending.add(el); if (!raf) raf = requestAnimationFrame(flush); };
  const resize = new ResizeObserver(entries => entries.forEach(e => queue(e.target as HTMLElement)));
  const add = (node: Element) => {
    const candidates = [node, ...Array.from(node.querySelectorAll(SQUIRCLE_SELECTOR))];
    for (const el of candidates) if (el instanceof HTMLElement && el.matches(SQUIRCLE_SELECTOR) && !tracked.has(el)) {
      tracked.set(el, { key: '', clip: el.style.clipPath, background: el.style.backgroundImage, border: el.style.borderColor, radius: el.style.borderRadius, shaped: '', origin: el.style.backgroundOrigin, size: el.style.backgroundSize, applied: '', classes: el.className });
      resize.observe(el); queue(el);
    }
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLElement) {
        const el = record.target, state = tracked.get(el);
        if (!state) { if (el.matches(SQUIRCLE_SELECTOR)) add(el); continue; }
        if (record.attributeName === 'class') { if (el.className !== state.classes) queue(el); }
        else {
          const current = el.getAttribute('style') ?? '';
          if (current === state.applied) continue;
          const borders = (s: string) => s.match(/(?:^|;)\s*border[^:]*:[^;]*/g)?.join(';') ?? '';
          if (borders(current) !== borders(record.oldValue ?? '')) {
            if (!native && el.style.borderColor !== 'transparent') state.border = el.style.borderColor;
            // Radius baru dari aplikasi (bukan nilai yang kita pasang sendiri).
            if (el.style.borderRadius !== state.shaped) state.radius = el.style.borderRadius;
            queue(el);
          }
        }
      }
      for (const node of Array.from(record.addedNodes)) if (node instanceof Element) add(node);
    }
    tracked.forEach((_state, el) => { if (!el.isConnected) { resize.unobserve(el); pending.delete(el); restore(el); tracked.delete(el); } });
  });
  add(root);
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['style', 'class'] });
  // Only density changes invalidate all radii; photo/pan style changes do not.
  const density = new MutationObserver(() => tracked.forEach((s, el) => { s.key = ''; queue(el); }));
  density.observe(root, { attributes: true, attributeFilter: ['data-size'] });
  return () => {
    observer.disconnect(); density.disconnect(); resize.disconnect(); cancelAnimationFrame(raf);
    tracked.forEach((_s, el) => restore(el)); tracked.clear(); pending.clear(); delete root.dataset.cornerGeometry;
  };
}
