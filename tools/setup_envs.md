# Setting up the upstream SpektraFilm toolchains (Windows / Git Bash)

This records the exact steps used to verify the two upstream Python
toolchains that DICHROIC Phase 1 depends on. See `tools/README.md` for the
verification results, upstream commit hashes, and deviations from the
original task brief.

Clone location deviates from the brief's `~/src/upstream`: on this Windows
machine we use `D:/Projects/upstream/` instead — outside the EMULSION repo,
stable, and not inside any git worktree.

## 1. Clone both upstream repos

```bash
mkdir -p D:/Projects/upstream
git clone https://github.com/andreavolpato/spektrafilm.git D:/Projects/upstream/spektrafilm
git clone https://github.com/chaert-s/spektrafilm-ofx.git D:/Projects/upstream/spektrafilm-ofx
```

Set for the session (Git Bash):

```bash
export SPEKTRAFILM_PY=D:/Projects/upstream/spektrafilm
export SPEKTRAFILM_OFX=D:/Projects/upstream/spektrafilm-ofx
```

## 2. Bake venv (spektrafilm-ofx's `generate_profile_curves.py`)

```bash
python -m venv D:/Projects/upstream/.venv-bake
D:/Projects/upstream/.venv-bake/Scripts/pip install numpy scipy colour-science
```

## 3. Run the upstream bake script as-is

```bash
D:/Projects/upstream/.venv-bake/Scripts/python \
  "$SPEKTRAFILM_OFX/tools/generate_profile_curves.py" \
  --output /tmp/spektra-probe/SpektraGeneratedProfileCurves.cpp \
  --hanatos-output /tmp/spektra-probe/SpektraHanatos2025Spectra.f32 \
  --output-gamut-compression-output /tmp/spektra-probe/SpektraOutputGamutCompression.f32
```

Expect `SpektraHanatos2025Spectra.f32` to be exactly `192 * 192 * 81 * 4 =
11943936` bytes.

## 4. Reference venv (the `spektrafilm` package itself)

Do **not** run a plain `pip install -e "$SPEKTRAFILM_PY"`. That pulls the
package's full `pyproject.toml` `dependencies` list, which includes GUI
packages (`pyside6`, `napari`, `qtpy`, `Pillow`, `pyconify`, `markdown`)
the core runtime never imports — `napari` alone drags in a huge transitive
tree (Sphinx, IPython, app-model, etc.) that can spend many minutes
resolving before anything installs. Install with `--no-deps` instead, then
add only the twelve packages the core runtime under `spektrafilm/` needs:

```bash
python -m venv D:/Projects/upstream/.venv-ref
D:/Projects/upstream/.venv-ref/Scripts/pip install --no-deps -e "$SPEKTRAFILM_PY"
D:/Projects/upstream/.venv-ref/Scripts/pip install numpy scipy colour-science scikit-image matplotlib opt-einsum numba OpenImageIO pyfftw rawpy exiv2 lensfunpy
```

See `tools/README.md`, "Deviation 2", for why.

## 5. Smoke test

```bash
D:/Projects/upstream/.venv-ref/Scripts/python tools/smoke_upstream.py
```

Expect `OK: cmy_film shape=(16, 32, 3) min=... max=...` and exit code 0.

See `tools/README.md` for what actually happened when these commands were
run, including package versions, commit hashes, and every deviation from
this plan.
