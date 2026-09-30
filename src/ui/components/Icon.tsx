/** Ikon garis (24×24, stroke) -- gaya SF Symbols tanpa bingkai, mengikuti `currentColor`. */
import type { IconName } from '../model/tools';

export type UiIconName =
  | IconName
  | 'close' | 'check' | 'chevronDown' | 'upDown' | 'compare' | 'reset' | 'minus' | 'plus'
  | 'search' | 'lock' | 'photo' | 'hdr' | 'camera' | 'open' | 'share' | 'warning' | 'info' | 'shuffle' | 'undo' | 'redo' | 'more' | 'chevronRight';

const PATHS: Record<UiIconName, string> = {
  exposure: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  auto: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M8.5 16l3.5-9 3.5 9M9.8 13h4.4',
  print: 'M7 8V3h10v5M17 16h4v-6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6h4M7 13h10v8H7z',
  negative: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 3v18M12 7.5h5M12 12h8.5M12 16.5h5',
  process: 'M4 8h13M14 5l3 3-3 3M20 16H7M10 13l-3 3 3 3',
  couplers: 'M8 5a3 3 0 1 0 0 6a3 3 0 1 0 0-6M16 5a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 13a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
  layers: 'M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4',
  edge: 'M4 4h16v16H4zM12 4v16M12 9l8-5M12 15l8-5M12 20l8-4',
  spread: 'M11 11h2v2h-2zM8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8',
  flash: 'M13 3L5 13h6l-1 8 8-10h-6z',
  enlargerFilter: 'M7 3h10l-2 6H9zM12 9v3M8 12h8l3 6H5zM4 21h16',
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
  temperature: 'M10 4a2 2 0 0 1 4 0v10a4 4 0 1 1-4 0zM12 9v7',
  tint: 'M12 3l5.5 8a6.5 6.5 0 1 1-11 0zM12 12v8',
  contrast: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 3v18M12 7h5M12 11h7M12 15h7M12 19h4',
  highlights: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M5 9h14M6.5 6h11',
  shadows: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M5 15h14M6.5 18h11',
  whites: 'M12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14M12 1.5v1M12 21.5v1M1.5 12h1M21.5 12h1',
  blacks: 'M12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14M9 9l6 6M15 9l-6 6',
  saturation: 'M12 3l6 8.5a7 7 0 1 1-12 0zM8 15a4 4 0 0 0 4 4',
  focus: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4',
  aperture: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 3l4 7M21 12l-7.5 1M16.5 19.8L12.5 13.5M7.5 19.8L11 14M3 12l7.5-1M7.5 4.2L11 10',
  focalLength: 'M3 9h4v6H3zM7 7h6v10H7zM13 5h8v14h-8z',
  nearSharp: 'M4 12h11M11 8l4 4-4 4M20 5v14',
  foreground: 'M4 20h16M7 20v-7a3 3 0 0 1 6 0v7M15 20v-4h3v4',
  blades: 'M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z',
  curvature: 'M4 18C4 10 10 4 18 4M4 18h4M18 4v4',
  catEye: 'M3 12c3-5 15-5 18 0c-3 5-15 5-18 0zM12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5',
  lens: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M14.3 3.3L8.6 13M20.2 8.3H9.1M18.9 17.3L13.3 7.7M9.7 20.7L15.4 11M3.8 15.7h11.1M5.1 6.7l5.6 9.6',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
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
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
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
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" style={color === 'currentColor' ? undefined : { color }} strokeWidth={name === 'grain' || name === 'more' ? strokeWidth + 1 : strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
