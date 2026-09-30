// Headless smoke test for Shadow Parlor.
//   Part A: production build (dist/) loads in Chromium with no errors and the
//           desktop attract mode renders a shadow.
//   Part B: dev server with the IWER emulator (Quest 2 profile): enter an
//           emulated XR session in hand mode, confirm hands are tracked, then
//           feed each target pose and confirm the whole daily run completes.
// Usage: node tools/smoke.mjs   (run `npm run build` first)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const EXE = process.env.CHROME_PATH || '/opt/pw-browsers/chromium';
const OUT = 'tools/smoke-out';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

function startServer(args, readyRe) {
  const proc = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, BROWSER: 'none' } });
  procs.push(proc);
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      if (readyRe.test(buf)) resolve(proc);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    setTimeout(() => reject(new Error('server did not start:\n' + buf.slice(-2000))), 90000);
  });
}

const procs = [];
const killAll = () => procs.forEach((p) => { try { process.kill(-p.pid, 'SIGTERM'); } catch {} });
process.on('exit', killAll);
const IGNORE = [/favicon/i, /Download the React DevTools/i];
function watch(page, errors) {
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORE.some((r) => r.test(m.text()))) errors.push('console: ' + m.text());
  });
}

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors'],
});

// ---------------- Part A: production build
{
  const server = await startServer(['vite', 'preview', '--port', '4173', '--strictPort'], /localhost:4173/);
  const actx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await actx.newPage();
  const errors = [];
  watch(page, errors);
  // the IWSDK vite plugin serves preview over HTTPS (WebXR needs a secure context)
  await page.goto('https://localhost:4173/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__parlor, null, { timeout: 30000 });
  await sleep(2500);
  const st = await page.evaluate(() => window.__parlor.state());
  await page.screenshot({ path: `${OUT}/A-desktop-attract.png` });
  check('A1 production build boots, system registered', !!st, JSON.stringify(st));
  check('A2 attract mode casts a shadow that matches its own target', st.iou > 0.9, `iou=${st.iou}`);
  check('A3 attract mode does not advance the game', st.caught === 0 && st.phase === 'play');
  check('A4 no console/page errors (prod)', errors.length === 0, errors.slice(0, 5).join(' | '));
  await actx.close();
  process.kill(-server.pid, 'SIGTERM');
}

// ---------------- Part B: dev server + IWER (Quest 2 profile)
{
  const server = await startServer(['vite', '--port', '8081', '--strictPort'], /Local:.*8081/);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  watch(page, errors);
  let url = 'https://localhost:8081/';
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  } catch {
    url = 'http://localhost:8081/';
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  }
  await page.waitForFunction(() => window.__parlor && window.__world, null, { timeout: 60000 });
  const device = await page.evaluate(() => {
    const d = window.IWER_DEVICE;
    return d ? { name: d.name, deviceName: d.deviceName, fov: d.fovy } : null;
  });
  check('B1 IWER emulator injected', !!device, JSON.stringify(device));

  await page.evaluate(() => {
    window.IWER_DEVICE.primaryInputMode = 'hand';
  });
  // Entering XR needs a user gesture in real browsers; click the page first.
  await page.mouse.click(640, 400);
  await page.evaluate(() => window.__world.launchXR());
  await page.waitForFunction(() => window.__parlor.state().visibility === 'visible', null, { timeout: 30000 }).catch(() => {});
  await sleep(1500);
  let st = await page.evaluate(() => window.__parlor.state());
  check('B2 emulated XR session is visible', st.visibility === 'visible', `visibility=${st.visibility}`);
  check('B3 hand tracking delivers joints (at least one hand)', st.tracked.some(Boolean), `tracked=${st.tracked}`);
  await page.screenshot({ path: `${OUT}/B-xr-emulated-hands.png` });

  // Drive the whole run by injecting each target pose (with small jitter)
  const runLength = st.runLength;
  let caughtAll = true;
  let negativeDone = false;
  for (let i = 0; i < runLength; i++) {
    const cur = await page.evaluate(() => window.__parlor.state());
    if (!negativeDone && !['open-hand', 'moth', 'gate'].includes(cur.puzzle)) {
      // Negative test: the wrong shape must NOT be accepted
      const wrong = cur.puzzle === 'stone' ? 'hare' : 'stone';
      await page.evaluate((w) => window.__parlor.injectPuzzlePose(w), wrong);
      await sleep(2500);
      const s2 = await page.evaluate(() => window.__parlor.state());
      check(`B6 wrong shape (${wrong}) is rejected for target ${cur.puzzle}`, s2.caught === cur.caught, `iou=${s2.iou} nnBest=${s2.nnBest}`);
      negativeDone = true;
    }
    await page.evaluate(() => window.__parlor.injectTargetPose(0.004));
    const ok = await page
      .waitForFunction((n) => window.__parlor.state().caught >= n, i + 1, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    const s = await page.evaluate(() => window.__parlor.state());
    if (i === 0) await page.screenshot({ path: `${OUT}/B-caught-first.png` });
    if (!ok) {
      caughtAll = false;
      check(`B4.${i} caught ${s.puzzle}`, false, JSON.stringify(s));
      break;
    }
    // wait for the caught animation to finish and the next puzzle to load
    await page.waitForFunction((n) => {
      const x = window.__parlor.state();
      return x.phase !== 'caught';
    }, i, { timeout: 5000 }).catch(() => {});
  }
  st = await page.evaluate(() => window.__parlor.state());
  check('B4 full daily run completes by matching shapes', caughtAll && st.phase === 'done', JSON.stringify(st));
  check('B5 streak recorded', st.streak >= 1, `streak=${st.streak}`);
  await page.screenshot({ path: `${OUT}/B-run-done.png` });

  await page.evaluate(() => window.__parlor.clearInjection());
  check('B7 no console/page errors (dev+IWER)', errors.length === 0, errors.slice(0, 5).join(' | '));
  await ctx.close();
  process.kill(-server.pid, 'SIGTERM');
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
