# Task 1: upstream toolchains — verification record

Both upstream Python toolchains that DICHROIC Phase 1 depends on were
verified working on Windows (Git Bash + PowerShell, Python 3.13.15). This
file records the exact commands that worked, the upstream commit hashes,
and every deviation from the task brief.

## Upstream repos and commits

| Repo | Path | Commit |
|---|---|---|
| `spektrafilm` | `D:/Projects/upstream/spektrafilm` | `3bb2c2d2801ff68b92019cf1dbcbb133d60832bc` |
| `spektrafilm-ofx` | `D:/Projects/upstream/spektrafilm-ofx` | `86476afc5b077de77e2278e3658d1ba9309892a1` |

Verified with:

```bash
git -C D:/Projects/upstream/spektrafilm rev-parse HEAD
git -C D:/Projects/upstream/spektrafilm-ofx rev-parse HEAD
```

## Deviation 1: clone location

The brief uses `~/src/upstream`. On this Windows machine we used
`D:/Projects/upstream/` instead — outside the EMULSION repo, stable, and
not inside any git worktree. `SPEKTRAFILM_PY` and `SPEKTRAFILM_OFX` point
there. Venvs (`.venv-bake`, `.venv-ref`) live alongside the clones in
`D:/Projects/upstream/`, not under `~/.venvs/`.

## Step 1–3: bake venv and bake script (PASSED)

Exact commands: `tools/setup_envs.md`, Steps 1–3. (Clone both repos, set
`SPEKTRAFILM_PY`/`SPEKTRAFILM_OFX`, create `.venv-bake`, install `numpy
scipy colour-science`, run `generate_profile_curves.py`.)

Installed versions (unpinned, latest compatible with Python 3.13): `numpy
2.5.3`, `scipy 1.18.1`, `colour-science 0.4.7`. Clean install, no build
failures.

Ran clean (one harmless `ColourUsageWarning` about matplotlib not being
installed in the bake venv — matplotlib is not needed for this script's
code path). Also printed a notice that SMPTE ST 2065-2 CSV files are
absent from the public checkout (licensed standards data, not
redistributed upstream) — this disables Academy Printer Density /
printer-light mode in the OFX build, which is expected and does not affect
this task's gate.

Output artifacts:

| File | Size (bytes) |
|---|---|
| `SpektraGeneratedProfileCurves.cpp` | 5,153,586 |
| `SpektraHanatos2025Spectra.f32` | **11,943,936** |
| `SpektraOutputGamutCompression.f32` | 1,872 |

`SpektraHanatos2025Spectra.f32` is exactly `192 * 192 * 81 * 4 =
11,943,936` bytes — **gate passed**. Note: the task context described this
LUT as "float16"; the byte math and the `.f32` filename both point to
float32 (4 bytes/element), not float16 (2 bytes/element — which would be
5,971,968 bytes). The actual output matches the float32 byte count
exactly, so this is a minor wording inconsistency in the context, not a
problem with the bake.

## Deviation 2: reference venv installed with `--no-deps` (coordinator ruling)

The brief's Step 4 (`pip install -e "$SPEKTRAFILM_PY"`) pulls in
`spektrafilm`'s full `dependencies` list from `pyproject.toml`, which
includes GUI/app packages (`qtpy`, `pyside6`, `napari`, `Pillow`,
`pyconify`, `markdown`) that the package's own pyproject.toml comments
state are "not imported by the core physical runtime under
`spektrafilm/`". A first attempt at the full `pip install -e` pulled in
`napari`'s huge transitive dependency tree (Sphinx, IPython, app-model,
etc.) and was still resolving dependencies with no packages actually
installed after several minutes — a bad trade for code this task never
calls.

**Ruling applied:** install the package with `--no-deps`, then install
only the twelve packages the core runtime under `spektrafilm/` actually
needs (per the `pyproject.toml` core-runtime dependency block). Exact
commands: `tools/setup_envs.md`, Step 4 — that file is the single source
of truth for the command sequence; it is not repeated here so the two
files cannot drift apart again.

All twelve installed as prebuilt Windows wheels — no source builds, no
`OpenImageIO`/`pyfftw` build failures on Windows (the anticipated risk in
the brief did not materialize once GUI deps were excluded).

Installed versions:

```
numpy==2.5.3
scipy==1.18.1
colour-science==0.4.7        (module name: colour, __version__ 0.4.7)
scikit-image==0.26.0         (module name: skimage, __version__ 0.26.0)
matplotlib==3.11.1
opt_einsum==3.4.0
numba==0.67.0                (pulls llvmlite==0.49.0)
OpenImageIO==3.1.17.0
pyFFTW==0.15.1                (module name: pyfftw)
rawpy==0.27.1
exiv2==0.19.2
lensfunpy==1.18.0
spektrafilm==0.3.4            (editable, at the commit above)
```

Risk noted by the coordinator — that `SimulationPipeline` might
transitively import something from the excluded GUI stack — did **not**
materialize: `smoke_upstream.py` (Step 6, below) imports and runs the full
`spektrafilm.runtime` pipeline with only these twelve packages installed,
with no `ModuleNotFoundError`.

## Deviation 3 (important): real `init_params()` / `SimulationPipeline` API

The brief's `smoke_upstream.py` assumed:
- `init_params()` takes no arguments.
- `SimulationPipeline(params).run(image, collect=tap)`.

**Both assumptions needed correction.** Read from
`$SPEKTRAFILM_PY/src/spektrafilm/runtime/params_builder.py` and
`$SPEKTRAFILM_PY/src/spektrafilm/runtime/pipeline.py`:

1. `init_params(film_profile="kodak_portra_400", print_profile="kodak_portra_endura")`
   — takes two *optional* keyword args with defaults, so calling it with no
   arguments works exactly as the brief assumed. **But** its own docstring
   states the result "needs to be digested with `digest_params` before
   being used in the runtime pipeline" — calling `init_params()` alone is
   not sufficient. `digest_params(params, apply_stocks_specifics=True)`
   from the same module must be called on the result first.

2. `SimulationPipeline` has **no `.run()` method**. The actual entry point
   is:

   ```python
   SimulationPipeline(params, update_params=False).process(
       image, *, inject: str | None = None, collect: str | None = None
   )
   ```

   `process()` defaults to a full `rgb_in` → `rgb_out` run when `inject`/
   `collect` are omitted (or taken from `params.taps` if set); passing
   `collect=Tap.CMY_FILM` exits early at that tap, same behavior the brief
   wanted from `.run(...)`.

`spektra/tools/smoke_upstream.py` was written against the **real** API:

```python
params = digest_params(init_params())
out = SimulationPipeline(params).process(ramp, collect=Tap.CMY_FILM)
```

**This changes what Tasks 3 and 11 should assume** — they should call
`.process(...)`, not `.run(...)`, and must digest params via
`digest_params()` before constructing `SimulationPipeline`.

The seven `Tap` constants (`RGB_IN, RGB_PRE, LOG_E_FILM, CMY_FILM,
LOG_E_PRINT, CMY_PRINT, RGB_OUT`) matched the brief exactly, confirmed by
reading `spektrafilm/runtime/topology.py` directly.

## Step 6: smoke test (PASSED)

Exact command: `tools/setup_envs.md`, Step 5.

Output:

```
OK: cmy_film shape=(16, 32, 3) min=0.030885 max=0.993923
```

Exit code `0`. Gate passed.

## Summary: reproduce from a clean machine

`tools/setup_envs.md` is the single source of truth for the exact
command sequence (Steps 1–5) — run it end to end. It is not duplicated
here so this file and that one cannot silently drift apart again. The
last command it runs should print `OK: cmy_film shape=(16, 32, 3) min=...
max=...` and exit `0`.

## Deviations summary

1. Clone/venv location: `D:/Projects/upstream/` instead of `~/src/upstream`
   and `~/.venvs/`.
2. Reference venv installed with `pip install --no-deps -e` plus twelve
   named core-runtime packages, instead of a plain `pip install -e`
   pulling the full GUI dependency stack (`pyside6`, `napari`, etc.).
   Coordinator ruling; no GUI packages were installed or needed.
3. `smoke_upstream.py` adapted to the real API: `digest_params(init_params())`
   feeding `SimulationPipeline(params).process(image, collect=Tap.CMY_FILM)`,
   not the brief's assumed `SimulationPipeline(params).run(image,
   collect=tap)`. **Tasks 3 and 11 need correcting for this.**

---

# Task 4: web asset emitter — verification record

`tools/bake_web_assets.py` bakes `public/data/{manifest.json, stocks.f32,
hanatos.f16, static.f32}` from the same upstream `spektrafilm-ofx`
modules `generate_profile_curves.py` imports for its own C++ literal
bake, run with the same `.venv-bake` from Task 1
(`D:/Projects/upstream/.venv-bake`).

## Deviation: real `ofx_stock_lists.py` accessor names

The task brief assumed `stocks.film_stock_order()` and
`stocks.paper_stock_order()` as function names. The real module
(`$SPEKTRAFILM_OFX/tools/ofx_stock_lists.py`) exports no functions with
those names — it exports module-level lists `FILMS` (from
`_LEGACY_FILM_ORDER`, 20 entries) and `PAPERS` (from
`_LEGACY_PAPER_ORDER`, 8 entries), plus `DEFAULT_FILM_STOCK`,
`DEFAULT_PAPER_STOCK`, `DEFAULT_FILM_INDEX`, `DEFAULT_PAPER_INDEX`.
`bake_web_assets.py` uses `stocks.FILMS + stocks.PAPERS` directly.

## Real divergence caught by the Step 5 C++ comparison — density-curve normalization

Step 5 (comparing emitted values against upstream's own
`SpektraGeneratedProfileCurves.cpp` literal) is not a formality here — it
caught a real bug in the emitter's first draft, which followed the task
brief's stub code literally.

`generate_profile_curves.py`'s `_emit_group` (line 1027) does **not**
call the same density-curve function for both groups:

```python
density_curves = _normalized_density_curves(profile) if group_name == "film" else _density_curves(profile)
```

`_normalized_density_curves` subtracts each channel's per-stock minimum
so the floor sits at exactly zero; `_density_curves` returns the raw
(un-floored) values, which are typically small negative numbers near the
toe. Paper stocks always use the raw form; film stocks use the
zero-floored form. The brief's Step 1 stub called `gpc._density_curves`
unconditionally for every stock (film and paper alike), which is what a
first draft of `pack_stocks` did too — silently diverging from upstream
for all 20 film stocks.

Caught by hand-verifying `kodak_portra_400` (a film stock) against the
upstream JSON profile directly: its raw first density row is
`[-0.0006779488455236844, -0.000717365606925111, -0.0007336407905284251]`
(matching `Resources/data/profiles/kodak_portra_400.json`), but
`generate_profile_curves.py`'s own C++ literal
(`film_2_kodak_portra_400_density_curves`) emits `0.0f, 0.0f, 0.0f` for
that same row — only explained by the per-channel floor subtraction
`_normalized_density_curves` performs.

Fixed by mirroring upstream's own branch in `pack_stocks`: film stocks
(`stocks.FILMS`) use `gpc._normalized_density_curves(profile)`, paper
stocks (`stocks.PAPERS`) use `gpc._density_curves(profile)` — same
functions upstream already exports, called the same way upstream itself
calls them. No spectral math was reimplemented.

## Step 5 result: emitted values vs. upstream C++ literal

Ran the upstream bake exactly as in `setup_envs.md` Step 3 to regenerate
`SpektraGeneratedProfileCurves.cpp` fresh, then compared:

**Film stock (`kodak_portra_400`, normalized path) — first 20
`density_curves` floats, `stocks.f32` vs.
`film_2_kodak_portra_400_density_curves[]` in the freshly generated
`.cpp`:**

```
stocks.f32 (as f32): [0.0, 0.0, 0.0, 0.00010853547428268939, 0.00013595950440503657,
  7.788008952047676e-05, 0.0002805612748488784, 0.0003780422848649323,
  0.00020588880579452962, 0.00046512772678397596, 0.0006180315976962447,
  0.0003652930317912251, 0.0006161166820675135, 0.0007130915182642639,
  0.0005807586130686104, 0.0007340260781347752, 0.0006166005041450262,
  0.0008604330942034721, 0.0008739828481338918, 0.0004690849164035171]
cpp literal:           [0.0f, 0.0f, 0.0f, 0.000108535476f, 0.000135959505f,
  7.78800863e-05f, 0.000280561274f, 0.000378042284f, 0.000205888813f,
  0.000465127734f, 0.000618031569f, 0.000365293036f, 0.000616116667f,
  0.000713091498f, 0.000580758622f, 0.000734026083f, 0.000616600478f,
  0.000860433091f, 0.000873982874f, 0.000469084905f]
```

Compared programmatically by round-tripping both sides through an f32
`struct.pack`/`unpack`: **all 20 values bit-identical as f32, max
absolute difference `0.0`.**

**Paper stock (`kodak_2383`, raw path) — first 12 `density_curves`
floats, spot-checked the same way:**

```
stocks.f32:  [-0.000822072965092957, -0.0008208895451389253, -0.0008278018794953823,
  -0.000707432278431952, -0.000671244750265032, -0.0007421677000820637,
  -0.0005224037449806929, -0.00040324850124306977, -0.0006007675547152758,
  -0.00032430372084490955, -0.00013798581494484097, -0.00042462439159862697]
cpp literal: [-0.000822072968f, -0.000820889517f, -0.000827801886f, -0.000707432257f,
  -0.000671244755f, -0.000742167709f, -0.00052240376f, -0.000403248507f,
  -0.000600767538f, -0.000324303724f, -0.000137985809f, -0.000424624396f]
```

Matches to f32 precision (differences only in the 7th–9th significant
digit, i.e. within f32 rounding of the same double-precision source
value).

This is the only check that the emitter did not silently diverge from
upstream's own derivation, and it did catch a real divergence on the
first attempt — see above.

## Emitted asset sizes

| File | Bytes | MB |
|---|---|---|
| `stocks.f32` | 114,688 | 0.109 |
| `hanatos.f16` | 5,971,968 | 5.696 |
| `static.f32` | 1,872 | 0.0018 |
| `manifest.json` | 32,403 | 0.031 |
| **Total** | **6,120,931** | **5.838** |

The task context predicted `stocks ≈0.45 MB`; the actual figure is
`0.109 MB`. Verified this isn't a bug: every one of the 28 profiles has
exactly 256 `log_exposure` points and 256 `density_curves` rows (checked
directly against the upstream JSON for `kodak_portra_400`, `kodak_2383`,
`kodak_kodachrome_64`), so `114,688 = 28 * (256 + 256*3) * 4` bytes
exactly, matching the offset-contiguity test in `assets.test.ts`. The
Hanatos LUT (`5.696 MB`) and total (`5.838 MB`) both landed close to
the predicted `5.70 MB` / `≈6.3 MB` — the stock-table estimate in the
original brief context was simply high; nothing in the derivation
supports a larger figure.

`hanatos.f16` is `192 * 192 * 81 * 2 = 5,971,968` bytes, confirming the
LUT source (`$SPEKTRAFILM_OFX/Resources/data/luts/spectral_upsampling/irradiance_xy_tc.npy`,
loaded via `gpc.HANATOS_LUT_PATH`) is genuinely float16 — the emitter's
`assert lut.dtype == np.float16` passed without needing to be relaxed.
