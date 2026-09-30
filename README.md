# DICHROIC

DICHROIC ports the SpektraFilm spectral film simulation pipeline to the
browser, running on WebGPU.

## Derivation and attribution

DICHROIC is a **derivative work** of SpektraFilm by Andrea Volpato:

- Python research implementation and profile-generation foundation:
  https://github.com/andreavolpato/spektrafilm
- Native OFX plugin (density-emulation foundation, profile curves,
  spectral upsampling direction):
  https://github.com/chaert-s/spektrafilm-ofx

The physical model, tap topology, and profile-curve generation this
project reimplements in WebGPU/TypeScript are ported from those two
upstream repositories. See `tools/README.md` and
`tools/setup_envs.md` in this repository for the exact upstream
commits verified against during Phase 1.

## Licence

DICHROIC is licensed under the **GNU General Public License v3.0 or
later** (GPL-3.0-or-later), the same licence as its upstream. The full
licence text is in [`LICENSE`](./LICENSE).

Third-party notices carried over from the upstream `spektrafilm-ofx`
distribution are reproduced below, for provenance. Not every notice
applies to this port (e.g. the OpenFX SDK and its vendored headers are
part of the native OFX plugin, not the WebGPU port), but the file is
included in full and unmodified so nothing is silently dropped.

## Relationship to EMULSION

DICHROIC began inside the EMULSION repository as a `spektra/` folder beside
EMULSION's `web/` app, and moved to its own repository on 2026-09-28 with its
full history preserved (`git filter-repo`, `spektra/` promoted to the root).

EMULSION is a separate project with its own licence. It is **not** covered by
DICHROIC's GPL-3.0-or-later licence, and DICHROIC's GPL-3.0 does not extend to
it. Living in separate repositories is now the primary boundary between them,
and it is stronger than the one this project used to rely on: neither can
reach the other's files through a relative path.

The old in-repo guards remain as a second line of defence against DICHROIC
ever importing EMULSION code: the `no-restricted-imports` rule in
`eslint.config.js`, and the first check in `test/boundary.test.ts`, which scans
every `.ts`/`.tsx` file under `src/` for any import or export form that
references `web/`. The second check in that file — the reverse direction,
reading `../web/src` — skips itself automatically when that directory does not
exist, which is the normal state for this standalone repository.

## Third-party notices (upstream `spektrafilm-ofx`, verbatim copy)

```text
spektrafilm OFX Third-Party Notices

This file accompanies the native OFX plugin distributions of spektrafilm,
spektrafilm flow, and spektrafilm dev.


Andrea Volpato spektrafilm
--------------------------

spektrafilm builds on foundational open-source imaging work. The
density-emulation foundation is informed by Andrea Volpato's film modeling
work.

Original Python research implementation and profile-generation foundation:
https://github.com/andreavolpato/spektrafilm


Hanatos / vkdt Spectral Upsampling Direction
--------------------------------------------

The spektrafilm spectral upsampling path uses Johannes Hanika's Hanatos 2025
models and LUT direction. The source context is the hanatos/vkdt GPU imaging
project:

https://github.com/hanatos/vkdt


Mallett and Yuksel 2019
-----------------------

The alternate spectral reconstruction path follows the Mallett and Yuksel 2019
spectral primary decomposition direction:

https://diglib.eg.org/items/bbffa865-e99c-4c1f-bd33-70102dc8af78


OpenFX SDK
----------

The OpenFX SDK headers and support headers are vendored from the Academy
Software Foundation OpenFX project.

Upstream: https://github.com/AcademySoftwareFoundation/openfx
Release: OFX_Release_1.5.1
Local license source: OFX/SpektraFilm/third_party/openfx/LICENSE.md

BSD 3-Clause License

Copyright (c) 2025, OpenFX and contributors to the OpenFX project

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from this
   software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.


OpenFX Key Symbols Embedded Notices
-----------------------------------

The vendored OpenFX header include/ofxKeySyms.h also carries the following
embedded notices.

Copyright (c) 1987, 1994  X Consortium

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE X CONSORTIUM BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

Except as contained in this notice, the name of the X Consortium shall
not be used in advertising or otherwise to promote the sale, use or
other dealings in this Software without prior written authorization
from the X Consortium.


Copyright 1987 by Digital Equipment Corporation, Maynard, Massachusetts

                        All Rights Reserved

Permission to use, copy, modify, and distribute this software and its
documentation for any purpose and without fee is hereby granted,
provided that the above copyright notice appear in all copies and that
both that copyright notice and this permission notice appear in
supporting documentation, and that the name of Digital not be
used in advertising or publicity pertaining to distribution of the
software without specific, written prior permission.

DIGITAL DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE, INCLUDING
ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS, IN NO EVENT SHALL
DIGITAL BE LIABLE FOR ANY SPECIAL, INDIRECT OR CONSEQUENTIAL DAMAGES OR
ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS
SOFTWARE.
```

Source: `Legal/THIRD_PARTY_NOTICES.txt` in `chaert-s/spektrafilm-ofx`.

## Running the app

```bash
npm ci
npm run dev        # http://localhost:5173 — open it on your phone with `npm run dev -- --host`
npm run build      # production bundle in dist/
npm run preview    # serve dist/ with the same headers
```

Use Node.js 22.13 or newer. Closing a photo releases its worker, including
the decoder heap and GPU resources; choosing another photo starts it again.
Decoders reject images that exceed their memory budget with a request to
open a smaller version. This budget bounds supported allocations, rather
than guaranteeing a particular browser's total memory consumption.

### Checking changes

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --audit-level=moderate
```

Tests use fresh, serialized processes for Dawn GPU tests. Set
`DICHROIC_TEST_GROUP=cpu` or `gpu` to run either group. Codec encoder checks
require Python with NumPy, Pillow, tifffile and OpenImageIO; point
`DICHROIC_REF_PYTHON` at that interpreter. CI installs and requires the
oracle environment, runs both groups, and blocks deployment on failures.
On Windows, `DICHROIC_DAWN_ADAPTER="Microsoft Basic Render Driver"` selects
WARP for a reproducible software GPU check.

`tools/browser_smoke.mjs` checks a fresh Chrome profile against a running
server. It requires Chrome and `playwright-core`, either locally installed
or under the package directory selected by `DICHROIC_PLAYWRIGHT_ROOT`.
Set `DICHROIC_SMOKE_URL` to the server URL. Run with `--depth --offline`
against a production preview to exercise explicit depth downloads, cached
inference, photo close/reopen, and offline PWA loading. Add `--gpu-depth`
to use desktop backend selection instead of the emulated mobile CPU policy.
Generated screenshots and test reports go to the ignored `artifacts/` directory.

See [the fixes and verification record](docs/PROJECT_FIXES.md) for the
findings addressed and the remaining hardware validation limits.

DICHROIC needs WebGPU (Safari on iOS 26+, current Chrome, Edge or Firefox).
RAW decoding uses shared WASM memory, so the page must be cross-origin
isolated: the dev and preview servers send `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.

### Installing and hosting

The production build is a Progressive Web App: its service worker
(`src/sw.ts`) caches the whole app, including the ~7 MB of spectral data,
so after the first visit it runs offline. On iPhone, open the site in Safari
and choose **Share → Add to Home Screen**; it then opens full screen like a
native app. Photos never leave the device.

- **GitHub Pages** — `.github/workflows/deploy.yml` builds and publishes on
  every push to `main`. Enable it once under *Settings → Pages → Source:
  GitHub Actions*; the app is served at `https://<user>.github.io/<repo>/`.
  Pages cannot send custom headers, so the service worker adds the isolation
  headers itself and the page reloads once on the first visit.
- **Cloudflare Pages / Netlify** — build command `npm run build`, output
  `dist`; `public/_headers` sends the isolation and cache headers.
- **Anywhere else** — serve `dist/` over HTTPS with the two headers above.
  For a subpath, build with `DICHROIC_BASE=/path/ npm run build`.

Icons and iOS launch screens come from `node tools/gen_icons.mjs`.

## Project layout

```
index.html        app entry
src/
  ui/             React + Motion interface (iPhone-first, Apple HIG / Liquid Glass)
  sw.ts           service worker (offline precache, cross-origin isolation)
  session/        Session facade and its Web Worker RPC
  engine/         WebGPU render graph and stages (TypeScript + WGSL in shaders/)
  io/             image decoders and encoders
  params/         RenderParams, parity-gated field registry, render plan
test/             vitest tests, including the licence boundary test
tools/            upstream toolchain records and fixture generators
package.json      independent dependency graph — see "Licence" above
```

## Camera develop controls

The Camera panel provides White Balance, Light, and Color adjustments before film simulation. Exposure is a scene-linear RGB gain of `2 ** EV` (-5 to +5 stops), independent of negative/print exposure. Values above 1 remain available to the film pipeline rather than being clipped to display white. The neutral camera stage is skipped exactly.

Temperature and Tint are relative corrections (-100 to +100), with zero preserving decoded white balance. LibRaw currently applies camera white balance during RAW decoding; the temperature readout therefore does not claim to show the sensor's original Kelvin metadata. Contrast, Highlights, Shadows, Whites, Blacks, and Saturation also use a relative -100 to +100 interface, mapped to the existing validated processing domains. Existing edits retain their underlying values.

The panel follows the basic photographic workflow described in [Adobe Camera Raw's official tone and color guide](https://helpx.adobe.com/camera-raw/desktop/using/make-color-tonal-adjustments-camera.html). Camera RAW decoding controls are format-specific in Resolve; consult [Blackmagic's official documentation](https://www.blackmagicdesign.com/support). DICHROIC uses its own CAT02 adaptation and luminance tone operators: matching slider numbers does not establish pixel parity with Adobe or Resolve. Highlights adjusts available decoded data, without claiming sensor highlight reconstruction, ISO changes, or a different demosaic.

Lens focus dragging previews a cached depth mask capped at 768 pixels on its long edge, composited over the existing high resolution photo. Source detail and export resolution stay unchanged. Pointer movement updates provisional focus locally; releasing the pointer commits the final focus and requests the expensive film/blur render once. Pinch and pointer cancellation discard provisional edits. A synthetic 4096x2048 preview benchmark in local Edge measured about 231 ms per old full-frame focus check versus 3.2 ms per prepared mask update; this is not an iPhone device benchmark.

## HSV Saturation

Camera → Color → HSV Saturation isolates the HSV S channel: 0–200 scales S by 0–2, with 100 neutral. Hue and Value (`max(R,G,B)`) stay fixed at this operation; saturation stops at 1, while HDR Value above 1 is retained. This runs in decoded linear input RGB after other Camera color/tone controls and before film. HSV Value is not luminance, so perceived brightness can change, and subsequent film processing can change hue/brightness. Neutral bypasses exactly; preview and full image export use the same camera uniform without adding a GPU pass or scratch buffer. Like the existing Camera develop controls, it is excluded from CUBE export. This is an isolated S gain, not a custom HSV curve or a claim of pixel parity with Resolve's working color spaces.

## Soften Detail

Camera → Detail → Soften Detail (0–100) attenuates harsh input texture before camera develop, film exposure, and grain. Zero omits the stage exactly. The implementation is an independent Gaussian-weighted self-guided filter on log input luminance, with color-space luminance weights, bounded scalar RGB corrections, and a maximum 90% blend. Strong edges receive less smoothing; this is not exact reversal of baked phone sharpening or a dedicated halo reconstruction algorithm. The four separable WebGPU passes reuse two compact vec2 scratch buffers through the render graph pool.

The kernel footprint scales with render dimensions (sigma 1.5 px at a 4096 px long edge, bounded to 0.85–4 px, with a minimum effective footprint for fit previews), so zoom previews and full exports use the same normalized detail scale. Tiled exports include the full two-kernel apron. Spatial smoothing is excluded from cube LUTs and reported with other disabled spatial effects. CPU/GPU reference checks cover texture attenuation, color ratios, alpha, strong edge contrast, and full-frame/tile consistency. Browser checks cover active preview, native zoom, mobile controls, and 2048×1366 PNG export; final tuning on real phone photos and iPhone hardware remains unverified.

## Film Off

Select Off at the top of the Film list, or disable Film Simulation in the Film controls. This bypasses spectral film exposure/develop, halation, DIR, grain, paper and scanner processing while retaining Camera develop, Soften Detail, Lens Blur and camera diffusion. Output still converts to the selected output primaries and transfer function. Film auto-exposure and film/print exposure controls are bypassed. Stock and paper selections are retained; choosing a film re-enables simulation. Preview and image export share the same path; the graph cache includes the bypass state.
