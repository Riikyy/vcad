/**
 * The markup model.
 *
 * Every coordinate is stored in *drawing* units, never screen pixels, so notes
 * stay welded to the geometry they describe as the user pans and zooms. Stroke
 * widths are stored in drawing units for the same reason.
 */

export type ToolKind =
  | 'select'
  | 'pan'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'brush'
  | 'highlighter'
  | 'text'
  | 'measure';

export type NoteKind =
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'brush'
  | 'highlighter'
  | 'text'
  | 'measure';

interface NoteBase {
  id: string;
  kind: NoteKind;
  /** CSS colour string, e.g. "#ff5c5c". */
  color: string;
  /** Stroke width in drawing units. */
  width: number;
  /** 0..1 */
  opacity: number;
  /** Author-supplied label shown on hover and in the notes list. */
  label?: string;
  /** Epoch milliseconds. */
  created: number;
}

/** Axis-aligned box notes: rectangle and ellipse. */
export interface BoxNote extends NoteBase {
  kind: 'rect' | 'ellipse';
  x: number;
  y: number;
  w: number;
  h: number;
  /** When true the interior is filled with `color` at `opacity`. */
  filled: boolean;
}

/** Two-point notes: plain line and arrow. */
export interface SegmentNote extends NoteBase {
  kind: 'line' | 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Freehand notes: brush and highlighter share a geometry shape. */
export interface StrokeNote extends NoteBase {
  kind: 'brush' | 'highlighter';
  /** Flat x,y pairs in drawing units. */
  points: number[];
}

export interface TextNote extends NoteBase {
  kind: 'text';
  x: number;
  y: number;
  text: string;
  /** Cap height in drawing units. */
  size: number;
}

/**
 * A distance measurement between two drawing points.
 *
 * Only the endpoints are stored. The displayed distance is recomputed from them
 * at render time, so moving the note or changing unit display can never leave a
 * stale number on screen.
 */
export interface MeasureNote extends NoteBase {
  kind: 'measure';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type Note = BoxNote | SegmentNote | StrokeNote | TextNote | MeasureNote;

/** On-disk shape of the sidecar notes file. */
export interface NotesFile {
  /** Schema version, bumped on breaking changes. */
  version: 1;
  /** Basename of the drawing these notes belong to, for a sanity check on load. */
  drawing?: string;
  notes: Note[];
}

export function emptyNotes(drawing?: string): NotesFile {
  return { version: 1, drawing, notes: [] };
}

/**
 * Validates and normalises parsed JSON from disk. Notes files are user-editable
 * and may be hand-edited or merged by a VCS, so anything malformed is dropped
 * rather than allowed to crash the renderer.
 */
export function parseNotes(raw: unknown): NotesFile {
  const out = emptyNotes();
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.drawing === 'string') out.drawing = obj.drawing;
  if (!Array.isArray(obj.notes)) return out;

  for (const item of obj.notes) {
    const n = sanitizeNote(item);
    if (n) out.notes.push(n);
  }
  return out;
}

const KINDS: ReadonlySet<string> = new Set([
  'rect',
  'ellipse',
  'line',
  'arrow',
  'brush',
  'highlighter',
  'text',
  'measure',
]);

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function sanitizeNote(item: unknown): Note | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind)) return null;

  const base = {
    id: typeof o.id === 'string' && o.id ? o.id : newId(),
    color: typeof o.color === 'string' ? o.color : '#ff3b30',
    width: num(o.width, 1),
    opacity: Math.min(1, Math.max(0, num(o.opacity, 1))),
    created: num(o.created, Date.now()),
    ...(typeof o.label === 'string' ? { label: o.label } : {}),
  };

  switch (o.kind) {
    case 'rect':
    case 'ellipse':
      return {
        ...base,
        kind: o.kind,
        x: num(o.x),
        y: num(o.y),
        w: num(o.w),
        h: num(o.h),
        filled: o.filled === true,
      };
    case 'line':
    case 'arrow':
    case 'measure':
      return {
        ...base,
        kind: o.kind,
        x1: num(o.x1),
        y1: num(o.y1),
        x2: num(o.x2),
        y2: num(o.y2),
      };
    case 'brush':
    case 'highlighter': {
      if (!Array.isArray(o.points) || o.points.length < 4) return null;
      const points: number[] = [];
      for (const p of o.points) if (typeof p === 'number' && Number.isFinite(p)) points.push(p);
      // An odd trailing value would desynchronise every x,y pair after it.
      if (points.length < 4) return null;
      if (points.length % 2 === 1) points.pop();
      return { ...base, kind: o.kind, points };
    }
    case 'text':
      return {
        ...base,
        kind: 'text',
        x: num(o.x),
        y: num(o.y),
        text: typeof o.text === 'string' ? o.text : '',
        size: num(o.size, 1) || 1,
      };
    default:
      return null;
  }
}

export interface Measurement {
  distance: number;
  dx: number;
  dy: number;
  /** Degrees counter-clockwise from +X, in [0, 360). */
  angle: number;
}

export function measure(x1: number, y1: number, x2: number, y2: number): Measurement {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle < 0) angle += 360;
  return { distance: Math.hypot(dx, dy), dx, dy, angle };
}

/** Formats a length with the drawing's precision and unit suffix. */
export function formatLength(value: number, precision: number, suffix: string): string {
  const text = value.toFixed(precision);
  return suffix ? `${text} ${suffix}` : text;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** Axis-aligned bounds of a note in drawing units, or null if degenerate. */
export function noteBounds(n: Note): { minX: number; minY: number; maxX: number; maxY: number } {
  switch (n.kind) {
    case 'rect':
    case 'ellipse':
      return {
        minX: Math.min(n.x, n.x + n.w),
        minY: Math.min(n.y, n.y + n.h),
        maxX: Math.max(n.x, n.x + n.w),
        maxY: Math.max(n.y, n.y + n.h),
      };
    case 'line':
    case 'arrow':
    case 'measure':
      return {
        minX: Math.min(n.x1, n.x2),
        minY: Math.min(n.y1, n.y2),
        maxX: Math.max(n.x1, n.x2),
        maxY: Math.max(n.y1, n.y2),
      };
    case 'brush':
    case 'highlighter': {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < n.points.length; i += 2) {
        const x = n.points[i];
        const y = n.points[i + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      return { minX, minY, maxX, maxY };
    }
    case 'text': {
      // Rough box; the renderer measures properly, this is only for hit-testing
      // and zoom-to-note, where an approximation is fine.
      const w = Math.max(1, n.text.length) * n.size * 0.6;
      return { minX: n.x, minY: n.y, maxX: n.x + w, maxY: n.y + n.size };
    }
  }
}
