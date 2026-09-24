/**
 * Markup rendering and hit-testing.
 *
 * Notes live in drawing coordinates, so they stay attached to the geometry they
 * annotate at any zoom. Stroke widths are drawing units too, which means a
 * highlighter stroke keeps covering the same wall as the user zooms in.
 */

import { formatLength, measure, MeasureNote, Note, noteBounds } from '../common/annotations';
import type { SnapHit } from './snap';
import { Viewport } from './viewport';

/** How distances are written on measure notes. */
export interface LengthFormat {
  precision: number;
  suffix: string;
}

/** Minimum on-screen stroke width, so notes never vanish when zoomed out. */
const MIN_STROKE_PX = 1;
/** Highlighter strokes are this many times wider than their nominal width. */
const HIGHLIGHTER_SCALE = 1;

export function drawNotes(
  ctx: CanvasRenderingContext2D,
  notes: readonly Note[],
  vp: Viewport,
  selectedIds: ReadonlySet<string>,
  accentColor: string,
  darkBackground: boolean,
  lengths: LengthFormat
): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Highlighter passes go underneath everything else, the way real highlighter
  // ink sits under pen.
  for (const n of notes) if (n.kind === 'highlighter') drawOne(ctx, n, vp, darkBackground);
  for (const n of notes) {
    if (n.kind === 'measure') drawMeasure(ctx, n, vp, lengths, darkBackground);
    else if (n.kind !== 'highlighter') drawOne(ctx, n, vp, darkBackground);
  }

  if (selectedIds.size) {
    for (const n of notes) {
      if (selectedIds.has(n.id)) drawSelection(ctx, n, vp, accentColor);
    }
  }
  ctx.restore();
}

function strokePx(width: number, vp: Viewport): number {
  return Math.max(MIN_STROKE_PX, width * vp.scale);
}

function drawOne(
  ctx: CanvasRenderingContext2D,
  n: Note,
  vp: Viewport,
  darkBackground: boolean
): void {
  ctx.save();
  ctx.globalAlpha = n.opacity;
  ctx.strokeStyle = n.color;
  ctx.fillStyle = n.color;

  if (n.kind === 'highlighter') {
    // Both modes let the geometry underneath show through, but they need
    // opposite maths: 'multiply' darkens, which is right over a light sheet and
    // turns the ink almost black over a dark one, so dark mode screens instead.
    ctx.globalCompositeOperation = darkBackground ? 'screen' : 'multiply';
    ctx.lineCap = 'butt';
  }

  switch (n.kind) {
    case 'rect': {
      const x = vp.toScreenX(Math.min(n.x, n.x + n.w));
      const y = vp.toScreenY(Math.max(n.y, n.y + n.h));
      const w = Math.abs(n.w) * vp.scale;
      const h = Math.abs(n.h) * vp.scale;
      ctx.lineWidth = strokePx(n.width, vp);
      if (n.filled) {
        ctx.globalAlpha = n.opacity * 0.25;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = n.opacity;
      }
      ctx.strokeRect(x, y, w, h);
      break;
    }

    case 'ellipse': {
      const cx = vp.toScreenX(n.x + n.w / 2);
      const cy = vp.toScreenY(n.y + n.h / 2);
      const rx = (Math.abs(n.w) / 2) * vp.scale;
      const ry = (Math.abs(n.h) / 2) * vp.scale;
      ctx.lineWidth = strokePx(n.width, vp);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (n.filled) {
        ctx.globalAlpha = n.opacity * 0.25;
        ctx.fill();
        ctx.globalAlpha = n.opacity;
      }
      ctx.stroke();
      break;
    }

    case 'line':
    case 'arrow': {
      const x1 = vp.toScreenX(n.x1);
      const y1 = vp.toScreenY(n.y1);
      const x2 = vp.toScreenX(n.x2);
      const y2 = vp.toScreenY(n.y2);
      ctx.lineWidth = strokePx(n.width, vp);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (n.kind === 'arrow') drawArrowHead(ctx, x1, y1, x2, y2, ctx.lineWidth);
      break;
    }

    case 'brush':
    case 'highlighter': {
      const w = strokePx(n.width * (n.kind === 'highlighter' ? HIGHLIGHTER_SCALE : 1), vp);
      ctx.lineWidth = w;
      ctx.beginPath();
      strokePath(ctx, n.points, vp);
      ctx.stroke();
      break;
    }

    case 'text': {
      const px = Math.max(8, n.size * vp.scale);
      ctx.font = `600 ${px}px var(--vscode-font-family, sans-serif)`;
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'left';
      const lines = n.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], vp.toScreenX(n.x), vp.toScreenY(n.y) + i * px * 1.25);
      }
      break;
    }
  }
  ctx.restore();
}

/**
 * Draws a measurement as a dimension line: a thin line between the two points,
 * perpendicular ticks marking each end, and the distance in a label that stays
 * upright and readable whatever direction the line runs.
 */
function drawMeasure(
  ctx: CanvasRenderingContext2D,
  n: MeasureNote,
  vp: Viewport,
  lengths: LengthFormat,
  darkBackground: boolean
): void {
  const x1 = vp.toScreenX(n.x1);
  const y1 = vp.toScreenY(n.y1);
  const x2 = vp.toScreenX(n.x2);
  const y2 = vp.toScreenY(n.y2);
  const len = Math.hypot(x2 - x1, y2 - y1);
  // Measurements are precise instruments, so their line weight ignores zoom.
  const lw = 1.5;

  ctx.save();
  ctx.globalAlpha = n.opacity;
  ctx.strokeStyle = n.color;
  ctx.fillStyle = n.color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'butt';

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // End ticks, perpendicular to the measured line.
  const nx = len > 0 ? -(y2 - y1) / len : 0;
  const ny = len > 0 ? (x2 - x1) / len : 1;
  const tick = 7;
  ctx.beginPath();
  ctx.moveTo(x1 - nx * tick, y1 - ny * tick);
  ctx.lineTo(x1 + nx * tick, y1 + ny * tick);
  ctx.moveTo(x2 - nx * tick, y2 - ny * tick);
  ctx.lineTo(x2 + nx * tick, y2 + ny * tick);
  ctx.stroke();

  // Label, centred on the line and rotated with it but never upside down.
  const m = measure(n.x1, n.y1, n.x2, n.y2);
  const text = formatLength(m.distance, lengths.precision, lengths.suffix);
  let angle = Math.atan2(y2 - y1, x2 - x1);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;

  ctx.font = '600 12px var(--vscode-font-family, sans-serif)';
  const tw = ctx.measureText(text).width;
  const padX = 5;
  const boxW = tw + padX * 2;
  const boxH = 18;

  ctx.translate((x1 + x2) / 2, (y1 + y2) / 2);
  ctx.rotate(angle);
  // Sit the label just above the line when there is room beside it; otherwise
  // centre it on the line so a short measurement stays legible.
  const offset = len > boxW + 16 ? -boxH / 2 - 3 : 0;
  ctx.globalAlpha = 1;
  ctx.fillStyle = darkBackground ? 'rgba(20,20,20,0.85)' : 'rgba(255,255,255,0.9)';
  ctx.fillRect(-boxW / 2, offset - boxH / 2, boxW, boxH);
  ctx.strokeStyle = n.color;
  ctx.lineWidth = 1;
  ctx.strokeRect(-boxW / 2, offset - boxH / 2, boxW, boxH);
  ctx.fillStyle = n.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, offset + 0.5);
  ctx.restore();
}

/** Draws the AutoCAD-style marker for the snap point under the cursor. */
export function drawSnapMarker(
  ctx: CanvasRenderingContext2D,
  hit: SnapHit,
  vp: Viewport,
  color: string
): void {
  const x = vp.toScreenX(hit.x);
  const y = vp.toScreenY(hit.y);
  const s = 6;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  switch (hit.kind) {
    case 'endpoint':
      ctx.rect(x - s, y - s, s * 2, s * 2);
      break;
    case 'midpoint':
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.lineTo(x - s, y + s);
      ctx.closePath();
      break;
    case 'center':
      ctx.arc(x, y, s, 0, Math.PI * 2);
      break;
    case 'quadrant':
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      break;
    case 'node':
      ctx.arc(x, y, s, 0, Math.PI * 2);
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s);
      ctx.lineTo(x - s, y + s);
      break;
  }
  ctx.stroke();

  ctx.font = '11px var(--vscode-font-family, sans-serif)';
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(hit.kind, x + s + 4, y + s + 2);
  ctx.restore();
}

/**
 * Traces a freehand stroke, smoothing corners with quadratic segments through
 * the midpoints so brush strokes do not look faceted.
 */
function strokePath(ctx: CanvasRenderingContext2D, pts: number[], vp: Viewport): void {
  const n = pts.length >> 1;
  if (n === 0) return;
  if (n === 1) {
    // A single tap still deserves a visible dot.
    const x = vp.toScreenX(pts[0]);
    const y = vp.toScreenY(pts[1]);
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.01, y);
    return;
  }

  let x0 = vp.toScreenX(pts[0]);
  let y0 = vp.toScreenY(pts[1]);
  ctx.moveTo(x0, y0);
  if (n === 2) {
    ctx.lineTo(vp.toScreenX(pts[2]), vp.toScreenY(pts[3]));
    return;
  }

  for (let i = 1; i < n - 1; i++) {
    const x1 = vp.toScreenX(pts[i * 2]);
    const y1 = vp.toScreenY(pts[i * 2 + 1]);
    ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    x0 = x1;
    y0 = y1;
  }
  ctx.quadraticCurveTo(x0, y0, vp.toScreenX(pts[(n - 1) * 2]), vp.toScreenY(pts[(n - 1) * 2 + 1]));
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lineWidth: number
): void {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(8, lineWidth * 4);
  const spread = Math.PI / 7;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - len * Math.cos(angle - spread), y2 - len * Math.sin(angle - spread));
  ctx.lineTo(x2 - len * Math.cos(angle + spread), y2 - len * Math.sin(angle + spread));
  ctx.closePath();
  ctx.fill();
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  n: Note,
  vp: Viewport,
  accent: string
): void {
  const b = noteBounds(n);
  if (!Number.isFinite(b.minX)) return;
  const x = vp.toScreenX(b.minX);
  const y = vp.toScreenY(b.maxY);
  const w = (b.maxX - b.minX) * vp.scale;
  const h = (b.maxY - b.minY) * vp.scale;
  const pad = 4;

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
  ctx.restore();
}

/**
 * Finds the topmost note at a screen position.
 * `tolerance` is in pixels, so thin strokes stay easy to grab when zoomed out.
 */
export function hitTest(
  notes: readonly Note[],
  px: number,
  py: number,
  vp: Viewport,
  tolerance = 6
): Note | null {
  const x = vp.toDrawingX(px);
  const y = vp.toDrawingY(py);
  const tol = tolerance / vp.scale;

  // Later notes are drawn on top, so search back to front.
  for (let i = notes.length - 1; i >= 0; i--) {
    if (hits(notes[i], x, y, tol)) return notes[i];
  }
  return null;
}

function hits(n: Note, x: number, y: number, tol: number): boolean {
  switch (n.kind) {
    case 'rect': {
      const minX = Math.min(n.x, n.x + n.w);
      const maxX = Math.max(n.x, n.x + n.w);
      const minY = Math.min(n.y, n.y + n.h);
      const maxY = Math.max(n.y, n.y + n.h);
      if (n.filled) {
        return x >= minX - tol && x <= maxX + tol && y >= minY - tol && y <= maxY + tol;
      }
      // Unfilled: only the border is clickable, so a box drawn around geometry
      // does not swallow clicks meant for what is inside it.
      const inOuter = x >= minX - tol && x <= maxX + tol && y >= minY - tol && y <= maxY + tol;
      const inInner = x > minX + tol && x < maxX - tol && y > minY + tol && y < maxY - tol;
      return inOuter && !inInner;
    }

    case 'ellipse': {
      const cx = n.x + n.w / 2;
      const cy = n.y + n.h / 2;
      const rx = Math.abs(n.w) / 2;
      const ry = Math.abs(n.h) / 2;
      if (rx < 1e-9 || ry < 1e-9) return false;
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (n.filled) return d <= 1 + tol / Math.min(rx, ry);
      const band = tol / Math.min(rx, ry);
      return Math.abs(Math.sqrt(d) - 1) <= band;
    }

    case 'line':
    case 'arrow':
      return distToSegment(x, y, n.x1, n.y1, n.x2, n.y2) <= tol + n.width / 2;

    case 'measure':
      // Drawn at a fixed screen width, so only the pixel tolerance applies.
      return distToSegment(x, y, n.x1, n.y1, n.x2, n.y2) <= tol;

    case 'brush':
    case 'highlighter': {
      const reach = tol + n.width / 2;
      for (let i = 0; i + 3 < n.points.length; i += 2) {
        if (
          distToSegment(x, y, n.points[i], n.points[i + 1], n.points[i + 2], n.points[i + 3]) <=
          reach
        ) {
          return true;
        }
      }
      return false;
    }

    case 'text': {
      const b = noteBounds(n);
      return x >= b.minX - tol && x <= b.maxX + tol && y >= b.minY - tol && y <= b.maxY + tol;
    }
  }
}

function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-18) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Moves a note by a drawing-space delta, returning a new object. */
export function translateNote(n: Note, dx: number, dy: number): Note {
  switch (n.kind) {
    case 'rect':
    case 'ellipse':
      return { ...n, x: n.x + dx, y: n.y + dy };
    case 'line':
    case 'arrow':
    case 'measure':
      return { ...n, x1: n.x1 + dx, y1: n.y1 + dy, x2: n.x2 + dx, y2: n.y2 + dy };
    case 'brush':
    case 'highlighter': {
      const points = n.points.slice();
      for (let i = 0; i < points.length; i += 2) {
        points[i] += dx;
        points[i + 1] += dy;
      }
      return { ...n, points };
    }
    case 'text':
      return { ...n, x: n.x + dx, y: n.y + dy };
  }
}
