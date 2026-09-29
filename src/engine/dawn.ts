/**
 * Paket `webgpu` (Dawn untuk Node) -- HANYA jalur test/Node. Di browser
 * `navigator.gpu` dan global `GPUBufferUsage`/`GPUMapMode` selalu ada, jadi
 * impor ini tidak pernah dieksekusi; nama modul lewat variabel supaya bundler
 * browser (Vite/Rollup) tidak mencoba membundel binding native Dawn.
 */
const DAWN_MODULE = 'webgpu';

export function importDawn(): Promise<unknown> {
  return import(/* @vite-ignore */ DAWN_MODULE);
}
