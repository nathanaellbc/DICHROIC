# Print-film LUT provenance

The `.cube` files in this directory are measured film-print emulations, used by
the LUT print engine as an alternative to the calculated print model. They are
indexed on Cineon log and output Rec.709 gamma 2.4. The 2383/3513 headers
declare this explicitly; the 2393 contract follows EMULSION's source notes,
since its G'MIC header contains only its size and domain. Film-stock names identify the
photographic response being modelled; all trademarks are the property of their
respective owners and no affiliation or endorsement is implied.

| File | Stock | Size | Source |
|---|---|---|---|
| `kodak-2383-d55.cube` | Kodak Vision 2383, D55 | 33³ | "Rec709 Kodak 2383 D55" — Film Look LUT as below. |
| `kodak-2383-d60.cube` | Kodak Vision 2383, D60 | 33³ | "Rec709 Kodak 2383 D60" — Film Look LUT as below. |
| `kodak-2383-d65.cube` | Kodak Vision 2383, D65 | 33³ | "Rec709 Kodak 2383 D65" — the Film Look LUT distributed with DaVinci Resolve, originally published by Kodak. Mirrored at `github.com/imnz730/LUTs` (Film Looks). |
| `kodak-2393-d65.cube` | Kodak Premier 2393 | 13³ | Autodesk Film Print Emulation (FPE) series, `kodak_2393_constlclip` variant, via the G'MIC film-LUT collection (`github.com/YahiaAngelo/Film-Luts`, `luts/print`). The FPE cube ships at 13³ in a single white point; its interpolation error is measured, not assumed — see the engine tests. |
| `fuji-3513-d55.cube` | Fujifilm 3513DI, D55 | 33³ | "Rec709 Fujifilm 3513DI D55" — Film Look LUT as below. |
| `fuji-3513-d60.cube` | Fujifilm 3513DI, D60 | 33³ | "Rec709 Fujifilm 3513DI D60" — Film Look LUT as below. |
| `fuji-3513-d65.cube` | Fujifilm 3513DI, D65 | 33³ | "Rec709 Fujifilm 3513DI D65" — Film Look LUT as above. |

Copied as assets only from [nathanaellbc/emulsion](https://github.com/nathanaellbc/emulsion/tree/68579a0fac2c1c9fdb67dd591468c6f1cc9c389f/web/public/luts),
commit `68579a0fac2c1c9fdb67dd591468c6f1cc9c389f`. No EMULSION implementation code is included.

Each file is validated at load for its 0–1 input domain, expected cube size,
sample count and finite values. A load failure surfaces as a render error;
the next render can retry. DICHROIC tests GPU results against independent
CPU Cineon/tetrahedral calculations; this does not measure fidelity to real film.

Implementation: camera/input decoding and controls → linear Rec.709 primaries
→ Cineon (95 black, 685 reference white, 300 codes/decade) → original cube,
with tetrahedral interpolation → gamma 2.4 decoding → chosen output primaries
and transfer function. Cineon values outside the cube domain clamp to its edges.

Film Off uses a neutral reversible density response, retaining exposure,
development gamma, halation, DIR and grain. Its selected stock still supplies
the texture calibration. Neutral DIR retains spatial adjacency contrast and
compensates its uniform-density inhibition so it does not darken the base exposure.
Film On additionally develops the selected stock and
balances each density channel against its own 18% patch before print LUT input.
That density reconstruction is DICHROIC's simulation adapter, not a Resolve CST
for a physical scanned negative. Neither path feeds display sRGB directly into
the Cineon-indexed cube. Photographic paper remains unavailable with Film Off.
