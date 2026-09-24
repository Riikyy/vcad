/**
 * Object snap for the measure tool.
 *
 * A measurement is only useful if it lands exactly on the geometry, which a
 * mouse click almost never does. Candidate points — endpoints, midpoints,
 * centres, quadrants and nodes — are collected once per draw plan and sorted by
 * X, so a lookup is a binary search plus a short scan rather than a walk over
 * every primitive in the drawing.
 */

import { Scene } from '../common/scene';
import type { RenderPlan } from './render';

export type SnapKind = 'endpoint' | 'midpoint' | 'center' | 'quadrant' | 'node';

const KIND_CODE: Record<SnapKind, number> = {
  endpoint: 0,
  midpoint: 1,
  center: 2,
  quadrant: 3,
  node: 4,
};
const CODE_KIND: SnapKind[] = ['endpoint', 'midpoint', 'center', 'quadrant', 'node'];

export interface SnapHit {
  x: number;
  y: number;
  kind: SnapKind;
}

/**
 * Polylines with more vertices than this are almost always flattened curves
 * (splines, bulged arcs). Their interior vertices are artefacts of tessellation,
 * not points a draughtsman placed, so only their two ends are offered.
 */
const TESSELLATED_VERTEX_THRESHOLD = 32;

/** Upper bound on candidates examined per lookup, to keep hover cheap when zoomed out. */
const MAX_SCAN = 20000;

export class SnapIndex {
  private xs: Float64Array;
  private ys: Float64Array;
  private kinds: Uint8Array;

  constructor(scene: Scene, plan: RenderPlan) {
    const xs: number[] = [];
    const ys: number[] = [];
    const kinds: number[] = [];
    const add = (x: number, y: number, kind: SnapKind) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      xs.push(x);
      ys.push(y);
      kinds.push(KIND_CODE[kind]);
    };

    for (const g of plan.groups) {
      for (const i of g.polys) {
        const start = scene.polyOffsets[i];
        const end = scene.polyOffsets[i + 1];
        const count = end - start;
        if (count < 2) continue;
        const X = (v: number) => scene.polyCoords[v * 2];
        const Y = (v: number) => scene.polyCoords[v * 2 + 1];

        // Construction lines are clipped to a 1e7 reach; their synthetic ends
        // are not real points and would only attract stray snaps.
        const span = Math.max(
          Math.abs(X(end - 1) - X(start)),
          Math.abs(Y(end - 1) - Y(start))
        );
        if (count === 2 && span > 1e6) continue;

        if (count > TESSELLATED_VERTEX_THRESHOLD) {
          add(X(start), Y(start), 'endpoint');
          add(X(end - 1), Y(end - 1), 'endpoint');
          continue;
        }
        for (let v = start; v < end; v++) {
          add(X(v), Y(v), 'endpoint');
          if (v + 1 < end) add((X(v) + X(v + 1)) / 2, (Y(v) + Y(v + 1)) / 2, 'midpoint');
        }
      }

      for (const i of g.arcs) {
        const d = i * 5;
        const cx = scene.arcData[d];
        const cy = scene.arcData[d + 1];
        const r = scene.arcData[d + 2];
        const a0 = scene.arcData[d + 3];
        const a1 = scene.arcData[d + 4];
        add(cx, cy, 'center');

        let sweep = a1 - a0;
        while (sweep <= 0) sweep += Math.PI * 2;
        const full = sweep >= Math.PI * 2 - 1e-9;
        if (full) {
          for (let k = 0; k < 4; k++) {
            const a = (k * Math.PI) / 2;
            add(cx + r * Math.cos(a), cy + r * Math.sin(a), 'quadrant');
          }
        } else {
          add(cx + r * Math.cos(a0), cy + r * Math.sin(a0), 'endpoint');
          add(cx + r * Math.cos(a1), cy + r * Math.sin(a1), 'endpoint');
          const mid = a0 + sweep / 2;
          add(cx + r * Math.cos(mid), cy + r * Math.sin(mid), 'midpoint');
        }
      }

      for (const i of g.ellipses) {
        add(scene.ellData[i * 7], scene.ellData[i * 7 + 1], 'center');
      }

      for (const i of g.points) {
        add(scene.ptCoords[i * 2], scene.ptCoords[i * 2 + 1], 'node');
      }
    }

    // Sort all three arrays together by X.
    const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
    this.xs = Float64Array.from(order, (i) => xs[i]);
    this.ys = Float64Array.from(order, (i) => ys[i]);
    this.kinds = Uint8Array.from(order, (i) => kinds[i]);
  }

  get size(): number {
    return this.xs.length;
  }

  /** Nearest candidate within `radius` drawing units of (x, y), or null. */
  nearest(x: number, y: number, radius: number): SnapHit | null {
    const xs = this.xs;
    // First index whose X is >= x - radius.
    let lo = 0;
    let hi = xs.length;
    const left = x - radius;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < left) lo = mid + 1;
      else hi = mid;
    }

    let best = -1;
    let bestDist = radius * radius;
    const right = x + radius;
    let scanned = 0;
    for (let i = lo; i < xs.length && xs[i] <= right && scanned < MAX_SCAN; i++, scanned++) {
      const dx = xs[i] - x;
      const dy = this.ys[i] - y;
      const d = dx * dx + dy * dy;
      if (d <= bestDist) {
        // On a tie prefer the more specific kind: an endpoint beats the
        // midpoint of a zero-length segment sitting on top of it.
        if (d < bestDist || best < 0 || this.kinds[i] < this.kinds[best]) {
          best = i;
          bestDist = d;
        }
      }
    }
    return best < 0 ? null : { x: xs[best], y: this.ys[best], kind: CODE_KIND[this.kinds[best]] };
  }
}
