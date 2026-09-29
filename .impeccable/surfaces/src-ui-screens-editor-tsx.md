---
version: 1
slug: "src-ui-screens-editor-tsx"
primary_target: "src/ui/screens/Editor.tsx"
related_targets: ["src/ui"]
---

# Surface brief: DICHROIC editor (all screens)

Scope: whole app UI (Start/empty state, Editor compact + regular, Film & Paper, Export, list pickers, menus, alerts, toast). Visitor mode: Operate.
Audience: film-literate photographers and film enthusiasts, equal weight; desktop browser and iPhone PWA equally primary.
Task: open a photo, choose film/paper/process, adjust six groups, compare, export. Every existing feature and flow stays.
Constraints: dark theme and existing palette tokens (black canvas, #1c1c1e/#2c2c2e surfaces, label greys, blue #0091ff) are pinned by the user; darkroom language stays.

## Direction contract

THESIS: DICHROIC as a mature Apple pro app (Photos for Mac, Final Cut Pro, Logic Pro): an edge-attached window with a unified toolbar, a source-list sidebar and an inspector, not iOS 26 glass cards floating over the photo. It refuses the floating-capsule, giant-radius, glass-everywhere arrangement it had.

OWN-WORLD: solid graphite panels (#1c1c1e) flush to the window edges and split by 1px separators; the photo sits on true black. Small radii: 6px controls, 8px lists and fields, 10px menus, 12px dialogs, 16px only for the phone's bottom panel. SF system type at macOS density on desktop (13px body, 11px labels, tabular numerals) and iOS sizes on the phone. Blue is the one accent, used only for selection, focus, edited marks and the primary action. Switches use blue too. Glass is kept only for controls floating over the photo.

STORY: the user sees the photo first. The film → paper recipe reads as the window's path; tools are dense, labelled rows with right-aligned values; export is a proper dialog with right-aligned buttons.

FIRST VIEWPORT (desktop): a 52px unified toolbar across the window. On the left: wordmark, file name, then Open and Close. In the centre: a path control reading "Portra 400 › Portra Endura". On the right: Undo, Redo, Before/After and a blue Export button. Below it, a 260px film/paper source list on the left, the photo centred on black, and a 300px inspector on the right with icon group tabs, then rows. A 28px status bar under the photo shows preview size, colour space and the Developing state. Phone: the top bar floats over the photo in the same order; a bottom panel attached to the screen edge holds the tool, the tool chips (rounded squares) and the group tabs.

Signature interaction: the recipe path control. Each segment (film, paper or "Scan") opens that list: on desktop it switches and scrolls the sidebar to the current stock; on the phone the two-line film/paper pill opens the Film & Paper sheet (one 44 pt target; two stacked segments would be too small to tap). Motion grammar: macOS-short 120–180ms ease-out fades and slides on desktop, iOS spring sheets only on the phone, no bounce anywhere else.

FORM: Mac pro app (Photos for Mac / Final Cut Pro conventions); Impeccable's pick, position 1 on the ordered grounded list; seed key 330d44e2.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
