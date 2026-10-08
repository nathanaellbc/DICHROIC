/**
 * Tampilan: ikut sistem, terang, atau gelap. Pilihan disimpan di
 * localStorage dan dipasang sebagai `html[data-theme]` (styles.css: token
 * terang berlaku untuk `data-theme="light"`, atau saat sistem terang dan
 * pengguna tidak memilih gelap). `applyTheme` dipanggil di main.tsx sebelum
 * render pertama supaya tidak berkedip.
 */
import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'dichroic.theme.v1';
const ORDER: readonly ThemePref[] = ['system', 'light', 'dark'];

export const THEME_LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export function loadTheme(): ThemePref {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
  // Kontrol bawaan browser (scrollbar, input) ikut skema yang dipilih.
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', pref === 'system' ? 'light dark' : pref);
}

export function nextTheme(pref: ThemePref): ThemePref {
  return ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]!;
}

/** Pilihan tampilan, dipasang dan disimpan setiap kali berubah. */
export function useTheme(): [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(loadTheme);
  useEffect(() => {
    applyTheme(pref);
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      // Tanpa penyimpanan, pilihan tetap berlaku untuk sesi ini.
    }
  }, [pref]);
  return [pref, setPref];
}
