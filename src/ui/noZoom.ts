/**
 * Aplikasi, bukan dokumen: halaman tidak boleh ikut ter-zoom browser. Zoom
 * foto tetap milik `PhotoView`/`PhotoLightbox` (pointer event dan listener
 * `wheel` mereka sendiri, yang berjalan lebih dulu di elemennya -- di sini
 * hanya `preventDefault`, tidak pernah `stopPropagation`).
 *
 *  - iOS Safari mengabaikan `user-scalable=no` di tab: pinch halaman dihentikan
 *    lewat event `gesture*` WebKit dan `touchmove` multi-jari.
 *  - Ketuk-dua-kali: `touch-action: manipulation` di `body` (styles.css).
 *  - Fokus kolom teks < 16 px: `maximum-scale=1` di meta viewport.
 *  - Desktop: Ctrl/⌘ + roda / pinch trackpad dan Ctrl/⌘ + = - 0.
 */
export function preventPageZoom(target: Window = window): void {
  const block = (e: Event) => {
    if (e.cancelable) e.preventDefault();
  };
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    target.document.addEventListener(type, block, { passive: false });
  }
  target.document.addEventListener(
    'touchmove',
    (e: TouchEvent) => {
      if (e.touches.length > 1) block(e);
    },
    { passive: false },
  );
  target.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) block(e);
    },
    { passive: false },
  );
  target.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ['=', '+', '-', '_', '0'].includes(e.key)) block(e);
  });
}
