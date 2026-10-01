/**
 * Editor: state bersama (kelompok, alat aktif, pembanding, sheet) dan dua
 * tata letak menurut size class -- DESIGN.md (Layout): fungsi sama di semua
 * ukuran, hanya susunannya yang berubah.
 *
 * - compact (iPhone): foto penuh, toolbar atas melayang (menu | stok |
 *   undo, bandingkan, Ekspor), panel kaca bawah dalam jangkauan jempol;
 *   lanskap: panel pindah ke samping.
 * - regular (iPad lanskap, desktop): sidebar stok, inspector parameter,
 *   toolbar melayang di atas foto.
 *
 * Pintasan keyboard (di luar dialog dan kolom teks): ⌘/Ctrl+Z undo,
 * ⇧⌘Z / Ctrl+Y redo, \ sebelum/sesudah, E ekspor, O buka foto.
 */
import { motion, useReducedMotion } from 'motion/react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RenderParams } from '../../params/renderParams';
import { isPrintLut } from '../../profiles/printLuts';
import { Icon } from '../components/Icon';
import { GroupTabs, PressButton } from '../components/controls';
import type { TabItem } from '../components/controls';
import { ActionSheet } from '../components/Overlays';
import type { SheetAction } from '../components/Overlays';
import { PhotoView } from '../components/PhotoView';
import { Sheet } from '../components/Sheet';
import { engine } from '../engine/engine';
import type { EngineState } from '../engine/engine';
import { isDisplayReferred } from '../engine/display';
import { prepareFocusOverlay } from '../engine/focusCheck';
import { dialogOpen } from '../hooks';
import { stockInfo } from '../model/stocks';
import { GROUPS, choicePatch, findTool, isModified, isScanMode, normalizePatch, stockPatch, valueText, visibleTools } from '../model/tools';
import type { ChoiceTool, GroupId } from '../model/tools';
import { ExportContent, ListPickerContent } from './Export';
import { StockBrowser } from './Stocks';
import type { StockKind } from './Stocks';
import { DropZone } from './Start';
import { InspectorTool, ResetButton, ToolChips, ToolControl, ToolSwitch } from './ToolControls';
import type { ToolContext } from './ToolControls';

type Stocks = Pick<RenderParams, 'film' | 'filmEnabled' | 'paper' | 'process'>;

type SheetState =
  /** `before`: stok saat sheet dibuka (Cancel). `swap`: sisi lain A/B. */
  | { kind: 'stocks'; stockKind: StockKind; before: Stocks; swap: Stocks }
  | { kind: 'export' }
  | { kind: 'list'; toolId: string }
  | null;

const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = APPLE ? '⌘' : 'Ctrl+';
/** Petunjuk pintasan hanya berarti bila ada keyboard (bukan layar sentuh saja). */
const HAS_KEYBOARD = typeof window !== 'undefined' && window.matchMedia('(hover: hover)').matches;
const UNDO_KEYS = 'Meta+Z Control+Z';
const REDO_KEYS = 'Meta+Shift+Z Control+Y';

const stocksOf = (p: RenderParams): Stocks => ({ film: p.film, filmEnabled: p.filmEnabled, paper: p.paper, process: p.process });
const sameStocks = (a: Stocks, b: Stocks) => a.filmEnabled === b.filmEnabled && a.film === b.film && a.paper === b.paper && a.process === b.process;
const offOutput = (s: Stocks) => isPrintLut(s.paper) ? 'on ' + stockInfo(s.paper).short : 'Neutral negative';

/** "Portra 400 → Portra Endura", atau "Velvia 100, scanned". */
function recipe(s: Stocks): string {
  if (!s.filmEnabled) return 'Film Off · ' + offOutput(s);
  const film = stockInfo(s.film).short;
  return isScanMode(s) ? `${film}, scanned` : `${film} → ${stockInfo(s.paper).short}`;
}

export interface EditorProps {
  state: EngineState;
  wide: boolean;
  landscape: boolean;
  onOpenFile: () => void;
  onToast: (message: string) => void;
  onError: (error: unknown) => void;
}

export function Editor({ state, wide, landscape, onOpenFile, onToast, onError }: EditorProps) {
  const [group, setGroup] = useState<GroupId>('film');
  const [toolByGroup, setToolByGroup] = useState<Record<GroupId, string>>({ camera: 'cameraWhiteBalanceK', lens: 'lensBlur', film: 'printExposureEv', color: 'filterC', darkroom: 'dirCouplersAmount', texture: 'halationAmount' });
  const [compare, setCompare] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [sidebarKind, setSidebarKind] = useState<StockKind>('film');
  const [discardAnchor, setDiscardAnchor] = useState<DOMRect | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const [pickingFocus, setPickingFocus] = useState(false);
  const [focusPreview, setFocusPreview] = useState<{ x: number; y: number } | null>(null);
  // Mode pilih fokus hanya selama grup Lens terbuka dan lens blur menyala.
  const picking = pickingFocus && group === 'lens' && state.params.lensBlurEnabled && state.depth.status === 'ready';
  useEffect(() => setFocusPreview(null), [picking, state.fileName]);
  const previewParams = useMemo(
    () => picking && focusPreview ? { ...state.params, lensFocusX: focusPreview.x, lensFocusY: focusPreview.y } : state.params,
    [picking, focusPreview, state.params],
  );
  const hasPhoto = !!state.frame;

  const ctx: ToolContext = {
    params: previewParams,
    defaults: state.defaults,
    onPatch: (patch) => engine.setParams(normalizePatch(state.params, patch)),
    onInteractionChange: engine.setInteracting,
    onOpenList: (tool) => setSheet({ kind: 'list', toolId: tool.id }),
    lens: {
      depth: state.depth,
      aspect: state.frame ? state.frame.width / state.frame.height : 1.5,
      onDownload: () => engine.downloadDepth(),
      onRetry: () => engine.retryDepth(),
    },
  };

  const openStocks = (stockKind: StockKind = 'film') => {
    const current = stocksOf(state.params);
    setSheet({ kind: 'stocks', stockKind, before: current, swap: current });
  };

  const onClose = (anchor: DOMRect) => {
    if (engine.isEdited()) setDiscardAnchor(anchor);
    else engine.closePhoto();
  };

  const onProcess = (process: string) => engine.setParams(choicePatch(findTool('process') as ChoiceTool, process, state.params));

  // Pintasan keyboard. Nilai terbaru lewat ref supaya pendengar dipasang sekali.
  const keys = useRef({ hasPhoto, onOpenFile, toggleCompare: () => {}, openExport: () => {} });
  useEffect(() => {
    keys.current = { hasPhoto, onOpenFile, toggleCompare: () => setCompare(!compare), openExport: () => setSheet({ kind: 'export' }) };
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (dialogOpen() || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const k = keys.current;
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) engine.redo();
          else engine.undo();
        } else if (key === 'y') {
          e.preventDefault();
          engine.redo();
        }
        return;
      }
      if (e.altKey || e.metaKey || e.ctrlKey || e.repeat) return;
      if (key === 'o') {
        e.preventDefault();
        k.onOpenFile();
      } else if (k.hasPhoto && e.key === '\\') {
        e.preventDefault();
        k.toggleCompare();
      } else if (k.hasPhoto && key === 'e') {
        e.preventDefault();
        k.openExport();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const listTool = sheet?.kind === 'list' ? (findTool(sheet.toolId) as ChoiceTool) : undefined;
  const film = stockInfo(state.params.film);
  const paper = stockInfo(state.params.paper);
  const scan = isScanMode(state.params);
  const photoLabel = !state.params.filmEnabled ? `${state.fileName ?? 'Photo'}, Neutral negative` : scan
    ? `${state.fileName ?? 'Photo'}, shot on ${film.name}, scanned directly`
    : `${state.fileName ?? 'Photo'}, developed on ${film.name}, printed on ${paper.name}`;
  // Mode fokus menampilkan cek fokus: di luar kedalaman ruang jadi abu-abu gelap.
  const depthMap = state.depth.status === 'ready' ? engine.depthMap : undefined;
  const focusOverlay = useMemo(
    () => (picking && state.frame && depthMap ? prepareFocusOverlay(state.frame, depthMap) : undefined),
    [picking, state.frame, depthMap],
  );
  const focusMask = useMemo(
    () => focusOverlay?.(previewParams),
    [focusOverlay, previewParams],
  );
  const photo = !hasPhoto ? (
    <DropZone onChoose={onOpenFile} engineReady={state.engine === 'ready'} engineFailed={state.engine === 'failed'} enginePaused={state.engine === 'paused'} />
  ) : (
    <PhotoView
      frame={state.frame}
      focusMask={focusMask}
      original={state.original}
      compare={compare}
      rendering={state.rendering && !state.interacting}
      photoKey={state.fileName ?? 'photo'}
      label={photoLabel}
      sourceSize={engine.imageSize}
      onResolutionChange={engine.setPreviewLongEdge}
      focus={{
        x: state.params.lensFocusX,
        y: state.params.lensFocusY,
        show: group === 'lens' && state.params.lensBlurEnabled && state.depth.status === 'ready',
        picking,
        onStart: () => setPickingFocus(true),
        // Preview only while held; commit a single render on release.
        onPreview: (x, y) => setFocusPreview((previous) => previous?.x === x && previous.y === y ? previous : { x, y }),
        onPreviewCancel: () => { setFocusPreview(null); setPickingFocus(false); },
        onPick: (lensFocusX, lensFocusY) => {
          setFocusPreview(null);
          setPickingFocus(false);
          if (lensFocusX !== state.params.lensFocusX || lensFocusY !== state.params.lensFocusY) engine.setParams({ lensFocusX, lensFocusY });
        },
        onCancel: () => setPickingFocus(false),
      }}
    />
  );

  const groupItems: TabItem<GroupId>[] = GROUPS.map((g) => ({
    value: g.id,
    label: g.label,
    icon: g.icon,
    edited: hasPhoto && visibleTools(g, state.params).some((t) => isModified(t, state.params, state.defaults)),
  }));

  const layoutProps = { state, hasPhoto, ctx, group, setGroup, groupItems, toolByGroup, setToolByGroup, compare, setCompare, openStocks, onClose, photo, onOpenFile, setSheet, sidebarKind, setSidebarKind, onProcess, onMenu: setMenuAnchor };

  const menuActions: SheetAction[] = [
    { label: 'Open Photo…', icon: 'open', shortcut: HAS_KEYBOARD ? 'O' : undefined, onSelect: () => { setMenuAnchor(null); onOpenFile(); } },
    ...(state.history.canRedo ? [{ label: 'Redo', icon: 'redo' as const, shortcut: HAS_KEYBOARD ? (APPLE ? '⇧⌘Z' : 'Ctrl+Y') : undefined, onSelect: () => { setMenuAnchor(null); engine.redo(); } }] : []),
    ...(engine.isEdited() ? [{ label: 'Reset All Adjustments', icon: 'reset' as const, onSelect: () => { setMenuAnchor(null); engine.resetAll(); } }] : []),
    { label: 'Close Photo', icon: 'close', onSelect: () => { const anchor = menuAnchor; setMenuAnchor(null); if (anchor) onClose(anchor); } },
  ];

  const current = stocksOf(state.params);

  return (
    <>
      {wide ? <WideLayout {...layoutProps} /> : <CompactLayout {...layoutProps} landscape={landscape} />}

      <Sheet
        open={sheet?.kind === 'stocks'}
        centered={wide}
        title="Film & Paper"
        detents={['medium', 'large']}
        mediumFraction={0.56}
        onClose={() => setSheet(null)}
        leading={
          <PressButton
            className="icon-btn"
            aria-label="Cancel"
            onClick={() => {
              if (sheet?.kind === 'stocks') engine.setParams(sheet.before);
              setSheet(null);
            }}
          >
            <Icon name="close" size={16} strokeWidth={2.6} />
          </PressButton>
        }
        trailing={
          <PressButton className="icon-btn prominent" aria-label="Done" onClick={() => setSheet(null)}>
            <Icon name="check" size={18} strokeWidth={2.8} />
          </PressButton>
        }
      >
        {sheet?.kind === 'stocks' && (
          <StockBrowser
            film={state.params.film}
          filmEnabled={state.params.filmEnabled}
            paper={state.params.paper}
            kind={sheet.stockKind}
            onKindChange={(stockKind) => setSheet({ ...sheet, stockKind })}
            onPick={(kind, id) => engine.setParams(stockPatch(kind, id, state.params))}
            scan={scan}
            process={state.params.process}
            onProcess={onProcess}
            previous={
              sameStocks(sheet.swap, current)
                ? undefined
                : {
                    label: recipe(sheet.swap),
                    onSwap: () => {
                      engine.setParams(sheet.swap);
                      setSheet({ ...sheet, swap: current });
                    },
                  }
            }
          />
        )}
      </Sheet>

      <Sheet
        open={sheet?.kind === 'export'}
        centered={wide}
        title="Export"
        blurIntensity={0.2}
        detents={['medium', 'large']}
        mediumFraction={0.76}
        dimAtMedium
        onClose={() => setSheet(null)}
        leading={
          // Dialog desktop memakai tombol Cancel di footer (macOS); sheet HP menutup dari bar.
          wide ? undefined : (
            <PressButton className="icon-btn" aria-label="Cancel" onClick={() => setSheet(null)}>
              <Icon name="close" size={16} strokeWidth={2.6} />
            </PressButton>
          )
        }
      >
        <ExportContent
          onCancel={() => setSheet(null)}
          outputColorSpace={state.params.outputColorSpace}
          inputColorSpace={state.params.inputColorSpace}
          recipe={!state.params.filmEnabled ? 'Film Off · ' + offOutput(state.params) : scan ? `${film.short}, scanned` : `${film.short} on ${paper.short}`}
          onDone={(message) => {
            setSheet(null);
            onToast(message);
          }}
          onError={onError}
        />
      </Sheet>

      <Sheet
        open={sheet?.kind === 'list'}
        centered={wide}
        title={listTool?.title ?? ''}
        detents={['medium', 'large']}
        onClose={() => setSheet(null)}
        trailing={
          <PressButton className="icon-btn prominent" aria-label="Done" onClick={() => setSheet(null)}>
            <Icon name="check" size={18} strokeWidth={2.8} />
          </PressButton>
        }
      >
        {listTool && (
          <ListPickerContent options={listTool.options} value={state.params[listTool.field]} onPick={(v) => engine.setParams(choicePatch(listTool, v, state.params))} />
        )}
      </Sheet>

      <ActionSheet open={menuAnchor !== null} anchor={menuAnchor} label="Photo" actions={menuActions} onCancel={() => setMenuAnchor(null)} />

      <ActionSheet
        open={discardAnchor !== null}
        anchor={discardAnchor}
        message="Discard your edits to this photo?"
        actions={[{ label: 'Discard Edits', destructive: true, onSelect: () => { setDiscardAnchor(null); engine.closePhoto(); } }]}
        onCancel={() => setDiscardAnchor(null)}
      />
    </>
  );
}

interface LayoutProps {
  state: EngineState;
  /** Belum ada foto: area foto berisi DropZone, kontrol dinonaktifkan. */
  hasPhoto: boolean;
  ctx: ToolContext;
  group: GroupId;
  setGroup: (g: GroupId) => void;
  groupItems: TabItem<GroupId>[];
  toolByGroup: Record<GroupId, string>;
  setToolByGroup: (v: Record<GroupId, string>) => void;
  compare: boolean;
  setCompare: (v: boolean) => void;
  openStocks: (kind?: StockKind) => void;
  onClose: (anchor: DOMRect) => void;
  photo: React.ReactNode;
  onOpenFile: () => void;
  setSheet: (s: SheetState) => void;
  sidebarKind: StockKind;
  setSidebarKind: (k: StockKind) => void;
  onProcess: (process: string) => void;
  onMenu: (anchor: DOMRect) => void;
}

/** Tanpa foto, panel tetap terlihat sebagai pratinjau fungsinya, tapi jelas belum aktif. */
const EMPTY_OPACITY = 0.6;

/** Status panjang tetap bisa digulir tanpa memenuhi viewport foto. */
const COMPACT_CONTROL_MAX_HEIGHT = 156;
/** Perubahan tinggi panel bawah: lembut, tanpa pantulan (tidak lompat). */
const panelResize = { type: 'spring' as const, duration: 0.38, bounce: 0 };

function PreviewNote({ state }: { state: EngineState }) {
  if (isDisplayReferred(state.params.outputColorSpace)) return null;
  return (
    <span className="glass-clear t-caption" style={{ padding: '4px 10px', borderRadius: 'var(--r-control)' }}>
      Preview converts {state.params.outputColorSpace} to sRGB
    </span>
  );
}

function UndoButton({ state, className, size = 20 }: { state: EngineState; className: string; size?: number }) {
  return (
    <PressButton className={className} aria-label="Undo" aria-keyshortcuts={UNDO_KEYS} title={`Undo (${MOD}Z)`} disabled={!state.history.canUndo} onClick={() => engine.undo()}>
      <Icon name="undo" size={size} strokeWidth={2.2} />
    </PressButton>
  );
}

// ---------------------------------------------------------------------------
// Compact (iPhone)

function CompactLayout({ state, hasPhoto, ctx, group, setGroup, groupItems, toolByGroup, setToolByGroup, compare, setCompare, openStocks, photo, onOpenFile, setSheet, onMenu, landscape }: LayoutProps & { landscape: boolean }) {
  const panelRef = useRef<HTMLElement>(null);
  // Tinggi bukan transform: MotionConfig tidak mematikannya, jadi eksplisit.
  const reduceMotion = useReducedMotion();
  const controlContentRef = useRef<HTMLDivElement>(null);
  const [controlHeight, setControlHeight] = useState(0);
  useLayoutEffect(() => {
    const el = controlContentRef.current;
    if (!el) return;
    const measure = () => setControlHeight(Math.min(el.getBoundingClientRect().height, COMPACT_CONTROL_MAX_HEIGHT));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [panelSize, setPanelSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      setPanelSize({ width: box.width, height: box.height });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Sisihkan tinggi panel yang tampil, tanpa ruang kosong untuk status Lens
  // yang belum dibuka. Ukuran kontrol mengikuti isi dan tetap dibatasi.
  const photoBottom = Math.round(panelSize.height + 12);

  const currentGroup = GROUPS.find((g) => g.id === group)!;
  // Alat terpilih yang tidak berlaku di mode proses ini (mis. Exposure print
  // saat scan) jatuh ke padanannya / alat pertama yang terlihat.
  const visible = visibleTools(currentGroup, state.params);
  const selectedTool = findTool(toolByGroup[group]);
  const tool = visible.includes(selectedTool) ? selectedTool : (visible.find((t) => t.label === selectedTool.label) ?? visible[0]!);
  const film = stockInfo(state.params.film);
  const paper = stockInfo(state.params.paper);
  const scan = isScanMode(state.params);

  const topBarTop = 'max(var(--safe-top), 12px)';
  const photoTop = 'calc(max(var(--safe-top), 12px) + 68px)';
  const photoStyle: React.CSSProperties = landscape
    ? { position: 'absolute', top: photoTop, bottom: 'calc(var(--safe-bottom) + 12px)', left: 'calc(var(--safe-left) + 12px)', right: hasPhoto ? panelSize.width + 12 : 'calc(var(--safe-right) + 12px)' }
    : { position: 'absolute', top: photoTop, left: 0, right: 0, bottom: hasPhoto ? photoBottom : 'var(--safe-bottom)' };

  return (
    <div className={`mobile-editor${landscape ? ' is-landscape' : ''}`} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--bg)' }}>
      <div style={{ ...photoStyle, zIndex: 0 }}>{photo}</div>

      <div
        className="mobile-toolbar glass"
        style={{
          position: 'absolute', top: topBarTop,
          left: 'calc(var(--safe-left) + 12px)',
          right: landscape && hasPhoto ? panelSize.width + 12 : 'calc(var(--safe-right) + 12px)',
        }}
      >
        {!hasPhoto ? <>
          <div className="mobile-brand"><span>DICHROIC</span><span className="secondary">Your pocket darkroom</span></div>
          <PressButton className="icon-btn plain" aria-label="Open Photo" onClick={onOpenFile}><Icon name="open" size={20} /></PressButton>
        </> : <>
        <PressButton className="icon-btn plain" aria-label="More" aria-haspopup="dialog" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect())}>
          <Icon name="more" size={20} strokeWidth={2.4} />
        </PressButton>
        <PressButton
          className="capsule plain mobile-recipe"
          aria-label={`Stocks: ${state.params.filmEnabled ? film.name : 'Film Off'}, ${!state.params.filmEnabled ? offOutput(state.params) : scan ? 'scanned' : `printed on ${paper.name}`}. Change`}
          disabled={!hasPhoto}
          onClick={() => openStocks('film')}
        >
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0, textAlign: 'left' }}>
            <span className="t-subhead" style={{ fontWeight: 600, lineHeight: 1.15, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{state.params.filmEnabled ? film.short : 'Film Off'}</span>
            <span className="t-caption secondary" style={{ fontWeight: 500, lineHeight: 1.15, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{!state.params.filmEnabled ? offOutput(state.params) : scan ? 'Scanned' : `on ${paper.short}`}</span>
          </span>
          <span className="secondary" style={{ display: 'inline-flex', flexShrink: 0 }}><Icon name="upDown" size={14} strokeWidth={2.4} /></span>
        </PressButton>
        <UndoButton state={state} className="icon-btn plain" />
        <PressButton className="icon-btn mobile-export" aria-label="Export" aria-keyshortcuts="E" title="Export (E)" onClick={() => setSheet({ kind: 'export' })}><Icon name="share" size={20} /></PressButton>
        </>}
      </div>

      {/* Sebelum/sesudah di atas panel, dalam jangkauan jempol; toolbar atas memberi ruang ke nama stok. */}
      {hasPhoto && (
        <PressButton
          className="icon-btn glass"
          aria-label="Compare with original"
          aria-keyshortcuts="\"
          title="Before / After (\)"
          aria-pressed={compare}
          onClick={() => setCompare(!compare)}
          style={{
            position: 'absolute',
            left: 'calc(var(--safe-left) + 12px)',
            bottom: landscape ? 'calc(var(--safe-bottom) + 12px)' : panelSize.height + 12,
          }}
        >
          <Icon name="compare" size={20} />
        </PressButton>
      )}

      <div style={{ position: 'absolute', left: 0, right: landscape ? panelSize.width : 0, top: 'calc(max(var(--safe-top), 12px) + 64px)', display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
        <PreviewNote state={state} />
      </div>

      <section
        ref={panelRef}
        aria-label="Adjustments"
        className="panel editor-frost mobile-adjustments"
        hidden={!hasPhoto}
        inert={!hasPhoto}
        style={{
          position: 'absolute',
          opacity: hasPhoto ? 1 : EMPTY_OPACITY,
          transition: 'opacity 0.2s',
          boxSizing: 'border-box',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <div id="compact-groups-panel" role="tabpanel" aria-labelledby={`compact-groups-tab-${group}`} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="mobile-tool-heading">
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <motion.h2 key={tool.id} className="t-headline" style={{ margin: 0 }} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} transition={{ duration: 0.16 }}>
                {tool.title}
              </motion.h2>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {(tool.kind === 'slider' || tool.kind === 'stepper') && (
                <span className="t-title3 tabular mobile-tool-value">{valueText(tool, state.params)}</span>
              )}
              <ResetButton tool={tool} ctx={ctx} />
              <ToolSwitch tool={tool} ctx={ctx} />
            </div>
          </div>

          {/*
            Tinggi mengikuti isi kontrol, termasuk status Lens yang berubah.
            Panel dan tombol compare bergeser lembut. Reduce Motion: langsung.
          */}
          <motion.div
            className="scroll-y"
            initial={false}
            animate={{ height: controlHeight }}
            transition={reduceMotion ? { duration: 0 } : panelResize}
            style={{ display: 'flex', flexDirection: 'column' }}
          >
            <div ref={controlContentRef} style={{ width: '100%', flexShrink: 0 }}>
              <ToolControl key={tool.id} tool={tool} ctx={ctx} />
            </div>
          </motion.div>

          <ToolChips group={currentGroup} selected={tool.id} onSelect={(id) => setToolByGroup({ ...toolByGroup, [group]: id })} ctx={ctx} />
        </div>

        <GroupTabs label="Adjustment group" idPrefix="compact-groups" items={groupItems} value={group} onChange={setGroup} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Regular (iPad lanskap, desktop): jendela aplikasi pro -- toolbar terpadu,
// source list stok, foto di atas hitam, inspector, status bar.

const SIDEBAR_WIDTH = 260;
const INSPECTOR_WIDTH = 300;

/**
 * Resep sebagai path control jendela ("Portra 400 › Portra Endura"): tiap
 * segmen membuka daftarnya di sidebar dan menggulir ke stok terpilih.
 */
function RecipePath({ state, onReveal, disabled }: { state: EngineState; onReveal: (kind: StockKind) => void; disabled: boolean }) {
  const film = stockInfo(state.params.film);
  const paper = stockInfo(state.params.paper);
  const scan = isScanMode(state.params);
  return (
    <nav aria-label="Recipe" className="path-control">
      <button type="button" className="path-segment" disabled={disabled} title={`${state.params.filmEnabled ? film.name : 'Film Off'}: show in Film list`} onClick={() => onReveal('film')}>
        {state.params.filmEnabled ? film.name : 'Film Off'}
      </button>
      <span className="path-chevron" aria-hidden="true"><Icon name="chevronRight" size={12} strokeWidth={2.4} /></span>
      <button type="button" className="path-segment secondary" disabled={disabled} title={scan ? 'Scanned, no paper: show Paper list' : `${paper.name}: show in Paper list`} onClick={() => onReveal('paper')}>
        {!state.params.filmEnabled && !isPrintLut(state.params.paper) ? 'Neutral negative' : scan ? 'Scanned' : paper.name}
      </button>
    </nav>
  );
}

function WideLayout({ state, hasPhoto, ctx, group, setGroup, groupItems, compare, setCompare, onClose, photo, onOpenFile, setSheet, sidebarKind, setSidebarKind, onProcess }: LayoutProps) {
  const currentGroup = GROUPS.find((g) => g.id === group)!;
  const edited = engine.isEdited();
  const [reveal, setReveal] = useState(0);
  const onReveal = (kind: StockKind) => {
    setSidebarKind(kind);
    setReveal((n) => n + 1);
  };
  const inert = !hasPhoto;
  const dim: React.CSSProperties = { opacity: hasPhoto ? 1 : EMPTY_OPACITY, transition: 'opacity 0.2s' };
  return (
    <div
      style={{
        position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--bg)',
        // Lebar panel dari styles.css (HP lanskap lebih sempit). Kolom tepi
        // ikut melebar sebesar safe area (0 di desktop): latarnya sampai ke
        // tepi layar, isinya diberi padding di styles.css.
        display: 'grid',
        gridTemplateColumns: `calc(var(--sidebar-w, ${SIDEBAR_WIDTH}px) + var(--safe-left)) minmax(0, 1fr) calc(var(--inspector-w, ${INSPECTOR_WIDTH}px) + var(--safe-right))`,
        gridTemplateRows: '52px minmax(0, 1fr)',
      }}
    >
      <header className="window-toolbar editor-frost" style={{ gridColumn: '1 / -1' }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 120, maxWidth: 380, flex: '0 1 auto' }}>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.12em' }}>DICHROIC</span>
          <span className="t-footnote secondary" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={state.fileName}>{state.fileName ?? 'No photo'}</span>
        </span>
        <PressButton className="icon-btn plain" aria-label="Open Photo" aria-keyshortcuts="O" title="Open Photo (O)" onClick={onOpenFile}>
          <Icon name="open" size={17} />
        </PressButton>
        <PressButton className="icon-btn plain" aria-label="Close Photo" title="Close Photo" disabled={!hasPhoto} onClick={(e) => onClose(e.currentTarget.getBoundingClientRect())}>
          <Icon name="close" size={15} strokeWidth={2.4} />
        </PressButton>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center' }}>
          {hasPhoto && <RecipePath state={state} onReveal={onReveal} disabled={!hasPhoto} />}
        </div>

        <UndoButton state={state} className="icon-btn plain" size={17} />
        <PressButton className="icon-btn plain" aria-label="Redo" aria-keyshortcuts={REDO_KEYS} title={`Redo (${APPLE ? '⇧⌘Z' : 'Ctrl+Y'})`} disabled={!state.history.canRedo} onClick={() => engine.redo()}>
          <Icon name="redo" size={17} strokeWidth={2.2} />
        </PressButton>
        <span className="toolbar-sep" aria-hidden="true" />
        <PressButton className="icon-btn plain" aria-label="Before / After" aria-keyshortcuts="\" title="Before / After (\)" aria-pressed={compare} disabled={!hasPhoto} onClick={() => setCompare(!compare)}>
          <Icon name="compare" size={17} />
        </PressButton>
        <PressButton className="capsule prominent" style={{ marginLeft: 6 }} aria-keyshortcuts="E" title="Export (E)" disabled={!hasPhoto} onClick={() => setSheet({ kind: 'export' })}>
          <Icon name="share" size={14} strokeWidth={2.2} /> Export
        </PressButton>
      </header>

      <nav aria-label="Stocks" className="panel editor-frost" inert={inert} style={{ ...dim, borderRight: '1px solid var(--hairline)', display: 'flex', flexDirection: 'column', minHeight: 0, paddingTop: 10 }}>
        <StockBrowser
          film={state.params.film}
          filmEnabled={state.params.filmEnabled}
          paper={state.params.paper}
          kind={sidebarKind}
          onKindChange={setSidebarKind}
          onPick={(kind, id) => engine.setParams(stockPatch(kind, id, state.params))}
          scan={isScanMode(state.params)}
          process={state.params.process}
          onProcess={onProcess}
          dense
          revealToken={reveal}
        />
      </nav>

      <main style={{ position: 'relative', zIndex: 0, display: 'grid', gridTemplateRows: 'minmax(0, 1fr) 28px', minWidth: 0, minHeight: 0 }}>
        <div style={{ position: 'relative', minHeight: 0 }}>
          <div style={{ position: 'absolute', inset: 0 }}>{photo}</div>
        </div>
        <div className="status-bar editor-frost" role="status">
          {state.frame ? <span className="tabular">Preview {state.frame.width} × {state.frame.height}</span> : <span>No photo open</span>}
          <span aria-hidden="true" className="tertiary">·</span>
          <span>{state.params.outputColorSpace}{isDisplayReferred(state.params.outputColorSpace) ? '' : ', shown without conversion'}</span>
          {state.rendering && !state.interacting && hasPhoto && (
            <>
              <span aria-hidden="true" className="tertiary">·</span>
              <span style={{ color: 'var(--blue-text)' }}>Developing…</span>
            </>
          )}
          <span style={{ marginLeft: 'auto' }}>Developed on this device</span>
        </div>
      </main>

      <aside aria-label="Parameters" className="panel editor-frost" inert={inert} style={{ ...dim, borderLeft: '1px solid var(--hairline)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ borderBottom: '1px solid var(--hairline)', padding: '0 4px', flexShrink: 0 }}>
          <GroupTabs label="Parameter group" idPrefix="wide-groups" items={groupItems} value={group} onChange={setGroup} small />
        </div>
        <motion.div key={group} id="wide-groups-panel" role="tabpanel" aria-labelledby={`wide-groups-tab-${group}`} className="scroll-y" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.14, ease: 'easeOut' }} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="pane-header">
            <h2 className="t-headline" style={{ margin: 0 }}>{currentGroup.label}</h2>
          </div>
          <div className={group === 'camera' ? 'camera-controls' : undefined} style={{ display: 'flex', flexDirection: 'column', paddingBottom: 12 }}>
            {group === 'camera' && <p className="t-footnote secondary" style={{ margin: '0 12px 4px' }}>Before film · WB relative to the decoded image.</p>}
            {visibleTools(currentGroup, state.params).map((tool, index, tools) => (
              <Fragment key={tool.id}>
                {tool.section && tool.section !== tools[index - 1]?.section && (
                  <div className="camera-section">
                    <h3>{tool.section}</h3>
                    {tool.section === 'White Balance' && <PressButton className="capsule plain" onClick={() => ctx.onPatch({ cameraWhiteBalanceK: state.defaults.cameraWhiteBalanceK, cameraTint: state.defaults.cameraTint })}>Reset WB</PressButton>}
                  </div>
                )}
                <InspectorTool tool={tool} ctx={ctx} />
              </Fragment>
            ))}
          </div>
        </motion.div>
        <div style={{ borderTop: '1px solid var(--hairline)', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0 }}>
          <PressButton className="capsule bordered" disabled={!edited} onClick={() => engine.resetAll()}>
            Reset All
          </PressButton>
        </div>
      </aside>
    </div>
  );
}
