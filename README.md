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
