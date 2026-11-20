// Run against the built site, not the dev server. No physical phone is implied.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = new URL(process.argv[2]);
const unsupported = await chromium.launch({ args: ['--disable-gpu', '--disable-webgl', '--disable-features=WebGPU'] });
try {
  const page = await unsupported.newPage();
  const faults = [];
  page.on('pageerror', e => faults.push(e.message));
  await page.route('**/assets/index-*.js', route => route.abort(), { times: 1 });
  await page.goto(url.href);
  await page.getByText(/game files could not be loaded/).waitFor();
  await page.getByRole('link', { name: 'Retry launch' }).click();
  await page.getByText(/Enable graphics acceleration/).waitFor();
  assert.ok(await page.getByRole('link', { name: 'Retry launch' }).isVisible());
  assert.equal(await page.evaluate(() => typeof window.__GT3_DEBUG__), 'undefined');
  assert.deepEqual(faults, []);
  console.log('PASS: failed entry → retry downloaded the game; no 3D API → actionable launch screen, no substitute renderer');
} finally { await unsupported.close(); }

await mkdir('qa-artifacts/platforms', { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
try {
  // A successful draw call doesn't guarantee a picture. Deny every canvas
  // draw until the test releases it, without affecting the shadow target.
  const display = await browser.newPage({ viewport: { width: 800, height: 450 } });
  display.setDefaultTimeout(120_000);
  const displayErrors = [];
  display.on('pageerror', e => displayErrors.push(e.message));
  await display.addInitScript(() => {
    window.blackFrames = 0;
    window.blackAll = true;
    for (const method of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const draw = WebGL2RenderingContext.prototype[method];
      WebGL2RenderingContext.prototype[method] = function (...args) {
        if (window.blackAll && this.canvas.id === 'scene' && !this.getParameter(this.DRAW_FRAMEBUFFER_BINDING)) {
          this.clearColor(0, 0, 0, 1); this.clear(this.COLOR_BUFFER_BIT); window.blackFrames++; return;
        }
        return draw.apply(this, args);
      };
    }
  });
  const glURL = new URL('?renderer=webgl2', url);
  await display.route(glURL.href, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "worker-src 'none'" } });
  });
  await display.goto(glURL.href);
  await display.waitForFunction(() => window.blackFrames > 0 && window.__GT3_DEBUG__?.getState().frame >= 3);
  assert.equal(await display.locator('#loading').isVisible(), true, 'a black completed frame must not reveal the garage');
  await display.evaluate(() => { window.blackAll = false; });
  await display.waitForFunction(() => window.__GT3_DEBUG__?.getState().ready && document.querySelector('#loading').style.display === 'none');
  const range = await display.evaluate(() => {
    const tile = document.createElement('canvas'); tile.width = 32; tile.height = 20;
    const ctx = tile.getContext('2d'); ctx.drawImage(document.querySelector('#scene'), 0, 0, 32, 20);
    const rgb = ctx.getImageData(0, 0, 32, 20).data.filter((_, i) => i % 4 !== 3);
    return Math.max(...rgb) - Math.min(...rgb);
  });
  assert.ok(range > 40, `the actual canvas must recover from a transient blank frame: RGB range ${range}`);
  await display.evaluate(() => { window.blackAll = true; });
  await display.locator('[data-quality=ultra]').click();
  await display.getByText(/returned a blank picture/).waitFor();
  assert.equal(await display.evaluate(() => typeof window.__GT3_DEBUG__), 'undefined');
  assert.ok(await display.getByRole('link', { name: 'Retry launch' }).isVisible());
  assert.deepEqual(displayErrors, []);
  await display.close();
  console.log(`PASS: workers denied, transient blank frames → lit 3D garage (RGB range ${range}); persistent blank frames → launch options`);

  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  const page = await ctx.newPage(), faults = [], requests = [];
  page.setDefaultTimeout(120_000);
  page.on('pageerror', e => faults.push(e.message));
  page.on('console', m => { if (m.type() === 'error') faults.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) faults.push(`${r.status()} ${r.url()}`); });
  page.on('request', r => requests.push(new URL(r.url()).pathname));
  const ready = phase => page.waitForFunction(ph => {
    const s = window.__GT3_DEBUG__?.getState();
    return s?.phase === ph && s.ready && document.querySelector('#loading').style.display === 'none';
  }, phase).catch(async error => {
    console.error(`Waiting for ${phase}:`, await page.evaluate(() => {
      const s = window.__GT3_DEBUG__?.getState();
      return { phase: s?.phase, frame: s?.frame, ready: s?.ready, reason: s?.fallbackReason, progress: document.querySelector('#progress').textContent };
    }), faults);
    throw error;
  });
  await page.goto(new URL('downloads/apex-gt3-lite.html', url).href);
  await ready('garage');
  assert.equal(await page.evaluate(() => location.pathname), url.pathname);
  assert.equal(await page.evaluate(() => window.__GT3_DEBUG__.getState().settings.graphics), 'high');
  assert.equal(await page.locator('[data-quality=high]').getAttribute('aria-pressed'), 'true');
  await page.goto(new URL('?view=light', url).href);
  await ready('garage');
  const state = () => page.evaluate(() => window.__GT3_DEBUG__.getState());
  const garage = await state();
  assert.equal(garage.backend, 'WebGL2'); assert.equal(garage.wasmFreeBytes, null);
  assert.ok(!requests.some(p => /jolt-physics|\/assets\/(asphalt|terrain)\//.test(p)));
  assert.ok(await page.evaluate(() => matchMedia('(pointer: coarse)').matches));
  await page.locator('[data-action=start]').tap();
  await ready('race');
  const cdp = await ctx.newCDPSession(page);
  const gas = await page.locator('[data-touch=throttle]').boundingBox();
  const wheel = await page.locator('[data-touch=steer]').boundingBox();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
    { id: 1, x: wheel.x + wheel.width * .57, y: wheel.y + wheel.height / 2 },
    { id: 2, x: gas.x + gas.width / 2, y: gas.y + 9 },
  ] });
  await page.waitForFunction(() => { const s = window.__GT3_DEBUG__.getState(), p = s.drivers[0]; return s.speedKmh > 30 && p.throttle > .8 && p.steer > .018; });
  const moving = await state();
  assert.equal(moving.drivers.filter(d => d.speed > 0).length, 10);
  assert.equal(moving.nanDetected, false);
  await page.screenshot({ path: 'qa-artifacts/platforms/touch-chase.jpg', quality: 88 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.evaluate(() => {
    const gl = document.querySelector('#scene').getContext('webgl2');
    window.qaLost = gl.getExtension('WEBGL_lose_context'); window.qaLost.loseContext();
  });
  await page.getByText(/Graphics connection lost/).waitFor();
  const stopped = await state();
  assert.equal(stopped.phase, 'paused'); assert.equal(stopped.ready, false);
  await page.evaluate(() => window.qaLost.restoreContext());
  await ready('paused');
  assert.equal((await state()).elapsed, stopped.elapsed);
  await page.getByRole('button', { name: 'Resume session' }).tap(); await ready('race');
  await page.waitForFunction(t => window.__GT3_DEBUG__.getState().elapsed > t && window.__GT3_DEBUG__.getState().drivers[0].throttle < .1, stopped.elapsed);
  assert.deepEqual(faults, []);
  console.log(`PASS: legacy links → High 3D, two-thumb driving at ${moving.speedKmh.toFixed(1)} km/h, ten moving cars; graphics loss paused and restored the same race`);
} finally { await browser.close(); }

const gpuBrowser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--use-vulkan=swiftshader', '--enable-features=Vulkan'] });
try {
  const page = await gpuBrowser.newPage({ viewport: { width: 800, height: 450 } });
  page.setDefaultTimeout(120_000);
  const faults = [];
  page.on('pageerror', e => faults.push(e.stack));
  page.on('console', m => { if (m.type() === 'error' || /GPUValidationError/i.test(m.text())) faults.push(m.text()); });
  await page.addInitScript(() => {
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) { return window.testDevice = await request.apply(this, args); };
  });
  await page.goto(new URL('?qa=1&autostart=1', url).href);
  await page.waitForFunction(() => window.__GT3_DEBUG__?.getState().ready);
  const state = () => page.evaluate(() => window.__GT3_DEBUG__.getState());
  await page.evaluate(() => { window.__GT3_DEBUG__.freeze(true); window.__GT3_DEBUG__.step(360); });
  const before = await state();
  assert.equal(before.backend, 'WebGPU'); assert.ok(before.speedKmh > 30);
  await page.evaluate(() => window.testDevice.destroy());
  await page.waitForFunction(() => { const s = window.__GT3_DEBUG__.getState(); return s.backend === 'WebGL2' && s.phase === 'paused' && s.ready; });
  const after = await state();
  assert.equal(after.elapsed, before.elapsed); assert.deepEqual(after.drivers, before.drivers);
  await page.getByRole('button', { name: 'Resume session' }).click();
  await page.evaluate(() => window.__GT3_DEBUG__.step(120));
  await page.keyboard.press('c');
  const resumed = await state();
  assert.equal(resumed.phase, 'race'); assert.equal(resumed.camera, 'cockpit');
  assert.ok(resumed.drivers.every((d, i) => d.distance > before.drivers[i].distance));
  assert.deepEqual(faults, []);
  console.log('PASS: lost a live WebGPU device, rebuilt on WebGL2, preserved all ten cars and the race clock, resumed driving');
} finally { await gpuBrowser.close(); }
