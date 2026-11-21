import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import { createCameras } from '../cameras';
import { buildVehicle } from '../vehicles/gt3Builder';
import { setCarPaintWetness } from '../materials/carFinish';
import { studio } from '../vehicles/studio';
import type { Circuit, GridWheelLayouts, Settings, TrackScene, VehicleRig, WheelLayout } from '../types';
import { bootstrap, lighting, whenSceneReady } from './render';
import { GraphicsUnavailable, type DrivingView } from './view';

const chassisFor = (id: number, player: Settings['chassis']) => id === 0 ? player : id % 2 ? 'concept' : '458';

export async function studioWheelLayouts(scene: Scene, { chassis, mode }: Pick<Settings, 'chassis' | 'mode'>): Promise<GridWheelLayouts> {
  async function measure(which: Settings['chassis']): Promise<WheelLayout> {
    // Same cached, decoded asset as buildVehicle, even if the offline Concept is a 458 conversion.
    const { hubs, radii } = await studio(scene, which);
    const wheel = (i: number) => ({ x: hubs[i].x, y: hubs[i].y, z: hubs[i].z, radius: radii[i] });
    return [wheel(0), wheel(1), wheel(2), wheel(3)];
  }
  const player = measure(chassis);
  const [own, other] = await Promise.all([player, mode === 'sprint' ? measure(chassis === '458' ? 'concept' : '458') : player]);
  return id => chassisFor(id, chassis) === chassis ? own : other;
}

export async function createStudioView(element: HTMLCanvasElement, circuit: Circuit, fallback?: string): Promise<DrivingView> {
  const { scene, engine, canvas, backend, adapter, software, reason, deviceLost } = await bootstrap(element, fallback);
  let rigs: VehicleRig[] = [], generation = 0, raf = 0, suspended = false;
  function discard() {
    for (const rig of rigs) rig.dispose();
    rigs = [];
  }
  function dispose() {
    if (engine.isDisposed) return;
    generation++;
    cancelAnimationFrame(raf);
    try {
      discard();
      scene.dispose();
    } finally {
      engine.dispose();
    }
  }
  try {
    const cameras = createCameras(scene, circuit), light = lighting(scene);
    let trackRoot: TransformNode | undefined, track: Pick<TrackScene, 'setWeather' | 'setLights' | 'update'> | undefined;
    let pending: Promise<void> | undefined;
    // Check the submitted game canvas, not the HTML dashboard or an intermediate
    // render target. This small, one-shot readback never runs in steady driving.
    function hasPicture() {
      const tile = document.createElement('canvas');
      tile.width = 24; tile.height = 16;
      const ctx = tile.getContext('2d', { willReadFrequently: true });
      if (!ctx) return Promise.resolve(true); // Readback can be disabled independently of 3D.
      ctx.globalCompositeOperation = 'copy';
      return new Promise<boolean>((resolve, reject) => {
        let misses = 0, next = 0;
        const release = scene.onDisposeObservable.addOnce(() => {
          sample.remove(); reject(Error('Scene disposed.'));
        });
        const sample = engine.onEndFrameObservable.add(() => {
          const now = performance.now();
          if (now < next || document.hidden || !canvas.clientWidth || !canvas.clientHeight || !rigs.length) return;
          next = now + 350;
          let visible = true;
          try {
            ctx.drawImage(canvas, 0, 0, tile.width, tile.height);
            const pixels = ctx.getImageData(0, 0, tile.width, tile.height).data;
            let min = 255, max = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              const level = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
              min = Math.min(min, level); max = Math.max(max, level);
            }
            visible = max > 12 && max - min > 5;
          } catch (error) {
            if (!(error instanceof DOMException && error.name === 'SecurityError')) throw error;
          }
          if (!visible && ++misses < 8) return; // Allow cold material programs time to link.
          sample.remove(); release.remove(); resolve(visible);
        });
      });
    }
    async function check() {
      await whenSceneReady(scene);
      if (await hasPicture()) return;
      throw new GraphicsUnavailable(`${backend} returned a blank picture. Try another graphics launch option or open the game directly in your browser.`);
    }
    // Freeze static materials on WebGL2 to eliminate per-frame CPU dirty-checking.
    // On WebGPU, Babylon's bind-group cache already handles fast binding and freezing
    // lit PBR materials skips binding Light0..LightN UBOs to newly created draw contexts.
    function freezeStaticMaterials(freeze: boolean) {
      if (backend === 'WebGPU') return;
      for (const m of scene.materials) {
        if (m.name === 'HDR sky' || m.name === 'rear vision glass' || m.name === 'instrument anti-glare LCD' ||
            m.name.startsWith('weather.') || m.name.includes('.LED tail') || m.name.includes('.rain') ||
            m.name.includes('.disc') || m.name === 'venue.asphalt' || m.name === 'venue.terrain' ||
            m.name === 'venue.distant pasture' || m.name === 'venue.Mediterranean canopy' ||
            m.name === 'venue.Mediterranean bark' || m.name === 'venue.circuitFlags' ||
            m.name.startsWith('venue.biome.') ||
            m.name === 'venue.gravel' || m.name === 'venue.concrete' || m.name === 'venue.kerb' ||
            m.name === 'venue.track enamel' || m.name === 'venue.FIA digital flag panel' ||
            m.name === 'venue.start signal unlit' || m.name === 'venue.FIA signal red') continue;
        if (freeze) m.freeze();
        else m.unfreeze();
      }
    }
    return {
      canvas, backend, adapter, software, reason,
      async prepareTrack(road, weather, surfaceGrid) {
        const { buildTrack } = await import('../track');
        if (scene.isDisposed) return;
        const before = new Set(scene.rootNodes);
        const { setLights, setWeather, update } = await buildTrack(scene, circuit, road, surfaceGrid);
        if (scene.isDisposed) return;
        track = { setLights, setWeather, update };
        trackRoot = new TransformNode('circuit assembly', scene);
        for (const n of scene.rootNodes.slice()) if (!before.has(n) && n !== trackRoot) n.parent = trackRoot;
        trackRoot.setEnabled(false);
        track.setWeather(weather);
      },
      wheelLayouts: settings => studioWheelLayouts(scene, settings),
      async present(s) {
        const token = ++generation;
        freezeStaticMaterials(false);
        discard();
        trackRoot?.setEnabled(s.phase !== 'garage');
        cameras.update(s, false, 0);
        light.stage(s.phase === 'garage');
        const loads = await Promise.allSettled(s.drivers.map(d => buildVehicle(
          scene, chassisFor(d.id, s.settings.chassis), d.livery, d.number,
        )));
        const group = loads.flatMap(r => r.status === 'fulfilled' ? [r.value] : []);
        const failed = loads.find(r => r.status === 'rejected');
        if (token !== generation || failed) {
          for (const rig of group) rig.dispose();
          if (token === generation && failed) throw failed.reason;
          return;
        }
        rigs = group;
        rigs.forEach((rig, i) => rig.update(s.drivers[i], 0, false, s.settings.weather));
        light.casters(scene.meshes.filter(m => !(s.phase === 'garage' && m.name.startsWith('garage.'))));
        // Freeze static materials immediately after the first rendered frame so steady-state CPU cost drops ~65%
        scene.onAfterRenderObservable.addOnce(() => {
          if (token === generation && !scene.isDisposed) freezeStaticMaterials(true);
        });
      },
      confirmPicture() {
        return pending ??= check().finally(() => { pending = undefined; });
      },
      async setWeather(w) {
        freezeStaticMaterials(false);
        setCarPaintWetness(scene, w === 'rain' ? 0.92 : w === 'damp' ? 0.45 : 0);
        track?.setWeather(w);
        await light.setWeather(w);
        if (!scene.isDisposed && rigs.length) {
          scene.onAfterRenderObservable.addOnce(() => {
            if (!scene.isDisposed) freezeStaticMaterials(true);
          });
        }
      },
      quality: light.quality,
      ready: () => scene.isReady(),
      onGraphicsReset(lost, restored) {
        if (deviceLost) {
          void deviceLost.then(() => {
            if (!engine.isDisposed) { suspended = true; lost(); }
          });
          return;
        }
        engine.onContextLostObservable.add(() => { suspended = true; lost(); });
        engine.onContextRestoredObservable.add(() => { suspended = false; restored(); });
      },
      run(frame, failed) {
        // Own the error boundary through endFrame: WebGPU submits its command
        // buffer there, after Babylon's normal render-loop callback returns.
        function render() {
          if (engine.isDisposed) return;
          try {
            if (!suspended && !document.hidden && rigs.length) {
              engine.beginFrame();
              frame(engine.getDeltaTime() / 1000, engine.getFps());
              engine.endFrame();
            }
          } catch (error) { failed(error); return; }
          raf = requestAnimationFrame(render);
        }
        raf = requestAnimationFrame(render);
      },
      draw(s, lookBack, dt) {
        const driverView = s.phase !== 'garage' && s.camera === 'cockpit' && !lookBack;
        rigs.forEach((rig, i) => {
          const driver = s.drivers[i];
          if (driver) rig.update(driver, dt, driverView && driver.id === 0, s.settings.weather);
        });
        cameras.update(s, lookBack, dt);
        track?.setLights(s.lights);
        track?.update(s, dt);
        light.update(s, rigs, engine.getDeltaTime());
        scene.render();
      },
      resize: light.resize,
      dispose,
    };
  } catch (e) {
    dispose();
    throw e;
  }
}
