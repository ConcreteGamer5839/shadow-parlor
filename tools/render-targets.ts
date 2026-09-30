import { poseJoints } from '../src/hand-model.js';
import { Silhouette, matchSilhouettes } from '../src/silhouette.js';
import { TUTORIAL, POOL } from '../src/puzzles.js';
import { writeFileSync } from 'node:fs';
const all = [TUTORIAL, ...POOL];
const sils = all.map((p) => { const s = new Silhouette(); s.clear(); for (const h of p.hands) s.addHand(poseJoints(h)); s.finish(); return s; });
let txt = '';
all.forEach((p, i) => {
  const s = sils[i]; const { nx, ny } = s.stage;
  txt += `== ${p.name} area=${s.area}\n`;
  for (let y = ny - 1; y >= 0; y -= 3) { let row = ''; for (let x = 0; x < nx; x += 2) row += s.mask[y * nx + x] >= 0.5 ? '#' : '.'; if (row.includes('#')) txt += row + '\n'; }
});
// confusion matrix: how distinct are targets from each other?
txt += '\nIoU matrix (row=player pose, col=target)\n' + '         ' + all.map(p=>p.id.slice(0,7).padEnd(8)).join('') + '\n';
const r = { iou: 0, scale: 1 };
all.forEach((a, i) => { txt += a.id.slice(0,8).padEnd(9) + all.map((b, j) => matchSilhouettes(sils[i], sils[j], r).iou.toFixed(2).padEnd(8)).join('') + '\n'; });
writeFileSync('tools/targets.txt', txt); console.log(txt.split('\nIoU')[1]);
