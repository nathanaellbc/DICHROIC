/** Lucide icons shared by every editor control and loading indicator. */
import {
  Sun, CircleDashed, Printer, Contrast, ArrowDownUp, Film, Repeat2, Circle,
  LogIn, ChartSpline, LogOut, Blend, Layers, PanelLeft, Radio, Zap, ScanLine,
  CircleDot, Grip, Dices, Sparkles, Triangle, Wind, Thermometer, Droplet,
  Sunrise, Sunset, Eclipse, Focus, Aperture, Telescope, ArrowRightToLine,
  BringToFront, Hexagon, Spline, Eye, X, Check, ChevronDown, ChevronsUpDown,
  Columns2, RotateCcw, Minus, Plus, Search, Lock, Image, Mountain, Camera,
  FolderOpen, Upload, TriangleAlert, Info, Shuffle, Undo2, Redo2, Ellipsis,
  ChevronRight, LoaderCircle, Eraser,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { IconName } from '../model/tools';

export type UiIconName =
  | IconName | 'erase'
  | 'close' | 'check' | 'chevronDown' | 'upDown' | 'compare' | 'reset' | 'minus' | 'plus'
  | 'search' | 'lock' | 'photo' | 'hdr' | 'camera' | 'open' | 'share' | 'warning' | 'info' | 'shuffle' | 'undo' | 'redo' | 'more' | 'chevronRight' | 'loader';

const ICONS: Record<UiIconName, LucideIcon> = {
  exposure: Sun, auto: CircleDashed, print: Printer, negative: Contrast,
  pushPull: ArrowDownUp, format: Film, process: Repeat2, dot: Circle,
  input: LogIn, decode: ChartSpline, output: LogOut, couplers: Blend,
  layers: Layers, edge: PanelLeft, spread: Radio, flash: Zap,
  enlargerFilter: ScanLine, halation: CircleDot, grain: Grip, seed: Dices,
  glare: Sparkles, sharpen: Triangle, diffusion: Wind, temperature: Thermometer,
  tint: Droplet, contrast: Contrast, highlights: Sunrise, shadows: Sunset,
  whites: Sun, blacks: Eclipse, saturation: Droplet, focus: Focus,
  aperture: Aperture, focalLength: Telescope, nearSharp: ArrowRightToLine,
  foreground: BringToFront, blades: Hexagon, curvature: Spline, catEye: Eye,
  lens: Aperture, close: X, check: Check, chevronDown: ChevronDown,
  chevronRight: ChevronRight, upDown: ChevronsUpDown, compare: Columns2,
  reset: RotateCcw, minus: Minus, plus: Plus, search: Search, lock: Lock,
  photo: Image, hdr: Mountain, camera: Camera, open: FolderOpen, share: Upload,
  warning: TriangleAlert, info: Info, undo: Undo2, redo: Redo2,
  more: Ellipsis, shuffle: Shuffle, loader: LoaderCircle, erase: Eraser,
};

export function Icon({ name, size = 22, strokeWidth = 2, color = 'currentColor', className }: {
  name: UiIconName;
  size?: number;
  strokeWidth?: number;
  color?: string;
  className?: string;
}) {
  const Glyph = ICONS[name];
  return <Glyph size={size} strokeWidth={strokeWidth} color={color} className={className} aria-hidden="true" focusable="false" />;
}
