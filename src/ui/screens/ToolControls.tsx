/**
 * Kontrol per alat, dipakai panel HP (satu alat aktif) dan inspector layar
 * lebar (semua alat satu kelompok). Satu sumber kebenaran: `model/tools.ts`.
 */
import { motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import type { RenderParams } from '../../params/renderParams';
import { Icon } from '../components/Icon';
import { OptionRow, PressButton, Slider, Stepper, Switch } from '../components/controls';
import { pressScale, snappy } from '../motion';
import {
  choicePatch,
  decodeAllowed,
  formatPushPull,
  isModified,
  resetPatch,
  sliderPatch,
  sliderValue,
  valueText,
} from '../model/tools';
import type { ChoiceTool, Tool, ToolGroup } from '../model/tools';

export interface ToolContext {
  params: RenderParams;
  defaults: RenderParams;
  onPatch: (patch: Partial<RenderParams>) => void;
  /** Daftar pilihan panjang (colour space input) dibuka di sheet terpisah. */
  onOpenList: (tool: ChoiceTool) => void;
}

/** Pilihan > 10 tidak muat sebagai kapsul; tampil sebagai tombol yang membuka daftar. */
export function isLongChoice(tool: ChoiceTool): boolean {
  return tool.options.length > 10;
}

function toolEnabled(tool: Tool, params: RenderParams): boolean {
  if (tool.kind === 'slider' && tool.enabledBy) return params[tool.enabledBy];
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
  if (tool.kind === 'slider' && tool.enabledBy) {
    const field = tool.enabledBy;
    return <Switch label={tool.title} checked={params[field]} onChange={(v) => onPatch({ [field]: v })} />;
  }
  return null;
}

export function ResetButton({ tool, ctx }: { tool: Tool; ctx: ToolContext }) {
  const show = (tool.kind === 'slider' || tool.kind === 'stepper') && isModified(tool, ctx.params, ctx.defaults);
  return (
    <motion.span
      initial={false}
      animate={{ opacity: show ? 1 : 0, scale: show ? 1 : 0.6, width: show ? 44 : 0 }}
      transition={snappy}
      style={{ display: 'inline-flex', overflow: 'hidden', flexShrink: 0 }}
    >
      <PressButton className="icon-btn" aria-label={`Reset ${tool.title}`} tabIndex={show ? 0 : -1} aria-hidden={!show} onClick={() => ctx.onPatch(resetPatch(tool, ctx.defaults))}>
        <Icon name="reset" size={18} strokeWidth={2.2} />
      </PressButton>
    </motion.span>
  );
}

/** Kontrol utama alat (slider, stepper, pilihan, atau catatan). */
export function ToolControl({ tool, ctx }: { tool: Tool; ctx: ToolContext }) {
  const { params, defaults, onPatch } = ctx;
  switch (tool.kind) {
    case 'slider': {
      const slider = (
        <Slider
          label={tool.title}
          value={sliderValue(tool, params)}
          min={tool.min}
          max={tool.max}
          step={tool.step}
          defaultValue={sliderValue(tool, defaults)}
          valueText={valueText(tool, params)}
          disabled={!toolEnabled(tool, params)}
          onChange={(v) => onPatch(sliderPatch(tool, v))}
        />
      );
      if (!tool.note) return slider;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {slider}
          <p className="t-footnote secondary" style={{ margin: 0 }}>{tool.note}</p>
        </div>
      );
    }
    case 'stepper': {
      const v = params[tool.field];
      const isSeed = tool.field === 'grainSeed';
      return (
        <Stepper
          label={tool.title}
          valueText={isSeed ? `Seed ${v}` : formatPushPull(v)}
          hint={isSeed ? 'Grain pattern' : v === 0 ? 'Normal development' : v > 0 ? 'Longer development' : 'Shorter development'}
          atMin={v <= tool.min}
          atMax={v >= tool.max}
          onDecrement={() => onPatch({ [tool.field]: Math.max(tool.min, v - tool.step) })}
          onIncrement={() => onPatch({ [tool.field]: Math.min(tool.max, v + tool.step) })}
          extra={
            isSeed ? (
              <PressButton className="icon-btn" aria-label="Random grain pattern" onClick={() => onPatch({ grainSeed: 1 + Math.floor(Math.random() * 9999) })}>
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
      return <OptionRow label={tool.title} options={tool.options} value={params[tool.field]} onChange={(v) => onPatch(choicePatch(tool, v))} />;
    case 'toggle': {
      const blocked = tool.field === 'inputCctfDecoding' && !decodeAllowed(params.inputColorSpace);
      return <p className="t-subhead secondary" style={{ margin: 0 }}>{blocked ? `Not available for ${params.inputColorSpace}.` : tool.note}</p>;
    }
    case 'locked':
      return <p className="t-subhead secondary" style={{ margin: 0 }}>{tool.note}</p>;
  }
}

/** Deretan alat satu kelompok (panel HP). Alat terpilih digulir ke tengah. */
export function ToolChips({ group, selected, onSelect, ctx }: { group: ToolGroup; selected: string; onSelect: (id: string) => void; ctx: ToolContext }) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    refs.current.get(selected)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [selected]);
  return (
    <div role="group" aria-label={`${group.label} tools`} className="scroll-x" style={{ display: 'flex', gap: 4, margin: '0 -20px', padding: '2px 16px' }}>
      {group.tools.map((tool) => {
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
                backgroundColor: isSelected ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.10)',
                boxShadow: modified ? 'inset 0 0 0 2px #0091ff' : 'inset 0 0 0 0px #0091ff',
              }}
              transition={snappy}
              style={{ position: 'relative', width: 48, height: 48, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name={tool.icon} size={22} color={isSelected ? '#000' : tool.tint ?? (dimmed ? 'rgba(235,235,245,0.45)' : '#fff')} />
              {tool.kind === 'locked' && (
                <span aria-hidden="true" style={{ position: 'absolute', right: -2, bottom: -2, width: 18, height: 18, borderRadius: '50%', background: '#3a3a3c', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="lock" size={10} strokeWidth={2.8} />
                </span>
              )}
            </motion.span>
            <span className="t-caption2" style={{ color: isSelected ? '#fff' : 'rgba(235,235,245,0.6)' }}>{tool.label}</span>
          </motion.button>
        );
      })}
    </div>
  );
}

/** Satu alat sebagai baris inspector (layar lebar). */
export function InspectorTool({ tool, ctx }: { tool: Tool; ctx: ToolContext }) {
  const locked = tool.kind === 'locked';
  return (
    <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6, opacity: locked ? 0.55 : 1 }}>
      <div style={{ minHeight: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          {tool.tint && <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: tool.tint, flexShrink: 0 }} />}
          <span className="t-subhead">{tool.title}</span>
          {locked && <Icon name="lock" size={13} />}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {(tool.kind === 'slider' || tool.kind === 'stepper') && <span className="t-subhead secondary tabular">{valueText(tool, ctx.params)}</span>}
          <ResetButton tool={tool} ctx={ctx} />
          <ToolSwitch tool={tool} ctx={ctx} />
        </span>
      </div>
      {tool.kind !== 'toggle' && <ToolControl tool={tool} ctx={ctx} />}
      {tool.kind === 'toggle' && (
        <p className="t-footnote secondary" style={{ margin: 0 }}>
          {tool.field === 'inputCctfDecoding' && !decodeAllowed(ctx.params.inputColorSpace) ? `Not available for ${ctx.params.inputColorSpace}.` : tool.note}
        </p>
      )}
    </div>
  );
}
