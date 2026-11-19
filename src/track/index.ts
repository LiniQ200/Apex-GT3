import type { Scene } from '@babylonjs/core/scene';
import type { Circuit, TrackScene } from '../types';
import { makeRoad } from './road';
import { roadMaterials } from './materials';
import { buildScenery, publish, publishKerbs } from './scenery';

export { createCircuit } from './circuit';

export function buildTrack(scene: Scene, circuit: Circuit): TrackScene {
  const { meshes, colliders } = makeRoad(circuit),
    m = roadMaterials(scene, circuit);
  for (const key of Object.keys(meshes) as (keyof typeof meshes)[]) {
    if (key === 'kerb') {
      publishKerbs(scene, meshes.kerb, m.kerb);
      continue;
    }
    const name = key === 'road' ? 'asphalt' : key === 'gravel' ? 'gravel runoff' : key;
    const material = key === 'pitWall' ? m.concrete : key === 'absorber' ? m.paint : m[key];
    const mesh = publish(
      scene,
      'circuit.' + name,
      meshes[key],
      material,
      key === 'wall' || key === 'pitWall' || key === 'absorber',
    );
    // Longitudinal index order means each submesh is a small contiguous sector.
    // In particular the full W-beam needn't be submitted to each cascade.
    if (key === 'wall' || key === 'grass' || key === 'road') mesh.subdivide(12);
  }
  const setLights = buildScenery(scene, circuit, m);
  return { colliders, setWeather: m.setWeather, setLights };
}
