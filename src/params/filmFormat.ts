/**
 * Sisi panjang tiap format film (mm), `filmFormatLongEdgeMm` OFX
 * (`SpektraVulkanRenderer.cpp:2008`). Modul ringan tanpa impor engine, dipakai
 * `plan.ts`, `Session`, dan UI (readout lens blur).
 */
import type { FilmFormat } from './renderParams';

export const FILM_FORMAT_LONG_EDGE_MM: Readonly<Record<FilmFormat, number>> = Object.freeze({
  standard8: 4.8,
  super8: 5.79,
  standard16: 10.26,
  super16: 12.52,
  standard35: 35,
  super35: 24.89,
  standard65: 52.48,
  imax70: 70.41,
});
