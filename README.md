# Shadow Parlor

Hands-only, seated shadow puppet puzzles for Meta Quest. WebXR, built on Meta's Immersive Web SDK (IWSDK 1.0.0-rc.2).

## Run it

```bash
npm install
npm run dev:runtime   # plain Vite dev server, https://localhost:8081, IWER emulator (Quest 2 profile) injected
npm run typecheck
npm run build         # static site in dist/
npm run smoke         # headless Chromium: prod build boots + emulated XR run completes (needs a build first)
npm run targets       # ASCII previews of every target shadow + a shape-confusion matrix
```

`npm run dev` starts the IWSDK-managed browser/editor workspace. It's heavier; `dev:runtime` is enough day to day.

On the headset: open the hosted URL (or `https://<your-PC-LAN-IP>:8081` while dev is running and accept the certificate warning) in Meta Quest Browser, put the controllers down, and press Enter VR.

## How it works

| File | What it does |
|---|---|
| `src/parlor-system.ts` | Game loop: builds the room, reads the 25 WebXR hand joints per hand, draws the shadow, scores it, handles hold-to-catch, poke buttons, daily run, streak |
| `src/silhouette.ts` | Projects the joints from the lamp onto the paper, rasterizes soft capsules on the CPU (128x96), IoU match with position/size normalization |
| `src/hand-model.ts` | Small forward-kinematics hand used to author target poses |
| `src/puzzles.ts` | Shape pool, warm-up, seeded "daily five" |
| `src/sound.ts` | WebAudio chimes (placeholder for real foley) |
| `tools/smoke.mjs` | Playwright smoke test |

The same raster is what you see and what gets scored, so the screen never lies about how close you are. A shape only counts if it beats every other shape in the pool by a small margin, so a fist can't pass for a candle.

Debug hook for tests: `window.__parlor.state()`, `injectTargetPose()`, `injectPuzzlePose(id)`, `clearInjection()`.
