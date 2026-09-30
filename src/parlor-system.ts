/**
 * Shadow Parlor core loop.
 *
 * A lamp behind you, a paper screen in front. Your real hands cast the
 * shadow. Make the shape on the card, hold it, and the shadow is "caught".
 * Five shadows a day, same five for everyone, streak kept on the device.
 *
 * Everything is built procedurally here so the scaffold has no external asset
 * dependencies. Hands only: there is no controller path at all.
 */
import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DataTexture,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RGBAFormat,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
  VisibilityState,
  createSystem,
  LinearFilter,
  PointLight,
  AmbientLight,
} from '@iwsdk/core';
import { INDEX_TIP, JOINTS, JOINT_COUNT, poseJoints } from './hand-model.js';
import { MatchResult, STAGE, Silhouette, matchSilhouettes, sampleTargetAt } from './silhouette.js';
import { POOL, Puzzle, TUTORIAL, dailyRun, dayKey } from './puzzles.js';
import { Chimes } from './sound.js';

type Phase = 'play' | 'caught' | 'done';

interface Progress {
  lastDay: string;
  streak: number;
  best: number;
  tutorialDone: boolean;
}

const HOLD_SECONDS = 0.8;
const CAUGHT_SECONDS = 1.6;
const NN_MARGIN = 0.01;

function loadProgress(): Progress {
  const fallback: Progress = { lastDay: '', streak: 0, best: 0, tutorialDone: false };
  try {
    const raw = localStorage.getItem('shadow-parlor-progress');
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function saveProgress(p: Progress): void {
  try {
    localStorage.setItem('shadow-parlor-progress', JSON.stringify(p));
  } catch {
    /* private mode etc. — the run still works */
  }
}

export class ParlorSystem extends createSystem({}) {
  // --- scene
  private rig!: Group;
  private screenTex!: DataTexture;
  private screenPixels!: Uint8Array;
  private paper!: Uint8Array;
  private titleCanvas!: HTMLCanvasElement;
  private titleTex!: CanvasTexture;
  private ghost!: InstancedMesh;
  private buttons: Array<{ id: 'hint' | 'skip' | 'recenter'; mesh: Mesh; pos: Vector3; cooldown: number }> = [];

  // --- silhouettes
  private live = new Silhouette();
  private target = new Silhouette();
  private others: Array<{ id: string; sil: Silhouette }> = [];
  private match: MatchResult = { iou: 0, scale: 1 };
  private tmpMatch: MatchResult = { iou: 0, scale: 1 };
  private nnBest = 0;
  private nnTimer = 0;
  private anchorX = 0;
  private anchorY = 0;
  private anchorS = 1;
  private anchorA = 0;

  // --- hands
  private joints = [new Float32Array(JOINT_COUNT * 3), new Float32Array(JOINT_COUNT * 3)];
  private radii = [new Float32Array(JOINT_COUNT), new Float32Array(JOINT_COUNT)];
  private tracked = [false, false];
  private poseBuf = new Float32Array(JOINT_COUNT * 16);
  private spaceCache = new WeakMap<object, XRJointSpace[]>();
  private injected: [Float32Array | null, Float32Array | null] | null = null;
  private v = new Vector3();
  private m = new Matrix4();

  // --- game state
  private run: Puzzle[] = [];
  private index = 0;
  private phase: Phase = 'play';
  private hold = 0;
  private phaseTime = 0;
  private hintOn = true;
  private progress = loadProgress();
  private calibrated = false;
  private chimes = new Chimes();
  private caughtCount = 0;

  init(): void {
    this.buildScene();
    const today = dayKey();
    this.run = dailyRun(today);
    if (!this.progress.tutorialDone) this.run.unshift(TUTORIAL);
    for (const p of [TUTORIAL, ...POOL]) {
      const sil = new Silhouette();
      sil.clear();
      for (const h of p.hands) sil.addHand(poseJoints(h));
      sil.finish();
      this.others.push({ id: p.id, sil });
    }
    this.startPuzzle(0);

    this.cleanupFuncs.push(
      this.visibilityState.subscribe((s) => {
        if (s === VisibilityState.Visible) {
          this.chimes.resume();
          if (!this.calibrated) this.calibrateSoon = 3; // wait a few frames for a head pose
        }
        if (s === VisibilityState.NonImmersive) this.calibrated = false;
      }),
    );

    // Debug / test hook. Harmless in production; used by the smoke test.
    (window as any).__parlor = {
      state: () => ({
        phase: this.phase,
        index: this.index,
        runLength: this.run.length,
        puzzle: this.run[this.index]?.id,
        iou: Number(this.match.iou.toFixed(3)),
        nnBest: Number(this.nnBest.toFixed(3)),
        hold: Number(this.hold.toFixed(2)),
        tracked: [...this.tracked],
        caught: this.caughtCount,
        visibility: this.visibilityState.peek(),
        streak: this.progress.streak,
      }),
      /** feed the current target's own pose as if it were the player's hands */
      injectTargetPose: (wobble = 0) => {
        const p = this.run[this.index];
        const out: [Float32Array | null, Float32Array | null] = [null, null];
        for (const h of p.hands) {
          const j = poseJoints(h);
          if (wobble) for (let i = 0; i < j.length; i++) j[i] += (Math.random() - 0.5) * wobble;
          out[h.handedness === 'left' ? 0 : 1] = j;
        }
        this.injected = out;
      },
      /** feed some other puzzle's pose (negative testing) */
      injectPuzzlePose: (id: string) => {
        const p = [TUTORIAL, ...POOL].find((x) => x.id === id);
        if (!p) return false;
        const out: [Float32Array | null, Float32Array | null] = [null, null];
        for (const h of p.hands) out[h.handedness === 'left' ? 0 : 1] = poseJoints(h);
        this.injected = out;
        return true;
      },
      clearInjection: () => {
        this.injected = null;
      },
    };
  }

  private calibrateSoon = 0;

  // ------------------------------------------------------------------ scene
  private buildScene(): void {
    this.scene.background = new Color(0x120d0a);
    this.rig = new Group();
    this.rig.name = 'ParlorRig';
    this.rig.position.set(0, 1.2, 0); // desktop default: seated eye height
    this.world.createTransformEntity(this.rig);

    this.rig.add(new AmbientLight(0xffe2c0, 0.35));
    const lamp = new PointLight(0xffc98a, 3.0, 4, 1.6);
    lamp.position.set(...STAGE.light);
    this.rig.add(lamp);

    // Paper screen with a CPU-drawn shadow texture.
    const { nx, ny } = STAGE;
    this.screenPixels = new Uint8Array(nx * ny * 4);
    this.paper = new Uint8Array(nx * ny * 3);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        // warm paper, brightest where the lamp hits
        const dx = (x - nx / 2) / nx, dy = (y - ny * 0.45) / ny;
        const glow = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 1.5);
        const i = (y * nx + x) * 3;
        this.paper[i] = 120 + 130 * glow;
        this.paper[i + 1] = 85 + 120 * glow;
        this.paper[i + 2] = 50 + 80 * glow;
      }
    }
    this.screenTex = new DataTexture(this.screenPixels, nx, ny, RGBAFormat);
    this.screenTex.colorSpace = SRGBColorSpace;
    this.screenTex.magFilter = LinearFilter;
    this.screenTex.minFilter = LinearFilter;
    const screen = new Mesh(
      new PlaneGeometry(STAGE.width, STAGE.height),
      new MeshBasicMaterial({ map: this.screenTex, toneMapped: false }),
    );
    screen.position.set(STAGE.cx, STAGE.cy, STAGE.screenZ);
    this.rig.add(screen);

    // Frame
    const wood = new MeshStandardMaterial({ color: 0x3b2416, roughness: 0.8 });
    const t = 0.04;
    const w = STAGE.width + t * 2, h = STAGE.height + t * 2;
    for (const [sx, sy, px, py] of [
      [w, t, 0, h / 2 - t / 2],
      [w, t, 0, -h / 2 + t / 2],
      [t, h, w / 2 - t / 2, 0],
      [t, h, -w / 2 + t / 2, 0],
    ]) {
      const bar = new Mesh(new BoxGeometry(sx, sy, 0.03), wood);
      bar.position.set(STAGE.cx + px, STAGE.cy + py, STAGE.screenZ + 0.005);
      this.rig.add(bar);
    }

    // Title card above the screen
    this.titleCanvas = document.createElement('canvas');
    this.titleCanvas.width = 1024;
    this.titleCanvas.height = 160;
    this.titleTex = new CanvasTexture(this.titleCanvas);
    this.titleTex.colorSpace = SRGBColorSpace;
    const title = new Mesh(
      new PlaneGeometry(1.0, 0.156),
      new MeshBasicMaterial({ map: this.titleTex, transparent: true, toneMapped: false }),
    );
    title.position.set(STAGE.cx, STAGE.cy + STAGE.height / 2 + 0.13, STAGE.screenZ + 0.01);
    this.rig.add(title);

    // Low table in front of the player (hands rest above it)
    const table = new Mesh(
      new BoxGeometry(0.9, 0.03, 0.42),
      new MeshStandardMaterial({ color: 0x5a3a26, roughness: 0.7 }),
    );
    table.position.set(0, -0.48, -0.36);
    this.rig.add(table);

    // Poke buttons on the table: press with a fingertip
    const labels: Array<['hint' | 'skip' | 'recenter', string, number, number]> = [
      ['hint', 'HINT', -0.22, 0x6fb7c9],
      ['skip', 'SKIP', 0.0, 0xc9a26f],
      ['recenter', 'CENTER', 0.22, 0x8f8f8f],
    ];
    for (const [id, text, x, color] of labels) {
      const btn = new Mesh(
        new CylinderGeometry(0.035, 0.035, 0.018, 24),
        new MeshStandardMaterial({ color, roughness: 0.5, emissive: color, emissiveIntensity: 0.15 }),
      );
      btn.position.set(x, -0.455, -0.26);
      this.rig.add(btn);
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = '#f3e6d0';
      g.font = 'bold 40px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, 128, 34);
      const lt = new CanvasTexture(c);
      lt.colorSpace = SRGBColorSpace;
      const label = new Mesh(
        new PlaneGeometry(0.1, 0.025),
        new MeshBasicMaterial({ map: lt, transparent: true, toneMapped: false }),
      );
      label.rotation.x = -Math.PI / 2.6;
      label.position.set(x, -0.44, -0.205);
      this.rig.add(label);
      this.buttons.push({ id, mesh: btn, pos: btn.position.clone(), cooldown: 0 });
    }

    // Ghost hand: shows where and how to hold your hand
    this.ghost = new InstancedMesh(
      new SphereGeometry(1, 10, 8),
      new MeshBasicMaterial({ color: 0x9fe3ff, transparent: true, opacity: 0.45, depthWrite: false }),
      JOINT_COUNT * 2,
    );
    this.ghost.frustumCulled = false;
    this.rig.add(this.ghost);
  }

  // ------------------------------------------------------------ game flow
  private startPuzzle(i: number): void {
    this.index = i;
    this.phase = 'play';
    this.hold = 0;
    this.phaseTime = 0;
    const p = this.run[i];
    this.target.clear();
    for (const h of p.hands) this.target.addHand(poseJoints(h));
    this.target.finish();
    this.anchorX = this.target.cxCell;
    this.anchorY = this.target.cyCell;
    this.anchorS = 1;
    this.anchorA = 0;
    this.hintOn = p.id === TUTORIAL.id || this.hintOn;
    this.layoutGhost(p);
    this.drawTitle();
  }

  private layoutGhost(p: Puzzle): void {
    let n = 0;
    for (const h of p.hands) {
      const j = poseJoints(h);
      for (let k = 0; k < JOINT_COUNT; k++) {
        const r = k === 0 ? 0.016 : k % 5 === 4 ? 0.007 : 0.009;
        this.m.makeScale(r, r, r).setPosition(j[k * 3], j[k * 3 + 1], j[k * 3 + 2]);
        this.ghost.setMatrixAt(n++, this.m);
      }
    }
    this.ghost.count = n;
    this.ghost.instanceMatrix.needsUpdate = true;
  }

  private drawTitle(): void {
    const g = this.titleCanvas.getContext('2d')!;
    const p = this.run[this.index];
    g.clearRect(0, 0, 1024, 160);
    g.fillStyle = 'rgba(20,14,10,0.75)';
    g.fillRect(0, 0, 1024, 160);
    g.fillStyle = '#f6e7cf';
    g.textAlign = 'center';
    if (this.phase === 'done') {
      g.font = 'bold 56px serif';
      g.fillText(`All five caught. Day streak: ${this.progress.streak}`, 512, 72);
      g.font = '34px sans-serif';
      g.fillText('New shadows tomorrow. Press SKIP to play them again.', 512, 128);
    } else {
      g.font = 'bold 60px serif';
      const label = p.id === TUTORIAL.id ? 'Warm-up' : `Shadow ${this.index + 1 - (this.run[0].id === TUTORIAL.id ? 1 : 0)} of 5`;
      g.fillText(`${p.name}  ·  ${label}`, 512, 70);
      g.font = '36px sans-serif';
      g.fillText(this.phase === 'caught' ? 'Caught it.' : p.hint, 512, 128);
    }
    this.titleTex.needsUpdate = true;
  }

  private onCaught(): void {
    this.phase = 'caught';
    this.phaseTime = 0;
    this.caughtCount++;
    this.chimes.caught(this.index);
    this.drawTitle();
  }

  private advance(): void {
    const p = this.run[this.index];
    if (p.id === TUTORIAL.id) {
      this.progress.tutorialDone = true;
      saveProgress(this.progress);
    }
    if (this.index + 1 < this.run.length) {
      this.startPuzzle(this.index + 1);
      return;
    }
    // Daily run complete: update streak
    const today = dayKey();
    if (this.progress.lastDay !== today) {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      this.progress.streak = this.progress.lastDay === dayKey(y) ? this.progress.streak + 1 : 1;
      this.progress.best = Math.max(this.progress.best, this.progress.streak);
      this.progress.lastDay = today;
      saveProgress(this.progress);
    }
    this.phase = 'done';
    this.hold = 0;
    this.chimes.finale();
    this.drawTitle();
  }

  private press(id: 'hint' | 'skip' | 'recenter'): void {
    this.chimes.tick();
    if (id === 'hint') {
      this.hintOn = !this.hintOn;
    } else if (id === 'skip') {
      if (this.phase === 'done') {
        this.run = dailyRun(dayKey());
        this.startPuzzle(0);
      } else {
        this.advance();
      }
    } else {
      this.calibrate();
    }
  }

  // ---------------------------------------------------------------- input
  private calibrate(): void {
    this.player.head.getWorldPosition(this.v);
    if (this.v.y < 0.3) return; // no head pose yet
    this.rig.position.copy(this.v);
    this.rig.updateMatrixWorld(true);
    this.calibrated = true;
  }

  private readHands(): void {
    this.tracked[0] = this.tracked[1] = false;
    if (this.injected) {
      for (let h = 0; h < 2; h++) {
        const src = this.injected[h];
        if (src) {
          this.joints[h].set(src);
          this.radii[h].fill(0);
          this.tracked[h] = true;
        }
      }
      return;
    }
    const frame = this.world.xrFrame;
    const ref = this.world.xrReferenceSpace;
    const session = this.world.xrSession;
    if (!frame || !ref || !session) return;
    this.rig.updateMatrixWorld();
    this.m.copy(this.rig.matrixWorld).invert();
    const playerMat = this.world.player.matrixWorld;
    for (const source of session.inputSources) {
      const hand = source.hand;
      if (!hand) continue;
      const h = source.handedness === 'left' ? 0 : 1;
      let spaces = this.spaceCache.get(hand);
      if (!spaces) {
        spaces = JOINTS.map((name) => hand.get(name as XRHandJoint)!);
        this.spaceCache.set(hand, spaces);
      }
      let ok = true;
      const f = frame as XRFrame & {
        fillPoses?: (s: XRSpace[], b: XRSpace, t: Float32Array) => boolean;
        fillJointRadii?: (s: XRJointSpace[], r: Float32Array) => boolean;
      };
      if (f.fillPoses && f.fillJointRadii) {
        ok = f.fillPoses(spaces, ref, this.poseBuf) && f.fillJointRadii(spaces, this.radii[h]);
      } else {
        for (let k = 0; k < JOINT_COUNT; k++) {
          const pose = frame.getJointPose?.(spaces[k], ref);
          if (!pose) {
            ok = false;
            break;
          }
          this.poseBuf.set(pose.transform.matrix, k * 16);
          this.radii[h][k] = pose.radius ?? 0;
        }
      }
      if (!ok) continue;
      const out = this.joints[h];
      for (let k = 0; k < JOINT_COUNT; k++) {
        this.v.set(this.poseBuf[k * 16 + 12], this.poseBuf[k * 16 + 13], this.poseBuf[k * 16 + 14]);
        this.v.applyMatrix4(playerMat).applyMatrix4(this.m); // tracking -> world -> rig
        out[k * 3] = this.v.x;
        out[k * 3 + 1] = this.v.y;
        out[k * 3 + 2] = this.v.z;
      }
      this.tracked[h] = true;
    }
  }

  private checkButtons(dt: number): void {
    for (const b of this.buttons) {
      b.cooldown = Math.max(0, b.cooldown - dt);
      let near = false;
      for (let h = 0; h < 2; h++) {
        if (!this.tracked[h] || this.injected) continue;
        const j = this.joints[h];
        const dx = j[INDEX_TIP * 3] - b.pos.x;
        const dy = j[INDEX_TIP * 3 + 1] - (b.pos.y + 0.009);
        const dz = j[INDEX_TIP * 3 + 2] - b.pos.z;
        if (dx * dx + dz * dz < 0.035 * 0.035 && dy < 0.012 && dy > -0.03) near = true;
      }
      b.mesh.position.y = b.pos.y - (near ? 0.006 : 0);
      if (near && b.cooldown === 0) {
        b.cooldown = 0.9;
        this.press(b.id);
      }
    }
  }

  // ---------------------------------------------------------------- frame
  update(dt: number, time: number): void {
    const vis = this.visibilityState.peek();
    if (vis === VisibilityState.Hidden || vis === VisibilityState.VisibleBlurred) return; // clean pause

    if (this.calibrateSoon > 0 && --this.calibrateSoon === 0) this.calibrate();

    // Desktop attract mode: no XR session, so show the target pose casting.
    // The game does not advance in attract mode.
    const attract = vis === VisibilityState.NonImmersive && !this.injected;
    if (attract) {
      this.readDemoHands(time);
    } else {
      this.readHands();
    }
    this.checkButtons(dt);

    // Raster the live shadow
    this.live.clear();
    // Use the same authored finger widths as the targets. The headset's own joint
    // radii are larger and made the palm balloon ("boxing gloves"), so the live
    // shadow could never line up with the thinner target.
    for (let h = 0; h < 2; h++) if (this.tracked[h]) this.live.addHand(this.joints[h], null);
    this.live.finish();

    const p = this.run[this.index];
    matchSilhouettes(this.live, this.target, this.match);

    // Nearest-neighbour check against the other shapes, ~10 Hz
    this.nnTimer -= dt;
    if (this.nnTimer <= 0) {
      this.nnTimer = 0.1;
      let best = 0;
      for (const o of this.others) {
        if (o.id === p.id) continue;
        best = Math.max(best, matchSilhouettes(this.live, o.sil, this.tmpMatch).iou);
      }
      this.nnBest = best;
    }

    this.phaseTime += dt;
    if (attract) {
      this.hold = 0;
    } else if (this.phase === 'play') {
      const good =
        this.match.iou >= p.threshold && (p.id === TUTORIAL.id || this.match.iou >= this.nnBest + NN_MARGIN);
      this.hold = good ? this.hold + dt : Math.max(0, this.hold - dt * 2);
      if (this.hold >= HOLD_SECONDS) this.onCaught();
    } else if (this.phase === 'caught' && this.phaseTime >= CAUGHT_SECONDS) {
      this.advance();
    }

    // Outline follows the player's shadow (what you see is what is scored)
    const k = Math.min(1, dt * 10);
    if (this.live.area >= 20) {
      this.anchorX += (this.live.cxCell - this.anchorX) * k;
      this.anchorY += (this.live.cyCell - this.anchorY) * k;
      this.anchorS += (this.match.scale - this.anchorS) * k;
      this.anchorA += ((this.match.angle ?? 0) - this.anchorA) * k;
    }

    this.ghost.visible = this.hintOn && this.phase === 'play';
    this.composite(time);
  }

  private readDemoHands(time: number): void {
    const p = this.run[this.index];
    this.tracked[0] = this.tracked[1] = false;
    for (const h of p.hands) {
      const idx = h.handedness === 'left' ? 0 : 1;
      poseJoints(h, this.joints[idx]);
      const sway = Math.sin(time * 0.8) * 0.02;
      for (let k = 0; k < JOINT_COUNT; k++) this.joints[idx][k * 3] += sway;
      this.radii[idx].fill(0);
      this.tracked[idx] = true;
    }
  }

  private composite(time: number): void {
    const { nx, ny } = STAGE;
    const px = this.screenPixels;
    const caught = this.phase === 'caught';
    const pulse = caught ? 0.5 + 0.5 * Math.sin(this.phaseTime * 12) : 0;
    const holdFrac = Math.min(1, this.hold / HOLD_SECONDS);
    const flicker = 0.96 + 0.04 * Math.sin(time * 7.3) * Math.sin(time * 3.1);
    const showTarget = this.phase !== 'done';
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        let r = this.paper[i * 3] * flicker, g = this.paper[i * 3 + 1] * flicker, b = this.paper[i * 3 + 2] * flicker;
        if (showTarget) {
          const t = sampleTargetAt(x, y, this.target, this.anchorS, this.anchorX, this.anchorY, this.anchorA);
          if (t > 0) {
            // amber card outline; turns sea-green as the hold fills / when caught
            const a = 0.35 * t;
            const tr = caught ? 90 : 235 - 140 * holdFrac, tg = caught ? 220 : 170 + 40 * holdFrac, tb = caught ? 160 : 60 + 90 * holdFrac;
            r += (tr - r) * a;
            g += (tg - g) * a;
            b += (tb - b) * a;
          }
        }
        const s = this.live.mask[i];
        if (s > 0) {
          const dark = 1 - 0.88 * s;
          r *= dark;
          g *= dark;
          b *= dark;
        }
        if (caught) {
          r += 30 * pulse;
          g += 40 * pulse;
          b += 30 * pulse;
        }
        // hold bar along the bottom edge
        if (y < 3 && x / nx < holdFrac) {
          r = 250;
          g = 230;
          b = 170;
        }
        const o = i * 4;
        px[o] = r > 255 ? 255 : r;
        px[o + 1] = g > 255 ? 255 : g;
        px[o + 2] = b > 255 ? 255 : b;
        px[o + 3] = 255;
      }
    }
    this.screenTex.needsUpdate = true;
  }
}
