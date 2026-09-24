/**
 * The flattened, render-ready form of a drawing.
 *
 * Geometry lives in parallel typed arrays rather than objects: a mid-size DWG
 * expands to hundreds of thousands of primitives, and an array-of-objects
 * representation costs both the structured-clone hop (worker -> host -> webview)
 * and the per-frame iteration in the renderer. Curves are kept as true arcs and
 * ellipses wherever possible so they stay smooth at any zoom; only geometry that
 * genuinely cannot be expressed that way (splines, non-uniformly scaled arcs) is
 * flattened into line segments at parse time.
 */

/** Colour sentinel meaning "inherit from the entity's layer". */
export const COLOR_BYLAYER = -1;

/** Lineweight sentinel meaning "inherit from the entity's layer". */
export const WEIGHT_BYLAYER = -1;

export interface SceneLayer {
  name: string;
  /** 0xRRGGBB resolved from the layer's ACI or true colour. */
  color: number;
  off: boolean;
  frozen: boolean;
  /** Lineweight in 1/100 mm, or -1 when the layer defers to the default. */
  weight: number;
}

export interface SceneText {
  x: number;
  y: number;
  /** Cap height in drawing units. */
  height: number;
  /** Rotation in radians, counter-clockwise. */
  rotation: number;
  text: string;
  /** 0 left, 1 center, 2 right. */
  halign: number;
  /** 0 baseline, 1 bottom, 2 middle, 3 top. */
  valign: number;
  /** Horizontal stretch factor (DXF group 41). */
  widthFactor: number;
  /** Oblique (italic slant) angle in radians. */
  oblique: number;
  layer: number;
  color: number;
}

export interface SceneBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bit flags for {@link Scene.polyFlags}. */
export const POLY_CLOSED = 1;
export const POLY_FILLED = 2;

export interface SceneUnits {
  /** AutoCAD INSUNITS code; 0 means unitless. */
  code: number;
  /** Short suffix for display, e.g. "mm"; empty when unitless. */
  suffix: string;
  /** Decimal places for distances, from the drawing's LUPREC. */
  precision: number;
}

/** INSUNITS codes to display suffixes, per the DXF header reference. */
const UNIT_SUFFIX: Record<number, string> = {
  1: 'in', 2: 'ft', 3: 'mi', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 8: 'µin', 9: 'mil',
  10: 'yd', 11: 'Å', 12: 'nm', 13: 'µm', 14: 'dm', 15: 'dam', 16: 'hm', 17: 'Gm',
  18: 'AU', 19: 'ly', 20: 'pc', 21: 'US ft', 22: 'US in', 23: 'US yd', 24: 'US mi',
};

export function makeUnits(insunits: unknown, luprec: unknown): SceneUnits {
  const code = typeof insunits === 'number' && Number.isInteger(insunits) ? insunits : 0;
  // AutoCAD allows 0..8 decimal places; 4 is its default.
  const precision =
    typeof luprec === 'number' && Number.isFinite(luprec) ? Math.min(8, Math.max(0, Math.round(luprec))) : 4;
  return { code, suffix: UNIT_SUFFIX[code] ?? '', precision };
}

export interface Scene {
  /** Interleaved x,y pairs for every polyline, concatenated. */
  polyCoords: Float64Array;
  /** Vertex-index boundaries into `polyCoords`; length is polyCount + 1. */
  polyOffsets: Uint32Array;
  polyLayer: Uint16Array;
  polyColor: Int32Array;
  polyFlags: Uint8Array;
  polyWeight: Int16Array;

  /** Groups of 5: cx, cy, radius, startAngle, endAngle (radians, CCW). */
  arcData: Float64Array;
  arcLayer: Uint16Array;
  arcColor: Int32Array;
  arcWeight: Int16Array;

  /** Groups of 7: cx, cy, rx, ry, tilt, startAngle, endAngle. */
  ellData: Float64Array;
  ellLayer: Uint16Array;
  ellColor: Int32Array;
  ellWeight: Int16Array;

  /** Interleaved x,y pairs. */
  ptCoords: Float64Array;
  ptLayer: Uint16Array;
  ptColor: Int32Array;

  texts: SceneText[];
  layers: SceneLayer[];
  bounds: SceneBounds;
  units: SceneUnits;
  stats: SceneStats;
}

export interface SceneStats {
  /** Format label, e.g. "AutoCAD 2018 (AC1032)". */
  format: string;
  /** Primitive counts after block expansion. */
  polylines: number;
  arcs: number;
  ellipses: number;
  points: number;
  texts: number;
  /** Entity types the builder had no renderer for, with counts. */
  skipped: Record<string, number>;
  /** True when the render cap was hit and geometry was dropped. */
  truncated: boolean;
  /** Milliseconds spent decoding and flattening. */
  parseMs: number;
}

/** Every typed array in a scene, for use as structured-clone transferables. */
export function sceneTransferables(scene: Scene): ArrayBuffer[] {
  return [
    scene.polyCoords.buffer,
    scene.polyOffsets.buffer,
    scene.polyLayer.buffer,
    scene.polyColor.buffer,
    scene.polyFlags.buffer,
    scene.polyWeight.buffer,
    scene.arcData.buffer,
    scene.arcLayer.buffer,
    scene.arcColor.buffer,
    scene.arcWeight.buffer,
    scene.ellData.buffer,
    scene.ellLayer.buffer,
    scene.ellColor.buffer,
    scene.ellWeight.buffer,
    scene.ptCoords.buffer,
    scene.ptLayer.buffer,
    scene.ptColor.buffer,
  ] as ArrayBuffer[];
}
