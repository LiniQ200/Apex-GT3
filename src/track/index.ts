import type { Scene } from '@babylonjs/core/scene';
import type { Circuit, TrackScene } from '../types';
import { makeRoad } from './road';
import { roadMaterials } from './materials';
import { buildScenery, publish, publishKerbs } from './scenery';

export { createCircuit } from './circuit';

export function buildTrack(scene: Scene, circuit: Circuit, { meshes, colliders } = makeRoad(circuit)): TrackScene {
  const m = roadMaterials(scene, circuit);
  for (const key of Object.keys(meshes) as (keyof typeof meshes)[]) {
    if (key === 'kerb') {
      publishKerbs(scene, meshes.kerb, m.kerb);
      continue;
    }
    const name = key === 'road' ? 'asphalt' : key === 'gravel' ? 'gravel runoff' : key;
    const material = key === 'pitWall' ? m.concrete : key === 'absorber' ? m.paint : m[key];
    const casts = key === 'wall' || key === 'pitWall' || key === 'absorber';
    const sector = casts ? 250 : key === 'gravel' ? 480 : 0;
    const mesh = publish(scene, 'circuit.' + name, meshes[key], material, casts, sector);
    // The indices already run along the lap. Give the frustum meaningful
    // bounds without copying vertices, cutting the road or touching Jolt.
    if (key === 'grass' || key === 'road') mesh.subdivide(12);
    else if (key === 'paint') mesh.subdivide(4);
  }
  const setLights = buildScenery(scene, circuit, m);
  return { colliders, setWeather: m.setWeather, setLights };
}
