---
name: DICHROIC
description: A spectral film-and-paper darkroom in the browser, drawn as a mature Apple pro app.
colors:
  canvas-black: "#000000"
  graphite: "#1c1c1e"
  graphite-raised: "#2c2c2e"
  graphite-high: "#3a3a3c"
  fill: "rgba(118, 118, 128, 0.24)"
  fill-strong: "rgba(120, 120, 128, 0.36)"
  fill-soft: "rgba(255, 255, 255, 0.08)"
  hover: "rgba(255, 255, 255, 0.06)"
  label: "#ffffff"
  label-secondary: "rgba(235, 235, 245, 0.62)"
  label-tertiary: "rgba(235, 235, 245, 0.32)"
  separator: "rgba(84, 84, 88, 0.65)"
  hairline: "rgba(255, 255, 255, 0.09)"
  signal-blue: "#0091ff"
  blue-fill: "#0070e0"
  blue-text: "#5cb8ff"
  blue-wash: "rgba(0, 145, 255, 0.16)"
  green: "#30d158"
  red: "#ff4245"
  red-text: "#ff6961"
  orange: "#ff9230"
  glass-bg: "rgba(28, 28, 30, 0.78)"
  glass-border: "rgba(255, 255, 255, 0.1)"
  clear-bg: "rgba(0, 0, 0, 0.55)"
typography:
  large-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"SF Pro Display\", \"Inter Variable\", system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.206
    letterSpacing: "0.01em"
  large-title-regular:
    fontSize: "26px"
    fontWeight: 700
    lineHeight: "32px"
  title2:
    fontSize: "1.294rem"
    fontWeight: 700
    lineHeight: 1.27
  title2-regular:
    fontSize: "17px"
    fontWeight: 700
    lineHeight: "22px"
  title3:
    fontSize: "1.176rem"
    fontWeight: 600
    lineHeight: 1.25
  title3-regular:
    fontSize: "15px"
    fontWeight: 600
    lineHeight: "20px"
  headline:
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.294
  headline-regular:
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "16px"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"SF Pro Display\", \"Inter Variable\", system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.294
  body-regular:
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "16px"
  subhead:
    fontSize: "0.882rem"
    fontWeight: 400
    lineHeight: 1.333
  subhead-regular:
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "15px"
  footnote:
    fontSize: "0.765rem"
    fontWeight: 400
    lineHeight: 1.385
  footnote-regular:
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "14px"
  caption:
    fontSize: "0.706rem"
    fontWeight: 400
    lineHeight: 1.333
  caption2:
    fontSize: "0.6471rem"
    fontWeight: 400
    lineHeight: 1.18
  caption-regular:
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "13px"
rounded:
  control-compact: "10px"
  control-regular: "6px"
  list-compact: "12px"
  list-regular: "8px"
  menu-compact: "12px"
  menu-regular: "10px"
  dialog-compact: "16px"
  dialog-regular: "12px"
  panel-compact: "16px"
  panel-regular: "0px"
  inline: "5px"
  pill: "9999px"
spacing:
  "2": "2px"
  "4": "4px"
  "6": "6px"
  "8": "8px"
  "10": "10px"
  "12": "12px"
  "16": "16px"
  "24": "24px"
components:
  button-prominent:
    backgroundColor: "{colors.blue-fill}"
    textColor: "{colors.label}"
    rounded: "{rounded.control-regular}"
    height: "28px"
    padding: "0 12px"
  button-prominent-compact:
    backgroundColor: "{colors.blue-fill}"
    textColor: "{colors.label}"
    rounded: "{rounded.control-compact}"
    height: "44px"
    padding: "0 16px"
  button-filled:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.label}"
    rounded: "{rounded.control-regular}"
    height: "28px"
    padding: "0 12px"
  button-plain-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.label}"
  icon-button-regular:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.label}"
    rounded: "{rounded.control-regular}"
    size: "30px"
  icon-button-compact:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.label}"
    rounded: "{rounded.control-compact}"
    size: "44px"
  icon-button-pressed:
    backgroundColor: "{colors.blue-wash}"
    textColor: "{colors.blue-text}"
  segmented-regular:
    backgroundColor: "{colors.fill}"
    rounded: "7px"
    height: "24px"
    padding: "2px"
  segmented-compact:
    backgroundColor: "{colors.fill}"
    rounded: "11px"
    height: "34px"
    padding: "2px"
  option-selected:
    backgroundColor: "{colors.blue-fill}"
    textColor: "{colors.label}"
    rounded: "{rounded.control-regular}"
    height: "22px"
    padding: "0 8px"
  source-row-selected:
    backgroundColor: "{colors.blue-fill}"
    textColor: "{colors.label}"
    rounded: "{rounded.inline}"
    height: "26px"
    padding: "3px 8px"
  path-segment:
    backgroundColor: "{colors.fill-soft}"
    textColor: "{colors.label}"
    rounded: "{rounded.inline}"
    height: "24px"
    padding: "0 7px"
  search-field-regular:
    backgroundColor: "{colors.fill}"
    rounded: "{rounded.control-regular}"
    height: "24px"
    padding: "0 8px"
  list-grouped:
    backgroundColor: "{colors.graphite-raised}"
    rounded: "{rounded.list-regular}"
  popover:
    backgroundColor: "{colors.graphite-raised}"
    rounded: "{rounded.menu-regular}"
    width: "260px"
  dialog:
    backgroundColor: "{colors.graphite}"
    rounded: "{rounded.dialog-regular}"
    width: "520px"
  window-toolbar:
    backgroundColor: "{colors.graphite}"
    height: "52px"
    padding: "0 10px 0 16px"
  status-bar:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.label-secondary}"
    height: "28px"
    padding: "0 12px"
---

# Design System: DICHROIC

## Overview

### Flat controls and soft overlay shadows (2026-09-30)

Switch knobs, slider thumbs, selected segments/tabs and pop-up fields have no cast shadow or inset highlight. Controls read as flat shapes through fill, colour and existing focus/selection marks. Floating menus/toasts use only `0 8px 40px rgba(0,0,0,0.18)`; dialogs use `0 16px 72px rgba(0,0,0,0.24)`. The compact panel keeps its hairline with a diffuse `0 -8px 48px rgba(0,0,0,0.12)` shadow. These treatments supersede the older knob/segment lift and overlay shadow vocabulary below. Accessibility outlines and image focus-marker contrast rings remain legible.

### Lucide icons and softer controls (2026-09-30)

All UI icons, including the spinner, use statically imported Lucide React components through the shared `Icon` adapter. They retain existing sizes, colours, accessible control labels and stroke weights. Control/field radii are 8px on desktop and 12px on compact layouts; list, menu and dialog radii are 10/12/14px on desktop and 14/14/18px on compact layouts. Dense inline controls use 7px/8px. Panel geometry and phone corner continuity stay unchanged. These values supersede the older radius scale below.

Vertical scrolling uses a transparent track and a slim rounded neutral thumb, brighter on hover or keyboard focus. Chromium/WebKit use a 4px gutter with a 2px visible thumb and no arrow buttons; other browsers use their thin scrollbar. Hover/focus keep the standard scrollbar color set to auto on Chromium/WebKit so it cannot override the custom thumb. Scrolling remains available with mouse, touch and keyboard.

### Editor zoom and frosted chrome (2026-09-30)

Preview detail follows fitted image size × zoom × screen pixel density, requested in 256px increments after a 180ms pause. The worker renders directly from the retained source, up to native resolution, with a matching original for compare/peek. It never enlarges source pixels or uses nearest-neighbour pixelated zoom. Only the latest requested size/parameter revision can publish; the previous image remains visible while developing. Fit releases unnecessary detail. Low-memory devices keep an 8 MP preview ceiling; desktop previews allow up to 64 MP and remain subject to the renderer's diffusion/GPU limits. High-resolution renders release GPU scratch after completion.

Dragging a zoomed photo beyond its pan bounds uses increasing rubber-band resistance. Releasing or cancelling the last pointer returns the photo to the nearest valid edge with the shared `photoReturn` spring (0.5s, bounce 0.2). A new drag, wheel zoom, Fit reset, photo change or viewport resize interrupts the return. Reduced motion keeps the resisted drag but restores the boundary immediately. This gesture feedback is an intentional exception to the desktop no-bounce rule; ordinary pan and zoom stay immediate.

The photo preview has no inset border on desktop. Zoomed pixels extend beyond the fitted preview area behind the editor chrome; only the outer app window clips them. Fit still shows the full photo, and zoom, pan, comparison and focus selection keep their existing coordinates.

The editor toolbar, stock sidebar, parameter inspector, status bar and compact adjustment panel use neutral frosted graphite: `rgba(28, 28, 30, 0.78)` with `blur(30px)` and no saturation boost. These panels sit above the photo, with their existing geometry and separators. Unsupported backdrop filters and reduced transparency use solid graphite. This user-requested editor treatment supersedes the solid-panel and glass-only-on-floating-controls rules below for these surfaces; dialogs and menus retain their existing materials.

**Creative North Star: "The Pro App Window"**

DICHROIC is drawn as a mature Apple pro application in the line of Photos for Mac and Final Cut Pro. On the desktop it is a window, not a web page. A unified toolbar runs across the top. A film/paper source list sits on the left and an inspector on the right, both solid graphite panels flush to the window edges and split by 1px lines. The photo sits between them on true black. On the phone the same world uses iOS sizes: a floating top bar over the photo and a bottom panel attached to the screen edge.

The world is quiet so the photo can be judged. Surfaces are neutral dark greys with no tint. Radii are small, and there is one accent, a system blue that marks selection, focus, edited state and the single primary action. Density follows the size class on `html[data-size]`. `compact` (under 1080px wide or under 560px tall) uses iOS Dynamic Type sizes and 44pt targets. `regular` uses macOS density: 13px body, 11px labels, 28px controls.

This world replaced an earlier iOS 26 arrangement of glass cards and capsules floating over the photo, with large radii. Glass survives only where a control actually floats over the image.

**Key Characteristics:**
- Solid graphite panels flush to the window edge, split by 1px hairlines; no floating cards on desktop.
- Photo on true black (#000); nothing tinted beside it.
- One blue accent, used only for selection, focus, edited marks and the primary action.
- Two densities from one token set: iOS sizes when compact, macOS density when regular.
- Small radii: 6px controls on desktop, 10px on the phone; 16px only for the phone's bottom panel.
- Tabular numerals for every value readout.

## Colors

Apple's system dark palette, used as is: black canvas, three graphite steps, translucent fills, grey labels, and a single blue.

### Primary
- **Signal Blue** (#0091ff): the accent as a mark, not a fill behind text. Slider fill, the edited dot on tabs and inspector rows, the active underline of the desktop group tabs, the inset ring on edited tool chips, the text caret. At 3.2:1 against white it never carries white text.
- **Blue Fill** (#0070e0): every blue surface that carries white text (4.8:1). Prominent buttons (Export, Download), the selected source-list row, the selected option, and the switch's on state.
- **Blue Text** (#5cb8ff): blue used as text on graphite. Text buttons, popover actions, the selected desktop group tab, the "Developing…" status, pressed icon buttons.
- **Blue Wash** (rgba 0,145,255 at 16%): the background of a toggled-on icon button such as Before/After on desktop.

### Neutral
- **Canvas Black** (#000000): the page and the photo well. Only the photo stands on it.
- **Graphite** (#1c1c1e): every structural panel: toolbar, sidebar, inspector, status bar, the phone's bottom panel, sheets and dialogs.
- **Raised Graphite** (#2c2c2e): grouped lists inside a panel, popovers and menus, alerts.
- **High Graphite** (#3a3a3c): small badges placed on other surfaces, such as the lock badge on a tool chip.
- **Fill / Fill Strong / Fill Soft** (grey at 24% / 36%, white at 8%): control bodies: filled buttons, segmented tracks, search fields, pop-up menus (Fill); switch-off and slider track (Fill Strong); unselected options, chips and path segments (Fill Soft).
- **Hover** (white at 6%): the hover wash for plain buttons, rows and path segments.
- **Label** (#ffffff), **Secondary Label** (235,235,245 at 62%), **Tertiary Label** (235,235,245 at 32%): text in three steps. Tertiary is kept for decorative separators such as the status-bar middle dot and the path chevron, not for reading text.
- **Separator** (84,84,88 at 65%) and **Hairline** (white at 9%): Separator divides rows inside grouped lists and menus. Hairline marks the edges of the window structure: toolbar bottom, panel sides, status-bar top, dialog header and footer, and inspector rows.

### Status
- **Green** (#30d158), **Red** (#ff4245) / **Red Text** (#ff6961), **Orange** (#ff9230): system status colours. Red is used for destructive menu actions. Orange backs the warning callout (13% fill, 22% inset ring).

### Named Rules
**The One Accent Rule.** Blue means one of four things: selected, focused, edited, or the primary action. Nothing else in the chrome is coloured. The cyan, magenta and yellow swatches on the CC-filter tools are data (the filter's own colour), not accent.

**The White-on-Fill Rule.** White text sits on #0070e0, never on #0091ff. Signal Blue is only for marks, lines and fills that carry no text.

**The Neutral Neighbour Rule.** Surfaces next to the photo are neutral grey or black. No gradient, tint or coloured glow may reach the image.

## Typography

**Display and Body Font:** SF (`-apple-system`, `BlinkMacSystemFont`, "SF Pro Text", "SF Pro Display") on Apple devices, then self-hosted **Inter Variable** (`@fontsource-variable/inter`, precached by the PWA), then `system-ui`.
**Label/Mono Font:** none. Numbers use the same face with `font-variant-numeric: tabular-nums`.

**Character:** One system voice at two densities. Hierarchy comes from weight (400/500/600/700) and grey steps, never from a second family.

### Hierarchy
The root is 17px (`font: -apple-system-body` on iOS, so Dynamic Type scales the compact sizes). Compact sizes are rem-based; regular sizes are fixed macOS pixel sizes.

- **Large Title** (700; 34px compact, 26px/32px regular): empty-state and start-screen titles.
- **Title 2** (700; 22px compact, 17px/22px regular): screen-level headings.
- **Title 3** (600; 20px compact, 15px/20px regular): the phone panel's live value readout (tabular).
- **Headline** (600; 17px compact, 13px/16px regular): tool titles, pane headers, sheet titles.
- **Body** (400; 17px compact, 13px/16px regular): row labels and values. Inspector tool names use Body at 500.
- **Subhead / Callout** (400; 15px / 16px compact, 12px regular): secondary lines, pop-up menus, search input.
- **Footnote** (400; 13px compact, 11px/14px regular): tool notes, file name, list headers (600).
- **Caption / Caption 2** (400; 12px / 11px compact, 11px/13px regular): chip labels, tab labels (600 compact, 500 regular), status bar.

### Named Rules
**The Tabular Rule.** Every number that changes (EV, ISO, pixel sizes, file sizes, slider values) is set in tabular numerals and aligned right in its row.

**The Two-Scale Rule.** A text style is one class with two sizes. Use the `t-*` role and let `html[data-size]` pick iOS or macOS size. Never hard-code a per-screen font size.

**The Wordmark Exception.** The DICHROIC wordmark in the toolbar (13px, 700, 0.12em tracking, uppercase) is the only tracked uppercase text in the system. It is the brand mark, not a label style.

## Layout

**Regular (desktop window, iPad landscape; at least 1080 × 560).** A CSS grid of three columns: 260px source list, a flexible photo column, 300px inspector. Two rows: a 52px unified toolbar spanning all columns, then content. The photo column has its own 28px status bar at the bottom (preview size, colour space, Developing state, "Developed on this device"), and the photo is inset 24px on black. Toolbar order, left to right: wordmark and file name, Open, Close; in the centre, the recipe path; on the right, Undo, Redo, a 1px separator, Before/After, then the blue Export button. Panels are flush to the window edges with no gutter and no radius. The inspector stacks group tabs, a 36px pane header, dense rows (padding 9px 12px 10px, divided by hairlines), and a footer with Reset All aligned right. Dialogs are centred at 520px wide with their action buttons aligned right.

**Compact (phone, portrait and small landscape).** The photo fills the screen between a floating top bar and a bottom panel. The top bar sits 4px below the safe area (at least 12px from the top) and is 44px tall. In order: More, a two-line film/paper pill (one 44pt target), Undo, and Export. Before/After floats at the bottom left, 12px above the panel. The bottom panel is attached to the screen edge (max 560px wide, 16px top radius). It holds the tool header (title, value, reset, switch), the control, a horizontal row of tool chips, and the group tabs. In small landscape the panel becomes a 340px right-hand column flush to the edge.

**Spacing rhythm.** A 2px base: 2, 4, 6, 8, 10, 12, 16, 24. Controls sit 2–6px apart within a group. Panel padding is 12px (desktop) or 16px (phone). Safe-area insets are added on every edge the layout touches.

## Elevation & Depth

Structure is flat. Panels sit side by side, divided by 1px hairlines, with no shadow. Shadow appears only on surfaces that sit above the window: menus, dialogs, alerts and the toast. Small raised control parts get a soft 1–3px shadow: the selected segment or tab pill, the switch knob and the slider thumb. Glass (blur plus saturation) appears only on controls that float over the photo.

### Shadow Vocabulary
- **Menu** (`box-shadow: 0 12px 32px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(0,0,0,0.6)`): popovers, context menus, the toast.
- **Dialog** (`box-shadow: 0 24px 64px rgba(0,0,0,0.6), 0 0 0 0.5px rgba(0,0,0,0.7)`): centred dialogs and alerts.
- **Segment lift** (`box-shadow: 0 1px 2px rgba(0,0,0,0.35), inset 0 0.5px 0 rgba(255,255,255,0.12)`): the selected pill in segmented controls and compact group tabs.
- **Knob** (`box-shadow: 0 2px 5px rgba(0,0,0,0.3)` compact, `0 1px 2px rgba(0,0,0,0.35)` regular) and **Thumb** (`0 3px 8px rgba(0,0,0,0.35)`): the switch knob and slider thumb.
- **Phone panel edge** (`box-shadow: 0 -1px 0 hairline, 0 -12px 32px rgba(0,0,0,0.35)`): the top edge of the compact bottom panel over the photo area.

### Named Rules
**The Glass Over Photo Rule.** Glass is only for controls floating over the photo: the phone's top bar buttons and film/paper pill, the phone's Before/After button, the before/after split handle and labels, and the toast. Structural panels, sheets, dialogs and menus are solid graphite. With `prefers-reduced-transparency: reduce`, glass falls back to solid graphite.

**The Flush Panel Rule.** On desktop, panels touch the window edges and each other. Separation comes from a 1px hairline, not a gap, a radius or a shadow.

## Shapes

Small, continuous-looking corners that tighten with density. Controls use 6px on desktop and 10px on the phone. Lists and fields use 8px / 12px, menus 10px / 12px, and dialogs 12px / 16px. The phone's bottom panel uses 16px on its top corners only; on desktop the equivalent panel has no radius. Dense inline elements (source rows, path segments, pop-up menus, stepper buttons) use 5px. Nested shapes follow their container: a segmented track is the control radius plus 1px and its pill the control radius minus 1px; group tabs are plus 2px. Tool chips are 46px rounded squares (12px). Only switches, slider tracks and the sheet grabber are full pills; dots and thumbs are circles. Borders are 1px hairlines; a bordered button uses a 1px inset ring (white at 16%) rather than a stroke.

## Components

### Buttons
Quiet, system-native buttons; only the primary action is coloured.
- **Shape:** control radius (6px regular, 10px compact); height 28px regular, 44px compact, 30px / 50px for the large size.
- **Prominent:** Blue Fill with white text, 600 weight (500 at 13px on desktop). One per surface: Export in the toolbar, Download in the export dialog.
- **Filled:** Fill background, white label. **Plain:** transparent, with the Hover wash on hover. **Bordered:** transparent with a 1px white-16% inset ring (Reset All, secondary dialog actions).
- **Icon buttons:** square (30px regular, 44px compact). Plain icon buttons in the toolbar use Secondary Label and brighten to Label on hover. When pressed, a toggle shows Blue Wash with Blue Text; over the photo the glass toggle turns white-92% with a black icon.
- **Hover / Press / Disabled:** filled buttons brighten 12% on hover. Every button scales to 0.94 on press (critically damped spring). Disabled is 35–40% opacity.
- **Text button:** Blue Text, no background, minimum height equal to the control height.

### Segmented Control
- **Style:** Fill track with 2px padding. The selected segment is a white-20% pill with the segment lift shadow, and it slides between segments. Labels are 72% grey, white when selected; 600 compact, 500 at 12px regular.
- **Sizes:** 34px / 24px, small 30px / 22px, and a dense variant with ellipsis for long option sets.

### Group Tabs
- **Compact:** ARIA tabs inside a Fill container, each an icon above a caption, at least 50px tall. The selected tab gets a white-18% sliding pill.
- **Regular:** a strip with no container, like Final Cut's inspector tabs. The selected tab shows a Blue Text icon and label over a 2px Signal Blue underline. A 7px Signal Blue dot marks a group with edits.

### Switch
- **Style:** full pill, 51 × 31px compact and 32 × 18px regular. Off is Fill Strong, on is Blue Fill, with a white knob that springs across.

### Slider
- **Style:** a 44px-tall hit area (22px regular) around a 4px (3px) Fill Strong track. The fill is Signal Blue, measured from zero. A tick marks the zero point of bipolar sliders. The thumb is a white circle, 28px compact and 16px regular. Keyboard focus draws a 2px blue ring 6px outside the track.

### Lists
- **Grouped inset list (phone, dialogs):** Raised Graphite body, list radius, 48px rows (30px regular). Separator lines start at the text inset. Hover shows the Hover wash and press shows white 8%. The header is a 600-weight footnote in Secondary Label.
- **Source list (desktop sidebar):** dense 26px rows with no card and a 5px radius. The name is 13px; tabular metadata (ISO, daylight/tungsten) is 11px in Secondary Label. The selected row is Blue Fill with its metadata in white 78%. Brand headers are 11px/600.

### Inputs / Fields
- **Search field:** Fill background, field radius, 36px compact and 24px regular, with a leading search icon and a blue caret.
- **Pop-up menu:** a native `select` restyled to 22px, Fill with a 0.5px lift, 5px radius and an up/down chevron; hovering switches to Fill Strong. Options sit on Raised Graphite.
- **Options:** a horizontal chip row (36px compact, scrolls) that wraps on desktop (22px, 11px text). Unselected is Fill Soft; selected is Blue Fill with white text.
- **Stepper:** minus and plus icon buttons around a tabular value. In the inspector they are 22px buttons with a 5px radius.

### Navigation
- **Recipe path control (signature):** the film → paper recipe shown as the window's path, "Kodak Portra 400 › Kodak Portra Endura". The segments are 24px Fill Soft buttons with a 5px radius; the film is 13px/500 in Label and the paper is 400 in Secondary Label, with a Tertiary chevron between them. Each segment switches the sidebar to its list and scrolls to the current stock. On the phone the path becomes one glass pill with two lines (film in 600 subhead, "on paper" in caption) and a single 44pt target that opens the Film & Paper sheet.
- **Window toolbar:** 52px Graphite with a hairline bottom edge, icon buttons at 30px, and a 1px × 18px separator between groups.
- **Status bar:** 28px Graphite with a hairline top edge, 11px Secondary Label and middle-dot separators.

### Tool Chips (phone)
46px rounded squares (12px) holding a 22px line icon, with a caption label below. Unselected is Fill Soft with a white icon, and a dimmed icon when the tool is off. Selected is white 95% with a black icon. An edited tool gets a 2px Signal Blue inset ring. A locked tool gets a small lock badge on High Graphite. The selected chip scrolls to the centre.

### Sheets, Dialogs, Menus
- **Bottom sheet (phone):** Graphite with a 1px white-8% border, top corners at the dialog radius, a 36 × 5px grabber and a 52px bar with a 44px close button. It drags between detents on the sheet spring. The backdrop is black 45%.
- **Dialog (desktop):** the same content centred at 520px with the dialog radius and dialog shadow. It has a 44px titled header and a footer with Cancel and the prominent action aligned right (minimum 96px), each separated by a hairline.
- **Popover / menu:** 260px on Raised Graphite, menu radius, glass-border stroke and menu shadow. Actions are 46px (30px regular) with separators between them; destructive actions are red.
- **Alert:** 300px, centred, Raised Graphite, dialog radius and shadow, black 45% scrim.
- **Toast:** 40px (32px regular) near-opaque graphite (36,36,38 at 94%) at the menu radius, placed below the top bar.

### Icons
24 × 24 line icons in the style of SF Symbols, drawn as inline SVG paths that follow `currentColor`. They are 17px in the desktop toolbar, 20px on the phone, 22px in chips and 12–14px inline.

### Motion
- **Desktop:** short fades and slides, no bounce. The group panel cross-fades in 140ms ease-out. The dialog enters in 180ms `cubic-bezier(0.2,0,0,1)` and exits in 120ms ease-in, and the backdrop fades in 160ms. Hover transitions run 100–150ms. Control state (the segment and tab pill, the switch knob, the press scale) uses the critically damped `snappy` spring (stiffness 560, damping 44, mass 0.8), which settles without overshoot.
- **Phone:** iOS springs. Sheets follow the finger and settle on `sheetSpring` (420 / 42 / 1). Popovers, alerts and toasts pop from their source on `popSpring` (520 / 34 / 0.7). Screen changes fade in 280ms.
- **Reduced motion:** `MotionConfig reducedMotion="user"` removes transform animation, and the spinner slows to 2.4s.

## Do's and Don'ts

### Do:
- **Do** read size from `html[data-size]` and use the density tokens (`--h-control`, `--r-control`, `--h-row`, `--icon-btn`) instead of fixed sizes, so one component serves both the phone and the desktop.
- **Do** keep hit targets at least 44px in compact. On the phone, merge adjacent small targets into one control, as the film/paper pill does.
- **Do** put white text on Blue Fill (#0070e0) and use Signal Blue (#0091ff) only for marks, lines and fills without text.
- **Do** separate desktop panels with 1px hairlines and let them touch the window edge.
- **Do** align numeric values right in tabular numerals, and give each tool a plain-language note under its control.
- **Do** align dialog actions right on desktop, with the prominent action last.
- **Do** provide a visible focus ring on every control (3px blue at 60% compact, 2px regular, 1px offset), full keyboard operation, ARIA roles and states (tabs, pressed, checked), and solid fallbacks for reduced transparency.

### Don't:
- **Don't** use glass on panels, sheets, dialogs or menus; glass is only for controls floating over the photo.
- **Don't** float cards or capsules with large radii over the desktop window. Radii stay within the scale (5–12px on desktop, 16px only for the phone's bottom panel and sheets).
- **Don't** introduce a second accent colour or tint any surface next to the photo.
- **Don't** put white text on #0091ff (3.2:1).
- **Don't** use Tertiary Label for text people must read.
- **Don't** add bouncy springs to desktop chrome; desktop motion stays within 120–180ms, with no overshoot.
- **Don't** add a second typeface or hard-code a font size outside the `t-*` roles.
