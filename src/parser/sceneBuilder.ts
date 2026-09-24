/**
 * Flattens a {@link Doc} into a render-ready {@link Scene}.
 *
 * This is where block references are expanded, OCS coordinates are lifted into
 * world space, and curves are either preserved as true arcs or tessellated.
 */

import {
  makeUnits,
  COLOR_BYLAYER,
  POLY_CLOSED,
  POLY_FILLED,
  Scene,
  SceneLayer,
  SceneText,
  WEIGHT_BYLAYER,
} from '../common/scene';
import { aciToRgb, resolveEntityColor } from './colors';
import { Doc, DocEntity, findBlock, P3 } from './doc';
import {
  bulgeToArc,
  IDENTITY,
  isConformal,
  Mat,
  matFrom,
  matMirrors,
  matMul,
  matRotation,
  matScale,
  ocsToWcs,
  Pt3,
  sweepCcw,
  tessellateArc,
  tessellateFitPoints,
  tessellateNurbs,
} from './geom';

export interface BuildOptions {
  darkBackground: boolean;
  maxEntities: number;
  showText: boolean;
  curveResolution: number;
}

/** Entity types that are intentionally not drawn, so they are not reported as gaps. */
const IGNORED = new Set([
  'VIEWPORT', // Paper-space plumbing, meaningless in a model-space view.
  'ATTDEF', // A prompt template; only the ATTRIB instances carry real values.
  'SEQEND',
  'VERTEX',
  'BLOCK',
  'ENDBLK',
  'DICTIONARY',
  'LAYOUT',
]);

/** Recursion guard for blocks that reference themselves, directly or otherwise. */
const MAX_BLOCK_DEPTH = 16;

/** A growable Float64Array that avoids the cost of a plain number[] for coordinates. */
class F64 {
  private buf: Float64Array;
  length = 0;

  constructor(initial = 4096) {
    this.buf = new Float64Array(initial);
  }

  push2(a: number, b: number): void {
    if (this.length + 2 > this.buf.length) this.grow(this.length + 2);
    this.buf[this.length++] = a;
    this.buf[this.length++] = b;
  }

  pushN(values: ArrayLike<number>, count = values.length): void {
    if (this.length + count > this.buf.length) this.grow(this.length + count);
    for (let i = 0; i < count; i++) this.buf[this.length++] = values[i];
  }

  private grow(min: number): void {
    let cap = this.buf.length * 2 || 1024;
    while (cap < min) cap *= 2;
    const next = new Float64Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  finish(): Float64Array {
    return this.buf.slice(0, this.length);
  }
}

interface Ctx {
  /** Accumulated block transform from model space down to this entity. */
  mat: Mat;
  /** Colour an entity resolves to when its colour is BYBLOCK. */
  blockColor: number;
  /** Layer an entity on layer "0" inherits from the enclosing block reference. */
  blockLayer: string;
  depth: number;
}

class SceneBuilder {
  private polyCoords = new F64(1 << 16);
  private polyOffsets: number[] = [0];
  private polyLayer: number[] = [];
  private polyColor: number[] = [];
  private polyFlags: number[] = [];
  private polyWeight: number[] = [];

  private arcData = new F64(1024);
  private arcLayer: number[] = [];
  private arcColor: number[] = [];
  private arcWeight: number[] = [];

  private ellData = new F64(256);
  private ellLayer: number[] = [];
  private ellColor: number[] = [];
  private ellWeight: number[] = [];

  private ptCoords = new F64(256);
  private ptLayer: number[] = [];
  private ptColor: number[] = [];

  private texts: SceneText[] = [];

  private layers: SceneLayer[] = [];
  private layerIndex = new Map<string, number>();

  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  private skipped: Record<string, number> = {};
  private primitives = 0;
  private truncated = false;

  constructor(private doc: Doc, private opts: BuildOptions) {
    for (const l of doc.layers) {
      const color =
        typeof l.color === 'number' && l.color > 0 && l.color <= 0xffffff
          ? l.color
          : aciToRgb(l.colorIndex ?? 7, opts.darkBackground);
      this.layerIndex.set(l.name.toUpperCase(), this.layers.length);
      this.layers.push({
        name: l.name,
        color,
        off: l.off === true || (l.colorIndex ?? 1) < 0,
        frozen: l.frozen === true,
        weight: typeof l.lineweight === 'number' ? l.lineweight : WEIGHT_BYLAYER,
      });
    }
    // Every drawing has layer "0"; synthesise it if the tables were incomplete.
    if (!this.layerIndex.has('0')) {
      this.layerIndex.set('0', this.layers.length);
      this.layers.push({
        name: '0',
        color: aciToRgb(7, opts.darkBackground),
        off: false,
        frozen: false,
        weight: WEIGHT_BYLAYER,
      });
    }
  }

  build(): Scene {
    const root: Ctx = { mat: IDENTITY, blockColor: 0xffffff, blockLayer: '0', depth: 0 };
    for (const e of this.doc.entities) this.emit(e, root);

    // A drawing containing nothing measurable still needs a usable view box.
    if (!Number.isFinite(this.minX)) {
      this.minX = 0;
      this.minY = 0;
      this.maxX = 1;
      this.maxY = 1;
    }

    return {
      polyCoords: this.polyCoords.finish(),
      polyOffsets: Uint32Array.from(this.polyOffsets),
      polyLayer: Uint16Array.from(this.polyLayer),
      polyColor: Int32Array.from(this.polyColor),
      polyFlags: Uint8Array.from(this.polyFlags),
      polyWeight: Int16Array.from(this.polyWeight),
      arcData: this.arcData.finish(),
      arcLayer: Uint16Array.from(this.arcLayer),
      arcColor: Int32Array.from(this.arcColor),
      arcWeight: Int16Array.from(this.arcWeight),
      ellData: this.ellData.finish(),
      ellLayer: Uint16Array.from(this.ellLayer),
      ellColor: Int32Array.from(this.ellColor),
      ellWeight: Int16Array.from(this.ellWeight),
      ptCoords: this.ptCoords.finish(),
      ptLayer: Uint16Array.from(this.ptLayer),
      ptColor: Int32Array.from(this.ptColor),
      texts: this.texts,
      layers: this.layers,
      bounds: { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY },
      // libredwg exposes header variables without the "$" that DXF uses.
      units: makeUnits(
        this.doc.header.INSUNITS ?? this.doc.header.$INSUNITS,
        this.doc.header.LUPREC ?? this.doc.header.$LUPREC
      ),
      stats: {
        format: this.doc.format,
        polylines: this.polyLayer.length,
        arcs: this.arcLayer.length,
        ellipses: this.ellLayer.length,
        points: this.ptLayer.length,
        texts: this.texts.length,
        skipped: this.skipped,
        truncated: this.truncated,
        parseMs: 0,
      },
    };
  }

  // ---------------------------------------------------------------- dispatch

  private emit(e: DocEntity, ctx: Ctx): void {
    if (this.primitives >= this.opts.maxEntities) {
      this.truncated = true;
      return;
    }
    if (e.isVisible === false) return;

    const type = e.type;
    if (IGNORED.has(type)) return;

    switch (type) {
      case 'LINE':
        return this.line(e, ctx);
      case 'LWPOLYLINE':
        return this.lwPolyline(e, ctx);
      case 'POLYLINE2D':
        return this.polyline2d(e, ctx);
      case 'POLYLINE3D':
      case 'POLYLINE_3D':
        return this.polyline3d(e, ctx);
      case 'CIRCLE':
        return this.circle(e, ctx);
      case 'ARC':
        return this.arc(e, ctx);
      case 'ELLIPSE':
        return this.ellipse(e, ctx);
      case 'POINT':
        return this.point(e, ctx);
      case 'SPLINE':
        return this.spline(e, ctx);
      case 'SOLID':
      case 'TRACE':
        return this.solid(e, ctx);
      case '3DFACE':
        return this.face3d(e, ctx);
      case 'TEXT':
        return this.text(e, ctx);
      case 'MTEXT':
        return this.mtext(e, ctx);
      case 'ATTRIB':
        return this.attrib(e, ctx);
      case 'INSERT':
        return this.insert(e, ctx);
      case 'DIMENSION':
      case 'ARC_DIMENSION':
        return this.dimension(e, ctx);
      case 'HATCH':
        return this.hatch(e, ctx);
      case 'LEADER':
        return this.leader(e, ctx);
      case 'MLINE':
        return this.mline(e, ctx);
      case 'XLINE':
      case 'RAY':
        return this.infiniteLine(e, ctx, type === 'RAY');
      default:
        this.skipped[type] = (this.skipped[type] || 0) + 1;
    }
  }

  // ------------------------------------------------------------ emit helpers

  private layerOf(e: DocEntity, ctx: Ctx): number {
    // Entities drawn on layer "0" inside a block adopt the block reference's layer.
    let name = typeof e.layer === 'string' && e.layer ? e.layer : '0';
    if (ctx.depth > 0 && name === '0') name = ctx.blockLayer;

    const key = name.toUpperCase();
    let idx = this.layerIndex.get(key);
    if (idx === undefined) {
      // Referenced but absent from the LAYER table; synthesise it so the layer
      // panel still lists it and the geometry remains toggleable.
      idx = this.layers.length;
      this.layerIndex.set(key, idx);
      this.layers.push({
        name,
        color: aciToRgb(7, this.opts.darkBackground),
        off: false,
        frozen: false,
        weight: WEIGHT_BYLAYER,
      });
    }
    return idx;
  }

  private colorOf(e: DocEntity, ctx: Ctx): number {
    return resolveEntityColor(e, this.opts.darkBackground, ctx.blockColor);
  }

  private weightOf(e: DocEntity): number {
    const w = e.lineweight;
    if (typeof w !== 'number' || w < 0) return WEIGHT_BYLAYER;
    return Math.min(2000, w);
  }

  private track(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }

  /** Applies a block transform to a world-space point. */
  private xf(m: Mat, x: number, y: number): [number, number] {
    return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
  }

  /**
   * Adds a polyline from flat world-space x,y pairs.
   * @param countsToBounds set false for infinite construction lines, whose
   *        synthetic endpoints must not drag the drawing extents outwards.
   */
  private addPoly(
    pts: ArrayLike<number>,
    e: DocEntity,
    ctx: Ctx,
    closed: boolean,
    filled = false,
    countsToBounds = true
  ): void {
    const n = pts.length >> 1;
    if (n < 2) return;

    this.polyCoords.pushN(pts, n * 2);
    this.polyOffsets.push(this.polyCoords.length >> 1);
    this.polyLayer.push(this.layerOf(e, ctx));
    this.polyColor.push(this.colorOf(e, ctx));
    this.polyFlags.push((closed ? POLY_CLOSED : 0) | (filled ? POLY_FILLED : 0));
    this.polyWeight.push(this.weightOf(e));
    this.primitives++;

    if (countsToBounds) {
      for (let i = 0; i < n * 2; i += 2) this.track(pts[i], pts[i + 1]);
    }
  }

  private addArc(
    cx: number,
    cy: number,
    r: number,
    a0: number,
    a1: number,
    e: DocEntity,
    ctx: Ctx
  ): void {
    if (!(r > 0) || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
    this.arcData.pushN([cx, cy, r, a0, a1], 5);
    this.arcLayer.push(this.layerOf(e, ctx));
    this.arcColor.push(this.colorOf(e, ctx));
    this.arcWeight.push(this.weightOf(e));
    this.primitives++;

    // Bounding an arc exactly means testing which axis extremes the sweep covers.
    const sweep = sweepCcw(a0, a1);
    this.track(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
    this.track(cx + r * Math.cos(a1), cy + r * Math.sin(a1));
    for (let k = 0; k < 4; k++) {
      const axis = (k * Math.PI) / 2;
      // Does `axis` lie inside the CCW sweep starting at a0?
      let delta = axis - a0;
      while (delta < 0) delta += Math.PI * 2;
      if (delta <= sweep) this.track(cx + r * Math.cos(axis), cy + r * Math.sin(axis));
    }
  }

  private addEllipse(
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    tilt: number,
    a0: number,
    a1: number,
    e: DocEntity,
    ctx: Ctx
  ): void {
    if (!(rx > 0) || !(ry > 0)) return;
    this.ellData.pushN([cx, cy, rx, ry, tilt, a0, a1], 7);
    this.ellLayer.push(this.layerOf(e, ctx));
    this.ellColor.push(this.colorOf(e, ctx));
    this.ellWeight.push(this.weightOf(e));
    this.primitives++;

    // Conservative bound: the enclosing circle of the major axis.
    const r = Math.max(rx, ry);
    this.track(cx - r, cy - r);
    this.track(cx + r, cy + r);
  }

  // ------------------------------------------------------- simple geometry

  private line(e: DocEntity, ctx: Ctx): void {
    const s = e.startPoint as P3 | undefined;
    const t = e.endPoint as P3 | undefined;
    if (!s || !t) return;
    // LINE endpoints are world-space per the DXF spec, so only the block
    // transform applies.
    const [x1, y1] = this.xf(ctx.mat, s.x, s.y);
    const [x2, y2] = this.xf(ctx.mat, t.x, t.y);
    this.addPoly([x1, y1, x2, y2], e, ctx, false);
  }

  /** Infinite construction lines, clipped to a long but finite segment. */
  private infiniteLine(e: DocEntity, ctx: Ctx, isRay: boolean): void {
    const p = (e.firstPoint || e.startPoint || e.basePoint) as P3 | undefined;
    // libredwg calls this `unitDirection`; the DXF reader maps group 11 to
    // `unitDirectionVector`. Accept either rather than silently dropping the
    // entity when only one spelling is present.
    const d = (e.unitDirection || e.unitDirectionVector || e.direction) as P3 | undefined;
    if (!p || !d) return;
    const len = Math.hypot(d.x, d.y) || 1;
    // Long enough to read as infinite at any sane zoom, short enough not to
    // wreck floating-point precision in the renderer.
    const K = 1e7 / len;
    const ax = isRay ? p.x : p.x - d.x * K;
    const ay = isRay ? p.y : p.y - d.y * K;
    const [x1, y1] = this.xf(ctx.mat, ax, ay);
    const [x2, y2] = this.xf(ctx.mat, p.x + d.x * K, p.y + d.y * K);
    // Excluded from bounds: otherwise zoom-to-extents would frame empty space.
    this.addPoly([x1, y1, x2, y2], e, ctx, false, false, false);
  }

  private circle(e: DocEntity, ctx: Ctx): void {
    const c = e.center as P3 | undefined;
    const r = e.radius as number;
    if (!c || !(r > 0)) return;
    this.emitCircular(e, ctx, c, r, 0, Math.PI * 2, true);
  }

  private arc(e: DocEntity, ctx: Ctx): void {
    const c = e.center as P3 | undefined;
    const r = e.radius as number;
    if (!c || !(r > 0)) return;
    // libredwg reports arc angles in radians, always sweeping counter-clockwise
    // from start to end in the entity's own OCS.
    this.emitCircular(e, ctx, c, r, (e.startAngle as number) || 0, (e.endAngle as number) || 0, false);
  }

  /**
   * Emits a circle or arc, preserving it as a true arc when the combined
   * OCS + block transform keeps it circular, and tessellating when it does not.
   */
  private emitCircular(
    e: DocEntity,
    ctx: Ctx,
    center: P3,
    radius: number,
    a0: number,
    a1: number,
    full: boolean
  ): void {
    const ocs = ocsToWcs(e.extrusionDirection as Pt3 | undefined);
    const conformal = isConformal(ctx.mat);

    if (!ocs && conformal) {
      const [cx, cy] = this.xf(ctx.mat, center.x, center.y);
      const scale = matScale(ctx.mat);
      const rot = matRotation(ctx.mat);
      if (matMirrors(ctx.mat)) {
        // A mirrored transform reverses the sweep direction; reflect the angles
        // about the mirror axis and swap them so the arc still runs CCW.
        const m = 2 * rot;
        this.addArc(cx, cy, radius * scale, m - a1, m - a0, e, ctx);
      } else {
        this.addArc(cx, cy, radius * scale, a0 + rot, a1 + rot, e, ctx);
      }
      return;
    }

    // General case: walk the curve in its own coordinate system and push every
    // sample through the full transform chain.
    const flat: number[] = [];
    const segs = this.opts.curveResolution;
    const raw: number[] = [];
    tessellateArc(raw, center.x, center.y, radius, a0, full ? a0 + Math.PI * 2 : a1, true, segs, true);
    for (let i = 0; i < raw.length; i += 2) {
      let x = raw[i];
      let y = raw[i + 1];
      let z = center.z ?? 0;
      if (ocs) {
        const w = ocs({ x, y, z });
        x = w.x;
        y = w.y;
        z = w.z;
      }
      const [tx, ty] = this.xf(ctx.mat, x, y);
      flat.push(tx, ty);
    }
    this.addPoly(flat, e, ctx, full);
  }

  private ellipse(e: DocEntity, ctx: Ctx): void {
    const c = e.center as P3 | undefined;
    const major = e.majorAxisEndPoint as P3 | undefined;
    if (!c || !major) return;

    const ratio = (e.axisRatio as number) ?? 1;
    const rx = Math.hypot(major.x, major.y);
    const ry = rx * ratio;
    const tilt = Math.atan2(major.y, major.x);
    const a0 = (e.startAngle as number) ?? 0;
    const a1 = (e.endAngle as number) ?? Math.PI * 2;
    const ocs = ocsToWcs(e.extrusionDirection as Pt3 | undefined);

    if (!ocs && isConformal(ctx.mat)) {
      const [cx, cy] = this.xf(ctx.mat, c.x, c.y);
      const s = matScale(ctx.mat);
      const rot = matRotation(ctx.mat);
      const mirror = matMirrors(ctx.mat);
      if (mirror) {
        this.addEllipse(cx, cy, rx * s, ry * s, 2 * rot - tilt, -a1, -a0, e, ctx);
      } else {
        this.addEllipse(cx, cy, rx * s, ry * s, tilt + rot, a0, a1, e, ctx);
      }
      return;
    }

    // Non-conformal or tilted out of plane: sample the parametric ellipse.
    const segs = this.opts.curveResolution;
    let sweep = a1 - a0;
    while (sweep <= 0) sweep += Math.PI * 2;
    const steps = Math.max(8, Math.ceil((segs * sweep) / (Math.PI * 2)));
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    const flat: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = a0 + (sweep * i) / steps;
      const ex = rx * Math.cos(t);
      const ey = ry * Math.sin(t);
      let x = c.x + ex * cos - ey * sin;
      let y = c.y + ex * sin + ey * cos;
      let z = c.z ?? 0;
      if (ocs) {
        const w = ocs({ x, y, z });
        x = w.x;
        y = w.y;
        z = w.z;
      }
      const [tx, ty] = this.xf(ctx.mat, x, y);
      flat.push(tx, ty);
    }
    this.addPoly(flat, e, ctx, Math.abs(sweep - Math.PI * 2) < 1e-9);
  }

  private point(e: DocEntity, ctx: Ctx): void {
    const p = e.position as P3 | undefined;
    if (!p) return;
    const ocs = ocsToWcs(e.extrusionDirection as Pt3 | undefined);
    const w = ocs ? ocs({ x: p.x, y: p.y, z: p.z ?? 0 }) : { x: p.x, y: p.y };
    const [x, y] = this.xf(ctx.mat, w.x, w.y);
    this.ptCoords.push2(x, y);
    this.ptLayer.push(this.layerOf(e, ctx));
    this.ptColor.push(this.colorOf(e, ctx));
    this.primitives++;
    this.track(x, y);
  }

  // ----------------------------------------------------------- polylines

  /**
   * Shared vertex walker for LWPOLYLINE and 2D POLYLINE.
   * Both store OCS vertices with optional bulges describing arc segments.
   */
  private emitOcsPolyline(
    e: DocEntity,
    ctx: Ctx,
    verts: { x: number; y: number; bulge?: number }[],
    closed: boolean,
    elevation: number
  ): void {
    if (verts.length < 2) {
      if (verts.length === 1) return;
      return;
    }

    const ocs = ocsToWcs(e.extrusionDirection as Pt3 | undefined);
    const flat: number[] = [];

    // Polylines with thousands of bulged vertices are real — a digitised contour
    // can carry an arc on every segment. Giving each one full curve resolution
    // would turn one entity into hundreds of thousands of points, so the budget
    // is shared out: few arcs keep full fidelity, pathological ones degrade
    // gracefully instead of exhausting memory.
    const VERTEX_BUDGET = 8000;
    let bulgeCount = 0;
    for (const v of verts) if (v.bulge) bulgeCount++;
    const segs =
      bulgeCount > 0
        ? Math.max(4, Math.min(this.opts.curveResolution, Math.floor(VERTEX_BUDGET / bulgeCount)))
        : this.opts.curveResolution;

    const push = (x: number, y: number) => {
      let px = x;
      let py = y;
      if (ocs) {
        const w = ocs({ x, y, z: elevation });
        px = w.x;
        py = w.y;
      }
      const [tx, ty] = this.xf(ctx.mat, px, py);
      flat.push(tx, ty);
    };

    const last = closed ? verts.length : verts.length - 1;
    push(verts[0].x, verts[0].y);
    for (let i = 0; i < last; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % verts.length];
      const bulge = a.bulge ?? 0;
      if (bulge) {
        const arc = bulgeToArc(a.x, a.y, b.x, b.y, bulge);
        if (arc) {
          const raw: number[] = [];
          tessellateArc(raw, arc.cx, arc.cy, arc.r, arc.a0, arc.a1, arc.ccw, segs, false);
          for (let k = 0; k < raw.length; k += 2) push(raw[k], raw[k + 1]);
          continue;
        }
      }
      push(b.x, b.y);
    }

    // For a closed run the final push duplicates vertex 0; the renderer closes
    // the path itself, so drop the repeat.
    if (closed && flat.length >= 4) {
      flat.length -= 2;
    }
    this.addPoly(flat, e, ctx, closed);
  }

  private lwPolyline(e: DocEntity, ctx: Ctx): void {
    const verts = e.vertices as { x: number; y: number; bulge?: number }[] | undefined;
    if (!verts?.length) return;
    const closed = (((e.flag as number) ?? 0) & 1) !== 0;
    this.emitOcsPolyline(e, ctx, verts, closed, (e.elevation as number) ?? 0);
  }

  private polyline2d(e: DocEntity, ctx: Ctx): void {
    const verts = e.vertices as { x: number; y: number; bulge?: number }[] | undefined;
    if (!verts?.length) return;
    const flag = (e.flag as number) ?? 0;
    // Bit 64 marks a polyface mesh, whose vertices are indices rather than a path.
    if (flag & 64) {
      this.skipped['POLYLINE(polyface)'] = (this.skipped['POLYLINE(polyface)'] || 0) + 1;
      return;
    }
    this.emitOcsPolyline(e, ctx, verts, (flag & 1) !== 0, (e.elevation as number) ?? 0);
  }

  private polyline3d(e: DocEntity, ctx: Ctx): void {
    const verts = e.vertices as P3[] | undefined;
    if (!verts?.length) return;
    const flat: number[] = [];
    for (const v of verts) {
      const [x, y] = this.xf(ctx.mat, v.x, v.y);
      flat.push(x, y);
    }
    this.addPoly(flat, e, ctx, (((e.flag as number) ?? 0) & 1) !== 0);
  }

  private spline(e: DocEntity, ctx: Ctx): void {
    const cps = (e.controlPoints as P3[] | undefined) ?? [];
    const fps = (e.fitPoints as P3[] | undefined) ?? [];
    const flag = (e.flag as number) ?? 0;
    const closed = (flag & 1) !== 0;
    const segs = this.opts.curveResolution;

    let flat: number[];
    if (cps.length >= 2) {
      flat = tessellateNurbs(
        cps,
        (e.degree as number) ?? 3,
        e.knots as number[] | undefined,
        e.weights as number[] | undefined,
        Math.max(segs, cps.length * 4),
        closed
      );
    } else if (fps.length >= 2) {
      // Fit-point splines carry no control net; interpolate through the points.
      flat = tessellateFitPoints(fps, Math.max(4, Math.round(segs / 8)), closed);
    } else {
      return;
    }

    for (let i = 0; i < flat.length; i += 2) {
      const [x, y] = this.xf(ctx.mat, flat[i], flat[i + 1]);
      flat[i] = x;
      flat[i + 1] = y;
    }
    this.addPoly(flat, e, ctx, false);
  }

  private solid(e: DocEntity, ctx: Ctx): void {
    const c1 = e.corner1 as P3 | undefined;
    const c2 = e.corner2 as P3 | undefined;
    const c3 = e.corner3 as P3 | undefined;
    const c4 = (e.corner4 as P3 | undefined) ?? c3;
    if (!c1 || !c2 || !c3 || !c4) return;

    const ocs = ocsToWcs(e.extrusionDirection as Pt3 | undefined);
    const flat: number[] = [];
    // SOLID stores corners in "Z" order: 1-2-4-3 walks the outline.
    for (const c of [c1, c2, c4, c3]) {
      let x = c.x;
      let y = c.y;
      if (ocs) {
        const w = ocs({ x, y, z: c.z ?? 0 });
        x = w.x;
        y = w.y;
      }
      const [tx, ty] = this.xf(ctx.mat, x, y);
      flat.push(tx, ty);
    }
    this.addPoly(flat, e, ctx, true, true);
  }

  private face3d(e: DocEntity, ctx: Ctx): void {
    const corners = [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean) as P3[];
    if (corners.length < 3) return;
    const flat: number[] = [];
    for (const c of corners) {
      const [x, y] = this.xf(ctx.mat, c.x, c.y);
      flat.push(x, y);
    }
    // 3DFACE is a wireframe face; edges flagged invisible are still drawn here
    // because hiding them needs a depth-sorted 3D pass this viewer does not do.
    this.addPoly(flat, e, ctx, true);
  }

  // --------------------------------------------------------------- text

  private text(e: DocEntity, ctx: Ctx): void {
    if (!this.opts.showText) return;
    this.emitText(e, ctx, e as unknown as TextLike);
  }

  private attrib(e: DocEntity, ctx: Ctx): void {
    if (!this.opts.showText) return;
    // An invisible attribute (flag bit 1) is data, not annotation.
    if ((((e.flags as number) ?? 0) & 1) !== 0) return;
    // libredwg nests the text payload; DXF keeps it flat on the entity.
    const t = (e.text && typeof e.text === 'object' ? e.text : e) as TextLike;
    this.emitText(e, ctx, t);
  }

  private emitText(e: DocEntity, ctx: Ctx, t: TextLike): void {
    const raw = typeof t.text === 'string' ? t.text : '';
    if (!raw) return;

    const halign = t.halign ?? 0;
    const valign = t.valign ?? 0;
    // Aligned (3), Middle (4) and Fit (5) position from the second alignment
    // point; the others use the first.
    const useEnd = (halign === 3 || halign === 4 || halign === 5) && t.endPoint;
    const src = (useEnd ? t.endPoint : t.startPoint) as P3 | undefined;
    if (!src) return;

    const ocs = ocsToWcs(t.extrusionDirection as Pt3 | undefined);
    let x = src.x;
    let y = src.y;
    if (ocs) {
      const w = ocs({ x, y, z: src.z ?? 0 });
      x = w.x;
      y = w.y;
    }
    const [tx, ty] = this.xf(ctx.mat, x, y);

    const scale = matScale(ctx.mat) || 1;
    const height = (t.textHeight ?? 1) * scale;
    if (!(height > 0)) return;

    this.texts.push({
      x: tx,
      y: ty,
      height,
      rotation: (t.rotation ?? 0) + matRotation(ctx.mat),
      text: raw,
      // Aligned/Fit/Middle all centre horizontally once positioned from endPoint.
      halign: halign === 4 ? 1 : halign > 2 ? 1 : halign,
      valign: valign ?? 0,
      widthFactor: t.xScale && t.xScale > 0 ? t.xScale : 1,
      oblique: t.obliqueAngle ?? 0,
      layer: this.layerOf(e, ctx),
      color: this.colorOf(e, ctx),
    });
    this.primitives++;

    // Approximate extents so text alone still produces a sensible zoom target.
    const w = raw.length * height * 0.6;
    this.track(tx, ty);
    this.track(tx + w, ty + height);
  }

  private mtext(e: DocEntity, ctx: Ctx): void {
    if (!this.opts.showText) return;
    const ins = e.insertionPoint as P3 | undefined;
    if (!ins) return;
    const raw = typeof e.text === 'string' ? e.text : '';
    if (!raw) return;

    const lines = decodeMText(raw);
    if (!lines.length) return;

    const ocs = ocsToWcs(e.extrusionDirection as Pt3 | undefined);
    let x = ins.x;
    let y = ins.y;
    if (ocs) {
      const w = ocs({ x, y, z: ins.z ?? 0 });
      x = w.x;
      y = w.y;
    }

    const scale = matScale(ctx.mat) || 1;
    const height = ((e.textHeight as number) ?? 1) * scale;
    if (!(height > 0)) return;

    // Attachment point 1..9 maps to a 3x3 grid, top-left through bottom-right.
    const ap = ((e.attachmentPoint as number) ?? 1) - 1;
    const col = ap % 3; // 0 left, 1 centre, 2 right
    const row = Math.floor(ap / 3); // 0 top, 1 middle, 2 bottom

    // MTEXT rotation can come from an explicit angle or an X-axis direction vector.
    const dir = e.direction as P3 | undefined;
    const rotation =
      dir && (dir.x || dir.y)
        ? Math.atan2(dir.y, dir.x)
        : ((e.rotation as number) ?? 0);
    const total = rotation + matRotation(ctx.mat);

    const lineStep = height * 1.6 * (((e.lineSpacing as number) || 1) || 1);
    // Shift the whole block so the anchor lands on the requested attachment row.
    const blockHeight = lineStep * (lines.length - 1);
    const yStart = row === 0 ? 0 : row === 1 ? blockHeight / 2 : blockHeight;

    const cos = Math.cos(total);
    const sin = Math.sin(total);
    const layer = this.layerOf(e, ctx);
    const color = this.colorOf(e, ctx);

    for (let i = 0; i < lines.length; i++) {
      // Offset down the text's own local Y axis, then rotate into world space.
      const dy = yStart - i * lineStep;
      const lx = x + -sin * dy;
      const ly = y + cos * dy;
      const [tx, ty] = this.xf(ctx.mat, lx, ly);
      this.texts.push({
        x: tx,
        y: ty,
        height,
        rotation: total,
        text: lines[i],
        halign: col,
        // Anchor each line on its baseline-ish bottom edge.
        valign: 1,
        widthFactor: 1,
        oblique: 0,
        layer,
        color,
      });
      this.primitives++;
      this.track(tx, ty);
      this.track(tx + lines[i].length * height * 0.6, ty + height);
    }
  }

  // -------------------------------------------------------------- blocks

  private insert(e: DocEntity, ctx: Ctx): void {
    if (ctx.depth >= MAX_BLOCK_DEPTH) return;
    const block = findBlock(this.doc, e.name as string);

    // Attributes are stored on the INSERT and drawn regardless of the block body.
    const attribs = (e.attribs as DocEntity[] | undefined) ?? [];

    if (!block) {
      if (e.name) {
        const key = `INSERT(missing block ${String(e.name)})`;
        this.skipped[key] = (this.skipped[key] || 0) + 1;
      }
      for (const a of attribs) this.emit(a, ctx);
      return;
    }

    const ins = (e.insertionPoint as P3 | undefined) ?? { x: 0, y: 0, z: 0 };
    let sx = (e.xScale as number) ?? 1;
    const sy = (e.yScale as number) ?? 1;
    const rot = (e.rotation as number) ?? 0;

    // A (0,0,-1) extrusion on an INSERT mirrors the block across the Y axis.
    const normal = e.extrusionDirection as Pt3 | undefined;
    let ix = ins.x;
    if (normal && Math.abs(normal.x) < 1e-12 && Math.abs(normal.y) < 1e-12 && normal.z < 0) {
      sx = -sx;
      ix = -ix;
    }

    // Arrays: AutoCAD writes 0 for "not an array", which must behave as 1.
    const cols = Math.max(1, (e.columnCount as number) || 1);
    const rows = Math.max(1, (e.rowCount as number) || 1);
    const colSpacing = (e.columnSpacing as number) || 0;
    const rowSpacing = (e.rowSpacing as number) || 0;

    const base = block.basePoint ?? { x: 0, y: 0, z: 0 };
    const blockColor =
      ctx.blockColor === undefined ? 0xffffff : this.colorOf(e, ctx);
    const resolvedBlockColor =
      blockColor === COLOR_BYLAYER ? this.layers[this.layerOf(e, ctx)].color : blockColor;
    const blockLayer =
      typeof e.layer === 'string' && e.layer ? e.layer : ctx.blockLayer;

    const cos = Math.cos(rot);
    const sin = Math.sin(rot);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (this.primitives >= this.opts.maxEntities) {
          this.truncated = true;
          return;
        }
        // Array offsets are applied in the block's rotated frame.
        const ox = c * colSpacing;
        const oy = r * rowSpacing;
        const tx = ix + ox * cos - oy * sin;
        const ty = ins.y + ox * sin + oy * cos;

        // Translate the block's base point to the origin before scaling/rotating.
        const local = matMul(matFrom(tx, ty, sx, sy, rot), {
          a: 1,
          b: 0,
          c: 0,
          d: 1,
          e: -base.x,
          f: -base.y,
        });
        const child: Ctx = {
          mat: matMul(ctx.mat, local),
          blockColor: resolvedBlockColor,
          blockLayer,
          depth: ctx.depth + 1,
        };
        for (const be of block.entities) this.emit(be, child);
      }
    }

    for (const a of attribs) this.emit(a, ctx);
  }

  /**
   * Dimensions carry their rendered geometry in an anonymous block (e.g. "*D3"),
   * which is exactly what AutoCAD draws, so expanding it reproduces the arrows,
   * extension lines and measurement text without re-implementing dimension styles.
   */
  private dimension(e: DocEntity, ctx: Ctx): void {
    if (ctx.depth >= MAX_BLOCK_DEPTH) return;
    const block = findBlock(this.doc, e.name as string);
    if (!block) {
      this.skipped['DIMENSION(no block)'] = (this.skipped['DIMENSION(no block)'] || 0) + 1;
      return;
    }
    const color = this.colorOf(e, ctx);
    const child: Ctx = {
      mat: ctx.mat,
      blockColor: color === COLOR_BYLAYER ? this.layers[this.layerOf(e, ctx)].color : color,
      blockLayer: typeof e.layer === 'string' && e.layer ? e.layer : ctx.blockLayer,
      depth: ctx.depth + 1,
    };
    for (const be of block.entities) this.emit(be, child);
  }

  // --------------------------------------------------------------- hatch

  private hatch(e: DocEntity, ctx: Ctx): void {
    const paths = e.boundaryPaths as HatchPath[] | undefined;
    if (!paths?.length) return;
    const solid = (e.solidFill as number) === 1;
    const segs = this.opts.curveResolution;

    for (const path of paths) {
      // Derived paths duplicate an existing entity's geometry; drawing them
      // would double-strike lines already in the drawing.
      if ((path.boundaryPathTypeFlag ?? 0) & 4) continue;

      const flat: number[] = [];
      if ('vertices' in path && Array.isArray(path.vertices)) {
        const verts = path.vertices;
        const closed = path.isClosed !== false;
        const last = closed ? verts.length : verts.length - 1;
        if (verts.length) flat.push(verts[0].x, verts[0].y);
        for (let i = 0; i < last; i++) {
          const a = verts[i];
          const b = verts[(i + 1) % verts.length];
          const arc = a.bulge ? bulgeToArc(a.x, a.y, b.x, b.y, a.bulge) : null;
          if (arc) {
            tessellateArc(flat, arc.cx, arc.cy, arc.r, arc.a0, arc.a1, arc.ccw, segs, false);
          } else {
            flat.push(b.x, b.y);
          }
        }
      } else if ('edges' in path && Array.isArray(path.edges)) {
        for (const edge of path.edges) this.hatchEdge(edge, flat, segs);
      }

      if (flat.length < 4) continue;
      for (let i = 0; i < flat.length; i += 2) {
        const [x, y] = this.xf(ctx.mat, flat[i], flat[i + 1]);
        flat[i] = x;
        flat[i + 1] = y;
      }
      // Pattern fills are drawn as outlines: reproducing the .pat line families
      // faithfully is a separate feature, and a wrong fill reads worse than none.
      this.addPoly(flat, e, ctx, true, solid);
    }
  }

  private hatchEdge(edge: HatchEdge, out: number[], segs: number): void {
    switch (edge.type) {
      case 1: {
        // Line
        const s = edge.start;
        const t = edge.end;
        if (!s || !t) return;
        if (out.length === 0) out.push(s.x, s.y);
        out.push(t.x, t.y);
        return;
      }
      case 2: {
        // Circular arc
        const c = edge.center;
        if (!c || !edge.radius) return;
        const ccw = edge.isCCW !== false;
        tessellateArc(
          out,
          c.x,
          c.y,
          edge.radius,
          edge.startAngle ?? 0,
          edge.endAngle ?? Math.PI * 2,
          ccw,
          segs,
          out.length === 0
        );
        return;
      }
      case 3: {
        // Elliptic arc; `end` is the major-axis vector from the centre.
        const c = edge.center;
        const maj = edge.end;
        if (!c || !maj) return;
        const rx = Math.hypot(maj.x, maj.y);
        const ry = rx * (edge.lengthOfMinorAxis ?? 1);
        const tilt = Math.atan2(maj.y, maj.x);
        const a0 = edge.startAngle ?? 0;
        let sweep = (edge.endAngle ?? Math.PI * 2) - a0;
        while (sweep <= 0) sweep += Math.PI * 2;
        const steps = Math.max(8, Math.ceil((segs * sweep) / (Math.PI * 2)));
        const cos = Math.cos(tilt);
        const sin = Math.sin(tilt);
        for (let i = out.length === 0 ? 0 : 1; i <= steps; i++) {
          const t = a0 + (sweep * i) / steps;
          const ex = rx * Math.cos(t);
          const ey = ry * Math.sin(t);
          out.push(c.x + ex * cos - ey * sin, c.y + ex * sin + ey * cos);
        }
        return;
      }
      case 4: {
        // Spline
        const cps = edge.controlPoints;
        if (!cps?.length) return;
        const pts = tessellateNurbs(
          cps,
          edge.degree ?? 3,
          edge.knots,
          cps.map((p) => p.weight ?? 1),
          segs,
          false
        );
        for (let i = out.length === 0 ? 0 : 2; i < pts.length; i += 2) out.push(pts[i], pts[i + 1]);
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------- leaders

  private leader(e: DocEntity, ctx: Ctx): void {
    const verts = e.vertices as P3[] | undefined;
    if (!verts || verts.length < 2) return;
    const flat: number[] = [];

    if (e.isSpline === true && verts.length > 2) {
      const curve = tessellateFitPoints(verts, Math.max(4, this.opts.curveResolution >> 3), false);
      for (let i = 0; i < curve.length; i += 2) {
        const [x, y] = this.xf(ctx.mat, curve[i], curve[i + 1]);
        flat.push(x, y);
      }
    } else {
      for (const v of verts) {
        const [x, y] = this.xf(ctx.mat, v.x, v.y);
        flat.push(x, y);
      }
    }
    this.addPoly(flat, e, ctx, false);
  }

  /**
   * MLINE draws N parallel lines offset from a common path. Each vertex records
   * the miter direction and per-element offsets, so the offset runs stay joined
   * correctly at corners.
   */
  private mline(e: DocEntity, ctx: Ctx): void {
    const verts = e.vertices as MLineVertex[] | undefined;
    if (!verts || verts.length < 2) return;
    const scale = (e.scale as number) ?? 1;
    const closed = (((e.flags as number) ?? 0) & 2) !== 0;
    const lineCount = (e.numberOfLines as number) ?? verts[0]?.lines?.length ?? 0;
    if (!lineCount) return;

    for (let li = 0; li < lineCount; li++) {
      const flat: number[] = [];
      for (const v of verts) {
        const params = v.lines?.[li]?.segmentParams;
        const offset = (params && params.length ? params[0] : 0) * scale;
        const miter = v.miterDirection ?? { x: 0, y: 0, z: 0 };
        const px = v.vertex.x + miter.x * offset;
        const py = v.vertex.y + miter.y * offset;
        const [x, y] = this.xf(ctx.mat, px, py);
        flat.push(x, y);
      }
      this.addPoly(flat, e, ctx, closed);
    }
  }
}

// ------------------------------------------------------------------ helpers

interface TextLike {
  text?: string;
  startPoint?: P3;
  endPoint?: P3;
  textHeight?: number;
  rotation?: number;
  halign?: number;
  valign?: number;
  xScale?: number;
  obliqueAngle?: number;
  extrusionDirection?: P3;
}

interface HatchVertex {
  x: number;
  y: number;
  bulge?: number;
}

interface HatchEdge {
  type: number;
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  center?: { x: number; y: number };
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  isCCW?: boolean;
  lengthOfMinorAxis?: number;
  degree?: number;
  knots?: number[];
  controlPoints?: { x: number; y: number; weight?: number }[];
}

type HatchPath = {
  boundaryPathTypeFlag?: number;
  isClosed?: boolean;
  vertices?: HatchVertex[];
  edges?: HatchEdge[];
};

interface MLineVertex {
  vertex: P3;
  miterDirection?: P3;
  lines?: { segmentParams?: number[] }[];
}

/**
 * Strips MTEXT inline formatting down to plain lines.
 *
 * MTEXT embeds styling in the string itself: `\P` breaks a line, `\f`/`\F`
 * select fonts, `{...}` groups a run, and a trailing `;` ends most codes.
 * Rendering the raw string would show the markup, so it is removed here.
 */
export function decodeMText(raw: string): string[] {
  let s = raw;

  // Stacked fractions: "a^Bb" renders as a over b; show it inline as a/b.
  s = s.replace(/\\S([^;]*);/g, (_m, body: string) =>
    String(body).replace(/[\^#]/, '/')
  );

  // Codes that take a parameter terminated by ';'.
  s = s.replace(/\\[fF][^;]*;/g, '');
  s = s.replace(/\\[HWQTAC][^;\\]*;?/g, '');

  // Paragraph and line breaks.
  s = s.replace(/\\P/g, '\n');
  s = s.replace(/\\X/g, '\n');

  // Non-breaking space and escaped literals.
  s = s.replace(/\\~/g, ' ');
  s = s.replace(/\\\\/g, ' '); // protect escaped backslashes
  s = s.replace(/\\[{}]/g, (m) => m[1]);

  // Remaining single-letter codes without parameters (\L \l \O \o \K \k \p...).
  s = s.replace(/\\[LlOoKk]/g, '');
  s = s.replace(/\\p[^;]*;/g, '');

  // Grouping braces.
  s = s.replace(/[{}]/g, '');

  s = s.replace(/ /g, '\\');

  return s.split('\n').map((l) => l.trimEnd());
}

export function buildScene(doc: Doc, opts: BuildOptions): Scene {
  return new SceneBuilder(doc, opts).build();
}
