import { GraphicsUnavailable } from './engine/view';
import { createCircuit } from './track/circuit';
import { TrackSurfaceGrid, weatherBaseWetness, weatherSurfaceTempC } from './track/surfaceState';
import { createAudio } from './audio';
import { createUI } from './ui';
import { rememberSetup, restoreSetup } from './ui/settings';
import { createWorld, STEP } from './physics/world';
import { createRace, createRaceState, driver } from './physics/race';
import { controls } from './controls';
import type { Settings, UiActions, CameraMode, Weather, PitStrategy } from './types';

const progress = (s: string) => {
  const e = document.getElementById('progress');
  if (e) e.textContent = s;
};
const lifetime = new AbortController();
const releases: (() => void)[] = [];
function onDispose(release: () => void) {
  // An async acquisition (notably Jolt) can finish after its sibling failed or the page left.
  if (lifetime.signal.aborted) release();
  else releases.push(release);
}
function dispose() {
  if (lifetime.signal.aborted) return;
  lifetime.abort();
  while (releases.length) {
    try {
      releases.pop()!();
    } catch (e) {
      console.error('Session cleanup failed', e);
    }
  }
}
window.addEventListener('pagehide', (e) => {
  if (!e.persisted) dispose();
}, { signal: lifetime.signal });

async function boot() {
  const query = new URLSearchParams(location.search),
    qa = query.get('qa') === '1';
  const compatibility = query.get('renderer') === 'webgl2';
  const alternate = document.querySelector<HTMLAnchorElement>('#alternate-renderer')!;
  const launch = new URL(location.href);
  if (compatibility) {
    launch.searchParams.delete('renderer');
    alternate.textContent = 'Use automatic graphics';
  } else launch.searchParams.set('renderer', 'webgl2');
  alternate.href = launch.href;
  progress('Loading the 3D engine');
  const studio = import('./engine/studioView');
  const circuit = createCircuit(),
    surfaceGrid = new TrackSurfaceGrid(circuit),
    { createStudioView } = await studio;
  progress(compatibility ? 'Starting WebGL 2' : 'Connecting to the graphics device');
  let view = await createStudioView(document.querySelector('#scene')!, circuit, compatibility ? 'WebGL2 launch' : '');
  onDispose(() => view.dispose());
  if (lifetime.signal.aborted) return;
  const s = createRaceState(view.backend), audio = createAudio();
  onDispose(audio.dispose);
  restoreSetup(s.settings);
  view.quality(s.settings.graphics);
  let world: Awaited<ReturnType<typeof createWorld>> | undefined,
    race: ReturnType<typeof createRace> | undefined,
    ticket = 0,
    busy = false,
    graphicsLost = false,
    acc = 0,
    frames = 0,
    frozen = false,
    prior: 'race' | 'lights' = 'race';
  const curtain = document.querySelector<HTMLElement>('#loading')!;
  const uiRoot = document.createElement('div');
  document.querySelector('#ui')!.append(uiRoot);
  onDispose(() => uiRoot.remove());
  function wait(label: string) {
    busy = true;
    input.clear();
    uiRoot.inert = true;
    curtain.style.display = 'grid';
    progress(label);
    return ++ticket;
  }
  async function verifyPicture(token = ticket) {
    try { await view.confirmPicture(); }
    catch (error) {
      if (token !== ticket || lifetime.signal.aborted) return;
      if (error instanceof GraphicsUnavailable && view.backend === 'WebGPU') await replaceLostDevice(error.message);
      else throw error;
    }
  }
  async function reveal(token: number) {
    await verifyPicture(token);
    if (token !== ticket) return;
    busy = false;
    acc = 0;
    if (graphicsLost) return;
    uiRoot.inert = false;
    curtain.classList.remove('interrupted');
    curtain.style.display = 'none';
    if (s.phase === 'race' || s.phase === 'lights') {
      if (document.hidden || !document.hasFocus()) input.interrupt();
      else view.canvas.focus();
    }
  }
  async function present(token: number) {
    ui.update(s);
    await view.present(s);
    if (token !== ticket) return;
    progress(`Checking the ${view.backend} picture`);
    await reveal(token);
  }
  async function garage() {
    const token = wait(`Preparing the ${s.settings.chassis === '458' ? '458 GT3 Evo' : 'Concept GT3'} and workshop lighting`);
    world?.clear();
    s.phase = 'garage';
    s.lights = 0;
    s.elapsed = 0;
    s.autopilot = false;
    acc = 0;
    s.drivers = [driver(0, s.settings.livery)];
    audio.update(s);
    await present(token);
  }
  async function prepareCircuit(token: number) {
    if (race) return race;
    const { makeRoad } = await import('./track/road');
    if (token !== ticket) return;
    const road = makeRoad(circuit);
    surfaceGrid.setWeather(s.settings.weather);
    const [created] = await Promise.all([
      createWorld(circuit, road.colliders, surfaceGrid).then(w => { onDispose(w.dispose); return w; }),
      view.prepareTrack(road, s.settings.weather, surfaceGrid),
    ]);
    if (token !== ticket) return;
    world = created;
    return race = createRace(circuit, world, s, surfaceGrid);
  }
  async function start(skip = false) {
    if (busy) return;
    const token = wait('Preparing circuit and suspension');
    const [session, wheels] = await Promise.all([prepareCircuit(token), view.wheelLayouts(s.settings)]);
    if (!session || token !== ticket) return;
    progress('Forming the starting grid');
    session.start(skip, wheels);
    await present(token);
  }
  const weatherOrder: Weather[] = ['clear', 'golden', 'dusk', 'damp', 'rain'];
  function applyWeather(w: Weather) {
    if (lifetime.signal.aborted) return;
    s.settings.weather = w;
    surfaceGrid.setWeather(w);
    s.surfaceTempC = weatherSurfaceTempC[w];
    s.trackWetness = surfaceGrid.getMeanWetness() || weatherBaseWetness[w];
    rememberSetup({ weather: w });
    void view.setWeather(w).then(checkChange).catch(failure);
    ui.update(s);
  }
  function configure(p: Partial<Settings>) {
    if (lifetime.signal.aborted) return;
    const old = { ...s.settings };
    Object.assign(s.settings, p);
    if (old.weather !== s.settings.weather) applyWeather(s.settings.weather);
    if (old.graphics !== s.settings.graphics) { view.quality(s.settings.graphics); checkChange(); }
    if (s.phase === 'garage' && (old.chassis !== s.settings.chassis || old.livery !== s.settings.livery)) void garage().catch(failure);
    ui.update(s);
  }
  function checkChange() {
    if (!busy && !graphicsLost && !lifetime.signal.aborted) void verifyPicture().catch(failure);
  }
  const actions: UiActions = {
    configure(patch) {
      rememberSetup(patch);
      configure(patch);
    },
    start() {
      audio.unlock();
      void start().catch(failure);
    },
    resume() {
      if (!busy && !graphicsLost && !document.hidden && s.phase === 'paused') {
        audio.unlock();
        s.phase = prior;
        acc = 0;
        input.clear();
        view.canvas.focus();
        checkChange();
      }
    },
    restart() {
      audio.unlock();
      void start().catch(failure);
    },
    garage() {
      void garage().catch(failure);
    },
    cycleTc() {
      s.tc = (s.tc + 1) % 11;
    },
    cycleAbs() {
      s.abs = (s.abs + 1) % 11;
    },
    toggleMute() {
      audio.unlock();
      s.muted = !s.muted;
    },
    setWeather(w: Weather) {
      if (weatherOrder.includes(w)) applyWeather(w);
    },
    cycleWeather() {
      const next = weatherOrder[(weatherOrder.indexOf(s.settings.weather) + 1) % weatherOrder.length];
      applyWeather(next);
    },
    togglePitLimiter() {
      const p = s.drivers[0];
      if (p && (s.phase === 'race' || s.phase === 'lights') && p.pitState === 'track') {
        p.pitLimiter = !p.pitLimiter;
      }
    },
    togglePitMfd() {
      if (s.phase === 'race' || s.phase === 'lights') s.pitMfdOpen = !s.pitMfdOpen;
    },
    updatePitStrategy(patch: Partial<PitStrategy>) {
      Object.assign(s.pitStrategy, patch);
    },
  };
  const ui = createUI(uiRoot, circuit, actions),
    modes: CameraMode[] = ['chase', 'cockpit', 'hood', 'tv'];
  function pause() {
    if (s.phase !== 'race' && s.phase !== 'lights') return;
    prior = s.phase;
    s.phase = 'paused';
    acc = 0;
    // Hidden pages need not receive another frame to silence continuous audio.
    audio.update(s);
    ui.update(s);
  }
  function command(code: string) {
    if (busy) return;
    if (code === 'Escape') {
      if (s.phase === 'paused') actions.resume();
      else input.interrupt();
    } else if (code === 'KeyM') actions.toggleMute();
    else if (s.phase === 'race' || s.phase === 'lights') {
      if (code === 'KeyC') { s.camera = modes[(modes.indexOf(s.camera) + 1) % 4]; checkChange(); }
      if (code === 'KeyT') actions.cycleTc();
      if (code === 'KeyY') actions.cycleAbs();
      if (code === 'KeyL') actions.togglePitLimiter();
      if (code === 'KeyP') actions.togglePitMfd();
      if (code === 'KeyV') actions.cycleWeather();
      if (code === 'KeyR') race?.resetPlayer();
      if ((code === 'KeyQ' || code === 'KeyE') && s.settings.transmission === 'manual')
        world?.shift(s.drivers[0], code === 'KeyQ' ? -1 : 1);
    }
  }
  let input = controls(view.canvas, s, command, pause);
  onDispose(() => input.dispose());
  async function replaceLostDevice(reason: string) {
    graphicsLost = true;
    input.interrupt();
    const token = wait('Switching to WebGL 2 and rebuilding the 3D picture');
    const replacement = view.canvas.cloneNode() as HTMLCanvasElement;
    view.canvas.replaceWith(replacement);
    view.dispose();
    const next = await createStudioView(replacement, circuit, reason);
    if (token !== ticket) { next.dispose(); return; }
    input.dispose();
    view = next;
    input = controls(view.canvas, s, command, pause);
    s.backend = view.backend;
    view.quality(s.settings.graphics);
    graphicsLost = false;
    view.onGraphicsReset(lost, restored);
    view.run(frame, renderFailure);
    if (world) {
      const { makeRoad } = await import('./track/road');
      if (token !== ticket) return;
      await view.prepareTrack(makeRoad(circuit), s.settings.weather, surfaceGrid);
    }
    await view.setWeather(s.settings.weather);
    if (token !== ticket) return;
    await present(token);
  }
  function renderFailure(error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = `${view.backend} could not draw the scene: ${detail}`;
    if (view.backend === 'WebGPU' && !busy) void replaceLostDevice(reason).catch(failure);
    else failure(new GraphicsUnavailable(reason));
  }
  function lost() {
    if (lifetime.signal.aborted) return;
    graphicsLost = true;
    input.interrupt();
    uiRoot.inert = true;
    curtain.style.display = 'grid';
    curtain.classList.add('interrupted');
    if (view.backend === 'WebGPU') {
      if (busy) failure(new GraphicsUnavailable('Graphics disconnected during scene preparation. Retry launch.'));
      else void replaceLostDevice('WebGPU device disconnected').catch(failure);
      return;
    }
    progress('Graphics connection lost. Restoring the 3D scene… If it does not return, retry launch.');
  }
  function restored() {
    graphicsLost = false;
    acc = 0;
    input.interrupt();
    curtain.classList.remove('interrupted');
    if (busy) progress('Finishing scene preparation');
    else void reveal(wait('Checking the restored 3D picture')).catch(failure);
  }
  view.onGraphicsReset(lost, restored);
  window.addEventListener('pagehide', (e) => {
    if (e.persisted) input.interrupt();
  }, { signal: lifetime.signal });
  function snapshot() {
    return {
      ...structuredClone(s),
      wheelCompressionM: [...s.drivers[0].wheelCompressionM],
      speedKmh: s.drivers[0].speed * 3.6,
      frame: frames,
      ready: !busy && !graphicsLost && view.ready(),
      adapter: view.adapter,
      software: view.software,
      fallbackReason: view.reason,
      wasmFreeBytes: world?.freeMemory() ?? null,
    };
  }
  const debug = {
    getState: snapshot,
    setAutopilot: (on: boolean) => {
      s.autopilot = !!on;
    },
    setCamera: (mode: CameraMode) => {
      if (modes.includes(mode) && s.camera !== mode) { s.camera = mode; checkChange(); }
    },
    setWeather: (w: Weather) => {
      if (weatherOrder.includes(w)) applyWeather(w);
    },
    togglePitLimiter: () => actions.togglePitLimiter(),
    togglePitMfd: () => actions.togglePitMfd(),
    updatePitStrategy: (patch: Partial<PitStrategy>) => actions.updatePitStrategy(patch),
    ...(qa
      ? {
          enterPitLane: () => race?.teleportToPitEntry() ?? false,
          freeze: (on: boolean) => {
            frozen = on;
            acc = 0;
          },
          step: (ticks: number) => {
            if (!frozen || busy || !race) return;
            const u = input.sample(STEP);
            for (let i = 0; i < Math.min(1200, ticks); i++) race.advance(u);
          },
        }
      : {}),
  };
  Object.assign(window, { __GT3_DEBUG__: debug });
  let afterResize: number | undefined;
  window.addEventListener('resize', () => {
    if (graphicsLost) return;
    view.resize();
    // Rotation can replace the backing surface without a context-lost event.
    window.clearTimeout(afterResize);
    afterResize = window.setTimeout(checkChange, 200);
  }, { signal: lifetime.signal });
  onDispose(() => {
    window.clearTimeout(afterResize);
    ++ticket;
    busy = true;
    Reflect.deleteProperty(window, '__GT3_DEBUG__');
  });
  function frame(seconds: number, fps: number) {
    if (graphicsLost) return;
    // Cap physics catch-up to 100 ms (12 ticks/frame) so a GPU hiccup never snowballs into stutter
    const dt = Math.max(0.001, Math.min(0.1, seconds)),
      u = input.sample(dt);
    if (!busy && !frozen && race && (s.phase === 'lights' || s.phase === 'race')) {
      acc += dt;
      while (acc >= STEP) {
        race.advance(u);
        acc -= STEP;
      }
    }
    s.fps = fps;
    if (!busy) audio.update(s);
    ui.update(s);
    view.draw(s, input.lookBack(), dt);
    frames++;
  }
  view.run(frame, renderFailure);
  const green = query.get('autostart') === '1';
  s.autopilot = green && qa;
  await Promise.all([view.setWeather(s.settings.weather), green ? start(true) : garage()]);
}
function failure(e: unknown) {
  if (lifetime.signal.aborted) return;
  dispose();
  if (!(e instanceof GraphicsUnavailable)) console.error(e);
  const curtain = document.querySelector<HTMLElement>('#loading')!;
  curtain.style.display = 'grid';
  curtain.classList.add('interrupted');
  progress(e instanceof Error ? e.message : String(e));
}
void boot().catch(failure);
