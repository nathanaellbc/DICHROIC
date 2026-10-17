/**
 * Label riwayat Undo (tekan lama tombol Undo): tiap langkah dinamai menurut
 * alat yang diubahnya, dengan nilai sesudahnya -- "Exposure  +0.3",
 * "Film  Portra 800". Beberapa alat sekaligus (Reset, Swap): "Exposure, Grain".
 */
import type { RenderParams } from '../../params/renderParams';
import { GROUPS, valueText } from './tools';
import type { Tool } from './tools';
import { stockInfo } from './stocks';

/** Field yang diatur sebuah alat. */
function fieldsOf(tool: Tool): readonly string[] {
  switch (tool.kind) {
    case 'slider': return tool.enabledBy ? [tool.field, tool.enabledBy] : [tool.field];
    case 'diffusion': return [tool.enabledBy, tool.familyField, tool.strengthField];
    case 'whiteBalance': return tool.fields;
    case 'locked': return [];
    default: return [tool.field];
  }
}

const TOOLS: readonly Tool[] = GROUPS.flatMap((g) => g.tools);

export interface HistoryLabel { label: string; value?: string }

export function describeChange(from: RenderParams, to: RenderParams): HistoryLabel {
  const changed = (Object.keys(to) as Array<keyof RenderParams>).filter((k) => from[k] !== to[k]);
  if (changed.length === 0) return { label: 'No change' };
  const names: string[] = [];
  let value: string | undefined;
  const add = (name: string, v: string) => {
    if (names.includes(name)) return;
    names.push(name);
    value = names.length === 1 ? v : undefined;
  };
  for (const key of changed) {
    if (key === 'film' || key === 'filmEnabled') add('Film', to.filmEnabled ? stockInfo(to.film).short : 'Off');
    else if (key === 'paper') add('Paper', stockInfo(to.paper).short);
    else {
      const tool = TOOLS.find((t) => fieldsOf(t).includes(key));
      if (tool) add(tool.title, valueText(tool, to));
    }
  }
  if (names.length === 0) return { label: 'Adjustment' };
  return names.length <= 2 ? { label: names.join(', '), value } : { label: `${names.slice(0, 2).join(', ')} +${names.length - 2}` };
}
