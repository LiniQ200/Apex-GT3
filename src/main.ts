import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { bootstrap, lighting, whenSceneReady } from './engine/render';
import { createCircuit, buildTrack } from './track';
import { createCameras } from './cameras';
import { buildVehicle } from './vehicles/gt3Builder';
import { createAudio } from './audio';
import { createUI } from './ui';
import { createWorld, STEP } from './physics/world';
import { createRace, driver } from './physics/race';
import { controls } from './controls';
import {
  teams,
  type Settings,
  type UiActions,
  type VehicleRig,
  type CameraMode,
  type Weather,
} from './types';

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
  const { engine, scene, canvas, backend, adapter, reason, software } = await bootstrap(
    document.querySelector('#scene')!,
  );
  onDispose(() => {
    try {
      scene.dispose();
    } finally {
      engine.dispose();
    }
  });
  if (lifetime.signal.aborted) return;
  const query = new URLSearchParams(location.search),
    qa = query.get('qa') === '1';
  progress('SURVEYING CIRCUIT');
  const circuit = createCircuit(),
    cameras = createCameras(scene, circuit),
    light = lighting(scene, software);
  const before = new Set(scene.rootNodes),
    track = buildTrack(scene, circuit),
    trackRoot = new TransformNode('circuit assembly', scene);
  for (const n of scene.rootNodes.slice()) if (!before.has(n) && n !== trackRoot) n.parent = trackRoot;
  trackRoot.setEnabled(false);
  light.quality('high');
  progress('PREPARING CAR & SUSPENSION');
  const [world] = await Promise.all([
    createWorld(circuit, track.colliders).then((w) => {
      onDispose(w.dispose);
      return w;
    }),
    light.setWeather('golden'),
  ]);
  if (lifetime.signal.aborted) return;
  const race = createRace(circuit, world, backend),
    s = race.state,
    audio = createAudio();
  onDispose(audio.dispose);
  let rigs: VehicleRig[] = [],
    ticket = 0,
    busy = false,
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
  }
  function discard() {
    for (const r of rigs) r.dispose();
    rigs = [];
  }
  async function presentCars() {
    const token = ++ticket;
    cameras.update(s, false, 0);
    ui.update(s);
    const loads = await Promise.allSettled(
      s.drivers.map((d) => buildVehicle(
        scene,
        d.id === 0 ? s.settings.chassis : d.id % 2 ? 'concept' : '458',
        d.livery,
        d.number,
      )),
    );
    const group = loads.flatMap((r) => r.status === 'fulfilled' ? [r.value] : []);
    const failed = loads.find((r) => r.status === 'rejected');
    if (token !== ticket || failed) {
      group.forEach((r) => r.dispose());
      if (token === ticket && failed) throw failed.reason;
      return;
    }
    rigs = group;
    rigs.forEach((r, i) => r.update(s.drivers[i], 0));
    light.casters(scene.meshes.filter((m) => !(s.phase === 'garage' && m.name.startsWith('garage.'))));
    await whenSceneReady(scene);
    if (token !== ticket) return;
    busy = false;
    acc = 0;
    uiRoot.inert = false;
    curtain.style.display = 'none';
    if ((s.phase === 'race' || s.phase === 'lights') && !document.hidden && document.hasFocus()) canvas.focus();
  }
  async function garage() {
    wait('OPENING COMPETITION GARAGE');
    world.clear();
    discard();
    trackRoot.setEnabled(false);
    s.phase = 'garage';
    s.lights = 0;
    track.setLights(0);
    s.elapsed = 0;
    s.autopilot = false;
    acc = 0;
    s.drivers = [driver(0, s.settings.livery)];
    audio.update(s);
    await presentCars();
  }
  async function start(skip = false) {
    if (busy) return;
    wait('FORMING THE STARTING GRID');
    discard();
    race.start(skip);
    trackRoot.setEnabled(true);
    track.setLights(s.lights);
    if (document.hidden) input.interrupt();
    await presentCars();
  }
  function configure(p: Partial<Settings>) {
    if (lifetime.signal.aborted) return;
    const old = { ...s.settings };
    Object.assign(s.settings, p);
    if (old.weather !== s.settings.weather) {
      track.setWeather(s.settings.weather);
      void light.setWeather(s.settings.weather).catch(failure);
    }
    if (old.graphics !== s.settings.graphics) light.quality(s.settings.graphics);
    if (s.phase === 'garage' && (p.chassis || p.livery !== undefined)) void garage().catch(failure);
    ui.update(s);
  }
  const actions: UiActions = {
    configure,
    start() {
      audio.unlock();
      void start().catch(failure);
    },
    resume() {
      if (!busy && !document.hidden && s.phase === 'paused') {
        audio.unlock();
        s.phase = prior;
        acc = 0;
        input.clear();
        canvas.focus();
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
      s.tc = (s.tc + 1) % 6;
    },
    cycleAbs() {
      s.abs = (s.abs + 1) % 4;
    },
    toggleMute() {
      audio.unlock();
      s.muted = !s.muted;
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
  const input = controls(canvas, s, (code) => {
    if (busy) return;
    if (code === 'Escape') {
      if (s.phase === 'paused') actions.resume();
      else input.interrupt();
    } else if (code === 'KeyM') actions.toggleMute();
    else if (s.phase === 'race' || s.phase === 'lights') {
      if (code === 'KeyC') s.camera = modes[(modes.indexOf(s.camera) + 1) % 4];
      if (code === 'KeyT') actions.cycleTc();
      if (code === 'KeyY') actions.cycleAbs();
      if (code === 'KeyR') race.resetPlayer();
      if ((code === 'KeyQ' || code === 'KeyE') && s.settings.transmission === 'manual')
        world.shift(s.drivers[0], code === 'KeyQ' ? -1 : 1);
    }
  }, pause);
  onDispose(input.dispose);
  window.addEventListener('pagehide', (e) => {
    if (e.persisted) input.interrupt();
  }, { signal: lifetime.signal });
  function snapshot() {
    return {
      ...structuredClone(s),
      wheelCompressionM: [...s.drivers[0].wheelCompressionM],
      speedKmh: s.drivers[0].speed * 3.6,
      frame: frames,
      ready: !busy && scene.isReady(),
      adapter,
      software,
      fallbackReason: reason,
      wasmFreeBytes: world.freeMemory(),
    };
  }
  const debug = {
    getState: snapshot,
    setAutopilot: (on: boolean) => {
      s.autopilot = !!on;
    },
    setCamera: (mode: CameraMode) => {
      if (modes.includes(mode)) s.camera = mode;
    },
    setWeather: (w: Weather) => {
      if (w === 'golden' || w === 'damp') configure({ weather: w });
    },
    ...(qa
      ? {
          freeze: (on: boolean) => {
            frozen = on;
            acc = 0;
          },
          step: (ticks: number) => {
            if (!frozen || busy) return;
            const u = input.sample(STEP);
            for (let i = 0; i < Math.min(1200, ticks); i++) race.advance(u);
          },
        }
      : {}),
  };
  Object.assign(window, { __GT3_DEBUG__: debug });
  window.addEventListener('resize', () => engine.resize(), { signal: lifetime.signal });
  onDispose(() => {
    ++ticket;
    busy = true;
    Reflect.deleteProperty(window, '__GT3_DEBUG__');
    engine.stopRenderLoop();
    discard();
  });
  engine.runRenderLoop(() => {
    const dt = Math.max(0.001, Math.min(0.25, engine.getDeltaTime() / 1000)),
      u = input.sample(dt);
    if (!busy && !frozen) {
      acc += dt;
      while (acc >= STEP) {
        race.advance(u);
        acc -= STEP;
      }
    }
    for (let i = 0; i < rigs.length; i++) if (s.drivers[i]) rigs[i].update(s.drivers[i], dt);
    cameras.update(s, input.lookBack(), dt);
    track.setLights(s.lights);
    light.update(s, rigs);
    s.fps = engine.getFps();
    if (!busy) audio.update(s);
    ui.update(s);
    scene.render();
    frames++;
  });
  if (query.get('autostart') === '1') {
    s.autopilot = qa;
    await start(true);
  } else await garage();
}
function failure(e: unknown) {
  if (lifetime.signal.aborted) return;
  dispose();
  console.error(e);
  document.querySelector<HTMLElement>('#loading')!.style.display = 'grid';
  progress(e instanceof Error ? e.message : String(e));
}
void boot().catch(failure);
