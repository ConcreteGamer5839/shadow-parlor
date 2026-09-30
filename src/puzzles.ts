/**
 * Shadow Parlor puzzle set and the daily run. Pure data + seeded RNG.
 */
import { HandPlacement, SHAPES } from './hand-model.js';

export interface Puzzle {
  id: string;
  name: string;
  hint: string;
  /** IoU needed to count as a match */
  threshold: number;
  hands: HandPlacement[];
}

// Where the "sweet spot" is: in front of the chest, below eye line, inside a
// seated two-foot radius. Rig origin = the player's eyes at calibration.
const R: [number, number, number] = [0.06, -0.2, -0.38];
const L: [number, number, number] = [-0.06, -0.2, -0.38];
const UP_FACING_SCREEN: [number, number, number] = [90, 0, 0];

export const TUTORIAL: Puzzle = {
  id: 'open-hand',
  name: 'Open Hand',
  hint: 'Hold up your right hand, fingers spread.',
  threshold: 0.55,
  hands: [{ handedness: 'right', position: R, rotationDeg: UP_FACING_SCREEN, shape: SHAPES.open }],
};

export const POOL: Puzzle[] = [
  {
    id: 'candle',
    name: 'Candle',
    hint: 'One finger up, the rest tucked.',
    threshold: 0.58,
    hands: [{ handedness: 'right', position: R, rotationDeg: UP_FACING_SCREEN, shape: SHAPES.point }],
  },
  {
    id: 'hare',
    name: 'Hare',
    hint: 'Two tall ears.',
    threshold: 0.58,
    hands: [{ handedness: 'right', position: R, rotationDeg: UP_FACING_SCREEN, shape: SHAPES.vee }],
  },
  {
    id: 'stone',
    name: 'Stone',
    hint: 'Close it up tight.',
    threshold: 0.62,
    hands: [{ handedness: 'right', position: R, rotationDeg: UP_FACING_SCREEN, shape: SHAPES.fist }],
  },
  {
    id: 'crescent',
    name: 'Crescent',
    hint: 'Turn your hand sideways and cup it.',
    threshold: 0.56,
    hands: [{ handedness: 'right', position: R, rotationDeg: [90, 90, 0], shape: SHAPES.cup }],
  },
  {
    id: 'beetle',
    name: 'Beetle',
    hint: 'First and little finger up.',
    threshold: 0.58,
    hands: [{ handedness: 'right', position: R, rotationDeg: UP_FACING_SCREEN, shape: SHAPES.horns }],
  },
  {
    id: 'moth',
    name: 'Moth',
    hint: 'Both hands, wrists together, fingers fanned out.',
    threshold: 0.52,
    hands: [
      { handedness: 'right', position: [0.045, -0.16, -0.38], rotationDeg: [90, 0, -50], shape: SHAPES.open },
      { handedness: 'left', position: [-0.045, -0.16, -0.38], rotationDeg: [90, 0, 50], shape: SHAPES.open },
    ],
  },
  {
    id: 'gate',
    name: 'Gate',
    hint: 'Both hands flat, side by side.',
    threshold: 0.55,
    hands: [
      { handedness: 'right', position: [0.07, -0.2, -0.38], rotationDeg: UP_FACING_SCREEN, shape: SHAPES.flat },
      { handedness: 'left', position: [-0.07, -0.2, -0.38], rotationDeg: UP_FACING_SCREEN, shape: SHAPES.flat },
    ],
  },
];

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Today's five shadows. Same for everyone on the same calendar day. Each
 * puzzle gets a small in-plane tilt so repeat shapes still feel fresh.
 */
export function dailyRun(key = dayKey(), count = 5): Puzzle[] {
  let seed = 0;
  for (const ch of key) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) >>> 0;
  const rand = rng(seed);
  const pool = POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count).map((p) => {
    const tilt = Math.round((rand() - 0.5) * 30);
    return {
      ...p,
      hands: p.hands.map((h) => ({
        ...h,
        rotationDeg: [h.rotationDeg[0], h.rotationDeg[1], h.rotationDeg[2] + tilt] as [number, number, number],
      })),
    };
  });
}
