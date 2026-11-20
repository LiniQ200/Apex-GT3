import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const url =
  process.env.QA_URL ?? JSON.parse(await readFile('.amp/portals/gt3-sim.json', 'utf8')).links[0].url;
const full = process.argv.includes('--full-profile'),
  gpu = process.argv.includes('--webgpu') || (full && !process.argv.includes('--webgl2')),
  dir = full ? `qa-artifacts/full-profile${gpu ? '' : '-webgl2'}` : gpu ? 'qa-artifacts/webgpu' : 'qa-artifacts';
await mkdir(dir, { recursive: true });
const args = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
];
if (gpu) args.push('--enable-unsafe-webgpu', '--use-vulkan=swiftshader', '--enable-features=Vulkan');
const browser = await chromium.launch({ args }),
  context = await browser.newContext({
    viewport: full ? { width: 800, height: 450 } : { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
if (!gpu) await context.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
const page = await context.newPage();
page.setDefaultTimeout(120000);
const faults = [],
  assets = new Set(),
  frames = [];
let lastError;
page.on('pageerror', (e) => {
  faults.push(String(e));
  console.log('pageerror', String(e));
  lastError = e;
});
page.on('console', (m) => {
  if (
    m.type() === 'error' ||
    (m.type() === 'warning' &&
      /GPUValidationError|destroyed texture|invalid (?:renderpipeline|commandbuffer)|error while parsing WGSL|GL_INVALID_|incomplete framebuffer|feedback loop formed/i.test(m.text()))
  ) {
    faults.push(m.text());
    console.log('renderer error', m.text().slice(0, 680));
  } else if (m.type() === 'warning') console.log('console.warn', m.text().slice(0, 240));
});
page.on('response', (r) => {
  const { pathname: path, protocol, origin } = new URL(r.url());
  if ((protocol === 'https:' || protocol === 'http:') && origin !== new URL(url).origin)
    faults.push(`unexpected runtime download: ${origin}${path}`);
  if (r.status() >= 400) {
    faults.push(`${r.status()} ${path}`);
    console.log(faults.at(-1));
  }
  if (/^\/assets\/(draco|models|skies|asphalt|concrete|kerb|terrain|gravel|bark|metal|foliage|kit|biome)\//.test(path)) assets.add(path);
});
page.on('requestfailed', (r) => {
  if (r.failure()?.errorText !== 'net::ERR_ABORTED') faults.push(`${r.failure()?.errorText} ${r.url()}`);
});
const state = () => page.evaluate(() => window.__GT3_DEBUG__.getState());
async function ready(phase) {
  await page.waitForFunction(
    (phase) => {
      const s = window.__GT3_DEBUG__?.getState();
      return s?.ready && (!phase || s.phase === phase);
    },
    phase,
    { timeout: 120000 },
  );
  if (lastError) throw lastError;
}
async function shot(name) {
  await ready();
  const before = (await state()).frame;
  await page.waitForFunction((n) => window.__GT3_DEBUG__.getState().frame > n + 1, before);
  const png = await page.screenshot({ path: `${dir}/${name}.png`, timeout: 90000 });
  // Sample the 3D viewport, not the DOM overlays. GPU validation alone won't
  // detect black color output from a valid draw.
  const lit = await page.evaluate(async (data) => {
    const im = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const ctx = new OffscreenCanvas(32, 24).getContext('2d');
    ctx.drawImage(im, im.width * 0.25, im.height * 0.28, im.width * 0.45, im.height * 0.38, 0, 0, 32, 24);
    const px = ctx.getImageData(0, 0, 32, 24).data;
    im.close();
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.max(px[i], px[i + 1], px[i + 2]) > 24) n++;
    return n / (32 * 24);
  }, png.toString('base64'));
  assert.ok(lit > 0.15, `${name}: only ${(100 * lit).toFixed(1)}% of the central scene is lit`);
  const s = await state();
  if (s.settings.graphics === 'high') {
    const buffer = await page.locator('#scene').evaluate(c => [c.width, c.height]);
    assert.deepEqual(buffer, [page.viewportSize().width, page.viewportSize().height], `${name}: High must retain native pixels at DPR 1`);
  }
  frames.push({
    name,
    backend: s.backend,
    phase: s.phase,
    camera: s.camera,
    weather: s.settings.weather,
    elapsed: s.elapsed,
    speed: s.speedKmh,
    position: s.drivers[0].s,
    brake: s.drivers[0].brake,
    temperatures: s.drivers[0].brakeTempC,
    compression: s.wheelCompressionM,
  });
  console.log(name, s.phase, s.camera, s.speedKmh.toFixed(1), 'km/h');
}
try {
  await page.goto(new URL('?qa=1', url).href);
  await ready('garage');
  await page.evaluate(() => document.fonts.ready);
  const garage = await state();
  assert.equal(garage.backend, gpu ? 'WebGPU' : 'WebGL2');
  assert.equal(garage.settings.graphics, 'high');
  await shot('01-garage-showroom');
  if (gpu || full) {
    await page.goto(new URL('?autostart=1&qa=1', url).href);
    await ready('race');
    assert.equal((await state()).backend, garage.backend);
    const name = garage.backend.toLowerCase();
    await shot(`${name}-grid`);
    if (full) {
      await page.evaluate(() => {
        const game = window.__GT3_DEBUG__;
        game.freeze(true);
        game.step(Math.max(0, Math.round((4.5 - game.getState().elapsed) * 120)));
        game.setCamera('cockpit');
      });
      await shot(`${name}-cockpit`);
      // The first picture after a long simulation frame must show the same
      // wheel and dash as a second draw of that exact pose. Exclude HUD, live
      // instruments and mirrors. A stationary screenshot misses this regression.
      const cabin = await page.evaluate(async () => {
        const game = window.__GT3_DEBUG__, canvas = document.querySelector('#scene');
        const ctx = new OffscreenCanvas(96, 48).getContext('2d', { willReadFrequently: true });
        async function sample() {
          await new Promise(requestAnimationFrame);
          const { width: w, height: h } = canvas;
          ctx.drawImage(canvas, 0.32*w, 0.715*h, 0.36*w, 0.26*h, 0, 0, 96, 48);
          return ctx.getImageData(0, 0, 96, 48).data;
        }
        game.step(30);
        const first = await sample(), second = await sample();
        let delta = 0, level = 0;
        for (let i = 0; i < first.length; i++) if (i % 4 !== 3) {
          delta += Math.abs(first[i] - second[i]);
          level += second[i];
        }
        game.freeze(false);
        return { delta: delta / (96*48*3), level: level / (96*48*3), speed: game.getState().speedKmh };
      });
      assert.ok(cabin.speed > 100 && cabin.level > 10 && cabin.delta < 2,
        `${name}: the moving cockpit changed between identical poses: ${JSON.stringify(cabin)}`);
      await page.evaluate(() => {
        window.__GT3_DEBUG__.setWeather('damp');
        window.__GT3_DEBUG__.setCamera('hood');
      });
      await shot(`${name}-damp`);
      await page.evaluate(() => {
        window.__GT3_DEBUG__.setWeather('rain');
        window.__GT3_DEBUG__.setCamera('chase');
      });
      await shot(`${name}-rain`);
      await page.keyboard.press('Escape');
      await ready('paused');
      await page.getByRole('button', { name: 'Resume session' }).click();
      await ready('race');
    }
  } else {
    // Record real input on the live garage, including a neighbour on either side of the chosen swatch.
    await page.screencast.start({
      path: `${dir}/garage-controls.webm`,
      size: { width: 1280, height: 720 },
      fps: 18,
    });
    await page.screencast.showActions({ cursor: 'pointer', duration: 350, style: { title: 'display:none' } });
    await page.evaluate(() => {
      const cursor = document.createElement('div');
      cursor.style.cssText =
        'position:fixed;inset:0 auto auto 0;width:18px;height:24px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 1px 2px black)';
      cursor.innerHTML =
        '<svg viewBox="0 0 18 24"><path d="M1 1v20l5-5 4 7 3-2-4-7h8z" fill="white" stroke="#181818"/></svg>';
      cursor.id = 'qa-recorded-pointer';
      document.body.append(cursor);
      document.addEventListener(
        'pointermove',
        (e) => (cursor.style.transform = `translate(${e.clientX}px,${e.clientY}px)`),
      );
    });
    const moveTo = async (locator) => {
      const box = await locator.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
      await page.waitForTimeout(320);
    };
    for (const i of [1, 2, 3]) await moveTo(page.locator(`[data-livery="${i}"]`));
    await page.locator('[data-livery="3"]').click();
    await ready('garage');
    assert.equal((await state()).settings.livery, 3);
    await page.waitForFunction((n) => window.__GT3_DEBUG__.getState().frame > n + 3, (await state()).frame);
    await page.waitForTimeout(1000);
    await moveTo(page.locator('[data-help]').first());
    await page.locator('[data-help]').first().click();
    assert.equal(await page.locator('dialog').evaluate((el) => el.open), true);
    await page.waitForFunction((n) => window.__GT3_DEBUG__.getState().frame > n + 3, (await state()).frame);
    await page.keyboard.press('Escape');
    await page.waitForFunction((n) => window.__GT3_DEBUG__.getState().frame > n + 1, (await state()).frame);
    await page.screencast.stop();
    await page.screencast.hideActions();
    await page.locator('#qa-recorded-pointer').evaluate((el) => el.remove());
    await page.getByRole('button', { name: 'Drive — Start session' }).click();
    await ready('lights');
    let s = await state();
    assert.equal(s.drivers.length, 10);
    await page.evaluate(() => window.__GT3_DEBUG__.freeze(true));
    await page.keyboard.press('r');
    assert.ok(Math.abs((await state()).drivers[0].d + 2.8) < 0.01, 'reset during lights must keep the grid box');
    await page.keyboard.press('Escape');
    assert.equal((await state()).phase, 'paused');
    await page.getByRole('button', { name: 'Resume session' }).click();
    await page.evaluate(() => window.__GT3_DEBUG__.step(540));
    assert.equal((await state()).phase, 'race');
    await page.keyboard.down('w');
    await page.evaluate(() => window.__GT3_DEBUG__.step(180));
    assert.ok((await state()).speedKmh > 25);
    await page.keyboard.up('w');
    await page.keyboard.press('c');
    assert.equal((await state()).camera, 'cockpit');
    await page.keyboard.press('r');
    assert.ok((await state()).speedKmh < 5);
    await page.goto(new URL('?autostart=1&qa=1', url).href);
    await ready('race');
    await page.evaluate(() => window.__GT3_DEBUG__.freeze(true));
    s = await state();
    assert.equal(s.autopilot, true);
    await shot('02-grid-golden-hour-chase');
    await page.evaluate(() => {
      const d = window.__GT3_DEBUG__;
      d.step(240);
      d.setCamera('cockpit');
    });
    await shot('03-cockpit-hud');
    await page.evaluate(() => {
      const d = window.__GT3_DEBUG__;
      d.setWeather('damp');
      d.setCamera('hood');
    });
    await shot('04-overcast-hood');
    await page.evaluate(() => {
      const d = window.__GT3_DEBUG__;
      d.setWeather('golden');
      d.setCamera('tv');
    });
    await ready();
    // Drive the same 120 Hz accumulator deterministically so the camera shutter lands
    // during braking rather than a variable number of desktop/SwiftShader frames later.
    const soak = await page.evaluate(() => {
      const d = window.__GT3_DEBUG__;
      let s = d.getState(),
        min = 1,
        max = 0,
        brakingInTurnOne = false;
      for (let i = 0; i < 2400; i++) {
        d.step(1);
        s = d.getState();
        min = Math.min(min, ...s.wheelCompressionM);
        max = Math.max(max, ...s.wheelCompressionM);
        const p = s.drivers[0];
        brakingInTurnOne = p.s >= 660 && p.s < 705 && p.brake > 0.1 && Math.max(...p.brakeTempC) >= 320;
        if (brakingInTurnOne) break;
      }
      return {
        min,
        max,
        brakingInTurnOne,
        elapsed: s.elapsed,
        temperature: s.maxBrakeTempC,
        peak: s.peakSpeedKmh,
        gear: s.maxGearReached,
        nan: s.nanDetected,
      };
    });
    assert.ok(soak.brakingInTurnOne, 'did not capture the player braking at the Turn 1 camera');
    await shot('05-turn1-braking-glow');
    console.log('autopilot', soak);
    assert.ok(
      soak.peak >= 185 && soak.gear >= 4 && soak.temperature >= 320 && !soak.nan,
      JSON.stringify(soak),
    );
    assert.ok(soak.min > 0.005 && soak.max < 0.22, JSON.stringify(soak));
    // The first cold-disc stop needn't glow in daylight. Photograph a warm stop
    // from the side on lap two without changing the temperature or the camera.
    const warmStop = await page.evaluate(() => {
      const d = window.__GT3_DEBUG__;
      for (let i = 0; i < 30 && d.getState().lap === 1; i++) d.step(600);
      for (let i = 0; i < 80 && d.getState().drivers[0].s < 640; i++) d.step(45);
      for (let i = 0; i < 700; i++) {
        const s = d.getState(), p = s.drivers[0];
        if (s.lap !== 2 || p.s > 695) break;
        if (p.s >= 675 && p.brake > 0.1 && Math.min(...p.brakeTempC.slice(0, 2)) > 600) return true;
        d.step(1);
      }
      return false;
    });
    assert.ok(warmStop, 'did not reach a warm braking application at Turn 1');
    await shot('05b-warm-turn1-discs');
    const finish = await page.evaluate(() => {
      const d = window.__GT3_DEBUG__;
      for (let n = 0; n < 48 && d.getState().phase === 'race'; n++) d.step(1200);
      return d.getState();
    });
    assert.equal(finish.phase, 'finished');
    const results = page.locator('[data-section="finished"]');
    await results.waitFor({ state: 'visible' });
    assert.equal(await results.locator('tbody tr').count(), 10);
    const place = await results.locator('tr.is-player td').first().innerText();
    assert.equal(await results.locator('[data-finish-place]').innerText(), `P${Number(place)}`);
    assert.ok(await results.locator('.ax-result-scroll').evaluate(el => el.scrollHeight <= el.clientHeight + 1),
      'all ten result rows should fit at 1280×720 without scrolling');
    await page.screenshot({ path: `${dir}/06-classification.png` });
    await page.setViewportSize({ width: 740, height: 400 });
    const lastRow = results.locator('tbody tr').last();
    await lastRow.scrollIntoViewIfNeeded();
    assert.ok(await lastRow.evaluate(row => {
      const b = row.getBoundingClientRect(), list = row.closest('.ax-result-scroll').getBoundingClientRect();
      return b.top >= list.top - 1 && b.bottom <= list.bottom + 1;
    }), 'the last driver must be reachable on a short screen');
    assert.ok(await results.locator('[data-action="garage"]').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight),
      'result actions must stay on screen while scrolling the field');
    await page.screenshot({ path: `${dir}/06b-compact-classification.png` });
    await writeFile(
      `${dir}/telemetry.json`,
      JSON.stringify(
        { url, adapter: garage.adapter, soak, frames, classification: await results.locator('tbody').innerText(), assets: [...assets].sort(), faults },
        null,
        2,
      ),
    );
  }
  const required = [
    'models/ferrari_base.glb',
    'models/car_concept_base.glb',
    'draco/draco_decoder.wasm',
    'skies/golden_hour.env',
    'foliage/mediterranean-atlas.webp',
    'kit/botanical.glb',
    'kit/trackside.glb',
    'biome/rock_moss.glb',
    'biome/fern.glb',
    'biome/shrub.glb',
    'biome/grass_clump.glb',
    'bark/normal.jpg',
    ...['asphalt', 'concrete', 'terrain', 'kerb', 'gravel', 'metal'].flatMap((s) =>
      ['albedo', 'normal', 'orm'].map((k) => `${s}/${k}.jpg`),
    ),
  ];
  if (!gpu || full) required.push('skies/overcast_race.env');
  if (full) required.push('skies/heavy_rain.env');
  for (const file of required) assert.ok(assets.has('/assets/' + file), `Missing request ${file}`);
  assert.deepEqual(faults, []);
  console.log(
    `PASS ${garage.backend}: ${frames.length} rendered states captured; 0 page, console, GPU validation or HTTP failures; ${assets.size} asset paths.`,
  );
} catch (e) {
  console.log(
    'At failure:',
    await page
      .locator('#progress')
      .textContent()
      .catch(() => ''),
    faults.slice(0, 3),
  );
  throw e;
} finally {
  await browser.close();
}
