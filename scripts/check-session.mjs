// node scripts/check-session.mjs <URL of a locally served scratch build>
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const gameURL = new URL(process.argv[2]);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(gameURL.hostname), 'use a private scratch server');
gameURL.searchParams.set('qa', '1');
gameURL.searchParams.delete('autostart');
const host = new URL('_session-check', gameURL);
const browser = await chromium.launch({ args: [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist',
] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.setDefaultTimeout(90_000);
  const faults = [];
  page.on('pageerror', (e) => faults.push(e.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
    window.sessionAudio = [];
    window.AudioContext = class extends AudioContext {
      constructor(...args) { super(...args); window.sessionAudio.push(this); }
      calls = { start: 0, stop: 0, disconnect: 0 };
      observe(source) {
        for (const key of Object.keys(this.calls)) {
          const perform = source[key].bind(source);
          source[key] = (...args) => { this.calls[key]++; return perform(...args); };
        }
        return source;
      }
      createOscillator() { return this.observe(super.createOscillator()); }
      createBufferSource() { return this.observe(super.createBufferSource()); }
      createStereoPanner() {
        if (window.sessionAudio.length === 1) throw Error('fixture: first audio device failed');
        return super.createStereoPanner();
      }
    };
  });
  await page.route(host.href, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
    <button>Outside game</button><iframe name="sim" allow="gamepad 'none'" style="width:99%;height:90vh"></iframe>` }));
  await page.goto(host.href);
  await page.locator('iframe').evaluate((el, url) => { el.src = url; }, gameURL.href);
  const game = page.frame({ name: 'sim' });
  const state = () => game.evaluate(() => window.__GT3_DEBUG__.getState());
  const ready = (phase) => game.waitForFunction((p) => {
    const s = window.__GT3_DEBUG__?.getState();
    return s?.ready && s.phase === p && document.querySelector('#loading').style.display === 'none';
  }, phase);
  await game.waitForFunction(() => window.__GT3_DEBUG__ || /gamepad/i.test(document.querySelector('#progress')?.textContent));
  assert.ok(await game.evaluate(() => !!window.__GT3_DEBUG__), await game.locator('#progress').textContent());
  await ready('garage');
  assert.equal(await game.evaluate(() => document.featurePolicy.allowsFeature('gamepad')), false);
  await game.evaluate(() => window.__GT3_DEBUG__.freeze(true));
  await game.locator('select[data-setting="mode"]').selectOption('hotlap');
  await game.locator('[data-action="start"]').click();
  await ready('lights');
  const checkStopped = ({ start, stop, disconnect }) => {
    assert.ok(start > 0, 'expected sources to have actually started');
    assert.equal(stop, start);
    assert.equal(disconnect, start);
  };
  checkStopped(await game.evaluate(() => window.sessionAudio[0].calls));
  await page.keyboard.press('Escape');
  await ready('paused');
  await game.locator('[data-action="resume"]').click();
  assert.equal((await state()).phase, 'lights');
  await game.evaluate(() => window.__GT3_DEBUG__.step(540));
  await page.keyboard.down('ArrowUp');
  await game.evaluate(() => window.__GT3_DEBUG__.step(180));
  const driving = await state();
  assert.ok(driving.speedKmh > 25, `keyboard in denied embed: ${driving.speedKmh} km/h`);

  await page.getByText('Outside game').click(); // keyup goes to the parent, not the game
  await page.keyboard.up('ArrowUp');
  await ready('paused');
  await game.evaluate(() => window.__GT3_DEBUG__.step(60));
  assert.equal((await state()).elapsed, driving.elapsed);
  await game.evaluate(() => window.sessionAudio.at(-1).suspend());
  await game.locator('[data-action="resume"]').click();
  await game.waitForFunction(() => window.sessionAudio.at(-1).state === 'running');
  await game.evaluate(() => window.__GT3_DEBUG__.step(1));
  assert.equal((await state()).drivers[0].throttle, 0);
  // Exercise both PageTransitionEvent branches regardless of host BFCache eligibility.
  await game.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await ready('paused');
  await game.locator('[data-section="paused"] [data-action="restart"]').click();
  await ready('lights');
  assert.equal((await state()).elapsed, 0);
  await page.keyboard.press('Escape');
  await ready('paused');
  await game.locator('[data-section="paused"] [data-action="garage"]').click();
  await ready('garage');
  await game.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });
  checkStopped(await game.evaluate(() => window.sessionAudio.at(-1).calls));
  assert.deepEqual(await game.evaluate(() => window.sessionAudio.map((c) => c.state)), ['closed', 'closed']);
  assert.equal(await game.evaluate(() => typeof window.__GT3_DEBUG__), 'undefined');

  await page.route('**/models/ferrari_base.glb', (route) => route.fulfill({ status: 503, body: 'fixture' }));
  await page.goto(gameURL.href);
  await page.waitForFunction(() => document.querySelector('#progress')?.textContent.includes('503'));
  assert.equal(await page.evaluate(() => typeof window.__GT3_DEBUG__), 'undefined');
  assert.deepEqual(faults, []);
  console.log(`PASS: denied gamepad, ${driving.speedKmh.toFixed(1)} km/h on keys, pause/resume, restart, garage, cache/exit, audio, failed boot`);
} finally {
  await browser.close();
}
