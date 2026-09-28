import { buildChain } from '../../src/engine/chain';
import type { Arenas } from '../../src/engine/arena';
import type { Stage } from '../../src/engine/graph';

/**
 * Rantai 11 tahap keluarga `measured` dengan grain (`<case>_stochastic`).
 * Sejak Fase 2A Task 4 rantainya dirakit di `src/engine/chain.ts`; nama ini
 * dipertahankan supaya gerbang yang sudah ada tidak berubah bentuk.
 */
export function fullChain(device: GPUDevice, arenas: Arenas): Stage[] {
  return buildChain(device, arenas, { family: 'measured', grain: true });
}
