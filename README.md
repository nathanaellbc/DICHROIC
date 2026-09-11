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
upstream repositories. See `spektra/tools/README.md` and
`spektra/tools/setup_envs.md` in this repository for the exact upstream
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

## `web/` (EMULSION) is a separate project

The `web/` directory at the root of this repository is **EMULSION**, a
separate, unrelated project with its own licence. EMULSION is **not**
covered by DICHROIC's GPL-3.0-or-later licence, and DICHROIC's GPL-3.0
does not extend to it. The two projects intentionally do not share a
dependency graph: `spektra/` has its own `package.json`.

The boundary is enforced in both directions, by different mechanisms,
because only `spektra/`'s own tooling can reach both trees:

- **`spektra/` importing `web/`** — blocked twice: by the `no-restricted-imports`
  ESLint rule in `spektra/eslint.config.js` (`npm run lint`, which runs
  `eslint src test` inside `spektra/`), and by the first check in
  `spektra/test/boundary.test.ts`, which scans every `.ts`/`.tsx` file under
  `spektra/src` for any import/export form that references `web/`.
- **`web/` importing `spektra/`** — the more dangerous direction, since it
  would pull GPL-3.0 code into non-GPL EMULSION. There is no ESLint
  coverage for it (`spektra`'s `lint` script only lints inside `spektra/`,
  and `web/` has its own separate lint config this project does not touch).
  It is enforced by the second check in `spektra/test/boundary.test.ts`,
  which reads (read-only — it never modifies `web/` or its config) every
  `.ts`/`.tsx` file under `../web/src` and fails if any of them reference
  `spektra`.

Both checks in `boundary.test.ts` catch static `import ... from '...'`,
side-effect `import '...'`, dynamic `import('...')`, and re-export
`export ... from '...'` — not just the first form.

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

## Project layout

```
spektra/
  src/            engine source (TypeScript + WGSL)
  test/           vitest tests, including the licence boundary test
  tools/          upstream toolchain verification records (Task 1)
  package.json    independent dependency graph — see "Licence" above
```
