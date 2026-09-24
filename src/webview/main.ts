/** Webview entry point: renders the drawing and drives the markup tools. */

import { formatLength, measure, MeasureNote, newId, Note, ToolKind } from '../common/annotations';
import type { HostMessage, ViewerCommand, ViewerConfig, WebviewMessage } from '../common/protocol';
import type { Scene, SceneBounds } from '../common/scene';
import { drawNotes, drawSnapMarker, hitTest, LengthFormat, translateNote } from './notes';
import { buildPlan, contentBounds, drawScene, RenderPlan } from './render';
import { SnapHit, SnapIndex } from './snap';
import { Viewport } from './viewport';

declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void };
const vscode = acquireVsCodeApi();

const PALETTE = ['#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#0a84ff', '#bf5af2', '#ffffff', '#111111'];

/** Tools that draw something rather than manipulating the view or selection. */
const DRAW_TOOLS: ReadonlySet<ToolKind> = new Set([
  'rect',
  'ellipse',
  'line',
  'arrow',
  'brush',
  'highlighter',
  'text',
]);

class Viewer {
  private canvas = document.getElementById('canvas') as HTMLCanvasElement;
  private ctx = this.canvas.getContext('2d')!;
  private stage = document.getElementById('stage') as HTMLElement;
  private toolbarEl = document.getElementById('toolbar') as HTMLElement;
  private statusEl = document.getElementById('status') as HTMLElement;
  private layersEl = document.getElementById('layers') as HTMLElement;
  private overlayEl = document.getElementById('overlay') as HTMLElement;

  private vp = new Viewport();
  private scene: Scene | null = null;
  private plan: RenderPlan | null = null;
  /** Extents used for zoom-to-fit; excludes outliers, unlike scene.bounds. */
  private fitBounds: SceneBounds | null = null;

  // Measure tool state.
  private snapIndex: SnapIndex | null = null;
  /** Snap point under the cursor, drawn as a marker while measuring. */
  private snapHit: SnapHit | null = null;
  /** Screen position of the press that started a measurement, to tell drag from click. */
  private measureDownAt: { x: number; y: number } | null = null;
  private notes: Note[] = [];
  private hiddenLayers = new Set<number>();

  private config: ViewerConfig = {
    background: 'dark',
    showText: true,
    lineWidth: 1,
    themeIsLight: false,
  };

  private tool: ToolKind = 'select';
  private color = PALETTE[0];
  /** Nominal stroke width in screen pixels; converted to drawing units on use. */
  private widthPx = 3;
  private opacity = 1;
  private filled = false;
  private notesVisible = true;

  private selected = new Set<string>();
  private draft: Note | null = null;
  private dirtyFrame = false;

  // Pointer interaction state.
  private pointerDown = false;
  private panning = false;
  private movingFrom: { x: number; y: number } | null = null;
  private moveBaseline: Note[] | null = null;
  private lastPointer = { x: 0, y: 0 };
  private spaceHeld = false;
  private errorShown = false;

  constructor() {
    this.buildToolbar();
    this.bindEvents();
    this.resize();
    this.setStatus('Loading…');
    vscode.postMessage({ type: 'ready' });
  }

  // ------------------------------------------------------------- host input

  handle(msg: HostMessage): void {
    try {
      this.handleUnsafe(msg);
    } catch (err) {
      // Without this, a throw while applying a scene leaves the status stuck on
      // its loading text with no hint of what went wrong.
      const detail = err instanceof Error ? err.stack || err.message : String(err);
      this.showError(`VCAD failed while handling "${msg.type}"`, detail);
      vscode.postMessage({ type: 'error', message: `Webview failed handling ${msg.type}: ${detail}` });
    }
  }

  private handleUnsafe(msg: HostMessage): void {
    switch (msg.type) {
      case 'loading':
        this.setStatus(`Opening ${msg.fileName}…`);
        return;

      case 'scene':
        this.errorShown = false;
        this.overlayEl.innerHTML = '';
        this.scene = msg.scene;
        this.notes = msg.notes.notes;
        this.config = msg.config;
        this.hiddenLayers.clear();
        this.rebuildPlan();
        this.applyBackground();
        this.buildLayersPanel();
        this.zoomToFit();
        this.showStats();
        vscode.postMessage({
          type: 'log',
          message: `scene applied: ${msg.scene.polyLayer.length} polylines, ${msg.notes.notes.length} notes, canvas ${this.vp.width}x${this.vp.height}`,
        });
        return;

      case 'setNotes':
        this.notes = msg.notes.notes;
        this.selected.clear();
        this.requestFrame();
        return;

      case 'config':
        this.config = msg.config;
        this.applyBackground();
        this.requestFrame();
        return;

      case 'error':
        this.showError(msg.message, msg.detail);
        return;

      case 'command':
        this.runCommand(msg.command);
        return;
    }
  }

  private runCommand(command: ViewerCommand): void {
    switch (command) {
      case 'zoomExtents':
        this.zoomToFit();
        return;
      case 'zoomIn':
        this.vp.zoomAt(this.vp.width / 2, this.vp.height / 2, 1.25);
        this.requestFrame();
        return;
      case 'zoomOut':
        this.vp.zoomAt(this.vp.width / 2, this.vp.height / 2, 0.8);
        this.requestFrame();
        return;
      case 'toggleLayers':
        this.layersEl.hidden = !this.layersEl.hidden;
        this.resize();
        return;
      case 'toggleNotes':
        this.notesVisible = !this.notesVisible;
        this.requestFrame();
        this.setStatus(this.notesVisible ? 'Notes shown' : 'Notes hidden');
        return;
      case 'clearNotes':
        if (this.notes.length) this.commit([], `Delete ${this.notes.length} notes`);
        return;
      case 'exportPng':
        this.exportPng();
        return;
    }
  }

  // ---------------------------------------------------------------- toolbar

  private buildToolbar(): void {
    const tools: { id: ToolKind; label: string; icon: string; key: string }[] = [
      { id: 'select', label: 'Select', icon: '⬚', key: 'V' },
      { id: 'pan', label: 'Pan', icon: '✥', key: 'H' },
      { id: 'rect', label: 'Rectangle', icon: '▭', key: 'R' },
      { id: 'ellipse', label: 'Ellipse', icon: '◯', key: 'O' },
      { id: 'line', label: 'Line', icon: '╱', key: 'L' },
      { id: 'arrow', label: 'Arrow', icon: '↗', key: 'A' },
      { id: 'brush', label: 'Brush', icon: '✎', key: 'B' },
      { id: 'highlighter', label: 'Highlighter', icon: '▰', key: 'G' },
      { id: 'text', label: 'Text note', icon: 'T', key: 'X' },
      { id: 'measure', label: 'Measure distance — snaps to geometry, Alt disables snap, Shift for orthogonal', icon: '📏', key: 'M' },
    ];

    const group = document.createElement('div');
    group.className = 'group';
    for (const t of tools) {
      const btn = document.createElement('button');
      btn.className = 'tool';
      btn.dataset.tool = t.id;
      btn.textContent = t.icon;
      btn.title = `${t.label} (${t.key})`;
      btn.setAttribute('aria-label', t.label);
      btn.addEventListener('click', () => this.setTool(t.id));
      group.appendChild(btn);
    }
    this.toolbarEl.appendChild(group);

    // Colour swatches.
    const colors = document.createElement('div');
    colors.className = 'group';
    for (const c of PALETTE) {
      const sw = document.createElement('button');
      sw.className = 'swatch';
      sw.dataset.color = c;
      sw.style.background = c;
      sw.title = c;
      sw.setAttribute('aria-label', `Colour ${c}`);
      sw.addEventListener('click', () => {
        this.color = c;
        this.applyStyleToSelection();
        this.syncToolbar();
      });
      colors.appendChild(sw);
    }
    this.toolbarEl.appendChild(colors);

    // Width and opacity.
    const sliders = document.createElement('div');
    sliders.className = 'group';

    const width = document.createElement('input');
    width.type = 'range';
    width.min = '1';
    width.max = '40';
    width.value = String(this.widthPx);
    width.title = 'Stroke width';
    width.className = 'slider';
    width.addEventListener('input', () => {
      this.widthPx = Number(width.value);
      this.applyStyleToSelection();
    });
    sliders.appendChild(labelled('Width', width));

    const alpha = document.createElement('input');
    alpha.type = 'range';
    alpha.min = '10';
    alpha.max = '100';
    alpha.value = '100';
    alpha.title = 'Opacity';
    alpha.className = 'slider';
    alpha.addEventListener('input', () => {
      this.opacity = Number(alpha.value) / 100;
      this.applyStyleToSelection();
    });
    sliders.appendChild(labelled('Opacity', alpha));
    this.toolbarEl.appendChild(sliders);

    // Actions.
    const actions = document.createElement('div');
    actions.className = 'group';

    const fill = document.createElement('button');
    fill.className = 'tool toggle';
    fill.textContent = '▩';
    fill.title = 'Fill shapes';
    fill.addEventListener('click', () => {
      this.filled = !this.filled;
      this.applyStyleToSelection();
      this.syncToolbar();
    });
    fill.dataset.role = 'fill';
    actions.appendChild(fill);

    const del = document.createElement('button');
    del.className = 'tool';
    del.textContent = '🗑';
    del.title = 'Delete selected (Del)';
    del.addEventListener('click', () => this.deleteSelected());
    actions.appendChild(del);

    const fit = document.createElement('button');
    fit.className = 'tool';
    fit.textContent = '⤢';
    fit.title = 'Zoom to extents (Ctrl+Shift+E)';
    fit.addEventListener('click', () => this.runCommand('zoomExtents'));
    actions.appendChild(fit);

    const layers = document.createElement('button');
    layers.className = 'tool';
    layers.textContent = '≣';
    layers.title = 'Layers';
    layers.addEventListener('click', () => this.runCommand('toggleLayers'));
    actions.appendChild(layers);

    this.toolbarEl.appendChild(actions);
    this.syncToolbar();
  }

  private setTool(tool: ToolKind): void {
    this.tool = tool;
    if (tool !== 'select') this.selected.clear();
    // Leaving the measure tool abandons a half-finished measurement.
    if (tool !== 'measure' && this.draft?.kind === 'measure') this.draft = null;
    this.snapHit = null;
    this.measureDownAt = null;
    if (tool === 'measure') {
      this.setStatus('Measure: click two points, or drag   ·   snaps to geometry, Alt = no snap, Shift = orthogonal');
    }
    this.syncToolbar();
    this.updateCursor();
    this.requestFrame();
  }

  private syncToolbar(): void {
    for (const el of this.toolbarEl.querySelectorAll<HTMLElement>('.tool[data-tool]')) {
      el.classList.toggle('active', el.dataset.tool === this.tool);
    }
    for (const el of this.toolbarEl.querySelectorAll<HTMLElement>('.swatch')) {
      el.classList.toggle('active', el.dataset.color === this.color);
    }
    const fill = this.toolbarEl.querySelector<HTMLElement>('.tool[data-role="fill"]');
    fill?.classList.toggle('active', this.filled);
  }

  private updateCursor(): void {
    const cursor =
      this.tool === 'pan'
        ? 'grab'
        : this.tool === 'select'
          ? 'default'
          : this.tool === 'text'
            ? 'text'
            : 'crosshair';
    this.canvas.style.cursor = cursor;
  }

  // ----------------------------------------------------------------- layers

  private buildLayersPanel(): void {
    const scene = this.scene;
    this.layersEl.innerHTML = '';
    if (!scene) return;

    const title = document.createElement('h2');
    title.textContent = 'Layers';
    this.layersEl.appendChild(title);

    const list = document.createElement('div');
    list.className = 'layer-list';

    scene.layers.forEach((layer, index) => {
      const row = document.createElement('label');
      row.className = 'layer';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !layer.off && !layer.frozen;
      if (layer.off || layer.frozen) this.hiddenLayers.add(index);
      box.addEventListener('change', () => {
        if (box.checked) this.hiddenLayers.delete(index);
        else this.hiddenLayers.add(index);
        this.rebuildPlan();
        this.requestFrame();
      });

      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.style.background = '#' + (layer.color & 0xffffff).toString(16).padStart(6, '0');

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = layer.name;
      name.title = layer.frozen ? `${layer.name} (frozen)` : layer.off ? `${layer.name} (off)` : layer.name;

      row.append(box, chip, name);
      list.appendChild(row);
    });

    this.layersEl.appendChild(list);
  }

  private rebuildPlan(): void {
    this.plan = this.scene ? buildPlan(this.scene, this.hiddenLayers) : null;
    // Built from the plan so hidden layers do not attract snaps.
    this.snapIndex = this.scene && this.plan ? new SnapIndex(this.scene, this.plan) : null;
    this.snapHit = null;
    this.fitBounds =
      this.scene && this.plan
        ? contentBounds(this.scene, this.plan) ?? this.scene.bounds
        : null;
  }

  /** Frames the drawing's main body, ignoring far-flung outlier geometry. */
  private zoomToFit(): void {
    const target = this.fitBounds ?? this.scene?.bounds;
    if (target) this.vp.fit(target);
    this.requestFrame();
  }

  // ------------------------------------------------------------------ input

  private bindEvents(): void {
    window.addEventListener('message', (e: MessageEvent<HostMessage>) => this.handle(e.data));
    window.addEventListener('resize', () => this.resize());

    // Splitting or dragging the editor group resizes the stage without always
    // firing a window resize, which would leave the canvas backing store stale.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize()).observe(this.stage);
    }

    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') {
        this.spaceHeld = false;
        this.updateCursor();
      }
    });
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Never steal keys from the inline text-note editor.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    if (e.key === ' ') {
      this.spaceHeld = true;
      this.canvas.style.cursor = 'grab';
      e.preventDefault();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selected.size) {
        this.deleteSelected();
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'Escape') {
      this.draft = null;
      this.measureDownAt = null;
      this.selected.clear();
      this.requestFrame();
      return;
    }

    // Undo and redo belong to VS Code's own stack; let the host handle them.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'y' || e.key === 'Z')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const shortcuts: Record<string, ToolKind> = {
      v: 'select',
      h: 'pan',
      r: 'rect',
      o: 'ellipse',
      l: 'line',
      a: 'arrow',
      b: 'brush',
      g: 'highlighter',
      x: 'text',
      m: 'measure',
    };
    const tool = shortcuts[e.key.toLowerCase()];
    if (tool) {
      this.setTool(tool);
      e.preventDefault();
    }
  }

  private localPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerDown(e: PointerEvent): void {
    // Capture keeps a drag alive when the pointer leaves the canvas. It can
    // reject the pointer id, and losing capture only degrades drags that run off
    // the edge — it must never abort the interaction itself.
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* continue without capture */
    }
    this.pointerDown = true;
    const p = this.localPoint(e);
    this.lastPointer = p;

    // Middle button, space, or the pan tool always pans, whatever else is active.
    if (e.button === 1 || this.spaceHeld || this.tool === 'pan') {
      this.panning = true;
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;

    if (this.tool === 'select') {
      const hit = this.notesVisible ? hitTest(this.notes, p.x, p.y, this.vp) : null;
      if (hit) {
        if (e.shiftKey) {
          if (this.selected.has(hit.id)) this.selected.delete(hit.id);
          else this.selected.add(hit.id);
        } else if (!this.selected.has(hit.id)) {
          this.selected.clear();
          this.selected.add(hit.id);
        }
        // Snapshot before the drag so the whole move is a single undo step.
        this.movingFrom = { x: this.vp.toDrawingX(p.x), y: this.vp.toDrawingY(p.y) };
        this.moveBaseline = this.notes;
      } else {
        this.selected.clear();
      }
      this.requestFrame();
      return;
    }

    if (this.tool === 'text') {
      this.openTextEditor(p.x, p.y);
      return;
    }

    if (this.tool === 'measure') {
      this.measurePointerDown(p.x, p.y, e);
      return;
    }

    if (DRAW_TOOLS.has(this.tool)) this.beginDraft(p.x, p.y);
  }

  // ---------------------------------------------------------------- measure

  /**
   * Resolves a cursor position to the drawing point a measurement should use:
   * an object snap if one is close, otherwise an orthogonal constraint when
   * Shift is held, otherwise the raw position. Alt suppresses snapping.
   */
  private measurePoint(
    px: number,
    py: number,
    mods: { altKey: boolean; shiftKey: boolean },
    anchor: { x: number; y: number } | null
  ): { x: number; y: number; snap: SnapHit | null } {
    const x = this.vp.toDrawingX(px);
    const y = this.vp.toDrawingY(py);
    const SNAP_RADIUS_PX = 12;

    if (!mods.altKey && this.snapIndex) {
      const hit = this.snapIndex.nearest(x, y, SNAP_RADIUS_PX / this.vp.scale);
      if (hit) return { x: hit.x, y: hit.y, snap: hit };
    }
    if (mods.shiftKey && anchor) {
      return Math.abs(x - anchor.x) >= Math.abs(y - anchor.y)
        ? { x, y: anchor.y, snap: null }
        : { x: anchor.x, y, snap: null };
    }
    return { x, y, snap: null };
  }

  /**
   * Starts or finishes a measurement. Both styles work: press-drag-release, or
   * click the first point and click again for the second.
   */
  private measurePointerDown(px: number, py: number, e: PointerEvent): void {
    const pending = this.draft?.kind === 'measure' ? this.draft : null;

    if (pending) {
      const pt = this.measurePoint(px, py, e, { x: pending.x1, y: pending.y1 });
      pending.x2 = pt.x;
      pending.y2 = pt.y;
      this.finishMeasure(pending);
      return;
    }

    const pt = this.measurePoint(px, py, e, null);
    const note: MeasureNote = {
      id: newId(),
      kind: 'measure',
      color: this.color,
      width: this.drawingWidth(),
      opacity: 1,
      created: Date.now(),
      x1: pt.x,
      y1: pt.y,
      x2: pt.x,
      y2: pt.y,
    };
    this.draft = note;
    this.measureDownAt = { x: px, y: py };
    this.snapHit = pt.snap;
    this.setStatus('Measure: pick the second point   ·   Esc to cancel');
    this.requestFrame();
  }

  private measurePointerMove(px: number, py: number, e: PointerEvent): void {
    const pending = this.draft?.kind === 'measure' ? this.draft : null;
    const pt = this.measurePoint(px, py, e, pending ? { x: pending.x1, y: pending.y1 } : null);
    this.snapHit = pt.snap;
    if (pending) {
      pending.x2 = pt.x;
      pending.y2 = pt.y;
      this.showMeasurement(pending);
    }
    this.requestFrame();
  }

  /** Commits on release after a drag; a plain click waits for a second click. */
  private measurePointerUp(px: number, py: number): void {
    const pending = this.draft?.kind === 'measure' ? this.draft : null;
    const down = this.measureDownAt;
    this.measureDownAt = null;
    if (!pending || !down) return;
    if (Math.hypot(px - down.x, py - down.y) > 4) this.finishMeasure(pending);
  }

  private finishMeasure(note: MeasureNote): void {
    this.draft = null;
    this.measureDownAt = null;
    // Snapping both ends to the same point is a mis-click, not a measurement.
    if (Math.hypot(note.x2 - note.x1, note.y2 - note.y1) * this.vp.scale < 1) {
      this.setStatus('Measurement cancelled: both points are the same');
      this.requestFrame();
      return;
    }
    this.commit([...this.notes, note], 'Add measurement');
    this.showMeasurement(note);
  }

  private lengthFormat(): LengthFormat {
    const u = this.scene?.units;
    return { precision: u?.precision ?? 4, suffix: u?.suffix ?? '' };
  }

  /** Full readout in the status bar: distance, per-axis deltas and angle. */
  private showMeasurement(n: MeasureNote): void {
    const f = this.lengthFormat();
    const m = measure(n.x1, n.y1, n.x2, n.y2);
    const len = (v: number) => formatLength(v, f.precision, f.suffix);
    this.setStatus(
      `Distance ${len(m.distance)}   ·   ΔX ${len(m.dx)}   ·   ΔY ${len(m.dy)}   ·   Angle ${m.angle.toFixed(2)}°`
    );
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.localPoint(e);
    this.showCoords(p.x, p.y);

    if (this.panning && this.pointerDown) {
      this.vp.panBy(p.x - this.lastPointer.x, p.y - this.lastPointer.y);
      this.lastPointer = p;
      this.requestFrame();
      return;
    }

    if (this.movingFrom && this.pointerDown) {
      const x = this.vp.toDrawingX(p.x);
      const y = this.vp.toDrawingY(p.y);
      const dx = x - this.movingFrom.x;
      const dy = y - this.movingFrom.y;
      this.movingFrom = { x, y };
      this.notes = this.notes.map((n) => (this.selected.has(n.id) ? translateNote(n, dx, dy) : n));
      this.requestFrame();
      return;
    }

    // Measuring tracks the cursor between clicks too, not only while pressed.
    if (this.tool === 'measure') {
      this.measurePointerMove(p.x, p.y, e);
      this.lastPointer = p;
      return;
    }

    if (this.draft && this.pointerDown) {
      this.updateDraft(p.x, p.y);
      this.requestFrame();
    }

    this.lastPointer = p;
  }

  private onPointerUp(e: PointerEvent): void {
    try {
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* capture was never taken */
    }
    this.pointerDown = false;

    if (this.panning) {
      this.panning = false;
      this.updateCursor();
      return;
    }

    if (this.movingFrom) {
      this.movingFrom = null;
      // Only record an edit if the notes actually moved.
      if (this.moveBaseline && this.moveBaseline !== this.notes) {
        const moved = this.notes;
        this.notes = this.moveBaseline;
        this.commit(moved, 'Move note');
      }
      this.moveBaseline = null;
      // Selecting a single measurement shows its full readout.
      if (this.selected.size === 1) {
        const only = this.notes.find((n) => this.selected.has(n.id));
        if (only?.kind === 'measure') this.showMeasurement(only);
      }
      return;
    }

    if (this.tool === 'measure') {
      const p = this.localPoint(e);
      this.measurePointerUp(p.x, p.y);
      return;
    }

    if (this.draft) {
      const draft = this.draft;
      this.draft = null;
      if (this.isDraftMeaningful(draft)) {
        this.commit([...this.notes, draft], `Add ${draft.kind}`);
      } else {
        this.requestFrame();
      }
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.localPoint(e);
    // Trackpads report fractional deltas; normalising keeps zoom steps even.
    const factor = Math.pow(0.999, e.deltaY * (e.deltaMode === 1 ? 16 : 1));
    this.vp.zoomAt(p.x, p.y, factor);
    this.requestFrame();
    this.showCoords(p.x, p.y);
  }

  // ------------------------------------------------------------- draft notes

  /** Stroke width in drawing units for the current zoom. */
  private drawingWidth(): number {
    return this.widthPx / this.vp.scale;
  }

  private beginDraft(px: number, py: number): void {
    const x = this.vp.toDrawingX(px);
    const y = this.vp.toDrawingY(py);
    const base = {
      id: newId(),
      color: this.color,
      width: this.drawingWidth(),
      opacity: this.tool === 'highlighter' ? Math.min(this.opacity, 0.45) : this.opacity,
      created: Date.now(),
    };

    switch (this.tool) {
      case 'rect':
      case 'ellipse':
        this.draft = { ...base, kind: this.tool, x, y, w: 0, h: 0, filled: this.filled };
        break;
      case 'line':
      case 'arrow':
        this.draft = { ...base, kind: this.tool, x1: x, y1: y, x2: x, y2: y };
        break;
      case 'brush':
      case 'highlighter':
        this.draft = {
          ...base,
          kind: this.tool,
          // Highlighter reads best as a broad flat stroke.
          width: base.width * (this.tool === 'highlighter' ? 3 : 1),
          points: [x, y],
        };
        break;
      default:
        this.draft = null;
    }
  }

  private updateDraft(px: number, py: number): void {
    const d = this.draft;
    if (!d) return;
    const x = this.vp.toDrawingX(px);
    const y = this.vp.toDrawingY(py);

    switch (d.kind) {
      case 'rect':
      case 'ellipse':
        d.w = x - d.x;
        d.h = y - d.y;
        break;
      case 'line':
      case 'arrow':
        d.x2 = x;
        d.y2 = y;
        break;
      case 'brush':
      case 'highlighter': {
        // Skip samples closer than a pixel: they add nothing visible but bloat
        // the saved note and slow down hit-testing.
        const n = d.points.length;
        const dx = x - d.points[n - 2];
        const dy = y - d.points[n - 1];
        if (Math.hypot(dx, dy) * this.vp.scale >= 1) d.points.push(x, y);
        break;
      }
      default:
        break;
    }
  }

  /** Rejects accidental zero-size shapes from a stray click. */
  private isDraftMeaningful(n: Note): boolean {
    const minPx = 3;
    switch (n.kind) {
      case 'rect':
      case 'ellipse':
        return Math.abs(n.w) * this.vp.scale > minPx && Math.abs(n.h) * this.vp.scale > minPx;
      case 'line':
      case 'arrow':
        return Math.hypot(n.x2 - n.x1, n.y2 - n.y1) * this.vp.scale > minPx;
      case 'brush':
      case 'highlighter':
        return n.points.length >= 4;
      case 'text':
        return n.text.trim().length > 0;
      case 'measure':
        return Math.hypot(n.x2 - n.x1, n.y2 - n.y1) * this.vp.scale >= 1;
    }
  }

  /** Places an inline input; webviews cannot use window.prompt. */
  private openTextEditor(px: number, py: number): void {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.placeholder = 'Note text, Enter to place';
    input.style.left = `${px}px`;
    input.style.top = `${py}px`;
    input.style.color = this.color;
    this.overlayEl.appendChild(input);
    input.focus();

    const x = this.vp.toDrawingX(px);
    const y = this.vp.toDrawingY(py);
    let closed = false;

    const close = (commit: boolean) => {
      if (closed) return;
      closed = true;
      const value = input.value.trim();
      input.remove();
      if (commit && value) {
        const note: Note = {
          id: newId(),
          kind: 'text',
          color: this.color,
          width: this.drawingWidth(),
          opacity: this.opacity,
          created: Date.now(),
          x,
          y,
          text: value,
          size: Math.max(this.widthPx * 4, 12) / this.vp.scale,
        };
        this.commit([...this.notes, note], 'Add text note');
      }
      this.canvas.focus();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        close(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => close(true));
  }

  // ------------------------------------------------------------------ edits

  /** Replaces the note set and tells the host, which owns undo and save. */
  private commit(next: Note[], description: string): void {
    this.notes = next;
    // Drop selections pointing at notes that no longer exist.
    for (const id of [...this.selected]) {
      if (!next.some((n) => n.id === id)) this.selected.delete(id);
    }
    vscode.postMessage({ type: 'edit', notes: next, description });
    this.requestFrame();
    this.setStatus(`${description}   ·   ${next.length} note${next.length === 1 ? '' : 's'}`);
  }

  private deleteSelected(): void {
    if (!this.selected.size) return;
    const count = this.selected.size;
    const next = this.notes.filter((n) => !this.selected.has(n.id));
    this.selected.clear();
    this.commit(next, count === 1 ? 'Delete note' : `Delete ${count} notes`);
  }

  private applyStyleToSelection(): void {
    if (!this.selected.size) return;
    const next = this.notes.map((n) => {
      if (!this.selected.has(n.id)) return n;
      const updated: Note = {
        ...n,
        color: this.color,
        opacity: n.kind === 'highlighter' ? Math.min(this.opacity, 0.45) : this.opacity,
        width: this.drawingWidth() * (n.kind === 'highlighter' ? 3 : 1),
      };
      if (updated.kind === 'rect' || updated.kind === 'ellipse') updated.filled = this.filled;
      return updated;
    });
    this.commit(next, 'Restyle note');
  }

  private exportPng(): void {
    // toDataURL captures exactly what is on screen, which is what "export view"
    // means here; notes are included only when they are visible.
    try {
      vscode.postMessage({ type: 'exportPng', dataUri: this.canvas.toDataURL('image/png') });
    } catch (err) {
      vscode.postMessage({
        type: 'error',
        message: `VCAD could not export the view: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ----------------------------------------------------------------- render

  private applyBackground(): void {
    const dark =
      this.config.background === 'dark' ||
      (this.config.background === 'match-theme' && !this.config.themeIsLight);
    document.body.classList.toggle('light', !dark);
  }

  private resize(): void {
    const rect = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.vp.width = Math.max(1, rect.width);
    this.vp.height = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.vp.width * dpr);
    this.canvas.height = Math.round(this.vp.height * dpr);
    this.canvas.style.width = `${this.vp.width}px`;
    this.canvas.style.height = `${this.vp.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.requestFrame();
  }

  private requestFrame(): void {
    if (this.dirtyFrame) return;
    this.dirtyFrame = true;
    requestAnimationFrame(() => {
      this.dirtyFrame = false;
      this.render();
    });
  }

  private render(): void {
    const style = getComputedStyle(document.body);
    const bg = style.getPropertyValue('--vcad-bg').trim() || '#1e1e1e';

    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = bg;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();

    if (this.scene && this.plan) {
      drawScene(this.ctx, this.scene, this.plan, this.vp, {
        baseLineWidth: this.config.lineWidth,
        background: bg,
        minTextPx: 5,
      });
    }

    if (this.notesVisible) {
      const accent = style.getPropertyValue('--vscode-focusBorder').trim() || '#0a84ff';
      const all = this.draft ? [...this.notes, this.draft] : this.notes;
      drawNotes(
        this.ctx,
        all,
        this.vp,
        this.selected,
        accent,
        !document.body.classList.contains('light'),
        this.lengthFormat()
      );
    } else if (this.draft) {
      // An in-progress measurement stays visible even with notes hidden.
      drawNotes(this.ctx, [this.draft], this.vp, this.selected, '#0a84ff',
        !document.body.classList.contains('light'), this.lengthFormat());
    }

    if (this.tool === 'measure' && this.snapHit) {
      drawSnapMarker(this.ctx, this.snapHit, this.vp, '#34c759');
    }
  }

  // ----------------------------------------------------------------- status

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  private showCoords(px: number, py: number): void {
    if (!this.scene) return;
    const x = this.vp.toDrawingX(px);
    const y = this.vp.toDrawingY(py);
    const zoom = this.vp.scale;
    const digits = zoom > 100 ? 4 : zoom > 1 ? 2 : 1;
    this.setStatus(
      `X ${x.toFixed(digits)}   Y ${y.toFixed(digits)}   ·   ${formatZoom(zoom)}   ·   ${this.notes.length} note${this.notes.length === 1 ? '' : 's'}`
    );
  }

  private showStats(): void {
    const s = this.scene;
    if (!s) return;
    const st = s.stats;
    const parts = [
      st.format,
      `${st.polylines + st.arcs + st.ellipses + st.points} primitives`,
      `${s.layers.length} layers`,
      `${st.parseMs} ms`,
    ];
    if (st.truncated) parts.push('truncated — raise vcad.render.maxEntities');
    this.setStatus(parts.join('   ·   '));

    const skippedTypes = Object.keys(st.skipped);
    if (skippedTypes.length) {
      // Surfaced quietly: unsupported entity types are informative, not errors.
      console.info('VCAD: entity types not rendered', st.skipped);
    }
  }

  private showError(message: string, detail?: string): void {
    if (this.errorShown) return;
    this.errorShown = true;
    this.overlayEl.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'error';
    const h = document.createElement('h3');
    h.textContent = message;
    box.appendChild(h);
    if (detail) {
      const p = document.createElement('p');
      p.textContent = detail;
      box.appendChild(p);
    }
    this.overlayEl.appendChild(box);
    this.setStatus(message);
  }
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  const span = document.createElement('span');
  span.textContent = text;
  wrap.append(span, control);
  return wrap;
}

function formatZoom(scale: number): string {
  if (scale >= 1) return `${scale.toFixed(scale >= 10 ? 0 : 1)}×`;
  return `1/${(1 / scale).toFixed(1)}×`;
}

// Uncaught errors in a webview only reach its own devtools console, which users
// rarely open; forward them to the VCAD output channel as well.
window.addEventListener('error', (e) => {
  vscode.postMessage({ type: 'error', message: `Webview error: ${e.message} (${e.filename}:${e.lineno})` });
});
window.addEventListener('unhandledrejection', (e) => {
  vscode.postMessage({ type: 'error', message: `Webview unhandled rejection: ${String(e.reason)}` });
});

try {
  new Viewer();
} catch (err) {
  vscode.postMessage({
    type: 'error',
    message: `VCAD viewer failed to start: ${err instanceof Error ? err.stack || err.message : String(err)}`,
  });
}
