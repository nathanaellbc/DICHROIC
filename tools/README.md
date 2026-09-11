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

```bash
mkdir -p D:/Projects/upstream
git clone https://github.com/andreavolpato/spektrafilm.git D:/Projects/upstream/spektrafilm
git clone https://github.com/chaert-s/spektrafilm-ofx.git D:/Projects/upstream/spektrafilm-ofx

export SPEKTRAFILM_PY=D:/Projects/upstream/spektrafilm
export SPEKTRAFILM_OFX=D:/Projects/upstream/spektrafilm-ofx

python -m venv D:/Projects/upstream/.venv-bake
D:/Projects/upstream/.venv-bake/Scripts/pip install numpy scipy colour-science
```

Installed versions (unpinned, latest compatible with Python 3.13): `numpy
2.5.3`, `scipy 1.18.1`, `colour-science 0.4.7`. Clean install, no build
failures.

```bash
D:/Projects/upstream/.venv-bake/Scripts/python \
  "$SPEKTRAFILM_OFX/tools/generate_profile_curves.py" \
  --output /tmp/spektra-probe/SpektraGeneratedProfileCurves.cpp \
  --hanatos-output /tmp/spektra-probe/SpektraHanatos2025Spectra.f32 \
  --output-gamut-compression-output /tmp/spektra-probe/SpektraOutputGamutCompression.f32
```

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
needs (per the `pyproject.toml` core-runtime dependency block):

```bash
rm -rf D:/Projects/upstream/.venv-ref
python -m venv D:/Projects/upstream/.venv-ref
D:/Projects/upstream/.venv-ref/Scripts/pip install --no-deps -e D:/Projects/upstream/spektrafilm
D:/Projects/upstream/.venv-ref/Scripts/pip install numpy scipy colour-science scikit-image matplotlib opt-einsum numba OpenImageIO pyfftw rawpy exiv2 lensfunpy
```

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

```bash
D:/Projects/upstream/.venv-ref/Scripts/python.exe spektra/tools/smoke_upstream.py
```

Output:

```
OK: cmy_film shape=(16, 32, 3) min=0.030885 max=0.993923
```

Exit code `0`. Gate passed.

## Summary: reproduce from a clean machine

```bash
mkdir -p D:/Projects/upstream
git clone https://github.com/andreavolpato/spektrafilm.git D:/Projects/upstream/spektrafilm
git clone https://github.com/chaert-s/spektrafilm-ofx.git D:/Projects/upstream/spektrafilm-ofx
export SPEKTRAFILM_PY=D:/Projects/upstream/spektrafilm
export SPEKTRAFILM_OFX=D:/Projects/upstream/spektrafilm-ofx

python -m venv D:/Projects/upstream/.venv-bake
D:/Projects/upstream/.venv-bake/Scripts/pip install numpy scipy colour-science
D:/Projects/upstream/.venv-bake/Scripts/python "$SPEKTRAFILM_OFX/tools/generate_profile_curves.py" \
  --output /tmp/spektra-probe/SpektraGeneratedProfileCurves.cpp \
  --hanatos-output /tmp/spektra-probe/SpektraHanatos2025Spectra.f32 \
  --output-gamut-compression-output /tmp/spektra-probe/SpektraOutputGamutCompression.f32

python -m venv D:/Projects/upstream/.venv-ref
D:/Projects/upstream/.venv-ref/Scripts/pip install --no-deps -e "$SPEKTRAFILM_PY"
D:/Projects/upstream/.venv-ref/Scripts/pip install numpy scipy colour-science scikit-image matplotlib opt-einsum numba OpenImageIO pyfftw rawpy exiv2 lensfunpy

D:/Projects/upstream/.venv-ref/Scripts/python spektra/tools/smoke_upstream.py
```

Expect the last command to print `OK: cmy_film shape=(16, 32, 3) min=...
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
