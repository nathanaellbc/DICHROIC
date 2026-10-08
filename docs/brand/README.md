# DICHROIC brand mark

**Exposure.** A disc of light (Signal Blue) falls on a sheet of paper (white).
Where the light lands, the paper prints black, so the overlap is cut out. It
is the darkroom in one shape: light, paper, and the print they make.

The icon set in `public/` is generated from the same geometry by
`node tools/gen_icons.mjs`.

## Files

| File | Use |
|---|---|
| `dichroic-symbol-on-dark.svg` | Primary symbol on black or graphite: white sheet, blue light |
| `dichroic-symbol-on-light.svg` | Symbol on white or light grey: black sheet, blue light |
| `dichroic-symbol-white.svg` / `-black.svg` / `-blue.svg` | One-colour versions (sheet and light merge; the overlap stays cut out) |
| `dichroic-horizontal-on-dark.svg` / `-on-light.svg` | Symbol + wordmark side by side: headers, README, social cards |
| `dichroic-stacked-on-dark.svg` / `-on-light.svg` | Symbol over wordmark: splash, square formats |
| `dichroic-wordmark-on-dark.svg` / `-on-light.svg` | Wordmark alone |
| `dichroic-app-icon.svg` | Full-bleed app icon: Signal Blue signature on white (iOS and the PWA mask it themselves) |
| `png/` | 1024 px symbols and app icon, 1600 px wide lockups, `board.png` (the mark in use) |

## Construction (256 grid)

- Light: circle, centre (101, 101), radius 70.
- Paper: square 89–225 on both axes, continuous corners with nominal radius 30
  (superellipse n = 3.26, running 1.528 r along each edge, the same corner the
  UI uses; see DESIGN.md, "Squircle and nested corner geometry").
- Overlap: cut out (`fill-rule="evenodd"`), never filled with a third colour.
- The mark's bounding box is 31–225, centred on the canvas.

The wordmark is drawn, not typeset: uppercase geometric letters with a stroke
of 20 % of the cap height and round letters overshooting by 1.5 %. It needs no
font licence. In the lockups the cap height is 0.42 × the symbol's height and
the gap is 0.34 × the symbol's height.

## Colour

| Name | HEX | RGB | Role |
|---|---|---|---|
| Canvas Black | `#000000` | 0 0 0 | Background, the printed overlap |
| Label White | `#FFFFFF` | 255 255 255 | The paper on dark backgrounds |
| Signal Blue | `#0091FF` | 0 145 255 | The light; the app's single accent |

These are the DESIGN.md tokens; the mark adds no new colour.

## Use

- **Clear space:** keep at least half the light's radius (35 on the 256 grid,
  about 18 % of the symbol's height) free on every side.
- **Minimum size:** symbol 16 px (favicon, on its black tile); horizontal
  lockup 120 px wide; stacked lockup 64 px wide.
- **Backgrounds:** black, graphite and photos dark enough for the white sheet
  to read use `on-dark`. White and light greys use `on-light`. Elsewhere use a
  one-colour version.

**Don't:**

- recolour the light, or add a second accent;
- fill the overlap with a colour or a gradient;
- swap the light and the paper, or rotate or mirror the mark;
- add shadows, glows or outlines;
- set the wordmark in a font instead of using the drawn file;
- stretch, or change the spacing in a lockup.

## Open items

- Trademark clearance has not been searched; do a professional search before
  any registration.
- The UI still uses the typeset toolbar wordmark (DESIGN.md, "The Wordmark
  Exception"). Adding the symbol to the start screen or toolbar is a separate
  UI change.
