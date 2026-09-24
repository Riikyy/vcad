import type { SceneBounds } from '../common/scene';

/**
 * Maps drawing coordinates to canvas pixels.
 *
 * CAD space has Y increasing upwards while canvas Y increases downwards, so the
 * vertical axis is flipped here once and every other part of the viewer can work
 * in plain drawing coordinates.
 */
export class Viewport {
  scale = 1;
  offsetX = 0;
  offsetY = 0;

  /** Canvas size in CSS pixels. */
  width = 1;
  height = 1;

  toScreenX(x: number): number {
    return x * this.scale + this.offsetX;
  }

  toScreenY(y: number): number {
    return -y * this.scale + this.offsetY;
  }

  toDrawingX(px: number): number {
    return (px - this.offsetX) / this.scale;
  }

  toDrawingY(py: number): number {
    return (this.offsetY - py) / this.scale;
  }

  /** Drawing-space rectangle currently visible, padded by `margin` pixels. */
  visibleBounds(margin = 0): SceneBounds {
    return {
      minX: this.toDrawingX(-margin),
      maxX: this.toDrawingX(this.width + margin),
      // Screen Y is inverted, so the bottom edge maps to the minimum Y.
      minY: this.toDrawingY(this.height + margin),
      maxY: this.toDrawingY(-margin),
    };
  }

  /** Frames `bounds` with a small margin. */
  fit(bounds: SceneBounds, padding = 0.04): void {
    const w = bounds.maxX - bounds.minX;
    const h = bounds.maxY - bounds.minY;

    if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) {
      // A single point, an empty drawing, or degenerate extents: centre at a
      // neutral zoom rather than dividing by zero.
      this.scale = 1;
      const cx = Number.isFinite(bounds.minX) ? bounds.minX : 0;
      const cy = Number.isFinite(bounds.minY) ? bounds.minY : 0;
      this.offsetX = this.width / 2 - cx;
      this.offsetY = this.height / 2 + cy;
      return;
    }

    const scale = Math.min(
      (this.width * (1 - padding * 2)) / w,
      (this.height * (1 - padding * 2)) / h
    );
    this.scale = Number.isFinite(scale) && scale > 0 ? scale : 1;

    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    this.offsetX = this.width / 2 - cx * this.scale;
    this.offsetY = this.height / 2 + cy * this.scale;
  }

  /** Zooms by `factor` while keeping the drawing point under the cursor fixed. */
  zoomAt(px: number, py: number, factor: number): void {
    const x = this.toDrawingX(px);
    const y = this.toDrawingY(py);
    const next = clampScale(this.scale * factor);
    if (next === this.scale) return;
    this.scale = next;
    this.offsetX = px - x * this.scale;
    this.offsetY = py + y * this.scale;
  }

  panBy(dx: number, dy: number): void {
    this.offsetX += dx;
    this.offsetY += dy;
  }
}

/**
 * Keeps zoom inside the range where double-precision coordinates still render
 * predictably; beyond this the canvas transform starts losing sub-pixel accuracy.
 */
function clampScale(scale: number): number {
  const MIN = 1e-9;
  const MAX = 1e9;
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX, Math.max(MIN, scale));
}
