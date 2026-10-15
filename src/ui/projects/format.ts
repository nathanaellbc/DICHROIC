/** Teks kartu proyek: film, sisa resep, dan waktu relatif. */
import type { RenderParams } from '../../params/renderParams';
import { isPrintLut } from '../../profiles/printLuts';
import { stockInfo } from '../model/stocks';
import { isScanMode } from '../model/tools';

/** `film`: label film ("Portra 400", "Film Off"); `rest`: "→ Endura", "scanned", "Neutral negative". */
export function recipeParts(params: RenderParams): { film: string; rest: string } {
  if (!params.filmEnabled) {
    return { film: 'Film Off', rest: isPrintLut(params.paper) ? `→ ${stockInfo(params.paper).short}` : 'Neutral negative' };
  }
  const film = stockInfo(params.film).short;
  return isScanMode(params) ? { film, rest: 'scanned' } : { film, rest: `→ ${stockInfo(params.paper).short}` };
}

/** "Portra 400 → Endura", "Velvia 50, scanned", "Film Off · Neutral negative". */
export function recipeText(params: RenderParams): string {
  const { film, rest } = recipeParts(params);
  if (!params.filmEnabled) return `${film} · ${rest}`;
  return rest === 'scanned' ? `${film}, scanned` : `${film} ${rest}`;
}

/** "Just now", "2 hours ago", "Yesterday", lalu tanggal ("12 Oct"). */
export function relativeTime(then: number, now = Date.now()): string {
  const diff = Math.max(0, now - then);
  if (diff < 60_000) return 'Just now';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const say = (value: number, unit: Intl.RelativeTimeFormatUnit) => {
    const text = rtf.format(-value, unit);
    return text.charAt(0).toUpperCase() + text.slice(1);
  };
  if (diff < 3_600_000) return say(Math.floor(diff / 60_000), 'minute');
  if (diff < 86_400_000) return say(Math.floor(diff / 3_600_000), 'hour');
  if (diff < 7 * 86_400_000) return say(Math.floor(diff / 86_400_000), 'day');
  return new Date(then).toLocaleDateString('en', { day: 'numeric', month: 'short' });
}

/** Kelompok daftar All Projects. */
export function dayGroup(then: number, now = Date.now()): 'Today' | 'Yesterday' | 'This Week' | 'Earlier' {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (then >= today) return 'Today';
  if (then >= today - 86_400_000) return 'Yesterday';
  if (then >= today - 6 * 86_400_000) return 'This Week';
  return 'Earlier';
}
