/** Rounded rectangles with quartic (n=4) superellipse corners, not circular arcs. */
export type CornerRadii = readonly [number, number, number, number];
export const SQUIRCLE_SELECTOR = '.icon-btn, .capsule, .segmented, .segment, .segment-pill, .tabs, .tab, .tab-pill, .list, .search-field, .callout, .sheet, .alert, .popover, .toast, .option, .nested-stock-swap, .choice-chip, .path-segment, .source-row, .step-btn, .popup select, .slider-zero, .compact-select, [style*="border-radius"]';

export function fitRadii(width: number, height: number, radii: CornerRadii): CornerRadii {
  const [tl, tr, br, bl] = radii.map(r => Math.max(0, r)) as unknown as CornerRadii;
  const ratio = (span: number, sum: number) => sum > 0 ? span / sum : 1;
  const scale = Math.min(1, ratio(width, tl + tr), ratio(width, bl + br), ratio(height, tl + bl), ratio(height, tr + br));
  return [tl * scale, tr * scale, br * scale, bl * scale];
}

export function squirclePath(width: number, height: number, radii: CornerRadii): string {
  if (!(width > 0 && height > 0)) return '';
  const [tl, tr, br, bl] = fitRadii(width, height, radii);
  const n = (v: number) => Number(v.toFixed(3));
  let path = `M ${n(tl)} 0 L ${n(width - tr)} 0`;
  const corner = (r: number, point: (s: number, c: number) => [number, number]) => {
    const steps = 16, dt = 1 / steps, tangent = Math.sqrt(3 * Math.PI / 2);
    const samples = Array.from({ length: steps + 1 }, (_, i) => {
      const t = i / steps, angle = Math.PI / 2 * t * t * (3 - 2 * t);
      const sin = Math.sin(angle), cos = Math.cos(angle), speed = 3 * Math.PI * t * (1 - t);
      const s = r * Math.sqrt(sin), c = r * Math.sqrt(cos);
      const ds = i === 0 ? r * tangent : i === steps ? 0 : r * cos * speed / (2 * Math.sqrt(sin));
      const dc = i === steps ? -r * tangent : i === 0 ? 0 : -r * sin * speed / (2 * Math.sqrt(cos));
      const origin = point(0, 0), derivative = point(ds, dc);
      return { p: point(s, c), d: [derivative[0] - origin[0], derivative[1] - origin[1]] };
    });
    // Align the first/last two controls with the straight edge: zero join curvature.
    const firstNormal = Math.abs(samples[0]!.d[0]!) < 1e-9 ? 0 : 1;
    const lastNormal = Math.abs(samples[steps]!.d[0]!) < 1e-9 ? 0 : 1;
    samples[1]!.d[firstNormal] = 3 * (samples[1]!.p[firstNormal]! - samples[0]!.p[firstNormal]!) / dt;
    samples[steps - 1]!.d[lastNormal] = 3 * (samples[steps]!.p[lastNormal]! - samples[steps - 1]!.p[lastNormal]!) / dt;
    for (let i = 1; i <= steps; i++) {
      const a = samples[i - 1]!, b = samples[i]!;
      path += ` C ${n(a.p[0] + a.d[0]! * dt / 3)} ${n(a.p[1] + a.d[1]! * dt / 3)} ${n(b.p[0] - b.d[0]! * dt / 3)} ${n(b.p[1] - b.d[1]! * dt / 3)} ${n(b.p[0])} ${n(b.p[1])}`;
    }
  };
  corner(tr, (s, c) => [width - tr + s, tr - c]);
  path += ` L ${n(width)} ${n(height - br)}`;
  corner(br, (s, c) => [width - br + c, height - br + s]);
  path += ` L ${n(bl)} ${n(height)}`;
  corner(bl, (s, c) => [bl - s, height - bl + c]);
  path += ` L 0 ${n(tl)}`;
  corner(tl, (s, c) => [tl - c, tl - s]);
  return `${path} Z`;
}

/** CSS-native corners where available; SVG-path clipping for stable Safari. */
export function installSquircleGeometry(root: HTMLElement = document.documentElement, forceFallback = false): () => void {
  if (!forceFallback && CSS.supports('corner-shape', 'squircle')) {
    root.dataset.cornerGeometry = 'native';
    return () => { delete root.dataset.cornerGeometry; };
  }
  root.dataset.cornerGeometry = 'svg';
  const tracked = new Map<HTMLElement, { key: string; clip: string; background: string; border: string; origin: string; size: string; applied: string; classes: string }>();
  const pending = new Set<HTMLElement>();
  let raf = 0;
  const update = (el: HTMLElement) => {
    if (!el.isConnected) return;
    const state = tracked.get(el)!;
    el.style.borderColor = state.border;
    const style = getComputedStyle(el), w = el.offsetWidth, h = el.offsetHeight;
    if (!(w > 0 && h > 0)) return;
    const radius = (value: string) => value.endsWith('%') ? parseFloat(value) / 100 * Math.min(w, h) : parseFloat(value);
    const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(radius) as unknown as CornerRadii;
    // Dots, focus rings, slider thumbs and true pill tracks retain their geometry.
    if (style.borderTopLeftRadius.includes('%') || radii.every(r => r >= 999) || radii.every(r => r === 0)) {
      if (state.key) { state.key = ''; restore(el); }
      state.applied = el.getAttribute('style') ?? ''; state.classes = el.className; return;
    }
    const key = `${w},${h},${radii.join(',')},${style.borderTopWidth},${style.borderTopColor},${style.borderTopStyle}`;
    if (key === state.key) { if (el.style.backgroundImage !== state.background) el.style.borderColor = 'transparent'; state.applied = el.getAttribute('style') ?? ''; return; }
    state.key = key;
    const path = squirclePath(w, h, radii);
    el.style.clipPath = `path('${path}')`;
    el.classList.add('squircle-fallback');
    // Repaint a uniform border on the actual contour rather than a circular arc.
    const border = parseFloat(style.borderTopWidth);
    if (border > 0 && ['solid', 'dashed'].includes(style.borderTopStyle)) {
      const innerRadii = fitRadii(w, h, radii).map(r => Math.max(0, r - border / 2)) as unknown as CornerRadii;
      const outline = squirclePath(w - border, h - border, innerRadii);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path transform="translate(${border / 2} ${border / 2})" d="${outline}" fill="none" stroke="${style.borderTopColor}" stroke-width="${border}" ${style.borderTopStyle === 'dashed' ? 'stroke-dasharray="6 4"' : ''}/></svg>`;
      el.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
      el.style.backgroundOrigin = 'border-box';
      el.style.backgroundSize = '100% 100%';
      el.style.borderColor = 'transparent';
    }
    state.applied = el.getAttribute('style') ?? ''; state.classes = el.className;
  };
  const flush = () => { raf = 0; pending.forEach(update); pending.clear(); };
  const queue = (el: HTMLElement) => { pending.add(el); if (!raf) raf = requestAnimationFrame(flush); };
  const resize = new ResizeObserver(entries => entries.forEach(e => queue(e.target as HTMLElement)));
  const add = (node: Element) => {
    const candidates = [node, ...Array.from(node.querySelectorAll(SQUIRCLE_SELECTOR))];
    for (const el of candidates) if (el instanceof HTMLElement && el.matches(SQUIRCLE_SELECTOR) && !tracked.has(el)) {
      tracked.set(el, { key: '', clip: el.style.clipPath, background: el.style.backgroundImage, border: el.style.borderColor, origin: el.style.backgroundOrigin, size: el.style.backgroundSize, applied: '', classes: el.className });
      resize.observe(el); queue(el);
    }
  };
  const restore = (el: HTMLElement) => {
    const state = tracked.get(el)!;
    el.style.clipPath = state.clip; el.style.backgroundImage = state.background; el.style.borderColor = state.border;
    el.style.backgroundOrigin = state.origin; el.style.backgroundSize = state.size;
    el.classList.remove('squircle-fallback');
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
            if (el.style.borderColor !== 'transparent') state.border = el.style.borderColor;
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
