/**
 * Port `enlarger_filtered_illuminant`/`color_enlarger`/`DichroicFilters.apply_cc`
 * (`$SPEKTRAFILM_PY/src/spektrafilm/model/color_filters.py`) -- Task 17
 * (PrintScan). Genuinely RUNTIME-tunable (unlike `densitySpectralMidgray`,
 * which Task 17 bakes into `stocks.f32` instead -- see
 * `tools/bake_web_assets.py::_py_density_spectral_midgray` for why that one
 * is a pure per-film-stock constant and this one is not): the enlarger's
 * M/Y dichroic filter shift are live UI controls
 * (`EnlargerParams.m_filter_shift`/`y_filter_shift`), so this must run at
 * `precomputeArenaData()` time, per-render, not be baked once ahead of time.
 *
 * Python (`color_filters.py`):
 *
 *   def color_enlarger(light_source, filter_cc_values, filters=custom_dichroic_filters):
 *       filter_cc_values = np.array(filter_cc_values)                # [C, M, Y]
 *       return filters.apply_cc(light_source, filter_cc_values)
 *
 *   def apply_cc(self, illuminant, filter_cc_values):
 *       transmittance = 10 ** -(filter_cc_values / 100.0)
 *       return self.apply(illuminant, transmittance)
 *
 *   def apply(self, illuminant, filter_transmittance_values):
 *       dimmed = 1 - (1 - self.filters) * (1 - transmittance)         # (nWave,3)
 *       total_filter = np.prod(dimmed, axis=1)                        # (nWave,)
 *       return illuminant * total_filter
 *
 * `self.filters` is `custom_dichroic_filters.filters` -- ALREADY baked
 * byte-identical between the OFX bake and the Python runtime (verified
 * directly, `scratchpad/probe_static_divergence.py` this session: max abs
 * diff 0.0 across all 81 wavelengths x 3 channels), so it is read here from
 * the existing `static.f32` table `customEnlargerFilters`
 * (`bake_web_assets.py::pack_static`), not recomputed.
 *
 * `filter_cc_values = [c_filter_neutral, m_filter_neutral + m_filter_shift,
 * y_filter_neutral + y_filter_shift]` (`filter_enlarger_source.py::
 * EnlargerService.enlarger_filtered_illuminant`) -- `c_filter_neutral` has
 * NO shift term in Python at all (only M/Y are exposed as live dials), so
 * `EnlargerFilterState` below mirrors that asymmetry exactly rather than
 * inventing a `cFilterShift` Python doesn't have.
 */

/** `EnlargerParams` fields this function actually reads (Python names in parens). */
export interface EnlargerFilterState {
  /** `c_filter_neutral` (default 0 -- Python exposes no C shift dial). */
  cFilterNeutral: number;
  /** `m_filter_neutral` (default 65, Kodak CC units). */
  mFilterNeutral: number;
  /** `m_filter_shift` (default 0 -- live UI dial). */
  mFilterShift: number;
  /** `y_filter_neutral` (default 55, Kodak CC units). */
  yFilterNeutral: number;
  /** `y_filter_shift` (default 0 -- live UI dial). */
  yFilterShift: number;
}

/**
 * `filteredEnlargerIlluminant(lightSource, customDichroicFilters, filters)`
 * -- pure function, f64 throughout (this is per-run host precompute, not
 * per-pixel, so f32 truncation only happens once the caller writes the
 * result into an arena `Float32Array`).
 *
 * @param lightSource nWavelengths spectrum -- `standard_illuminant(enlarger.illuminant)`,
 *   which for every fixture this gate exercises is `TH-KG3`
 *   (`EnlargerParams.illuminant` default, never overridden) -- read by the
 *   caller from `bundle.staticTable('thKg3Illuminant')`, verified
 *   byte-identical between the OFX bake and the Python runtime
 *   (`scratchpad/probe_static_divergence.py`).
 * @param customDichroicFilters (nWavelengths x 3, C/M/Y column order)
 *   transmittance table -- `bundle.staticTable('customEnlargerFilters')`.
 */
export function filteredEnlargerIlluminant(
  lightSource: ArrayLike<number>,
  customDichroicFilters: ArrayLike<number>,
  filters: EnlargerFilterState,
): Float32Array {
  const wavelengthCount = lightSource.length;
  const cValue = filters.cFilterNeutral;
  const mValue = filters.mFilterNeutral + filters.mFilterShift;
  const yValue = filters.yFilterNeutral + filters.yFilterShift;
  const transmittance: [number, number, number] = [
    10 ** -(cValue / 100),
    10 ** -(mValue / 100),
    10 ** -(yValue / 100),
  ];

  const out = new Float32Array(wavelengthCount);
  for (let wl = 0; wl < wavelengthCount; wl += 1) {
    let totalFilter = 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const filterValue = customDichroicFilters[wl * 3 + channel]!;
      totalFilter *= 1 - (1 - filterValue) * (1 - transmittance[channel]!);
    }
    out[wl] = lightSource[wl]! * totalFilter;
  }
  return out;
}
