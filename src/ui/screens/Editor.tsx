/**
 * Editor: state bersama (kelompok, alat aktif, pembanding, sheet) dan dua
 * tata letak menurut size class -- DESIGN.md (Layout): fungsi sama di semua
 * ukuran, hanya susunannya yang berubah.
 *
 * - compact (iPhone): foto penuh, toolbar atas melayang (tutup | stok |
 *   bandingkan, Ekspor), panel kaca bawah dalam jangkauan jempol; lanskap:
 *   panel pindah ke samping.
 * - regular (iPad lanskap, desktop): sidebar stok, inspector parameter,
 *   toolbar melayang di atas foto.
 */
import { motion } from 'motion/react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { RenderParams } from '../../params/renderParams';
import { Icon } from '../components/Icon';
import { PressButton, Segmented } from '../components/controls';
import { ActionSheet } from '../components/Overlays';
import { PhotoView } from '../components/PhotoView';
import { Sheet } from '../components/Sheet';
import { engine } from '../engine/engine';
import type { EngineState } from '../engine/engine';
import { isDisplayReferred } from '../engine/display';
import { stockInfo } from '../model/stocks';
import { GROUPS, choicePatch, findTool, valueText } from '../model/tools';
import type { ChoiceTool, GroupId } from '../model/tools';
import { snappy } from '../motion';
import { ExportContent, ListPickerContent } from './Export';
import { StockBrowser } from './Stocks';
import type { StockKind } from './Stocks';
import { InspectorTool, ResetButton, ToolChips, ToolControl, ToolSwitch } from './ToolControls';
import type { ToolContext } from './ToolControls';

type SheetState =
  | { kind: 'stocks'; stockKind: StockKind; before: Pick<RenderParams, 'film' | 'paper'> }
  | { kind: 'export' }
  | { kind: 'list'; toolId: string }
  | null;

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
  const [toolByGroup, setToolByGroup] = useState<Record<GroupId, string>>({ film: 'printExposureEv', color: 'filterC', texture: 'halationAmount' });
  const [compare, setCompare] = useState(false);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [sidebarKind, setSidebarKind] = useState<StockKind>('film');
  const [discardAnchor, setDiscardAnchor] = useState<DOMRect | null>(null);

  const ctx: ToolContext = {
    params: state.params,
    defaults: state.defaults,
    onPatch: (patch) => engine.setParams(patch),
    onOpenList: (tool) => setSheet({ kind: 'list', toolId: tool.id }),
  };

  const openStocks = (stockKind: StockKind = 'film') =>
    setSheet({ kind: 'stocks', stockKind, before: { film: state.params.film, paper: state.params.paper } });

  const onClose = (anchor: DOMRect) => {
    if (engine.isEdited()) setDiscardAnchor(anchor);
    else engine.closePhoto();
  };

  const listTool = sheet?.kind === 'list' ? (findTool(sheet.toolId) as ChoiceTool) : undefined;
  const film = stockInfo(state.params.film);
  const paper = stockInfo(state.params.paper);
  const photoLabel = `${state.fileName ?? 'Photo'}, developed on ${film.name}, printed on ${paper.name}`;
  const photo = (
    <PhotoView frame={state.frame} original={state.original} compare={compare} rendering={state.rendering} photoKey={state.fileName ?? 'photo'} label={photoLabel} />
  );

  const layoutProps = { state, ctx, group, setGroup, toolByGroup, setToolByGroup, compare, setCompare, openStocks, onClose, photo, onOpenFile, setSheet, sidebarKind, setSidebarKind };

  return (
    <>
      {wide ? <WideLayout {...layoutProps} /> : <CompactLayout {...layoutProps} landscape={landscape} />}

      <Sheet
        open={sheet?.kind === 'stocks'}
        centered={wide}
        title="Stock"
        detents={['medium', 'large']}
        mediumFraction={0.62}
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
          <PressButton className="icon-btn" aria-label="Done" style={{ background: 'var(--blue)', color: '#fff' }} onClick={() => setSheet(null)}>
            <Icon name="check" size={18} strokeWidth={2.8} />
          </PressButton>
        }
      >
        {sheet?.kind === 'stocks' && (
          <StockBrowser
            film={state.params.film}
            paper={state.params.paper}
            kind={sheet.stockKind}
            onKindChange={(stockKind) => setSheet({ ...sheet, stockKind })}
            onPick={(kind, id) => engine.setParams(kind === 'film' ? { film: id } : { paper: id })}
          />
        )}
      </Sheet>

      <Sheet
        open={sheet?.kind === 'export'}
        centered={wide}
        title="Export"
        detents={['medium', 'large']}
        mediumFraction={0.76}
        dimAtMedium
        onClose={() => setSheet(null)}
        leading={
          <PressButton className="icon-btn" aria-label="Cancel" onClick={() => setSheet(null)}>
            <Icon name="close" size={16} strokeWidth={2.6} />
          </PressButton>
        }
      >
        <ExportContent
          outputColorSpace={state.params.outputColorSpace}
          inputColorSpace={state.params.inputColorSpace}
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
          <PressButton className="icon-btn" aria-label="Done" style={{ background: 'var(--blue)', color: '#fff' }} onClick={() => setSheet(null)}>
            <Icon name="check" size={18} strokeWidth={2.8} />
          </PressButton>
        }
      >
        {listTool && (
          <ListPickerContent options={listTool.options} value={state.params[listTool.field]} onPick={(v) => engine.setParams(choicePatch(listTool, v))} />
        )}
      </Sheet>

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
  ctx: ToolContext;
  group: GroupId;
  setGroup: (g: GroupId) => void;
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
}

const GROUP_ITEMS = GROUPS.map((g) => ({ value: g.id, label: g.label }));

function PreviewNote({ state }: { state: EngineState }) {
  if (isDisplayReferred(state.params.outputColorSpace)) return null;
  return (
    <span className="glass-clear t-caption" style={{ padding: '4px 10px', borderRadius: 9999 }}>
      Preview shows {state.params.outputColorSpace} values without conversion
    </span>
  );
}

// ---------------------------------------------------------------------------
// Compact (iPhone)

function CompactLayout({ state, ctx, group, setGroup, toolByGroup, setToolByGroup, compare, setCompare, openStocks, onClose, photo, setSheet, landscape }: LayoutProps & { landscape: boolean }) {
  const panelRef = useRef<HTMLElement>(null);
  const [panelSize, setPanelSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setPanelSize({ width: el.offsetWidth, height: el.offsetHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const currentGroup = GROUPS.find((g) => g.id === group)!;
  const tool = findTool(toolByGroup[group]);
  const film = stockInfo(state.params.film);

  const topBarTop = 'calc(max(var(--safe-top), 12px) + 4px)';
  const photoTop = 'calc(max(var(--safe-top), 12px) + 64px)';
  const photoStyle: React.CSSProperties = landscape
    ? { position: 'absolute', top: photoTop, bottom: 'calc(var(--safe-bottom) + 12px)', left: 'calc(var(--safe-left) + 12px)', right: panelSize.width + 28 }
    : { position: 'absolute', top: photoTop, left: 0, right: 0, bottom: panelSize.height + 20 };

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#000' }}>
      <div style={photoStyle}>{photo}</div>

      <div
        style={{
          position: 'absolute', top: topBarTop,
          left: 'calc(var(--safe-left) + 16px)',
          right: landscape ? panelSize.width + 28 : 'calc(var(--safe-right) + 16px)',
          height: 44, display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        <PressButton className="icon-btn glass" aria-label="Close" onClick={(e) => onClose(e.currentTarget.getBoundingClientRect())}>
          <Icon name="close" size={18} strokeWidth={2.4} />
        </PressButton>
        <PressButton
          className="capsule glass"
          style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, padding: '0 12px', fontSize: '0.882rem' }}
          aria-label={`Film stock: ${film.name}. Change stock`}
          onClick={() => openStocks('film')}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{film.short}</span>
          <span style={{ opacity: 0.7, display: 'inline-flex' }}><Icon name="chevronDown" size={14} strokeWidth={3} /></span>
        </PressButton>
        <PressButton className="icon-btn glass" aria-label="Compare with original" aria-pressed={compare} onClick={() => setCompare(!compare)}>
          <Icon name="compare" size={20} />
        </PressButton>
        <PressButton className="capsule prominent" onClick={() => setSheet({ kind: 'export' })}>Export</PressButton>
      </div>

      <div style={{ position: 'absolute', left: 0, right: landscape ? panelSize.width + 28 : 0, top: 'calc(max(var(--safe-top), 12px) + 70px)', display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
        <PreviewNote state={state} />
      </div>

      <section
        ref={panelRef}
        aria-label="Adjustments"
        className="glass"
        style={{
          position: 'absolute',
          ...(landscape
            ? { top: 'calc(var(--safe-top) + 8px)', maxHeight: 'calc(100% - var(--safe-top) - var(--safe-bottom) - 16px)', right: 'calc(var(--safe-right) + 8px)', width: 340, overflowY: 'auto' }
            : { left: 'calc(var(--safe-left) + 8px)', right: 'calc(var(--safe-right) + 8px)', bottom: 8, margin: '0 auto', maxWidth: 520 }),
          boxSizing: 'border-box',
          borderRadius: 'calc(var(--display-radius) - 8px)',
          padding: landscape ? '16px 20px' : '16px 20px max(20px, calc(var(--safe-bottom) - 4px))',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <div style={{ minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span className="t-footnote secondary">{currentGroup.label}</span>
            <motion.h2 key={tool.id} className="t-headline" style={{ margin: 0 }} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
              {tool.title}
            </motion.h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {(tool.kind === 'slider' || tool.kind === 'stepper' || tool.kind === 'choice') && (
              <span className="t-title3 tabular" style={{ whiteSpace: 'nowrap' }}>{tool.kind === 'choice' ? '' : valueText(tool, state.params)}</span>
            )}
            <ResetButton tool={tool} ctx={ctx} />
            <ToolSwitch tool={tool} ctx={ctx} />
          </div>
        </div>

        <div style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>
          <ToolControl key={tool.id} tool={tool} ctx={ctx} />
        </div>

        <ToolChips group={currentGroup} selected={tool.id} onSelect={(id) => setToolByGroup({ ...toolByGroup, [group]: id })} ctx={ctx} />

        <Segmented label="Adjustment group" items={GROUP_ITEMS} value={group} onChange={setGroup} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Regular (iPad lanskap, desktop)

function WideLayout({ state, ctx, group, setGroup, compare, setCompare, onClose, photo, onOpenFile, setSheet, sidebarKind, setSidebarKind }: LayoutProps) {
  const currentGroup = GROUPS.find((g) => g.id === group)!;
  const film = stockInfo(state.params.film);
  const paper = stockInfo(state.params.paper);
  const edited = engine.isEdited();
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#000' }}>
      <div style={{ position: 'absolute', top: 76, bottom: 60, left: 304, right: 344 }}>{photo}</div>

      <nav aria-label="Stocks" className="glass" style={{ position: 'absolute', top: 12, bottom: 12, left: 12, width: 280, borderRadius: 22, paddingTop: 12, display: 'flex', flexDirection: 'column', boxSizing: 'border-box', overflow: 'hidden' }}>
        <div style={{ padding: '4px 20px 10px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <span className="t-subhead" style={{ fontWeight: 700, letterSpacing: '0.14em' }}>DICHROIC</span>
          <span className="t-caption secondary" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{state.fileName}</span>
        </div>
        <StockBrowser
          film={state.params.film}
          paper={state.params.paper}
          kind={sidebarKind}
          onKindChange={setSidebarKind}
          onPick={(kind, id) => engine.setParams(kind === 'film' ? { film: id } : { paper: id })}
          onBackground
        />
      </nav>

      <div style={{ position: 'absolute', top: 16, left: 304, right: 344, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
        <div className="glass" style={{ pointerEvents: 'auto', height: 52, borderRadius: 9999, padding: 4, display: 'flex', alignItems: 'center', gap: 4, boxSizing: 'border-box' }}>
          <PressButton className="capsule" style={{ background: 'transparent', fontWeight: 500 }} onClick={onOpenFile}>
            <Icon name="open" size={18} /> Open
          </PressButton>
          <PressButton className="capsule" style={{ background: 'transparent', fontWeight: 500 }} onClick={(e) => onClose(e.currentTarget.getBoundingClientRect())}>
            Close
          </PressButton>
          <span aria-hidden="true" style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.14)' }} />
          <PressButton className="capsule" style={{ background: compare ? 'rgba(255,255,255,0.18)' : 'transparent', fontWeight: 500 }} aria-pressed={compare} onClick={() => setCompare(!compare)}>
            <Icon name="compare" size={18} /> Before / After
          </PressButton>
          <PressButton className="capsule prominent" style={{ marginLeft: 8 }} onClick={() => setSheet({ kind: 'export' })}>
            <Icon name="share" size={16} strokeWidth={2.2} /> Export
          </PressButton>
        </div>
      </div>

      <aside aria-label="Parameters" className="glass" style={{ position: 'absolute', top: 12, right: 12, width: 320, maxHeight: 'calc(100% - 24px)', borderRadius: 22, padding: 12, display: 'flex', flexDirection: 'column', gap: 12, boxSizing: 'border-box' }}>
        <Segmented label="Parameter group" items={GROUP_ITEMS} value={group} onChange={setGroup} small />
        <motion.div key={group} className="scroll-y" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={snappy} style={{ minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ borderRadius: 12, background: 'rgba(255,255,255,0.06)', display: 'flex', flexDirection: 'column' }}>
            {currentGroup.tools.map((tool, i) => (
              <div key={tool.id} style={{ borderTop: i === 0 ? 0 : '1px solid rgba(255,255,255,0.08)' }}>
                <InspectorTool tool={tool} ctx={ctx} />
              </div>
            ))}
          </div>
        </motion.div>
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.10)', padding: '10px 4px 2px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="t-caption secondary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="check" size={14} color="#30d158" strokeWidth={2.6} /> Parity-verified parameters
          </span>
          <PressButton className="capsule bordered" style={{ height: 30, padding: '0 12px', fontSize: '0.765rem', fontWeight: 500 }} disabled={!edited} onClick={() => engine.resetAll()}>
            Reset All
          </PressButton>
        </div>
      </aside>

      <div style={{ position: 'absolute', bottom: 16, left: 304, right: 344, display: 'flex', justifyContent: 'center', gap: 8, pointerEvents: 'none' }}>
        <div className="glass-clear t-caption" style={{ height: 30, padding: '0 14px', borderRadius: 9999, display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: 600 }}>{film.name}</span>
          <span aria-hidden="true" style={{ opacity: 0.6 }}>→</span>
          <span>{paper.name}</span>
          {state.frame && (
            <>
              <span aria-hidden="true" style={{ opacity: 0.5 }}>·</span>
              <span className="tabular">Preview {state.frame.width} × {state.frame.height}</span>
            </>
          )}
        </div>
        <PreviewNote state={state} />
      </div>
    </div>
  );
}
