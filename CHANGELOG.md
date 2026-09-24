# Changelog

## 0.2.0

- New **Measure** tool (`M`): click two points, or drag, to measure a distance.
  - Snaps to endpoints, midpoints, arc and circle centres, quadrants and points; the snap type is shown next to the cursor. Hold `Alt` to place a point freely, `Shift` to constrain horizontally or vertically.
  - Distances use the drawing's own units (`INSUNITS`) and precision (`LUPREC`).
  - The status bar shows distance, ΔX, ΔY and angle while measuring, and again when a measurement is selected.
  - Measurements are saved with your other notes, and can be moved, deleted and undone like them.

## 0.1.1

- Fix: DWG/DXF files stuck on "Loading…" in VS Code. The editor waited for the webview to report ready before returning, but VS Code only starts the webview after that point, so it deadlocked.
- Add a **VCAD** output channel (View > Output) that logs each step of opening a drawing, including parser warnings.
- Parsing now times out after 180 s with an error instead of spinning forever.
- Errors inside the viewer are shown on the canvas and logged instead of failing silently.

## 0.1.0

Initial release.

- View DWG (R14-2018+) and ASCII DXF drawings in a custom editor.
- Pan, zoom, zoom-to-fit, per-layer visibility, PNG export.
- Markup tools: rectangle, ellipse, line, arrow, brush, highlighter, text note.
- Markup saved to a JSON sidecar; the drawing file is never modified.
- Undo, redo, dirty state and hot exit integrate with VS Code.

