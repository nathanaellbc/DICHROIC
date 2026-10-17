/**
 * Kontrol per alat, dipakai panel HP (satu alat aktif) dan inspector layar
 * lebar (semua alat satu kelompok). Satu sumber kebenaran: `model/tools.ts`.
 */
import { motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import type { RenderParams } from '../../params/renderParams';
import { Icon } from '../components/Icon';
import { useElasticScroll } from '../components/useElasticScroll';
import { OptionRow, PopUp, PressButton, Slider, Stepper, Switch, centerInScroller } from '../components/controls';
import type { SliderProps } from '../components/controls';
import { RulerSlider } from '../components/RulerSlider';
import { Spinner } from '../components/Overlays';
import type { DepthState } from '../engine/depthController';
import { DEPTH_MODELS, isDepthModelId } from '../../depth/model';
import type { DepthModelId } from '../../depth/model';
import { pressScale, snappy } from '../motion';
import {
  DIFFUSION_FAMILIES,
  DIFFUSION_STRENGTH,
  choicePatch,
  decodeAllowed,
  formatStops,
  lensReadoutText,
  isModified,
  positionPatch,
  resetPatch,
  sliderPosition,
  sliderRange,
  stepperAtEnd,
  stepperDisplay,
  stepperPatch,
  toolEnabled,
  valueText,
  visibleTools,
} from '../model/tools';
import { WB_TEMP, WB_TINT } from '../model/tools';
import type { ChoiceTool, LensTool, SliderTool, StepperTool, Tool, ToolGroup } from '../model/tools';

/** Status peta kedalaman dan aksi lens blur (grup Lens). */
export interface LensContext {
  depth: DepthState;
  /** Rasio lebar/tinggi foto (readout kedalaman ruang). */
  aspect: number;
  onDownload: () => void;
  onRetry: () => void;
  /** Model kedalaman terpilih dan pilihan di perangkat ini. */
  model: DepthModelId;
  models: readonly DepthModelId[];
  /** Pilihan yang bisa kehabisan memori di perangkat ini. */
  experimental: readonly DepthModelId[];
  onModel: (model: DepthModelId) => void;
  /** Sakelar GPU kedalaman (iPhone); disembunyikan bila tidak berarti. */
  gpu: boolean;
  gpuOption: boolean;
  onGpu: (on: boolean) => void;
  /** Refine Edge terpasang untuk foto ini, dan pembukanya. */
  refined: boolean;
  onRefine: () => void;
}

/** Pemilih putih dan Auto di alat White Balance (grup Camera). */
export interface WhiteBalanceContext {
  /** Mode pipet aktif: ketukan berikutnya di foto memilih warna netral. */
  picking: boolean;
  /** Sedang menghitung (pipet atau Auto). */
  busy: boolean;
  onPick: () => void;
  onAuto: () => void;
}

export interface ToolContext {
  params: RenderParams;
  defaults: RenderParams;
  onPatch: (patch: Partial<RenderParams>) => void;
  onInteractionChange?: (active: boolean) => void;
  /** Daftar pilihan panjang (colour space input) dibuka di sheet terpisah. */
  onOpenList: (tool: ChoiceTool) => void;
  lens?: LensContext;
  whiteBalance?: WhiteBalanceContext;
}

/** Pilihan > 10 tidak muat sebagai kapsul; tampil sebagai tombol yang membuka daftar. */
export function isLongChoice(tool: ChoiceTool): boolean {
  return tool.options.length > 10;
}

/** Sakelar di readout: alat bertoggle (auto exposure, decode) dan slider ber-`enabledBy`. */
export function ToolSwitch({ tool, ctx }: { tool: Tool; ctx: ToolContext }) {
  const { params, onPatch } = ctx;
  if (tool.kind === 'toggle') {
    const allowed = tool.field !== 'inputCctfDecoding' || decodeAllowed(params.inputColorSpace);
    return <Switch label={tool.title} checked={params[tool.field]} disabled={!allowed} onChange={(v) => onPatch({ [tool.field]: v })} />;
  }
  if (tool.kind === 'lens') {
    return <Switch label={tool.title} checked={params.lensBlurEnabled} onChange={(v) => onPatch({ lensBlurEnabled: v })} />;
  }
  if ((tool.kind === 'slider' || tool.kind === 'diffusion') && tool.enabledBy) {
    const field = tool.enabledBy;
    // Menyalakan filter difusi yang strength-nya 0 langsung memberi 1/2 stop.
    const onFilter = tool.kind === 'diffusion' && params[tool.strengthField] <= 0 ? { [tool.strengthField]: 0.5 } : {};
    return <Switch label={tool.title} checked={params[field]} onChange={(v) => onPatch({ [field]: v, ...(v ? onFilter : {}) })} />;
  }
  return null;
}

export function ResetButton({ tool, ctx, compact }: { tool: Tool; ctx: ToolContext; compact?: boolean }) {
  const show = (tool.kind === 'slider' || tool.kind === 'stepper' || tool.kind === 'diffusion' || tool.kind === 'whiteBalance') && isModified(tool, ctx.params, ctx.defaults);
  return (
    <motion.span
      initial={false}
      animate={{ opacity: show ? 1 : 0, scale: show ? 1 : 0.6, width: show ? (compact ? 22 : 44) : 0 }}
      transition={snappy}
      style={{ display: 'inline-flex', overflow: 'hidden', flexShrink: 0 }}
    >
      <PressButton className={compact ? 'icon-btn plain' : 'icon-btn'} style={compact ? { width: 22, height: 22, borderRadius: 'var(--r-inline)' } : undefined} aria-label={`Reset ${tool.title}`} title={`Reset ${tool.title}`} tabIndex={show ? 0 : -1} aria-hidden={!show} onClick={() => ctx.onPatch(resetPatch(tool, ctx.defaults))}>
        <Icon name="reset" size={compact ? 13 : 18} strokeWidth={2.2} />
      </PressButton>
    </motion.span>
  );
}

/** Nilai, petunjuk, dan aksi satu stepper (panel HP dan baris inspector). */
function stepperModel(tool: StepperTool, params: RenderParams, onPatch: ToolContext['onPatch']) {
  const { text, hint } = stepperDisplay(tool, params);
  if (tool.values) {
    const enabled = toolEnabled(tool, params);
    return {
      text,
      hint,
      atMin: !enabled || stepperAtEnd(tool, params, -1),
      atMax: !enabled || stepperAtEnd(tool, params, 1),
      dec: () => onPatch(stepperPatch(tool, params, -1)),
      inc: () => onPatch(stepperPatch(tool, params, 1)),
      seed: false,
    };
  }
  const v = params[tool.field];
  const seed = tool.field === 'grainSeed';
  return {
    text,
    hint,
    atMin: v <= tool.min,
    atMax: v >= tool.max,
    dec: () => onPatch({ [tool.field]: Math.max(tool.min, v - tool.step) }),
    inc: () => onPatch({ [tool.field]: Math.min(tool.max, v + tool.step) }),
    seed,
  };
}

const randomSeed = () => ({ grainSeed: 1 + Math.floor(Math.random() * 9999) });

/**
 * Kontrol utama alat (slider, stepper, pilihan, atau catatan). `dense`:
 * baris inspector layar lebar -- pilihan pendek dan stepper hidup di baris
 * label (pop-up, −/+), di sini hanya catatannya.
 */
/**
 * `ruler`: panel HP -- slider jadi penggaris (RulerSlider) dan catatan alat
 * tidak ditampilkan di bawahnya (dibuka lewat tombol info di judul alat).
 */
export function ToolControl({ tool, ctx, dense, ruler }: { tool: Tool; ctx: ToolContext; dense?: boolean; ruler?: boolean }) {
  const { params, defaults, onPatch } = ctx;
  const SliderControl = ruler ? RulerSlider : Slider;
  switch (tool.kind) {
    case 'slider': {
      // Posisi, bukan nilai: slider berskala log (lensa) bergerak di log10/log2.
      const range = sliderRange(tool, params);
      const slider = (
        <SliderControl
          label={tool.title}
          value={sliderPosition(tool, params)}
          min={range.min}
          max={range.max}
          step={range.step}
          defaultValue={sliderPosition(tool, { ...params, [tool.field]: defaults[tool.field] })}
          valueText={valueText(tool, params)}
          disabled={!toolEnabled(tool, params)}
          onChange={(v) => onPatch(positionPatch(tool, v, params))}
          onInteractionChange={ctx.onInteractionChange}
        />
      );
      if (!tool.note || ruler || (dense && tool.section)) return slider;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {slider}
          <p className="t-footnote secondary" style={{ margin: 0 }}>{tool.note}</p>
        </div>
      );
    }
    case 'stepper': {
      const m = stepperModel(tool, params, onPatch);
      if (dense) return <p className="note">{m.hint}</p>;
      return (
        <Stepper
          label={tool.title}
          valueText={m.text}
          hint={m.hint}
          atMin={m.atMin}
          atMax={m.atMax}
          onDecrement={m.dec}
          onIncrement={m.inc}
          extra={
            m.seed ? (
              <PressButton className="icon-btn" aria-label="Random grain pattern" onClick={() => onPatch(randomSeed())}>
                <Icon name="shuffle" size={18} />
              </PressButton>
            ) : undefined
          }
        />
      );
    }
    case 'choice':
      if (isLongChoice(tool)) {
        return (
          <PressButton className="capsule" style={{ width: '100%', justifyContent: 'space-between', fontWeight: 500 }} onClick={() => ctx.onOpenList(tool)} aria-label={`${tool.title}: ${valueText(tool, params)}. Change`}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{valueText(tool, params)}</span>
            <Icon name="upDown" size={16} />
          </PressButton>
        );
      }
      if (dense) return tool.note ? <p className="note">{tool.note}</p> : null;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
          <OptionRow label={tool.title} options={tool.options} value={params[tool.field]} onChange={(v) => onPatch(choicePatch(tool, v, params))} />
          {tool.note && <p className="t-footnote secondary" style={{ margin: 0 }}>{tool.note}</p>}
        </div>
      );
    case 'diffusion': {
      const enabled = params[tool.enabledBy];
      const onFamily = (v: string) => onPatch({ [tool.familyField]: v, [tool.enabledBy]: true, ...(params[tool.strengthField] <= 0 ? { [tool.strengthField]: 0.5 } : {}) });
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: dense ? 6 : 8, width: '100%' }}>
          {dense ? (
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span className="t-footnote secondary">Filter</span>
              <PopUp label={`${tool.title} type`} options={DIFFUSION_FAMILIES} value={params[tool.familyField]} onChange={onFamily} />
            </span>
          ) : (
            <OptionRow label={`${tool.title} type`} options={DIFFUSION_FAMILIES} value={params[tool.familyField]} onChange={onFamily} />
          )}
          <SliderControl
            label={`${tool.title} strength`}
            value={params[tool.strengthField]}
            min={DIFFUSION_STRENGTH.min}
            max={DIFFUSION_STRENGTH.max}
            step={DIFFUSION_STRENGTH.step}
            defaultValue={defaults[tool.strengthField]}
            valueText={enabled ? `${formatStops(params[tool.strengthField])} stop` : 'Off'}
            disabled={!enabled}
            onChange={(v) => onPatch({ [tool.strengthField]: v })}
            onInteractionChange={ctx.onInteractionChange}
          />
          {!ruler && <p className="t-footnote secondary" style={{ margin: 0 }}>{tool.note}</p>}
        </div>
      );
    }
    case 'toggle': {
      const blocked = tool.field === 'inputCctfDecoding' && !decodeAllowed(params.inputColorSpace);
      return <p className="t-subhead secondary" style={{ margin: 0 }}>{blocked ? `Not available for ${params.inputColorSpace}.` : tool.note}</p>;
    }
    case 'lens':
      return <LensCard tool={tool} ctx={ctx} />;
    case 'whiteBalance':
      return <WhiteBalanceCard note={tool.note} ctx={ctx} dense={dense} ruler={ruler} />;
    case 'locked':
      return <p className="t-subhead secondary" style={{ margin: 0 }}>{tool.note}</p>;
  }
}

/**
 * White Balance: pipet dan Auto di atas, Temp dan Tint di bawahnya. Pipet
 * dan Auto hanya mengisi kedua field, jadi slider ikut bergeser ke hasilnya
 * dan tetap bisa disetel halus sesudahnya.
 */
function WhiteBalanceCard({ note, ctx, dense, ruler }: { note: string; ctx: ToolContext; dense?: boolean; ruler?: boolean }) {
  const wb = ctx.whiteBalance;
  const SliderControl: (props: SliderProps) => React.ReactNode = ruler ? RulerSlider : Slider;
  const row = (tool: SliderTool) => {
    const range = sliderRange(tool, ctx.params);
    return (
      <div key={tool.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span className="t-footnote secondary">{tool.title}</span>
          <span className="t-footnote secondary tabular">{valueText(tool, ctx.params)}</span>
        </span>
        <SliderControl
          label={tool.title}
          value={sliderPosition(tool, ctx.params)}
          min={range.min}
          max={range.max}
          step={range.step}
          defaultValue={sliderPosition(tool, { ...ctx.params, [tool.field]: ctx.defaults[tool.field] })}
          valueText={valueText(tool, ctx.params)}
          onChange={(v) => ctx.onPatch(positionPatch(tool, v, ctx.params))}
          onInteractionChange={ctx.onInteractionChange}
        />
      </div>
    );
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: dense ? 6 : 10, width: '100%' }}>
      {wb && (
        <div style={{ display: 'flex', gap: 8 }}>
          <PressButton
            className={`capsule${wb.picking ? ' prominent' : ''}`}
            aria-pressed={wb.picking}
            disabled={wb.busy}
            onClick={wb.onPick}
            style={{ flex: 1 }}
          >
            <Icon name="pipette" size={dense ? 14 : 16} />
            {wb.picking ? 'Tap white or grey' : 'Pick White'}
          </PressButton>
          <PressButton className="capsule" disabled={wb.busy} onClick={wb.onAuto} style={{ flex: 1 }}>
            {wb.busy ? <Spinner size={14} /> : <Icon name="auto" size={dense ? 14 : 16} />}
            Auto
          </PressButton>
        </div>
      )}
      {row(WB_TEMP)}
      {row(WB_TINT)}
      {!dense && !ruler && <p className="t-footnote secondary" style={{ margin: 0 }}>{note}</p>}
    </div>
  );
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

const DEPTH_PHASE: Record<string, string> = {
  runtime: 'Downloading the depth engine',
  model: 'Downloading the depth model',
  compile: 'Preparing the depth model',
  infer: 'Measuring depth',
  refine: 'Refining edges',
};

/** Status peta kedalaman, unduhan model, pilih fokus, dan kedalaman ruang. */
function LensCard({ tool, ctx }: { tool: LensTool; ctx: ToolContext }) {
  const { params, lens } = ctx;
  const note = <p className="t-footnote secondary" style={{ margin: 0 }}>{tool.note}</p>;
  if (!params.lensBlurEnabled || !lens) return note;

  const readout = <p className="t-footnote secondary tabular" style={{ margin: 0 }}>{lensReadoutText(params, lens.aspect)}</p>;
  // Pemilih jaringan kedalaman: hanya muncul bila perangkat punya pilihan.
  // Pemilih jaringan kedalaman dan sakelar GPU dalam satu baris: kartu Lens
  // harus muat di panel HP tanpa scroll. Di HP (ada sakelar GPU) labelnya
  // pendek supaya keduanya muat.
  const short = lens.gpuOption;
  const picker = lens.models.length > 1 || lens.gpuOption ? (
    <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      {short ? null : <span className="t-footnote secondary">Depth model</span>}
      <PopUp
        label="Depth model"
        options={lens.models.map((id) => ({
          value: id,
          label: `${DEPTH_MODELS[id].label}${short ? '' : ` · ${DEPTH_MODELS[id].name}`}${lens.experimental.includes(id) ? (short ? ' (exp.)' : ' (experimental)') : ''}`,
        }))}
        value={lens.model}
        onChange={(value) => { if (isDepthModelId(value)) lens.onModel(value); }}
      />
      {lens.gpuOption ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="t-footnote secondary">GPU</span>
          <Switch label="Measure depth on the GPU" checked={lens.gpu} onChange={lens.onGpu} />
        </span>
      ) : null}
    </span>
  ) : null;
  const { depth } = lens;
  let status: React.ReactNode;
  switch (depth.status) {
    case 'idle':
    case 'working': {
      const phase = depth.status === 'working' ? depth.phase : 'runtime';
      const pct = depth.status === 'working' && depth.total > 0 ? ` ${Math.round((100 * depth.loaded) / depth.total)}%` : '';
      status = (
        <span className="t-subhead" role="status" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spinner size={16} />
          {DEPTH_PHASE[phase]}…{pct}
        </span>
      );
      break;
    }
    case 'needs-download':
      status = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p className="t-subhead" style={{ margin: 0 }}>One-time download of {DEPTH_MODELS[lens.model].name}. It stays on this device; photos never leave it.</p>
          <PressButton className="capsule bordered" style={{ alignSelf: 'flex-start' }} onClick={lens.onDownload}>
            Download · {megabytes(depth.bytes)}
          </PressButton>
        </div>
      );
      break;
    case 'error':
      status = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p className="t-subhead" role="alert" style={{ margin: 0 }}>Couldn’t measure depth: {depth.message}</p>
          <PressButton className="capsule bordered" style={{ alignSelf: 'flex-start' }} onClick={lens.onRetry}>
            Try Again
          </PressButton>
        </div>
      );
      break;
    case 'ready':
      status = (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="t-footnote secondary">
            Depth ready · {DEPTH_MODELS[depth.model].label} · {depth.backend === 'webgpu' ? 'GPU' : 'CPU'} · {(depth.ms / 1000).toFixed(1)} s
          </span>
          <PressButton className="capsule bordered" onClick={lens.onRefine}>{lens.refined ? 'Refine Edge · On' : 'Refine Edge…'}</PressButton>
        </div>
      );
      break;
  }
  return (
    <div className="lens-status" style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      {picker}
      {status}
      {/* Kedalaman ruang baru berarti setelah ada peta; tanpa ini kartu unduh/galat tidak muat di panel HP. */}
      {(depth.status === 'ready' || depth.status === 'working') && readout}
    </div>
  );
}

/** Deretan alat satu kelompok (panel HP). Alat terpilih digulir ke tengah. */
export function ToolChips({ group, selected, onSelect, ctx }: { group: ToolGroup; selected: string; onSelect: (id: string) => void; ctx: ToolContext }) {
  const scroll = useElasticScroll();
  const resetScroll = scroll.reset;
  const refs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    resetScroll();
    const el = refs.current.get(selected);
    if (el) centerInScroller(el);
  }, [selected, resetScroll]);
  return (
    <div ref={scroll.ref} role="group" aria-label={`${group.label} tools`} className="scroll-x mobile-tools" {...scroll.handlers}>
      <motion.div className="mobile-tools-track" style={{ transform: scroll.transform }}>
      {visibleTools(group, ctx.params).map((tool) => {
        const isSelected = tool.id === selected;
        const modified = isModified(tool, ctx.params, ctx.defaults);
        const dimmed = !toolEnabled(tool, ctx.params) || (tool.kind === 'toggle' && !ctx.params[tool.field]);
        return (
          <motion.button
            key={tool.id}
            ref={(el: HTMLButtonElement | null) => {
              if (el) refs.current.set(tool.id, el);
              else refs.current.delete(tool.id);
            }}
            type="button"
            className="tool-pill"
            aria-pressed={isSelected}
            aria-label={`${tool.title}${modified ? ', edited' : ''}${tool.kind === 'locked' ? ', not yet available' : ''}`}
            onClick={() => onSelect(tool.id)}
            whileTap={{ scale: pressScale }}
            initial={false}
            animate={{
              backgroundColor: isSelected ? 'rgba(var(--ink), 0.92)' : 'rgba(var(--ink), 0.06)',
              color: isSelected ? 'var(--bg)' : dimmed ? 'var(--label-3)' : 'var(--label-2)',
            }}
            transition={snappy}
          >
            <Icon name={tool.kind === 'locked' ? 'lock' : tool.icon} size={15} strokeWidth={2.2} color={isSelected ? 'currentColor' : tool.tint ?? 'currentColor'} />
            {tool.label}
            {/* Sudah diubah: titik Signal Blue (dulu cincin biru di ikon). */}
            {modified && <span className="tool-pill-dot" aria-hidden="true" />}
          </motion.button>
        );
      })}
      </motion.div>
    </div>
  );
}

/** Satu alat sebagai baris inspector (layar lebar). */
export function InspectorTool({ tool, ctx }: { tool: Tool; ctx: ToolContext }) {
  const locked = tool.kind === 'locked';
  const modified = isModified(tool, ctx.params, ctx.defaults);
  const stepper = tool.kind === 'stepper' ? stepperModel(tool, ctx.params, ctx.onPatch) : null;
  return (
    <div className="inspector-row" style={{ opacity: locked ? 0.55 : 1 }}>
      <div style={{ minHeight: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          {tool.tint && <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 2, background: tool.tint, flexShrink: 0 }} />}
          <span className="t-body" title={tool.kind === 'slider' ? tool.note : undefined} style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tool.title}</span>
          {modified && <span aria-label="edited" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--blue)', flexShrink: 0 }} />}
          {locked && <Icon name="lock" size={12} />}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {stepper && <span className="t-body secondary tabular" style={{ whiteSpace: 'nowrap' }}>{stepper.text}</span>}
          {(tool.kind === 'slider' || tool.kind === 'diffusion' || tool.kind === 'whiteBalance') && <span className="t-body secondary tabular" style={{ whiteSpace: 'nowrap' }}>{valueText(tool, ctx.params)}</span>}
          <ResetButton tool={tool} ctx={ctx} compact />
          {stepper && (
            <span style={{ display: 'inline-flex', gap: 2, marginLeft: 2 }}>
              {stepper.seed && (
                <PressButton className="icon-btn plain step-btn" aria-label="Random grain pattern" title="Random grain pattern" onClick={() => ctx.onPatch(randomSeed())}>
                  <Icon name="shuffle" size={13} />
                </PressButton>
              )}
              <PressButton className="icon-btn step-btn" aria-label={`Decrease ${tool.title}`} disabled={stepper.atMin} onClick={stepper.dec}>
                <Icon name="minus" size={12} strokeWidth={2.6} />
              </PressButton>
              <PressButton className="icon-btn step-btn" aria-label={`Increase ${tool.title}`} disabled={stepper.atMax} onClick={stepper.inc}>
                <Icon name="plus" size={12} strokeWidth={2.6} />
              </PressButton>
            </span>
          )}
          {tool.kind === 'choice' && !isLongChoice(tool) && (
            <PopUp label={tool.title} options={tool.options} value={ctx.params[tool.field]} onChange={(v) => ctx.onPatch(choicePatch(tool, v, ctx.params))} />
          )}
          <ToolSwitch tool={tool} ctx={ctx} />
        </span>
      </div>
      {tool.kind !== 'toggle' && <ToolControl tool={tool} ctx={ctx} dense />}
      {tool.kind === 'toggle' && (
        <p className="note">
          {tool.field === 'inputCctfDecoding' && !decodeAllowed(ctx.params.inputColorSpace) ? `Not available for ${ctx.params.inputColorSpace}.` : tool.note}
        </p>
      )}
    </div>
  );
}
