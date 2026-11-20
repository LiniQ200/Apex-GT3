import type { Scene } from '@babylonjs/core/scene';
import type { Circuit, RaceState, TrackScene, Weather } from '../types';
import { makeRoad } from './road';
import { roadMaterials } from './materials';
import { buildScenery, publish, publishKerbs } from './scenery';
import type { TrackSurfaceGrid } from './surfaceState';
import { createWeatherFx } from './weatherFx';

export { createCircuit } from './circuit';

export async function buildTrack(
  scene: Scene,
  circuit: Circuit,
  { meshes, colliders } = makeRoad(circuit),
  surfaceGrid?: TrackSurfaceGrid,
): Promise<TrackScene> {
  const m = roadMaterials(scene, circuit, surfaceGrid);
  for (const key of Object.keys(meshes) as (keyof typeof meshes)[]) {
    if (key === 'kerb') {
      publishKerbs(scene, meshes.kerb, m.kerb);
      continue;
    }
    const name = key === 'road' ? 'asphalt' : key === 'gravel' ? 'gravel runoff' : key;
    const material =
      key === 'pitWall' || key === 'pitApron'
        ? m.concrete
        : key === 'absorber'
          ? m.paint
          : m[key];
    const casts = key === 'pitWall';
    const sector = key === 'wall' || key === 'pitWall' || key === 'absorber' ? 320 : key === 'gravel' ? 480 : 0;
    const mesh = publish(scene, 'circuit.' + name, meshes[key], material, casts, sector);
    if (key === 'grass' || key === 'road') mesh.subdivide(12);
    else if (key === 'paint') mesh.subdivide(4);
  }
  const scenery = await buildScenery(scene, circuit, m);
  const fx = createWeatherFx(scene, m.grid);

  return {
    colliders,
    setWeather(w: Weather) {
      m.setWeather(w);
      scenery.setFlagWeather(w);
    },
    setLights: scenery.setLights,
    update(state: RaceState, dt: number) {
      m.syncSurface(dt);
      fx.update(state, dt);
    },
  };
}
