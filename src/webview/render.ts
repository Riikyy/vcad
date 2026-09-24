/**
 * Scene renderer.
 *
 * Drawings routinely contain hundreds of thousands of primitives, so the work is
 * split in two: a plan built once per scene that groups primitives by stroke
 * style and precomputes bounding boxes, and a per-frame pass that culls against
 * the viewport and issues one path per style group. Doing it the naive way — a
 * beginPath/stroke per entity — is what makes most canvas CAD viewers crawl.
 */

import { POLY_CLOSED, POLY_FILLED, Scene, SceneBounds } from '../common/scene';
import { Viewport } from './viewport';

/** Style buckets keyed by colour and weight class. */
interface Group {
  css: string;
  /** Stroke width multiplier derived from the CAD lineweight. */
  widthFactor: number;
  polys: number[];
  arcs: number[];
  ellipses: number[];
  points: number[];
}

export interface RenderPlan {
  groups: Group[];
  /** Per-primitive bounds, 4 values each, for viewport culling. */
  polyBounds: Float64Array;
  arcBounds: Float64Array;
  ellBounds: Float64Array;
  visibleTexts: number[];
}

function rgbCss(rgb: number): string {
  return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
}

/**
 * Maps a CAD lineweight (1/100 mm) onto a stroke multiplier.
 * True lineweight display would need the drawing's units and plot scale; this
 * keeps the visual hierarchy of heavy vs. hairline without inventing a scale.
 */
function weightFactor(weight: number): number {
  if (weight < 0) return 1;
  if (weight >= 100) return 2;
  if (weight >= 50) return 1.5;
  return 1;
}

export function buildPlan(scene: Scene, hidden: ReadonlySet<number>): RenderPlan {
  const groups = new Map<string, Group>();

  const groupFor = (layer: number, color: number, weight: number): Group | null => {
    if (hidden.has(layer)) return null;
    const l = scene.layers[layer];
    if (!l || l.off || l.frozen) return null;
    const rgb = color < 0 ? l.color : color;
    const w = weight < 0 ? l.weight : weight;
    const factor = weightFactor(w);
    const key = `${rgb}|${factor}`;
    let g = groups.get(key);
    if (!g) {
      g = { css: rgbCss(rgb), widthFactor: factor, polys: [], arcs: [], ellipses: [], points: [] };
      groups.set(key, g);
    }
    return g;
  };

  const polyCount = scene.polyLayer.length;
  const polyBounds = new Float64Array(polyCount * 4);
  for (let i = 0; i < polyCount; i++) {
    const start = scene.polyOffsets[i] * 2;
    const end = scene.polyOffsets[i + 1] * 2;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = start; k < end; k += 2) {
      const x = scene.polyCoords[k];
      const y = scene.polyCoords[k + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    polyBounds[i * 4] = minX;
    polyBounds[i * 4 + 1] = minY;
    polyBounds[i * 4 + 2] = maxX;
    polyBounds[i * 4 + 3] = maxY;
    groupFor(scene.polyLayer[i], scene.polyColor[i], scene.polyWeight[i])?.polys.push(i);
  }

  const arcCount = scene.arcLayer.length;
  const arcBounds = new Float64Array(arcCount * 4);
  for (let i = 0; i < arcCount; i++) {
    const cx = scene.arcData[i * 5];
    const cy = scene.arcData[i * 5 + 1];
    const r = scene.arcData[i * 5 + 2];
    // A conservative square bound is enough for culling and far cheaper than
    // solving which axis extremes the sweep actually reaches.
    arcBounds[i * 4] = cx - r;
    arcBounds[i * 4 + 1] = cy - r;
    arcBounds[i * 4 + 2] = cx + r;
    arcBounds[i * 4 + 3] = cy + r;
    groupFor(scene.arcLayer[i], scene.arcColor[i], scene.arcWeight[i])?.arcs.push(i);
  }

  const ellCount = scene.ellLayer.length;
  const ellBounds = new Float64Array(ellCount * 4);
  for (let i = 0; i < ellCount; i++) {
    const cx = scene.ellData[i * 7];
    const cy = scene.ellData[i * 7 + 1];
    const r = Math.max(scene.ellData[i * 7 + 2], scene.ellData[i * 7 + 3]);
    ellBounds[i * 4] = cx - r;
    ellBounds[i * 4 + 1] = cy - r;
    ellBounds[i * 4 + 2] = cx + r;
    ellBounds[i * 4 + 3] = cy + r;
    groupFor(scene.ellLayer[i], scene.ellColor[i], scene.ellWeight[i])?.ellipses.push(i);
  }

  for (let i = 0; i < scene.ptLayer.length; i++) {
    groupFor(scene.ptLayer[i], scene.ptColor[i], -1)?.points.push(i);
  }

  const visibleTexts: number[] = [];
  for (let i = 0; i < scene.texts.length; i++) {
    const t = scene.texts[i];
    if (hidden.has(t.layer)) continue;
    const l = scene.layers[t.layer];
    if (!l || l.off || l.frozen) continue;
    visibleTexts.push(i);
  }

  return {
    groups: [...groups.values()],
    polyBounds,
    arcBounds,
    ellBounds,
    visibleTexts,
  };
}

/**
 * Extents of the drawing's main body, ignoring far-flung outliers.
 *
 * Real drawings routinely contain a handful of primitives thousands of times
 * further out than everything else — construction lines, a block inserted at a
 * huge scale, stray geometry left in model space. Framing the true min/max would
 * render the actual drawing a few pixels wide, so the bulk of the geometry is
 * located first and the outliers are allowed to fall off-screen.
 *
 * Returns null when there is nothing to measure, in which case callers should
 * fall back to the scene's own bounds.
 */
export function contentBounds(scene: Scene, plan: RenderPlan): SceneBounds | null {
  const cx: number[] = [];
  const cy: number[] = [];

  const collect = (bounds: Float64Array, indices: number[]) => {
    for (const i of indices) {
      const b = i * 4;
      cx.push((bounds[b] + bounds[b + 2]) / 2);
      cy.push((bounds[b + 1] + bounds[b + 3]) / 2);
    }
  };
  for (const g of plan.groups) {
    collect(plan.polyBounds, g.polys);
    collect(plan.arcBounds, g.arcs);
    collect(plan.ellBounds, g.ellipses);
    for (const i of g.points) {
      cx.push(scene.ptCoords[i * 2]);
      cy.push(scene.ptCoords[i * 2 + 1]);
    }
  }
  if (cx.length === 0) return null;

  const mx = median(cx);
  const my = median(cy);

  // Distance from the median at which 90% of primitives are enclosed. Using a
  // percentile rather than a mean keeps a few extreme values from dragging the
  // threshold out with them.
  const dist = cx.map((x, i) => Math.hypot(x - mx, cy[i] - my)).sort((a, b) => a - b);
  const d90 = dist[Math.min(dist.length - 1, Math.floor(dist.length * 0.9))];
  // A generous multiple: the goal is to exclude only genuine outliers, not to
  // crop a drawing that is legitimately spread out.
  const radius = Math.max(d90 * 4, 1e-9);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let kept = 0;

  const include = (bounds: Float64Array, indices: number[]) => {
    for (const i of indices) {
      const b = i * 4;
      const x = (bounds[b] + bounds[b + 2]) / 2;
      const y = (bounds[b + 1] + bounds[b + 3]) / 2;
      if (Math.hypot(x - mx, y - my) > radius) continue;
      // A primitive centred in the cluster can still be enormous — an XLINE is
      // anchored locally but stretches to the horizon. Skip those extents too.
      const w = bounds[b + 2] - bounds[b];
      const h = bounds[b + 3] - bounds[b + 1];
      if (w > radius * 4 || h > radius * 4) continue;
      if (bounds[b] < minX) minX = bounds[b];
      if (bounds[b + 1] < minY) minY = bounds[b + 1];
      if (bounds[b + 2] > maxX) maxX = bounds[b + 2];
      if (bounds[b + 3] > maxY) maxY = bounds[b + 3];
      kept++;
    }
  };

  for (const g of plan.groups) {
    include(plan.polyBounds, g.polys);
    include(plan.arcBounds, g.arcs);
    include(plan.ellBounds, g.ellipses);
    for (const i of g.points) {
      const x = scene.ptCoords[i * 2];
      const y = scene.ptCoords[i * 2 + 1];
      if (Math.hypot(x - mx, y - my) > radius) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      kept++;
    }
  }

  // Text sits outside the geometry arrays but is often the only thing in a
  // sparse drawing, so fold in whatever falls inside the cluster.
  for (const i of plan.visibleTexts) {
    const t = scene.texts[i];
    if (Math.hypot(t.x - mx, t.y - my) > radius) continue;
    if (t.x < minX) minX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.x > maxX) maxX = t.x;
    if (t.y > maxY) maxY = t.y;
    kept++;
  }

  if (!kept || !Number.isFinite(minX) || !(maxX > minX) || !(maxY > minY)) return null;
  return { minX, minY, maxX, maxY };
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface DrawOptions {
  baseLineWidth: number;
  background: string;
  /** Text smaller than this many pixels is not worth drawing. */
  minTextPx: number;
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  plan: RenderPlan,
  vp: Viewport,
  opts: DrawOptions
): void {
  const view = vp.visibleBounds(32);
  const s = vp.scale;
  const ox = vp.offsetX;
  const oy = vp.offsetY;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const g of plan.groups) {
    ctx.strokeStyle = g.css;
    ctx.fillStyle = g.css;
    ctx.lineWidth = opts.baseLineWidth * g.widthFactor;

    // Filled primitives need their own path, so they are collected and drawn
    // after the stroked ones rather than interrupting the batch.
    let filledPolys: number[] | null = null;

    ctx.beginPath();
    for (const i of g.polys) {
      const b = i * 4;
      if (
        plan.polyBounds[b + 2] < view.minX ||
        plan.polyBounds[b] > view.maxX ||
        plan.polyBounds[b + 3] < view.minY ||
        plan.polyBounds[b + 1] > view.maxY
      ) {
        continue;
      }

      if (scene.polyFlags[i] & POLY_FILLED) {
        (filledPolys ??= []).push(i);
        continue;
      }

      const start = scene.polyOffsets[i] * 2;
      const end = scene.polyOffsets[i + 1] * 2;
      if (end - start < 4) continue;

      // Sub-pixel geometry still needs a mark, but not every vertex of it.
      const w = (plan.polyBounds[b + 2] - plan.polyBounds[b]) * s;
      const h = (plan.polyBounds[b + 3] - plan.polyBounds[b + 1]) * s;
      if (w < 1.2 && h < 1.2) {
        const x = scene.polyCoords[start] * s + ox;
        const y = -scene.polyCoords[start + 1] * s + oy;
        ctx.moveTo(x, y);
        ctx.lineTo(x + 0.6, y);
        continue;
      }

      ctx.moveTo(scene.polyCoords[start] * s + ox, -scene.polyCoords[start + 1] * s + oy);
      for (let k = start + 2; k < end; k += 2) {
        ctx.lineTo(scene.polyCoords[k] * s + ox, -scene.polyCoords[k + 1] * s + oy);
      }
      if (scene.polyFlags[i] & POLY_CLOSED) ctx.closePath();
    }

    for (const i of g.arcs) {
      const b = i * 4;
      if (
        plan.arcBounds[b + 2] < view.minX ||
        plan.arcBounds[b] > view.maxX ||
        plan.arcBounds[b + 3] < view.minY ||
        plan.arcBounds[b + 1] > view.maxY
      ) {
        continue;
      }
      const d = i * 5;
      const r = scene.arcData[d + 2] * s;
      if (r < 0.3) continue;
      const cx = scene.arcData[d] * s + ox;
      const cy = -scene.arcData[d + 1] * s + oy;
      // The Y flip turns a counter-clockwise CAD sweep into a clockwise screen
      // sweep, so the angles are negated and the direction flag inverted.
      ctx.moveTo(cx + r * Math.cos(-scene.arcData[d + 3]), cy + r * Math.sin(-scene.arcData[d + 3]));
      ctx.arc(cx, cy, r, -scene.arcData[d + 3], -scene.arcData[d + 4], true);
    }

    for (const i of g.ellipses) {
      const b = i * 4;
      if (
        plan.ellBounds[b + 2] < view.minX ||
        plan.ellBounds[b] > view.maxX ||
        plan.ellBounds[b + 3] < view.minY ||
        plan.ellBounds[b + 1] > view.maxY
      ) {
        continue;
      }
      const d = i * 7;
      const rx = scene.ellData[d + 2] * s;
      const ry = scene.ellData[d + 3] * s;
      if (rx < 0.3 && ry < 0.3) continue;
      const cx = scene.ellData[d] * s + ox;
      const cy = -scene.ellData[d + 1] * s + oy;
      const tilt = -scene.ellData[d + 4];
      const a0 = -scene.ellData[d + 5];
      const a1 = -scene.ellData[d + 6];
      ctx.ellipse(cx, cy, rx, ry, tilt, a0, a1, true);
    }

    for (const i of g.points) {
      const x = scene.ptCoords[i * 2] * s + ox;
      const y = -scene.ptCoords[i * 2 + 1] * s + oy;
      if (x < -8 || y < -8 || x > vp.width + 8 || y > vp.height + 8) continue;
      // A bare POINT has no size of its own; draw a small fixed marker.
      ctx.moveTo(x - 2.5, y);
      ctx.lineTo(x + 2.5, y);
      ctx.moveTo(x, y - 2.5);
      ctx.lineTo(x, y + 2.5);
    }

    ctx.stroke();

    if (filledPolys) {
      ctx.beginPath();
      for (const i of filledPolys) {
        const start = scene.polyOffsets[i] * 2;
        const end = scene.polyOffsets[i + 1] * 2;
        if (end - start < 6) continue;
        ctx.moveTo(scene.polyCoords[start] * s + ox, -scene.polyCoords[start + 1] * s + oy);
        for (let k = start + 2; k < end; k += 2) {
          ctx.lineTo(scene.polyCoords[k] * s + ox, -scene.polyCoords[k + 1] * s + oy);
        }
        ctx.closePath();
      }
      ctx.fill();
    }
  }

  drawTexts(ctx, scene, plan, vp, opts);
  ctx.restore();
}

function drawTexts(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  plan: RenderPlan,
  vp: Viewport,
  opts: DrawOptions
): void {
  ctx.textBaseline = 'alphabetic';
  let lastColor = '';

  for (const i of plan.visibleTexts) {
    const t = scene.texts[i];
    const px = t.height * vp.scale;
    // Below a few pixels text is an illegible smear that costs more than the
    // geometry around it.
    if (px < opts.minTextPx) continue;

    const x = vp.toScreenX(t.x);
    const y = vp.toScreenY(t.y);
    // Generous margin: the anchor can sit off-screen while the run is visible.
    const reach = Math.max(px * t.text.length, px) + 64;
    if (x < -reach || y < -reach || x > vp.width + reach || y > vp.height + reach) continue;

    const css = t.color < 0 ? rgbCss(scene.layers[t.layer].color) : rgbCss(t.color);
    if (css !== lastColor) {
      ctx.fillStyle = css;
      lastColor = css;
    }

    ctx.save();
    ctx.translate(x, y);
    // Drawing-space rotation is counter-clockwise; screen rotation is clockwise.
    if (t.rotation) ctx.rotate(-t.rotation);
    if (t.widthFactor !== 1) ctx.scale(t.widthFactor, 1);
    if (t.oblique) ctx.transform(1, 0, -Math.tan(t.oblique), 1, 0, 0);

    ctx.font = `${px}px var(--vcad-cad-font, monospace)`;
    ctx.textAlign = t.halign === 1 ? 'center' : t.halign === 2 ? 'right' : 'left';

    // DXF vertical alignment is measured from the baseline; canvas offsets are
    // applied in screen pixels, where positive Y is down.
    let dy = 0;
    if (t.valign === 1) dy = 0;
    else if (t.valign === 2) dy = px * 0.36;
    else if (t.valign === 3) dy = px * 0.72;

    ctx.fillText(t.text, 0, dy);
    ctx.restore();
  }
}
