import type { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { RaceState } from '../types';
import type { TrackSurfaceGrid } from './surfaceState';

/**
 * Pure GPU-instanced weather atmosphere:
 *  1) Crisp 3D rain-streak sheets around the camera in Heavy Rain (zero post-process blur)
 *  2) Dynamic roostertail tire-spray plumes behind all 10 GT3 cars scaled by speed & local wetness
 */
export function createWeatherFx(scene: Scene, surfaceGrid: TrackSurfaceGrid) {
  // --- 1. 3D GPU Rain-Streak Volume (Thin-instanced vertical blades around camera) ---
  const rainCount = 420;
  const rainMesh = new Mesh('weather.rainStreaks', scene);
  const rvd = new VertexData();
  // Crossed slender streak cards so rain reads crisp and fine from every camera angle
  rvd.positions = [
    -0.0055, -0.55, 0,  0.0055, -0.55, 0,  0.0055, 0.55, 0,  -0.0055, 0.55, 0,
    0, -0.55, -0.0055,  0, -0.55, 0.0055,  0, 0.55, 0.0055,  0, 0.55, -0.0055,
  ];
  rvd.indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  rvd.normals = [
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
  ];
  rvd.uvs = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  rvd.applyToMesh(rainMesh);
  const rainMat = new StandardMaterial('weather.rainMat', scene);
  rainMat.disableLighting = true;
  rainMat.emissiveColor = new Color3(0.68, 0.74, 0.80);
  rainMat.alpha = 0.22;
  rainMat.backFaceCulling = false;
  rainMat.disableDepthWrite = true;
  rainMesh.material = rainMat;
  rainMesh.isPickable = false;
  rainMesh.alwaysSelectAsActiveMesh = true;
  rainMesh.metadata = { noShadowCaster: true };
  rainMesh.setEnabled(false);

  const rainMatrices = new Float32Array(rainCount * 16);
  const rainSeeds = Array.from({ length: rainCount }, (_, i) => {
    const a = ((i * 2654435761) >>> 0) / 4294967296;
    const b = (((i + 73) * 1597334677) >>> 0) / 4294967296;
    const c = (((i + 191) * 2246822519) >>> 0) / 4294967296;
    return { x: (a - 0.5) * 42, y: b * 18, z: (c - 0.5) * 42, speed: 22 + 8 * a };
  });
  rainMesh.thinInstanceSetBuffer('matrix', rainMatrices, 16, false);

  // --- 2. Dynamic GPU Roostertail Tire-Spray Plumes behind all 10 cars ---
  const sprayTex = new DynamicTexture('weather.sprayTex', 128, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const sctx = sprayTex.getContext() as CanvasRenderingContext2D;
  const g = sctx.createRadialGradient(64, 64, 4, 64, 64, 60);
  g.addColorStop(0, 'rgba(182, 194, 206, 0.48)');
  g.addColorStop(0.5, 'rgba(164, 178, 190, 0.22)');
  g.addColorStop(1, 'rgba(154, 168, 180, 0)');
  sctx.fillStyle = g;
  sctx.fillRect(0, 0, 128, 128);
  sprayTex.hasAlpha = true;
  sprayTex.update(true);

  const sprayMat = new StandardMaterial('weather.sprayMat', scene);
  sprayMat.disableLighting = true;
  sprayMat.emissiveTexture = sprayTex;
  sprayMat.opacityTexture = sprayTex;
  sprayMat.emissiveColor = new Color3(0.54, 0.60, 0.66);
  sprayMat.alpha = 0.28;
  sprayMat.backFaceCulling = false;
  sprayMat.disableDepthWrite = true;

  const puffPerWheel = 6; // 6 trailing puffs per rear tire x 2 rear tires x 10 cars = 120 GPU instances
  const maxPuffs = 10 * 2 * puffPerWheel;
  const sprayMesh = new Mesh('weather.roostertail', scene);
  const svd = new VertexData();
  // Crossed soft mist billow geometry so plumes have full 3D volume from Chase, Cockpit & TV cams
  svd.positions = [
    -0.5, -0.5, 0,  0.5, -0.5, 0,  0.5, 0.5, 0,  -0.5, 0.5, 0,
    0, -0.5, -0.5,  0, -0.5, 0.5,  0, 0.5, 0.5,  0, 0.5, -0.5,
  ];
  svd.indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  svd.normals = [
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
  ];
  svd.uvs = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  svd.applyToMesh(sprayMesh);
  sprayMesh.material = sprayMat;
  sprayMesh.isPickable = false;
  sprayMesh.alwaysSelectAsActiveMesh = true;
  sprayMesh.metadata = { noShadowCaster: true };
  sprayMesh.setEnabled(false);

  const sprayMatrices = new Float32Array(maxPuffs * 16);
  sprayMesh.thinInstanceSetBuffer('matrix', sprayMatrices, 16, false);

  const tmpMat = new Matrix();
  const tmpPos = new Vector3();
  const tmpScale = new Vector3();
  const tmpQuat = new Quaternion();
  let clock = 0;

  return {
    update(s: RaceState, dt: number) {
      clock += Math.max(0, Math.min(0.1, dt));
      const inRace = s.phase === 'race' || s.phase === 'lights';
      const isRain = inRace && s.settings.weather === 'rain';
      if (rainMesh.isEnabled() !== isRain) rainMesh.setEnabled(isRain);

      if (isRain && scene.activeCamera) {
        const cam = scene.activeCamera.globalPosition;
        Quaternion.RotationYawPitchRollToRef(0, 0.14, 0.08, tmpQuat);
        tmpScale.set(1, 1.35, 1);
        for (let i = 0; i < rainCount; i++) {
          const seed = rainSeeds[i];
          const y = 16 - ((seed.y + clock * seed.speed) % 18);
          tmpPos.set(cam.x + seed.x, cam.y + y - 2, cam.z + seed.z);
          Matrix.ComposeToRef(tmpScale, tmpQuat, tmpPos, tmpMat);
          tmpMat.copyToArray(rainMatrices, i * 16);
        }
        rainMesh.thinInstanceBufferUpdated('matrix');
      }

      const wetScene = inRace && (s.settings.weather === 'damp' || s.settings.weather === 'rain' || s.trackWetness > 0.12);
      if (sprayMesh.isEnabled() !== wetScene) sprayMesh.setEnabled(wetScene);
      if (!wetScene) return;

      let slot = 0;
      const zeroScale = Vector3.Zero();
      for (const d of s.drivers) {
        if (slot + 2 * puffPerWheel > maxPuffs) break;
        const speedNorm = Math.max(0, Math.min(1, (d.speed - 11) / 55));
        const local = surfaceGrid.sample(d.s, d.d, 8);
        const effWet = Math.max(0, local.wetness * (1 - 0.55 * local.dryingGroove));
        const intensity = speedNorm * Math.min(1, effWet * 1.45);
        const sn = Math.sin(d.yaw),
          cs = Math.cos(d.yaw);

        for (const side of [-0.88, 0.88]) {
          for (let k = 0; k < puffPerWheel; k++) {
            if (intensity < 0.06) {
              Matrix.ComposeToRef(zeroScale, Quaternion.Identity(), Vector3.Zero(), tmpMat);
              tmpMat.copyToArray(sprayMatrices, slot * 16);
              slot++;
              continue;
            }
            const phase = (clock * (3.2 + 2.8 * speedNorm) + k / puffPerWheel + d.id * 0.17 + (side > 0 ? 0.37 : 0)) % 1;
            const back = 1.9 + phase * (4.0 + 7.2 * speedNorm);
            const rise = 0.16 + phase * (0.78 + 0.85 * intensity);
            const spread = side + (side > 0 ? 1 : -1) * phase * 0.55;
            const size = (0.42 + phase * 1.45) * (0.35 + 0.68 * intensity);
            tmpPos.set(d.x - sn * back + cs * spread, d.y + rise, d.z - cs * back - sn * spread);
            tmpScale.set(size, size * 0.85, size);
            Quaternion.RotationYawPitchRollToRef(d.yaw + phase * 1.8, 0, 0, tmpQuat);
            Matrix.ComposeToRef(tmpScale, tmpQuat, tmpPos, tmpMat);
            tmpMat.copyToArray(sprayMatrices, slot * 16);
            slot++;
          }
        }
      }
      while (slot < maxPuffs) {
        Matrix.ComposeToRef(zeroScale, Quaternion.Identity(), Vector3.Zero(), tmpMat);
        tmpMat.copyToArray(sprayMatrices, slot * 16);
        slot++;
      }
      sprayMesh.thinInstanceBufferUpdated('matrix');
    },
  };
}
