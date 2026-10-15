/**
 * Layar boot (`#boot` di index.html, salinan persis layar pembuka iOS) ke
 * aplikasi tanpa lompatan atau kedip.
 *
 * Layar boot polos (seperti gambar layar pembuka iOS, tanpa motif). Intro
 * pertama: setelah CSS app termuat, font siap, dan tata letak stabil (semua
 * di balik layar boot, jadi pergeseran awal tidak terlihat), motif muncul halus
 * di tengah, lalu terbang ke wordmark "gammā" sambil mengecil dan larut ke dalam blur, latar
 * memudar memperlihatkan langit dan kubah, dan huruf wordmark muncul dari blur
 * di tempat yang sama (`ChromeWordmark`). Selain intro (sudah disambut, Reduce
 * Motion, atau layar lain): cukup memudar setelah tenang.
 */

const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
/** Durasi terbang motif ke wordmark (ms); huruf wordmark mulai muncul di sekitar sepertiganya. */
export const BOOT_FLIGHT_MS = 950;
/** Motif muncul (ms) dan diam sejenak (ms) sebelum terbang. */
const APPEAR_MS = 520;
const HOLD_MS = 160;

let pending: Promise<boolean> | undefined;

function reduced(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
/** Satu frame, atau 50 ms bila rAF tidak berjalan (tab di latar): boot tidak boleh macet. */
const frame = () => new Promise<void>((resolve) => {
  const t = window.setTimeout(resolve, 50);
  requestAnimationFrame(() => { window.clearTimeout(t); resolve(); });
});

/**
 * Tunggu sampai halaman di balik layar boot tenang: stylesheet app termuat
 * (dimuat tanpa memblokir render, lih. vite.config.ts), font siap, dan ukuran
 * viewport serta #root sama selama 4 frame berturut-turut.
 */
async function settled(): Promise<void> {
  const sheets = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).filter((l) => !l.closest('noscript'));
  await Promise.all(
    sheets.map((l) =>
      l.sheet && l.media !== 'print'
        ? undefined
        : new Promise<void>((resolve) => {
            l.addEventListener('load', () => resolve(), { once: true });
            l.addEventListener('error', () => resolve(), { once: true });
            window.setTimeout(resolve, 3000);
          }),
    ),
  );
  await Promise.race([document.fonts?.ready ?? Promise.resolve(), wait(1000)]);
  const root = document.getElementById('root');
  const start = performance.now();
  let last = '';
  let stable = 0;
  while (stable < 4 && performance.now() - start < 1000) {
    await frame();
    const r = root?.getBoundingClientRect();
    const sig = `${innerWidth}x${innerHeight}|${r?.width}x${r?.height}`;
    stable = sig === last ? stable + 1 : 0;
    last = sig;
  }
}

function remove(boot: HTMLElement): void {
  boot.remove();
  document.documentElement.classList.remove('booting');
}

async function run(target: Element | null | undefined): Promise<boolean> {
  const boot = document.getElementById('boot');
  if (!boot) {
    document.documentElement.classList.remove('booting');
    return false;
  }
  await settled();
  const mark = boot.querySelector('svg');
  if (!target || !target.isConnected || !mark || reduced() || typeof mark.animate !== 'function') {
    const fade = boot.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 280, easing: 'ease-out', fill: 'forwards' });
    if (fade) fade.onfinish = () => remove(boot);
    else remove(boot);
    return false;
  }
  // Motif muncul halus dulu di layar polos (fade, sedikit membesar, blur
  // berkurang), sejenak diam, baru terbang.
  await mark.animate(
    [
      { opacity: 0, transform: 'scale(0.92)', filter: 'blur(10px)' },
      { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' },
    ],
    { duration: APPEAR_MS, easing: EASE, fill: 'forwards' },
  ).finished.catch(() => undefined);
  await wait(HOLD_MS);
  const from = mark.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (!(from.width > 0 && to.width > 0)) {
    remove(boot);
    return false;
  }
  // Motif mengecil setinggi huruf kecil wordmark, pusatnya ke pusat wordmark.
  const scale = (to.height * 0.62) / from.height;
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  mark.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1, filter: 'blur(0px)' },
      { transform: `translate(${dx * 0.55}px, ${dy * 0.55}px) scale(${1 + (scale - 1) * 0.55})`, opacity: 0.9, filter: 'blur(1px)', offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0, filter: 'blur(14px)' },
    ],
    { duration: BOOT_FLIGHT_MS, easing: EASE, fill: 'forwards' },
  );
  // Latar memudar sedikit lebih cepat: langit dan kubah sudah terlihat saat motif tiba.
  const veil = boot.animate([{ backgroundColor: getComputedStyle(boot).backgroundColor }, { backgroundColor: 'transparent' }], {
    duration: BOOT_FLIGHT_MS * 0.7,
    easing: 'ease-out',
    fill: 'forwards',
  });
  veil.finished.then(() => window.setTimeout(() => remove(boot), BOOT_FLIGHT_MS * 0.35), () => remove(boot));
  return true;
}

/**
 * Lepas layar boot setelah halaman tenang. `target`: elemen wordmark tujuan
 * terbang motif; tanpa target layar boot memudar saja. Panggilan berikutnya
 * mendapat janji yang sama. Selesai saat motif mulai terbang: `true` bila
 * terbang ke `target` (pemanggil lalu memunculkan huruf wordmark).
 */
export function releaseBoot(target?: Element | null): Promise<boolean> {
  pending ??= run(target);
  return pending;
}

/** Cadangan: layar mana pun yang tampil, boot tidak boleh menutupi app lebih lama dari ini. */
export function releaseBootSoon(delay = 1500): void {
  window.setTimeout(() => void releaseBoot(), delay);
}
