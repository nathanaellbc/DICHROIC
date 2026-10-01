/**
 * Kontrol per alat, dipakai panel HP (satu alat aktif) dan inspector layar
 * lebar (semua alat satu kelompok). Satu sumber kebenaran: `model/tools.ts`.
 */
import { motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { lensReadout, lensSettings } from '../../host/lens';
import { FILM_FORMAT_LONG_EDGE_MM } from '../../params/filmFormat';
import type { RenderParams } from '../../params/renderParams';
import { Icon } from '../components/Icon';
import { OptionRow, PopUp, PressButton, Slider, Stepper, Switch, centerInScroller } from '../components/controls';
import { Spinner } from '../components/Overlays';
import type { DepthState } from '../engine/depthController';
import { pressScale, snappy } from '../motion';
import {
  DIFFUSION_FAMILIES,
  DIFFUSION_STRENGTH,
  choicePatch,
  decodeAllowed,
  formatPushPull,
  formatStops,
  isModified,
  positionPatch,
  resetPatch,
  sliderPosition,
  sliderRange,
  stepperAtEnd,
  stepperPatch,
  stepperText,
  valueText,
  visibleTools,
} from '../model/tools';
import type { ChoiceTool, LensTool, StepperTool, Tool, ToolGroup } from '../model/tools';

/** Status peta kedalaman dan aksi lens blur (grup Lens). */
export interface LensContext {
  depth: DepthState;
  /** Mode pilih titik fokus aktif di foto. */
  picking: boolean;
  /** Rasio lebar/tinggi foto (readout kedalaman ruang). */
  aspect: number;
  onDownload: () => void;
  onRetry: () => void;
  onPickFocus: () => void;
}

export interface ToolContext {
  params: RenderParams;
  defaults: RenderParams;
  onPatch: (patch: Partial<RenderParams>) => void;
  onInteractionChange?: (active: boolean) => void;
  /** Daftar pilihan panjang (colour space input) dibuka di sheet terpisah. */
  onOpenList: (tool: ChoiceTool) => void;
  lens?: LensContext;
}

/** Pilihan > 10 tidak muat sebagai kapsul; tampil sebagai tombol yang membuka daftar. */
export function isLongChoice(tool: ChoiceTool): boolean {
  return tool.options.length > 10;
}

function toolEnabled(tool: Tool, params: RenderParams): boolean {
  if (tool.requires && !params[tool.requires]) return false;
  if (tool.kind === 'slider' && tool.enabledBy) return params[tool.enabledBy];
  if (tool.kind === 'diffusion') return params[tool.enabledBy];
  if (tool.kind === 'toggle' && tool.field === 'inputCctfDecoding') return decodeAllowed(params.inputColorSpace);
  return tool.kind !== 'locked';
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
  const show = (tool.kind === 'slider' || tool.kind === 'stepper' || tool.kind === 'diffusion') && isModified(tool, ctx.params, ctx.defaults);
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
  if (tool.values) {
    const enabled = toolEnabled(tool, params);
    return {
      text: stepperText(tool, params),
      hint: tool.field === 'lensFNumber' ? 'Wider apertures blur more' : 'Shape of out-of-focus highlights',
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
    text: seed ? `Seed ${v}` : formatPushPull(v),
    hint: seed ? 'Grain pattern' : v === 0 ? 'Normal development' : v > 0 ? 'Longer development' : 'Shorter development',
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
export function ToolControl({ tool, ctx, dense }: { tool: Tool; ctx: ToolContext; dense?: boolean }) {
  const { params, defaults, onPatch } = ctx;
  switch (tool.kind) {
    case 'slider': {
      // Posisi, bukan nilai: slider berskala log (lensa) bergerak di log10/log2.
      const range = sliderRange(tool, params);
      const slider = (
        <Slider
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
      if (!tool.note || (dense && tool.section)) return slider;
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
          <Slider
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
          <p className="t-footnote secondary" style={{ margin: 0 }}>{tool.note}</p>
        </div>
      );
    }
    case 'toggle': {
      const blocked = tool.field === 'inputCctfDecoding' && !decodeAllowed(params.inputColorSpace);
      return <p className="t-subhead secondary" style={{ margin: 0 }}>{blocked ? `Not available for ${params.inputColorSpace}.` : tool.note}</p>;
    }
    case 'lens':
      return <LensCard tool={tool} ctx={ctx} />;
    case 'locked':
      return <p className="t-subhead secondary" style={{ margin: 0 }}>{tool.note}</p>;
  }
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function meters(m: number): string {
  if (!Number.isFinite(m)) return '∞';
  if (m < 1) return `${m.toFixed(2)} m`;
  if (m < 10) return `${m.toFixed(1)} m`;
  return `${Math.round(m)} m`;
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

  const r = lensReadout(lensSettings(params), params.filmFormat, FILM_FORMAT_LONG_EDGE_MM[params.filmFormat], lens.aspect);
  const readout = (
    <p className="t-footnote secondary tabular" style={{ margin: 0 }}>
      Sharp from {meters(r.nearLimitM)} to {meters(r.farLimitM)} · {Math.round(r.focalLengthMm)} mm f/{params.lensFNumber} · hyperfocal {meters(r.hyperfocalM)}
    </p>
  );
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
          <p className="t-subhead" style={{ margin: 0 }}>Lens blur needs a one-time download of the depth model. It stays on this device, and your photos never leave it.</p>
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
          <PressButton className="capsule bordered" aria-pressed={lens.picking} onClick={lens.onPickFocus} style={lens.picking ? { background: 'var(--blue)', color: '#fff' } : undefined}>
            <Icon name="focus" size={16} /> {lens.picking ? 'Done' : 'Pick Focus'}
          </PressButton>
          <span className="t-footnote secondary">
            Depth ready · {depth.backend === 'webgpu' ? 'GPU' : 'CPU'} · {(depth.ms / 1000).toFixed(1)} s
          </span>
        </div>
      );
      break;
  }
  return (
    <div className="lens-status" style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      {status}
      {readout}
    </div>
  );
}

/** Deretan alat satu kelompok (panel HP). Alat terpilih digulir ke tengah. */
export function ToolChips({ group, selected, onSelect, ctx }: { group: ToolGroup; selected: string; onSelect: (id: string) => void; ctx: ToolContext }) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    const el = refs.current.get(selected);
    if (el) centerInScroller(el);
  }, [selected]);
  return (
    <div role="group" aria-label={`${group.label} tools`} className="scroll-x mobile-tools">
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
            aria-pressed={isSelected}
            aria-label={`${tool.title}${modified ? ', edited' : ''}${tool.kind === 'locked' ? ', not yet available' : ''}`}
            onClick={() => onSelect(tool.id)}
            whileTap={{ scale: pressScale }}
            transition={snappy}
            style={{ width: 66, flexShrink: 0, border: 0, background: 'transparent', padding: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, cursor: 'pointer' }}
          >
            <motion.span
              initial={false}
              animate={{
                backgroundColor: isSelected ? 'rgba(0,145,255,0.16)' : 'rgba(255,255,255,0.04)',
                boxShadow: modified ? 'inset 0 0 0 2px #0091ff' : 'inset 0 0 0 0px #0091ff',
              }}
              transition={snappy}
              style={{ position: 'relative', width: 46, height: 46, borderRadius: 'var(--r-list)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name={tool.icon} size={22} color={isSelected ? 'var(--blue-text)' : tool.tint ?? (dimmed ? 'rgba(235,235,245,0.45)' : 'var(--label-2)')} />
              {tool.kind === 'locked' && (
                <span aria-hidden="true" style={{ position: 'absolute', right: -3, bottom: -3, width: 18, height: 18, borderRadius: 'var(--r-control)', background: 'var(--bg-elevated-3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="lock" size={10} strokeWidth={2.8} />
                </span>
              )}
            </motion.span>
            {/* Selalu setinggi dua baris: label panjang (Flash Magenta) tidak menaikkan panel. */}
            <span className="t-caption2" style={{ color: isSelected ? '#fff' : 'rgba(235,235,245,0.6)', height: '2.36em', textAlign: 'center' }}>{tool.label}</span>
          </motion.button>
        );
      })}
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
          {(tool.kind === 'slider' || tool.kind === 'diffusion') && <span className="t-body secondary tabular" style={{ whiteSpace: 'nowrap' }}>{valueText(tool, ctx.params)}</span>}
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
