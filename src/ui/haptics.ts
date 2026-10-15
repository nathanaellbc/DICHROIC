/**
 * Getar halus satu ketukan. Android: Vibration API. iOS (Safari 18+): tidak
 * ada Vibration API, tetapi mengubah `<input type="checkbox" switch>` memberi
 * haptic sistem -- jadi satu sakelar tersembunyi di-klik. Keduanya hanya
 * bekerja di dalam gesture pengguna (pointerup, keydown, ...).
 */
let toggle: HTMLLabelElement | undefined;

export function haptic() {
  try { navigator.vibrate?.(12); } catch { /* tidak didukung */ }
  if (typeof document === 'undefined') return;
  if (!toggle) {
    toggle = document.createElement('label');
    toggle.setAttribute('aria-hidden', 'true');
    toggle.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    toggle.append(input);
    document.body.append(toggle);
  }
  toggle.click();
}
