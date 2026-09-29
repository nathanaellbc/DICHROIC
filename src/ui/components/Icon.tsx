/** Ikon garis (24×24, stroke) -- gaya SF Symbols tanpa bingkai, mengikuti `currentColor`. */
import type { IconName } from '../model/tools';

export type UiIconName =
  | IconName
  | 'close' | 'check' | 'chevronDown' | 'upDown' | 'compare' | 'reset' | 'minus' | 'plus'
  | 'search' | 'lock' | 'photo' | 'hdr' | 'camera' | 'open' | 'share' | 'warning' | 'info' | 'shuffle';

const PATHS: Record<UiIconName, string> = {
  exposure: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  auto: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M8.5 16l3.5-9 3.5 9M9.8 13h4.4',
  print: 'M7 8V3h10v5M17 16h4v-6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6h4M7 13h10v8H7z',
  pushPull: 'M8 20V4M4 8l4-4 4 4M16 4v16M12 16l4 4 4-4',
  format: 'M4 5h16v14H4zM4 9h16M4 15h16M8 5v4M12 5v4M16 5v4M8 15v4M12 15v4M16 15v4',
  dot: 'M12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14',
  input: 'M3 12h11M10 8l4 4-4 4M16 4h4v16h-4',
  decode: 'M4 20C9 20 11 4 20 4M4 4v16h16',
  output: 'M10 12h11M17 8l4 4-4 4M8 4H4v16h4',
  halation: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18',
  grain: 'M6 6h.01M12 6h.01M18 6h.01M9 10h.01M15 10h.01M6 14h.01M12 14h.01M18 14h.01M9 18h.01M15 18h.01',
  seed: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1M9 9h.01M15 15h.01M15 9h.01M9 15h.01M12 12h.01',
  glare: 'M12 3v5M12 16v5M3 12h5M16 12h5M6.5 6.5L9 9M15 15l2.5 2.5M17.5 6.5L15 9M9 15l-2.5 2.5',
  sharpen: 'M12 4L20 19H4Z',
  diffusion: 'M4 8h11M4 12h16M4 16h9M18 8h2M16 16h4',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevronDown: 'M6 9l6 6 6-6',
  upDown: 'M8 9l4-4 4 4M8 15l4 4 4-4',
  compare: 'M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3M12 4v16',
  reset: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  minus: 'M5 12h14',
  plus: 'M5 12h14M12 5v14',
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13M16 16l4.5 4.5',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  photo: 'M6 5h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3M3 16l5-5 4 4 3-3 6 6',
  hdr: 'M4 18L10 6l4 8 2-4 4 8z',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 9.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7',
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  share: 'M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
  warning: 'M12 3l9.5 17h-19zM12 10v4M12 17.5v.01',
  info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 8v.01M12 11v5',
  shuffle: 'M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4M18 4l3 3-3 3M18 14l3 3-3 3',
};

export function Icon({
  name,
  size = 22,
  strokeWidth = 2,
  color = 'currentColor',
}: {
  name: UiIconName;
  size?: number;
  strokeWidth?: number;
  color?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={name === 'grain' ? strokeWidth + 1 : strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
