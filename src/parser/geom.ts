/** Geometry helpers shared by the DWG and DXF readers. */

export interface Pt3 {
  x: number;
  y: number;
  z: number;
}

/**
 * A 2D affine transform laid out as
 *   | a c e |
 *   | b d f |
 * matching the canvas/SVG convention.
 */
export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function matMul(m: Mat, n: Mat): Mat {
  // Returns m ∘ n, i.e. apply `n` first and then `m`.
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function matFrom(
  tx: number,
  ty: number,
  sx: number,
  sy: number,
  rotation: number
): Mat {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    a: cos * sx,
    b: sin * sx,
    c: -sin * sy,
    d: cos * sy,
    e: tx,
    f: ty,
  };
}

/** True when the transform scales x and y equally and does not shear. */
export function isConformal(m: Mat, epsilon = 1e-9): boolean {
  const sx = Math.hypot(m.a, m.b);
  const sy = Math.hypot(m.c, m.d);
  if (Math.abs(sx - sy) > epsilon * Math.max(1, sx)) return false;
  // Dot product of the two basis vectors must vanish for a pure rotation+scale.
  return Math.abs(m.a * m.c + m.b * m.d) <= epsilon * Math.max(1, sx * sy);
}

/** Uniform scale factor of a conformal transform. */
export function matScale(m: Mat): number {
  return Math.hypot(m.a, m.b);
}

/** Rotation angle of a conformal transform, in radians. */
export function matRotation(m: Mat): number {
  return Math.atan2(m.b, m.a);
}

/** True when the transform flips orientation (mirrors). */
export function matMirrors(m: Mat): boolean {
  return m.a * m.d - m.b * m.c < 0;
}

/**
 * AutoCAD's Arbitrary Axis Algorithm.
 *
 * Entities such as CIRCLE, ARC, LWPOLYLINE, TEXT and INSERT store their points in
 * an Object Coordinate System defined by an extrusion vector. Ignoring this is
 * the classic cause of blocks rendering mirrored, because a (0,0,-1) extrusion —
 * extremely common in real drawings — negates the X axis.
 */
export function ocsToWcs(normal: Pt3 | undefined): ((p: Pt3) => Pt3) | null {
  if (!normal) return null;
  const { x: nx, y: ny, z: nz } = normal;
  const len = Math.hypot(nx, ny, nz);
  if (!len || !Number.isFinite(len)) return null;
  const n: Pt3 = { x: nx / len, y: ny / len, z: nz / len };

  // The overwhelmingly common case: OCS is already world space.
  if (Math.abs(n.x) < 1e-12 && Math.abs(n.y) < 1e-12 && n.z > 0) return null;

  // Pick the world axis least parallel to the normal, per the DXF specification.
  const arbitrary: Pt3 =
    Math.abs(n.x) < 1 / 64 && Math.abs(n.y) < 1 / 64
      ? { x: 0, y: 1, z: 0 }
      : { x: 0, y: 0, z: 1 };

  const ax = normalize(cross(arbitrary, n));
  const ay = normalize(cross(n, ax));

  return (p: Pt3): Pt3 => ({
    x: ax.x * p.x + ay.x * p.y + n.x * p.z,
    y: ax.y * p.x + ay.y * p.y + n.y * p.z,
    z: ax.z * p.x + ay.z * p.y + n.z * p.z,
  });
}

function cross(a: Pt3, b: Pt3): Pt3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalize(v: Pt3): Pt3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/** True when the extrusion is the identity (+Z) and no OCS work is needed. */
export function isWorldNormal(n: Pt3 | undefined): boolean {
  if (!n) return true;
  return Math.abs(n.x) < 1e-12 && Math.abs(n.y) < 1e-12 && n.z > 0;
}

export interface BulgeArc {
  cx: number;
  cy: number;
  r: number;
  /** Start angle in radians. */
  a0: number;
  /** End angle in radians; sweeping counter-clockwise from a0 when ccw. */
  a1: number;
  ccw: boolean;
}

/**
 * Converts a polyline bulge into an arc.
 *
 * `bulge` is tan(theta/4) where theta is the included angle; its sign gives the
 * sweep direction. Returns null for a straight segment or degenerate input.
 */
export function bulgeToArc(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bulge: number
): BulgeArc | null {
  if (!bulge || !Number.isFinite(bulge)) return null;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return null;

  const theta = 4 * Math.atan(bulge);
  const half = Math.abs(theta / 2);
  if (half < 1e-12) return null;

  const r = chord / (2 * Math.sin(half));
  if (!Number.isFinite(r)) return null;

  // Sagitta-based centre: offset from the chord midpoint along the chord normal.
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  // Distance from midpoint to centre; negative when the arc is a major arc.
  const h = r * Math.cos(half);
  const sign = bulge > 0 ? 1 : -1;
  const cx = midX - (dy / chord) * h * sign;
  const cy = midY + (dx / chord) * h * sign;

  const a0 = Math.atan2(y1 - cy, x1 - cx);
  const a1 = Math.atan2(y2 - cy, x2 - cx);
  return { cx, cy, r: Math.abs(r), a0, a1, ccw: bulge > 0 };
}

/** Normalises a CCW sweep from a0 to a1 into the range (0, 2*PI]. */
export function sweepCcw(a0: number, a1: number): number {
  let d = a1 - a0;
  while (d <= 0) d += Math.PI * 2;
  while (d > Math.PI * 2) d -= Math.PI * 2;
  return d;
}

/**
 * Appends a tessellated arc to `out` as flat x,y pairs.
 * The starting point is emitted only when `includeStart` is set, so callers can
 * chain segments without duplicating shared vertices.
 */
export function tessellateArc(
  out: number[],
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  ccw: boolean,
  segments: number,
  includeStart: boolean
): void {
  let sweep = ccw ? sweepCcw(a0, a1) : -sweepCcw(a1, a0);
  if (Math.abs(sweep) < 1e-12) sweep = ccw ? Math.PI * 2 : -Math.PI * 2;

  const steps = Math.max(2, Math.ceil((segments * Math.abs(sweep)) / (Math.PI * 2)));
  for (let i = includeStart ? 0 : 1; i <= steps; i++) {
    const a = a0 + (sweep * i) / steps;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}

/**
 * Evaluates a NURBS curve from control points, knots and optional weights.
 * Falls back to the control polygon if the knot vector is unusable.
 */
export function tessellateNurbs(
  controlPoints: { x: number; y: number }[],
  degree: number,
  knots: number[] | undefined,
  weights: number[] | undefined,
  segments: number,
  closed: boolean
): number[] {
  const n = controlPoints.length;
  if (n === 0) return [];
  if (n === 1) return [controlPoints[0].x, controlPoints[0].y];

  const p = Math.max(1, Math.min(degree || 3, n - 1));
  let knot = knots && knots.length === n + p + 1 ? knots.slice() : null;
  if (!knot) {
    // Synthesise a clamped uniform knot vector.
    knot = [];
    for (let i = 0; i <= n + p; i++) {
      if (i <= p) knot.push(0);
      else if (i >= n) knot.push(n - p);
      else knot.push(i - p);
    }
  }

  const w = weights && weights.length === n ? weights : null;
  const t0 = knot[p];
  const t1 = knot[n];
  if (!(t1 > t0)) {
    const flat: number[] = [];
    for (const c of controlPoints) flat.push(c.x, c.y);
    return flat;
  }

  const steps = Math.max(segments, p * 4);
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    // Nudge the final sample inside the domain; at exactly t1 the span search
    // would run past the last valid span.
    const t = i === steps ? t1 - (t1 - t0) * 1e-10 : t0 + ((t1 - t0) * i) / steps;
    const pt = evalNurbs(controlPoints, p, knot, w, t);
    out.push(pt.x, pt.y);
  }
  if (closed && out.length >= 4) out.push(out[0], out[1]);
  return out;
}

function evalNurbs(
  cps: { x: number; y: number }[],
  p: number,
  knot: number[],
  weights: number[] | null,
  t: number
): { x: number; y: number } {
  const n = cps.length;

  // Locate the knot span containing t.
  let span = p;
  for (let i = p; i < n; i++) {
    if (t >= knot[i] && t < knot[i + 1]) {
      span = i;
      break;
    }
    span = i;
  }

  // Cox-de Boor basis functions for the span.
  const N = new Array<number>(p + 1).fill(0);
  N[0] = 1;
  const left = new Array<number>(p + 1).fill(0);
  const right = new Array<number>(p + 1).fill(0);
  for (let j = 1; j <= p; j++) {
    left[j] = t - knot[span + 1 - j];
    right[j] = knot[span + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      const temp = denom === 0 ? 0 : N[r] / denom;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }

  let x = 0;
  let y = 0;
  let wSum = 0;
  for (let i = 0; i <= p; i++) {
    const idx = span - p + i;
    if (idx < 0 || idx >= n) continue;
    const wi = weights ? weights[idx] : 1;
    const b = N[i] * wi;
    x += cps[idx].x * b;
    y += cps[idx].y * b;
    wSum += b;
  }
  if (wSum === 0) return { x: cps[Math.min(span, n - 1)].x, y: cps[Math.min(span, n - 1)].y };
  return { x: x / wSum, y: y / wSum };
}

/**
 * Smooth interpolating curve through fit points, used for splines that were
 * stored with fit points only (common for curves drawn with SPLINE "fit" mode).
 * Uses a centripetal Catmull-Rom spline, which avoids the cusps and overshoot
 * that a uniform parameterisation produces on unevenly spaced points.
 */
export function tessellateFitPoints(
  pts: { x: number; y: number }[],
  segmentsPerSpan: number,
  closed: boolean
): number[] {
  const n = pts.length;
  if (n === 0) return [];
  if (n <= 2) {
    const flat: number[] = [];
    for (const q of pts) flat.push(q.x, q.y);
    return flat;
  }

  const out: number[] = [];
  const last = closed ? n : n - 1;
  const at = (i: number) => pts[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];

  out.push(pts[0].x, pts[0].y);
  for (let i = 0; i < last; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);

    // Centripetal knot spacing (alpha = 0.5).
    const d01 = Math.sqrt(Math.hypot(p1.x - p0.x, p1.y - p0.y)) || 1e-6;
    const d12 = Math.sqrt(Math.hypot(p2.x - p1.x, p2.y - p1.y)) || 1e-6;
    const d23 = Math.sqrt(Math.hypot(p3.x - p2.x, p3.y - p2.y)) || 1e-6;

    // Tangents scaled to the local knot spacing.
    const m1x = ((p2.x - p1.x) / d12 - (p0.x - p1.x) / d01 - (p2.x - p0.x) / (d01 + d12)) * d12;
    const m1y = ((p2.y - p1.y) / d12 - (p0.y - p1.y) / d01 - (p2.y - p0.y) / (d01 + d12)) * d12;
    const m2x = ((p3.x - p2.x) / d23 - (p1.x - p2.x) / d12 - (p3.x - p1.x) / (d12 + d23)) * d12;
    const m2y = ((p3.y - p2.y) / d23 - (p1.y - p2.y) / d12 - (p3.y - p1.y) / (d12 + d23)) * d12;

    for (let s = 1; s <= segmentsPerSpan; s++) {
      const u = s / segmentsPerSpan;
      const u2 = u * u;
      const u3 = u2 * u;
      // Hermite basis.
      const h00 = 2 * u3 - 3 * u2 + 1;
      const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2;
      const h11 = u3 - u2;
      out.push(
        h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x,
        h00 * p1.y + h10 * m1y + h01 * p2.y + h11 * m2y
      );
    }
  }
  return out;
}
