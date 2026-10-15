/**
 * Layar boot (`#boot` di index.html, salinan persis layar pembuka iOS) ke
 * aplikasi tanpa lompatan.
 *
 * Intro pertama: motif terbang ke wordmark "gammā" sambil mengecil dan larut
 * ke dalam blur, latar hitam memudar memperlihatkan langit dan kubah, dan
 * huruf wordmark muncul dari blur di tempat yang sama (`ChromeWordmark`) --
 * logo seakan menjadi namanya. Selain intro (sudah pernah disambut, Reduce
 * Motion, atau layar lain): cukup memudar.
 */

const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
/** Durasi terbang motif ke wordmark (ms); huruf wordmark mulai muncul di sekitar sepertiganya. */
export const BOOT_FLIGHT_MS = 950;

let released = false;

function reduced(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Lepas layar boot. `target`: elemen wordmark tujuan terbang motif; tanpa
 * target layar boot memudar saja. Hanya panggilan pertama yang berlaku.
 * Mengembalikan `true` bila motif benar-benar terbang ke `target` (pemanggil
 * lalu menunda munculnya huruf wordmark).
 */
export function releaseBoot(target?: Element | null): boolean {
  if (released) return false;
  released = true;
  const boot = document.getElementById('boot');
  if (!boot) return false;
  const mark = boot.querySelector('svg');
  const done = () => boot.remove();
  if (!target || !mark || reduced() || typeof mark.animate !== 'function') {
    const fade = boot.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease-out', fill: 'forwards' });
    if (fade) fade.onfinish = done;
    else done();
    return false;
  }
  const from = mark.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (!(from.width > 0 && to.width > 0)) {
    done();
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
  veil.finished.then(() => window.setTimeout(done, BOOT_FLIGHT_MS * 0.35), done);
  return true;
}

/** Cadangan: layar mana pun yang tampil, boot tidak boleh menutupi app lebih lama dari ini. */
export function releaseBootSoon(delay = 1200): void {
  window.setTimeout(() => releaseBoot(), delay);
}
