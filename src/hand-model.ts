/**
 * Shadow Parlor: a tiny parametric hand used to author target shadow poses.
 *
 * Pure math, no IWSDK / DOM imports, so it can run anywhere (runtime, tests).
 * Joint order matches the WebXR Hand Input spec (25 joints per hand).
 */

export const JOINTS = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
] as const;

export const JOINT_COUNT = 25;
export const INDEX_TIP = 9;
export const WRIST = 0;

/**
 * Capsules that make up the silhouette: pairs of joint indices plus a radius
 * multiplier. Finger bones follow the skeleton; extra wrist->knuckle and
 * knuckle->knuckle capsules fill the palm so the shadow reads as a hand.
 */
export const BONES: ReadonlyArray<readonly [number, number, number]> = [
  // thumb
  [1, 2, 1.25], [2, 3, 1.1], [3, 4, 1.0],
  // index
  [6, 7, 1.0], [7, 8, 0.95], [8, 9, 0.9],
  // middle
  [11, 12, 1.0], [12, 13, 0.95], [13, 14, 0.9],
  // ring
  [16, 17, 1.0], [17, 18, 0.95], [18, 19, 0.9],
  // pinky
  [21, 22, 0.95], [22, 23, 0.9], [23, 24, 0.85],
  // palm fill
  [0, 6, 2.1], [0, 11, 2.2], [0, 16, 2.1], [0, 21, 1.9], [0, 1, 1.6],
  [6, 21, 1.6], [1, 6, 1.4],
];

/** Default joint radius in metres when the runtime does not report one. */
export const DEFAULT_RADIUS = 0.0095;

/** Finger flexion per joint, radians. 0 = straight, ~1.5 = fully curled. */
export interface FingerCurl {
  mcp: number; // knuckle
  pip: number; // middle joint
  dip: number; // last joint
  spread?: number; // side-to-side at the knuckle, radians (+ toward thumb)
}

export interface HandShape {
  thumb: { curl: number; spread: number };
  index: FingerCurl;
  middle: FingerCurl;
  ring: FingerCurl;
  pinky: FingerCurl;
}

export interface HandPlacement {
  handedness: 'left' | 'right';
  /** wrist position in rig space (metres) */
  position: [number, number, number];
  /** Euler XYZ in degrees applied to the hand-local frame */
  rotationDeg: [number, number, number];
  shape: HandShape;
}

const STRAIGHT: FingerCurl = { mcp: 0, pip: 0, dip: 0 };
const CURLED: FingerCurl = { mcp: 1.45, pip: 1.6, dip: 1.0 };

export const SHAPES = {
  open: {
    thumb: { curl: 0, spread: 0.55 },
    index: { ...STRAIGHT, spread: 0.18 },
    middle: { ...STRAIGHT, spread: 0.05 },
    ring: { ...STRAIGHT, spread: -0.08 },
    pinky: { ...STRAIGHT, spread: -0.22 },
  },
  flat: {
    thumb: { curl: 0.15, spread: 0.1 },
    index: { ...STRAIGHT },
    middle: { ...STRAIGHT },
    ring: { ...STRAIGHT },
    pinky: { ...STRAIGHT },
  },
  point: {
    thumb: { curl: 1.0, spread: 0.05 },
    index: { ...STRAIGHT },
    middle: CURLED,
    ring: CURLED,
    pinky: CURLED,
  },
  vee: {
    thumb: { curl: 1.0, spread: 0.05 },
    index: { ...STRAIGHT, spread: 0.2 },
    middle: { ...STRAIGHT, spread: -0.12 },
    ring: CURLED,
    pinky: CURLED,
  },
  fist: {
    thumb: { curl: 0.9, spread: 0.1 },
    index: CURLED,
    middle: CURLED,
    ring: CURLED,
    pinky: CURLED,
  },
  cup: {
    thumb: { curl: 0.25, spread: 0.35 },
    index: { mcp: 0.55, pip: 0.75, dip: 0.4 },
    middle: { mcp: 0.55, pip: 0.75, dip: 0.4 },
    ring: { mcp: 0.55, pip: 0.75, dip: 0.4 },
    pinky: { mcp: 0.55, pip: 0.75, dip: 0.4 },
  },
  horns: {
    thumb: { curl: 1.0, spread: 0.05 },
    index: { ...STRAIGHT, spread: 0.15 },
    middle: CURLED,
    ring: CURLED,
    pinky: { ...STRAIGHT, spread: -0.2 },
  },
} satisfies Record<string, HandShape>;

type V3 = [number, number, number];

function rotX(v: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}
function rotY(v: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}
function rotZ(v: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

/**
 * Hand-local frame (right hand): fingers extend along -Z, back of the hand is
 * +Y, thumb side is -X. The left hand is the mirror image across X.
 */
const FINGERS: Array<{
  key: 'index' | 'middle' | 'ring' | 'pinky';
  base: number;
  meta: V3;
  knuckle: V3;
  lengths: [number, number, number];
}> = [
  { key: 'index', base: 5, meta: [-0.012, 0, -0.025], knuckle: [-0.026, 0, -0.092], lengths: [0.044, 0.025, 0.022] },
  { key: 'middle', base: 10, meta: [-0.002, 0, -0.025], knuckle: [-0.006, 0, -0.095], lengths: [0.049, 0.03, 0.024] },
  { key: 'ring', base: 15, meta: [0.008, 0, -0.024], knuckle: [0.013, 0, -0.088], lengths: [0.046, 0.028, 0.023] },
  { key: 'pinky', base: 20, meta: [0.016, 0, -0.022], knuckle: [0.03, -0.002, -0.078], lengths: [0.034, 0.02, 0.02] },
];

/**
 * Forward kinematics: returns joint positions (rig space, metres) as a flat
 * Float32Array of length 25*3.
 */
export function poseJoints(p: HandPlacement, out = new Float32Array(JOINT_COUNT * 3)): Float32Array {
  const local: V3[] = new Array(JOINT_COUNT);
  local[0] = [0, 0, 0];

  // Fingers: chain of three bones from the knuckle, flexing about local X
  // toward the palm (-Y), spread about local Y.
  for (const f of FINGERS) {
    const c = p.shape[f.key];
    local[f.base] = f.meta;
    local[f.base + 1] = f.knuckle;
    let dir: V3 = [0, 0, -1];
    dir = rotY(dir, c.spread ?? 0);
    const flex = [c.mcp, c.pip, c.dip];
    let pos = f.knuckle;
    let acc = 0;
    for (let i = 0; i < 3; i++) {
      acc += flex[i];
      // flexion rotates the finger direction toward -Y (into the palm)
      const d = rotX(dir, -acc);
      pos = add(pos, scale(d, f.lengths[i]));
      local[f.base + 2 + i] = pos;
    }
  }

  // Thumb: leaves the palm toward -X/-Z, curls across the palm (+X, -Y).
  {
    const t = p.shape.thumb;
    local[1] = [-0.02, -0.012, -0.022];
    let dir: V3 = [-0.62, -0.12, -0.77];
    dir = rotY(dir, -t.spread * 0.6);
    const lengths = [0.038, 0.032, 0.026];
    let pos = local[1];
    for (let i = 0; i < 3; i++) {
      const curlStep = t.curl * (i === 0 ? 0.5 : 0.9);
      dir = rotY(dir, -curlStep); // swing across the palm
      dir = rotX(dir, -curlStep * 0.35);
      pos = add(pos, scale(dir, lengths[i]));
      local[2 + i] = pos;
    }
  }

  const mirror = p.handedness === 'left' ? -1 : 1;
  const [rx, ry, rz] = p.rotationDeg.map((d) => (d * Math.PI) / 180);
  for (let j = 0; j < JOINT_COUNT; j++) {
    let v: V3 = [local[j][0] * mirror, local[j][1], local[j][2]];
    v = rotX(v, rx);
    v = rotY(v, ry);
    v = rotZ(v, rz);
    out[j * 3] = v[0] + p.position[0];
    out[j * 3 + 1] = v[1] + p.position[1];
    out[j * 3 + 2] = v[2] + p.position[2];
  }
  return out;
}
