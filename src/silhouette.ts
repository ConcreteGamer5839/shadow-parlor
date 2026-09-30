/**
 * Shadow Parlor: project hand joints from a point light onto the paper screen,
 * rasterise a soft silhouette on the CPU, and score it against a target.
 *
 * Pure math, no allocation in the per-frame paths. The same code draws what
 * the player sees and computes the score, so the display never lies about the
 * match.
 */
import { BONES, DEFAULT_RADIUS, JOINT_COUNT } from './hand-model.js';

export interface Stage {
  /** light position, rig space */
  light: [number, number, number];
  /** z of the screen plane (rig space), screen faces +Z */
  screenZ: number;
  /** screen centre x,y and size in metres */
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** grid resolution */
  nx: number;
  ny: number;
}

export const STAGE: Stage = {
  // The lamp sits just behind the player, like a shadow theatre where the
  // light is behind the audience. Magnification at the sweet spot is ~2.7x.
  light: [0, -0.28, 0.12],
  screenZ: -1.25,
  cx: 0,
  cy: 0.1,
  width: 1.4,
  height: 1.05,
  nx: 128,
  ny: 96,
};

const MAX_CAPSULES = BONES.length * 2;

export class Silhouette {
  readonly mask: Float32Array; // 0..1 coverage, row-major, y=0 at bottom
  area = 0; // binarised cell count
  cxCell = 0; // centroid in cell units
  cyCell = 0;
  // scratch
  private px = new Float32Array(JOINT_COUNT * 2);
  private pr = new Float32Array(JOINT_COUNT);
  private cap = new Float32Array(MAX_CAPSULES * 5);
  private capCount = 0;

  constructor(readonly stage: Stage = STAGE) {
    this.mask = new Float32Array(stage.nx * stage.ny);
  }

  clear(): void {
    this.mask.fill(0);
    this.capCount = 0;
    this.area = 0;
  }

  /**
   * Add one hand. joints: 25*3 rig-space positions. radii: optional 25 radii.
   * Returns false if the hand is behind the light (cannot cast).
   */
  addHand(joints: Float32Array, radii?: Float32Array | null): boolean {
    const s = this.stage;
    const [lx, ly, lz] = s.light;
    const cellW = s.width / s.nx;
    const cellH = s.height / s.ny;
    const x0 = s.cx - s.width / 2;
    const y0 = s.cy - s.height / 2;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const dz = joints[j * 3 + 2] - lz;
      if (dz > -0.02) return false; // at or behind the light
      const t = (s.screenZ - lz) / dz;
      const X = lx + t * (joints[j * 3] - lx);
      const Y = ly + t * (joints[j * 3 + 1] - ly);
      this.px[j * 2] = (X - x0) / cellW;
      this.px[j * 2 + 1] = (Y - y0) / cellH;
      const r = radii ? radii[j] || DEFAULT_RADIUS : DEFAULT_RADIUS;
      this.pr[j] = (r * t) / cellW; // radius in cell units (x scale)
    }
    const aspect = cellW / cellH;
    for (const [a, b, k] of BONES) {
      const o = this.capCount * 5;
      this.cap[o] = this.px[a * 2];
      this.cap[o + 1] = this.px[a * 2 + 1] * aspect; // make cells isotropic
      this.cap[o + 2] = this.px[b * 2];
      this.cap[o + 3] = this.px[b * 2 + 1] * aspect;
      this.cap[o + 4] = Math.max(0.8, 0.5 * (this.pr[a] + this.pr[b]) * k);
      this.rasterCapsule(o, aspect);
      this.capCount++;
    }
    return true;
  }

  private rasterCapsule(o: number, aspect: number): void {
    const { nx, ny } = this.stage;
    const ax = this.cap[o], ay = this.cap[o + 1], bx = this.cap[o + 2], by = this.cap[o + 3];
    const r = this.cap[o + 4];
    const soft = 0.9;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1));
    const maxX = Math.min(nx - 1, Math.ceil(Math.max(ax, bx) + r + 1));
    const minY = Math.max(0, Math.floor((Math.min(ay, by) - r - 1) / aspect));
    const maxY = Math.min(ny - 1, Math.ceil((Math.max(ay, by) + r + 1) / aspect));
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-6;
    for (let y = minY; y <= maxY; y++) {
      const py = (y + 0.5) * aspect;
      for (let x = minX; x <= maxX; x++) {
        const qx = x + 0.5;
        let t = ((qx - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = ax + dx * t - qx, ey = ay + dy * t - py;
        const d = Math.sqrt(ex * ex + ey * ey);
        let c = (r - d) / soft + 0.5;
        if (c <= 0) continue;
        if (c > 1) c = 1;
        const i = y * nx + x;
        if (c > this.mask[i]) this.mask[i] = c;
      }
    }
  }

  /** Binarise stats: area and centroid. Call after all hands are added. */
  finish(): void {
    const { nx, ny } = this.stage;
    let a = 0, sx = 0, sy = 0;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (this.mask[y * nx + x] >= 0.5) {
          a++;
          sx += x;
          sy += y;
        }
      }
    }
    this.area = a;
    this.cxCell = a ? sx / a : nx / 2;
    this.cyCell = a ? sy / a : ny / 2;
  }
}

export interface MatchResult {
  iou: number;
  /** player-to-target scale factor used (1 = same size) */
  scale: number;
}

/**
 * Compare player silhouette with the target. The target is re-centred on the
 * player's shadow and scaled to the same area (within limits), so the player
 * is scored on SHAPE, not on holding their hand at an exact spot. The overlay
 * drawn on the screen uses the same transform.
 */
export function matchSilhouettes(player: Silhouette, target: Silhouette, out: MatchResult): MatchResult {
  if (player.area < 20 || target.area < 20) {
    out.iou = 0;
    out.scale = 1;
    return out;
  }
  const { nx, ny } = player.stage;
  let s = Math.sqrt(player.area / target.area);
  s = Math.min(1.35, Math.max(0.75, s));
  let inter = 0, uni = 0;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const p = player.mask[y * nx + x] >= 0.5;
      const tx = Math.round((x - player.cxCell) / s + target.cxCell);
      const ty = Math.round((y - player.cyCell) / s + target.cyCell);
      const t = tx >= 0 && tx < nx && ty >= 0 && ty < ny && target.mask[ty * nx + tx] >= 0.5;
      if (p && t) inter++;
      if (p || t) uni++;
    }
  }
  out.iou = uni ? inter / uni : 0;
  out.scale = s;
  return out;
}

/** Sample the target mask in the player's frame (for drawing the outline). */
export function sampleTargetAt(
  x: number,
  y: number,
  target: Silhouette,
  s: number,
  anchorX: number,
  anchorY: number,
): number {
  const { nx, ny } = target.stage;
  const tx = Math.round((x - anchorX) / s + target.cxCell);
  const ty = Math.round((y - anchorY) / s + target.cyCell);
  if (tx < 0 || tx >= nx || ty < 0 || ty >= ny) return 0;
  return target.mask[ty * nx + tx];
}
