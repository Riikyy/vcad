# VCAD — DWG/DXF Viewer & Notes for VS Code

Open AutoCAD `.dwg` and `.dxf` drawings directly in VS Code, and mark them up with
shapes, lines, brush and highlighter notes.

The drawing file is **never modified**. Markup is stored in a separate JSON
sidecar next to it, so it diffs cleanly in Git and can be reviewed like any other
text file.

---

## Features

### Viewing

- Reads **DWG** (R14 through 2018+) via LibreDWG compiled to WebAssembly — no
  AutoCAD, no ODA converter, no cloud service.
- Reads **ASCII DXF** with a built-in parser.
- Smooth pan and zoom. Arcs, circles and ellipses are kept as true curves rather
  than pre-flattened, so they stay smooth at any magnification.
- Layer panel with per-layer visibility; layers that are off or frozen in the
  drawing start hidden.
- Block references, nested blocks, block arrays and dimensions are expanded and
  drawn the way AutoCAD draws them.
- Live cursor coordinates, zoom level and drawing statistics.
- Export the current view as a PNG.

### Markup

| Tool | Key | Notes |
| --- | --- | --- |
| Select | `V` | Click to select, drag to move, `Delete` to remove |
| Pan | `H` | Also: middle-drag, or hold `Space` |
| Rectangle | `R` | Optional fill |
| Ellipse | `O` | Optional fill |
| Line | `L` | |
| Arrow | `A` | |
| Brush | `B` | Smoothed freehand stroke |
| Highlighter | `G` | Wide translucent stroke; geometry stays readable underneath |
| Text note | `X` | Type inline, `Enter` to place, `Esc` to cancel |
| Measure | `M` | Distance between two points; see below |

Other shortcuts: `Ctrl+Shift+E` zoom to fit, `Ctrl+Z` / `Ctrl+Y` undo and redo,
`Ctrl+S` save.

### Measuring distances

Pick **Measure** (`M`), then either click the two points or drag from one to the other. `Esc` cancels a half-finished measurement.

- **Object snap.** The cursor snaps to nearby endpoints, midpoints, arc and circle centres, circle quadrants and point entities within about 12 px. A green marker shows the snap point and its type. Hold `Alt` to place a point exactly where you click.
- **Orthogonal.** Hold `Shift` while placing the second point to lock the measurement horizontal or vertical (an active snap still wins, as in AutoCAD).
- **Units.** Distances are reported in the drawing's own units (`INSUNITS`, e.g. `mm`) with its display precision (`LUPREC`). Drawings saved as unitless show a bare number.
- **Readout.** While measuring, and whenever you select a measurement, the status bar shows distance, ΔX, ΔY and angle.

Measurements are saved with your other notes, so they persist, and can be moved, deleted and undone the same way. When geometry overlaps closely, the snap takes the nearest vertex, so zoom in if two candidates are within a pixel of each other.

Notes are stored in **drawing coordinates**, not screen pixels, so a highlight
stays on the wall it was drawn over no matter how far you zoom.

---

## How markup is saved

Editing markup marks the editor dirty; `Ctrl+S` writes the sidecar. Undo, redo,
and hot-exit all work through VS Code's own document machinery.

By default the sidecar sits beside the drawing:

```
floor-plan.dwg
floor-plan.dwg.vcadnotes.json
```

Set `vcad.notes.location` to `subfolder` to keep them in a `.vcad/` folder
instead. Deleting every note deletes the sidecar rather than leaving an empty
file behind.

The format is plain JSON:

```json
{
  "version": 1,
  "drawing": "floor-plan.dwg",
  "notes": [
    {
      "id": "k3m9x1a2f8c1",
      "kind": "highlighter",
      "color": "#ffd60a",
      "width": 220,
      "opacity": 0.45,
      "created": 1757980800000,
      "points": [1200.5, 880.25, 1420.75, 884.0]
    }
  ]
}
```

---

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `vcad.background` | `dark` | Canvas background: `dark`, `light`, or `match-theme`. CAD drawings are authored for dark model space, so `dark` keeps colours closest to AutoCAD. |
| `vcad.notes.location` | `sibling` | `sibling` or `subfolder`. |
| `vcad.render.maxEntities` | `400000` | Cap on expanded primitives. Very large drawings are truncated rather than freezing the editor. |
| `vcad.render.showText` | `true` | Draw TEXT and MTEXT. Turning this off speeds up text-heavy drawings. |
| `vcad.render.lineWidth` | `1` | Base stroke width in device pixels. |
| `vcad.render.curveResolution` | `64` | Segments used when a curve must be flattened. |

Changing a setting that affects parsing reloads the drawing automatically.

---

## Known limitations

These are real gaps, not bugs to report:

- **Hatch patterns are drawn as outlines.** Solid fills render solid; patterned
  fills (`ANSI31`, `ANGLE`, …) render as their boundary only. Reproducing `.pat`
  line families is a separate feature, and a wrong fill reads worse than none.
- **Not rendered:** `3DSOLID`, `ACAD_TABLE`, `MULTILEADER`, `TOLERANCE`,
  `WIPEOUT`, raster images, and polyface meshes. Unrendered types are listed in
  the webview developer console when a drawing opens.
- **Binary DXF is not supported** — only ASCII DXF. DWG is read natively, so
  converting to DWG is usually easier than converting to ASCII DXF.
- **Model space only.** Paper-space layouts and viewports are not drawn.
- **Lineweights are approximate.** Heavy lines render thicker than hairlines, but
  true plot-scale lineweight needs the drawing's units and plot configuration.
- **2D top view.** 3D geometry is projected onto the XY plane with no hidden-line
  removal.
- **Text uses a substitute font.** SHX and custom CAD fonts are not loaded, so
  text metrics are approximate.

---

## Licence

**GPL-3.0-or-later.**

This extension bundles [LibreDWG](https://www.gnu.org/software/libredwg/) (via
[`@mlightcad/libredwg-web`](https://github.com/mlightcad/libredwg-web)), which is
GPL-3.0. Because LibreDWG ships inside the extension, the extension as a whole is
distributed under the GPL-3.0 as well.

The full licence text is in [LICENSE](LICENSE); copyright and third-party
attribution are in [NOTICE](NOTICE).

If you need a permissively licensed extension instead, the parser is pluggable:
`src/parser/` isolates DWG decoding behind a small interface, so LibreDWG can be
swapped for a shell-out to the free ODA File Converter (DWG → DXF) plus the
built-in DXF reader, which is original code.

---

## Development

```bash
npm install
npm run build        # or: npm run watch
```

Press `F5` in VS Code to launch an Extension Development Host, then open any
`.dwg` or `.dxf` file.

```bash
npm run typecheck    # tsc --noEmit
npm run package      # build a .vsix (requires @vscode/vsce)
```

The `.vsix` is around 12 MB, almost entirely the LibreDWG `.wasm` binary.

### Architecture

```
src/
  common/      Types shared by the host, the worker and the webview
  parser/      DWG (LibreDWG/wasm) and DXF (hand-written) readers
               -> one intermediate Doc -> a flattened Scene
  editor/      Custom editor: document, save, undo/redo, backup
  webview/     Canvas renderer, viewport, markup tools
```

Parsing runs in a **worker thread**, not on the extension host. Initialising a
10 MB wasm module and walking a large drawing on the host would freeze the whole
VS Code window, since every extension shares that thread.

Geometry crosses the worker → host → webview boundary as **typed arrays** rather
than objects: a mid-size DWG expands to hundreds of thousands of primitives, and
an array-of-objects representation would make both the structured-clone hop and
the per-frame render loop far more expensive.

The renderer builds a **draw plan** once per scene — primitives bucketed by
stroke style with precomputed bounding boxes — then each frame culls against the
viewport and issues one path per bucket, instead of a `beginPath`/`stroke` per
entity.
