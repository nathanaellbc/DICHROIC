# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences with equal weight:

- Photographers and colorists who know film stocks, papers and the darkroom, editing RAW or JPEG files and exporting finished work.
- Film enthusiasts who want a real film look without knowing the darkroom's technical side.

Desktop browsers and the iPhone PWA are equally primary. Neither is a secondary layout.

## Product Purpose

DICHROIC develops a photo through a spectral simulation of real film negatives and print papers, entirely in the browser on the user's own GPU (WebGPU). The user picks a film, a paper (or scans the film directly), adjusts camera, lens, film, color, development and texture parameters, and exports an image or a LUT. Success is a file that looks developed and printed, not filtered, made without the photo ever leaving the device.

## Positioning

A browser port of SpektraFilm's physical film model (Andrea Volpato; derivative work under GPL-3.0-or-later). The look comes from simulated film and print chemistry, not preset curves. Effects with a physical size (grain, halation, diffusion) are re-developed at each export's pixel pitch.

## Operating Context

- Open a photo (JPEG, PNG, TIFF 8/16/32-bit, OpenEXR, camera RAW), pick film and paper, adjust, compare with the original, export.
- Processing runs locally in a Web Worker on WebGPU. Nothing is uploaded; the optional depth model for lens blur is a one-time on-device download.
- Installable as a PWA; runs in a desktop browser tab or window and in iOS Safari or on the Home Screen.

## Capabilities and Constraints

- Film and paper catalogs grouped by brand, with search. Process is Print (negative onto paper) or Scan (the film itself).
- Six tool groups: Camera, Lens, Film, Color, Develop, Texture. Lens blur runs from an estimated depth map.
- Export: PNG 8/16, TIFF 16, and JPEG through the app's own encoders, with ICC and EXIF embedded. WebP and AVIF when the browser can encode them. LUT (.cube) export.
- Undo/redo, before/after compare and hold-to-peek, keyboard shortcuts.
- Every existing feature and flow must be preserved.
- Requires WebGPU; the UI must say so clearly where it is unavailable.

## Brand Commitments

- Name: DICHROIC.
- Darkroom language stays: print, scan, preflash, CC filters, push/pull, and the instructive note on each tool.
- Dark theme and the existing blue accent and color palette are kept (user-confirmed, 2026-09-29).

## Evidence on Hand

- Upstream attribution and licence: `README.md`, `LICENSE`.
- No testimonials, customer names, benchmarks or press exist; none may be invented.

## Product Principles

- The photo is the judge: nothing in the interface may compete with or tint the image being evaluated.
- Teach the darkroom without gatekeeping it: novices get plain guidance, experts get precise values and shortcuts, in the same interface.
- Honest by construction: show measured facts (file size, formats this browser can really encode, what a LUT leaves out), never estimates dressed as facts.
- Local and private: the photo never leaves the device, and the interface says so where it matters.

## Accessibility & Inclusion

Keyboard operation of every control, screen reader labels and states, WCAG AA contrast for text and controls, and respect for reduced motion and reduced transparency.
