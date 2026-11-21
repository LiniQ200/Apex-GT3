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

function makeSoftPuffTexture(scene: Scene, name: string, inner: string, mid: string, outer: string) {
  const tex = new DynamicTexture(name, 128, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  // Multi-lobe turbulent mist sprite so roostertails & tire smoke read as organic aerosol plumes, not circles
  for (const [cx, cy, r] of [
    [64, 64, 54],
    [46, 56, 36],
    [82, 58, 34],
    [62, 78, 38],
  ]) {
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, r);
    g.addColorStop(0, inner);
    g.addColorStop(0.46, mid);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  tex.hasAlpha = true;
  tex.update(true);
  return tex;
}

function makeBillowMesh(scene: Scene, name: string, mat: StandardMaterial) {
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = [
    -0.5, -0.5, 0,  0.5, -0.5, 0,  0.5, 0.5, 0,  -0.5, 0.5, 0,
    0, -0.5, -0.5,  0, -0.5, 0.5,  0, 0.5, 0.5,  0, 0.5, -0.5,
  ];
  vd.indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  vd.normals = [
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
  ];
  vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  vd.applyToMesh(mesh);
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.metadata = { noShadowCaster: true };
  mesh.setEnabled(false);
  return mesh;
}

/**
 * Pure GPU-instanced dynamic race atmosphere (zero post-process blur):
 *  1) Feathered optical 3D rain-streak sheets around camera in Heavy Rain
 *  2) Turbulent volumetric roostertail tire-spray plumes behind all 10 cars in Damp/Rain
 *  3) Dynamic tire lockup/drift smoke & off-track gravel-dust plumes behind sliding/off-road cars
 *  4) High-speed rear-wing aero condensation vortices
 *  5) Titanium underbody skid-block spark showers on heavy kerb/compression impacts
 */
export function createWeatherFx(scene: Scene, surfaceGrid: TrackSurfaceGrid) {
  // --- 1. Optical Feathered 3D GPU Rain-Streak Volume ---
  const rainCount = 720;
  const rainTex = new DynamicTexture('weather.rainStreakTex', { width: 16, height: 128 }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  {
    const rc = rainTex.getContext() as CanvasRenderingContext2D;
    const vg = rc.createLinearGradient(0, 0, 0, 128);
    vg.addColorStop(0.0, 'rgba(215, 228, 242, 0.0)');
    vg.addColorStop(0.22, 'rgba(220, 232, 245, 0.58)');
    vg.addColorStop(0.62, 'rgba(232, 242, 252, 0.92)');
    vg.addColorStop(0.88, 'rgba(240, 248, 255, 0.65)');
    vg.addColorStop(1.0, 'rgba(215, 228, 242, 0.0)');
    rc.fillStyle = vg;
    rc.fillRect(4, 0, 8, 128);
    rainTex.hasAlpha = true;
    rainTex.update(true);
  }
  const rainMesh = new Mesh('weather.rainStreaks', scene);
  const rvd = new VertexData();
  rvd.positions = [
    -0.0028, -0.54, 0,  0.0028, -0.54, 0,  0.0028, 0.54, 0,  -0.0028, 0.54, 0,
    0, -0.54, -0.0028,  0, -0.54, 0.0028,  0, 0.54, 0.0028,  0, 0.54, -0.0028,
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
  rainMat.emissiveTexture = rainTex;
  rainMat.opacityTexture = rainTex;
  rainMat.emissiveColor = new Color3(0.76, 0.83, 0.90);
  rainMat.alpha = 0.24;
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
    const near = i < 280 ? 0.42 : 1.0;
    return { x: (a - 0.5) * 44 * near, y: b * 18, z: (c - 0.5) * 44 * near, speed: 27 + 12 * a };
  });
  rainMesh.thinInstanceSetBuffer('matrix', rainMatrices, 16, false);

  // --- 2. Dynamic GPU Roostertail Tire-Spray Plumes behind all 10 cars ---
  const sprayTex = makeSoftPuffTexture(
    scene,
    'weather.sprayTex',
    'rgba(206, 216, 226, 0.36)',
    'rgba(178, 190, 202, 0.16)',
    'rgba(154, 168, 180, 0)',
  );
  const sprayMat = new StandardMaterial('weather.sprayMat', scene);
  sprayMat.disableLighting = true;
  sprayMat.emissiveTexture = sprayTex;
  sprayMat.opacityTexture = sprayTex;
  sprayMat.emissiveColor = new Color3(0.66, 0.72, 0.78);
  sprayMat.alpha = 0.36;
  sprayMat.backFaceCulling = false;
  sprayMat.disableDepthWrite = true;

  const puffPerWheel = 7;
  const maxPuffs = 10 * 2 * puffPerWheel;
  const sprayMesh = makeBillowMesh(scene, 'weather.roostertail', sprayMat);
  const sprayMatrices = new Float32Array(maxPuffs * 16);
  sprayMesh.thinInstanceSetBuffer('matrix', sprayMatrices, 16, false);

  // --- 3. Dynamic Tire-Smoke & Off-Track Gravel-Dust Plumes ---
  const smokeTex = makeSoftPuffTexture(
    scene,
    'weather.smokeTex',
    'rgba(226, 222, 214, 0.34)',
    'rgba(196, 190, 178, 0.15)',
    'rgba(170, 164, 152, 0)',
  );
  const smokeMat = new StandardMaterial('weather.smokeMat', scene);
  smokeMat.disableLighting = true;
  smokeMat.emissiveTexture = smokeTex;
  smokeMat.opacityTexture = smokeTex;
  smokeMat.emissiveColor = new Color3(0.76, 0.73, 0.66);
  smokeMat.alpha = 0.36;
  smokeMat.backFaceCulling = false;
  smokeMat.disableDepthWrite = true;

  const smokePerWheel = 4;
  const maxSmoke = 10 * 2 * smokePerWheel;
  const smokeMesh = makeBillowMesh(scene, 'weather.tireSmoke', smokeMat);
  const smokeMatrices = new Float32Array(maxSmoke * 16);
  smokeMesh.thinInstanceSetBuffer('matrix', smokeMatrices, 16, false);

  // --- 4. High-Speed Rear-Wing Aero Condensation Vortices (humid air > 165 km/h) ---
  const vortexTex = new DynamicTexture('weather.wingVortexTex', { width: 32, height: 128 }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  {
    const vc = vortexTex.getContext() as CanvasRenderingContext2D;
    const grad = vc.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0.0, 'rgba(220, 232, 245, 0.0)');
    grad.addColorStop(0.14, 'rgba(220, 232, 245, 0.55)');
    grad.addColorStop(0.55, 'rgba(205, 220, 235, 0.24)');
    grad.addColorStop(1.0, 'rgba(195, 212, 228, 0.0)');
    vc.fillStyle = grad;
    vc.fillRect(0, 0, 32, 128);
    vortexTex.hasAlpha = true;
    vortexTex.update(true);
  }
  const vortexMat = new StandardMaterial('weather.wingVortexMat', scene);
  vortexMat.disableLighting = true;
  vortexMat.emissiveTexture = vortexTex;
  vortexMat.opacityTexture = vortexTex;
  vortexMat.emissiveColor = new Color3(0.84, 0.90, 0.96);
  vortexMat.alpha = 0.26;
  vortexMat.backFaceCulling = false;
  vortexMat.disableDepthWrite = true;
  const vortexMesh = new Mesh('weather.wingVortex', scene);
  const vvd = new VertexData();
  // Softly tapered condensation ribbon streaming backward from rear wing endplates
  vvd.positions = [
    -0.010, 0, 0,  0.010, 0, 0,  0.044, 0, -1,  -0.044, 0, -1,
    0, -0.010, 0,  0, 0.010, 0,  0, 0.044, -1,  0, -0.044, -1,
  ];
  vvd.indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  vvd.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0];
  vvd.uvs = [0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0];
  vvd.applyToMesh(vortexMesh);
  vortexMesh.material = vortexMat;
  vortexMesh.isPickable = false;
  vortexMesh.alwaysSelectAsActiveMesh = true;
  vortexMesh.metadata = { noShadowCaster: true };
  vortexMesh.setEnabled(false);
  const maxVortex = 10 * 2;
  const vortexMatrices = new Float32Array(maxVortex * 16);
  vortexMesh.thinInstanceSetBuffer('matrix', vortexMatrices, 16, false);

  // --- 5. Titanium Underbody Skid-Block Spark Showers (high-speed kerb / compression strikes) ---
  const sparkMat = new StandardMaterial('weather.skidSparkMat', scene);
  sparkMat.disableLighting = true;
  sparkMat.emissiveColor = new Color3(3.8, 2.2, 0.72);
  sparkMat.backFaceCulling = false;
  sparkMat.disableDepthWrite = true;
  const sparkMesh = new Mesh('weather.skidSparks', scene);
  const svd = new VertexData();
  svd.positions = [
    -0.008, 0, 0,  0.008, 0, 0,  0.003, 0, -0.42,  -0.003, 0, -0.42,
    0, -0.008, 0,  0, 0.008, 0,  0, 0.003, -0.42,  0, -0.003, -0.42,
  ];
  svd.indices = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  svd.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0];
  svd.applyToMesh(sparkMesh);
  sparkMesh.material = sparkMat;
  sparkMesh.isPickable = false;
  sparkMesh.alwaysSelectAsActiveMesh = true;
  sparkMesh.metadata = { noShadowCaster: true };
  sparkMesh.setEnabled(false);
  const sparksPerCar = 12;
  const maxSparks = 10 * sparksPerCar;
  const sparkMatrices = new Float32Array(maxSparks * 16);
  sparkMesh.thinInstanceSetBuffer('matrix', sparkMatrices, 16, false);

  const tmpMat = new Matrix();
  const tmpPos = new Vector3();
  const tmpScale = new Vector3();
  const tmpQuat = new Quaternion();
  const zeroScale = Vector3.Zero();
  let clock = 0;

  return {
    update(s: RaceState, dt: number) {
      clock += Math.max(0, Math.min(0.1, dt));
      const inRace = s.phase === 'race' || s.phase === 'lights';
      const isRain = inRace && s.settings.weather === 'rain';
      if (rainMesh.isEnabled() !== isRain) rainMesh.setEnabled(isRain);

      if (isRain && scene.activeCamera) {
        const cam = scene.activeCamera.globalPosition;
        const player = s.drivers[0];
        const speedLean = Math.min(0.46, (player?.speed ?? 0) * 0.009);
        Quaternion.RotationYawPitchRollToRef(player?.yaw ?? 0, 0.14 + speedLean, 0.06, tmpQuat);
        tmpScale.set(1, 1.25 + speedLean * 1.5, 1);
        for (let i = 0; i < rainCount; i++) {
          const seed = rainSeeds[i];
          const y = 16 - ((seed.y + clock * seed.speed) % 18);
          tmpPos.set(cam.x + seed.x, cam.y + y - 2, cam.z + seed.z);
          Matrix.ComposeToRef(tmpScale, tmpQuat, tmpPos, tmpMat);
          tmpMat.copyToArray(rainMatrices, i * 16);
        }
        rainMesh.thinInstanceBufferUpdated('matrix');
      }

      // Wet roostertail plumes
      const wetScene =
        inRace && (s.settings.weather === 'damp' || s.settings.weather === 'rain' || s.trackWetness > 0.12);
      if (sprayMesh.isEnabled() !== wetScene) sprayMesh.setEnabled(wetScene);
      if (wetScene) {
        let slot = 0;
        for (const d of s.drivers) {
          if (slot + 2 * puffPerWheel > maxPuffs) break;
          const speedNorm = Math.max(0, Math.min(1, (d.speed - 9) / 52));
          const local = surfaceGrid.sample(d.s, d.d, 8);
          const effWet = Math.max(0, local.wetness * (1 - 0.52 * local.dryingGroove));
          const intensity = speedNorm * Math.min(1, effWet * 1.65);
          const sn = Math.sin(d.yaw),
            cs = Math.cos(d.yaw);

          for (const side of [-0.88, 0.88]) {
            for (let k = 0; k < puffPerWheel; k++) {
              if (intensity < 0.05) {
                Matrix.ComposeToRef(zeroScale, Quaternion.Identity(), Vector3.Zero(), tmpMat);
                tmpMat.copyToArray(sprayMatrices, slot * 16);
                slot++;
                continue;
              }
              const phase =
                (clock * (3.4 + 3.0 * speedNorm) + k / puffPerWheel + d.id * 0.17 + (side > 0 ? 0.37 : 0)) % 1;
              const back = 1.75 + phase * (4.6 + 8.6 * speedNorm);
              const rise = 0.14 + phase * (0.98 + 1.15 * intensity);
              const spread = side + (side > 0 ? 1 : -1) * phase * 0.72;
              const size = (0.50 + phase * 1.85) * (0.40 + 0.72 * intensity);
              tmpPos.set(d.x - sn * back + cs * spread, d.y + rise, d.z - cs * back - sn * spread);
              tmpScale.set(size, size * 0.84, size);
              Quaternion.RotationYawPitchRollToRef(d.yaw + phase * 2.1, 0, 0, tmpQuat);
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
      }

      // Dynamic tire-smoke (high slip/lockup on dry) & gravel-dust (off-track)
      let anySmoke = false;
      let anyDust = false;
      if (inRace) {
        let slot = 0;
        for (const d of s.drivers) {
          if (slot + 2 * smokePerWheel > maxSmoke) break;
          const offRoad = (d.surface === 'gravel' || d.surface === 'grass') && d.speed > 7;
          const drySlip = !wetScene && d.speed > 6 && (d.slip > 0.24 || (d.absActive && d.brake > 0.75 && d.speed > 18));
          const active = offRoad || drySlip;
          if (offRoad) anyDust = true;
          if (active) anySmoke = true;
          const strength = offRoad
            ? Math.min(1, d.speed / 28)
            : drySlip
              ? Math.min(1, Math.max(d.slip - 0.18, d.absActive ? 0.45 : 0) * 1.8)
              : 0;
          const sn = Math.sin(d.yaw),
            cs = Math.cos(d.yaw);
          for (const side of [-0.88, 0.88]) {
            for (let k = 0; k < smokePerWheel; k++) {
              if (!active || strength < 0.08) {
                Matrix.ComposeToRef(zeroScale, Quaternion.Identity(), Vector3.Zero(), tmpMat);
                tmpMat.copyToArray(smokeMatrices, slot * 16);
                slot++;
                continue;
              }
              const phase = (clock * 3.8 + k / smokePerWheel + d.id * 0.23 + (side > 0 ? 0.5 : 0)) % 1;
              const back = 1.6 + phase * (3.2 + Math.min(6, d.speed * 0.14));
              const rise = 0.15 + phase * (0.82 + 0.55 * strength);
              const spread = side + (side > 0 ? 1 : -1) * phase * 0.52;
              const size = (0.36 + phase * 1.35) * (0.45 + 0.65 * strength);
              tmpPos.set(d.x - sn * back + cs * spread, d.y + rise, d.z - cs * back - sn * spread);
              tmpScale.set(size, size * 0.85, size);
              Quaternion.RotationYawPitchRollToRef(d.yaw + phase * 1.9, 0, 0, tmpQuat);
              Matrix.ComposeToRef(tmpScale, tmpQuat, tmpPos, tmpMat);
              tmpMat.copyToArray(smokeMatrices, slot * 16);
              slot++;
            }
          }
        }
        while (slot < maxSmoke) {
          Matrix.ComposeToRef(zeroScale, Quaternion.Identity(), Vector3.Zero(), tmpMat);
          tmpMat.copyToArray(smokeMatrices, slot * 16);
          slot++;
        }
      }
      if (smokeMesh.isEnabled() !== anySmoke) smokeMesh.setEnabled(anySmoke);
      if (anySmoke) {
        if (anyDust) smokeMat.emissiveColor.set(0.68, 0.58, 0.44);
        else smokeMat.emissiveColor.set(0.84, 0.85, 0.86);
        smokeMesh.thinInstanceBufferUpdated('matrix');
      }

      // High-speed rear-wing condensation vortices in humid conditions (Damp / Rain > 43 m/s)
      let anyVortex = false;
      if (wetScene) {
        let vSlot = 0;
        for (const d of s.drivers) {
          if (vSlot + 2 > maxVortex) break;
          const vNorm = Math.max(0, Math.min(1, (d.speed - 43) / 26));
          const sn = Math.sin(d.yaw),
            cs = Math.cos(d.yaw);
          for (const side of [-0.94, 0.94]) {
            if (vNorm < 0.06) {
              Matrix.ComposeToRef(zeroScale, Quaternion.Identity(), Vector3.Zero(), tmpMat);
            } else {
              anyVortex = true;
              const len = 2.4 + vNorm * 5.2;
              const flutter = Math.sin(clock * 22 + d.id * 1.7 + side) * 0.025;
              tmpPos.set(d.x - sn * 2.18 + cs * side, d.y + 1.18 + flutter, d.z - cs * 2.18 - sn * side);
              tmpScale.set(0.75 + vNorm * 0.55, 0.75 + vNorm * 0.55, len);
              Quaternion.RotationYawPitchRollToRef(d.yaw, d.pitch - 0.03, d.roll, tmpQuat);
              Matrix.ComposeToRef(tmpScale, tmpQuat, tmpPos, tmpMat);
            }
            tmpMat.copyToArray(vortexMatrices, vSlot * 16);
            vSlot++;
          }
        }
        while (vSlot < maxVortex) {
          Matrix.ComposeToRef(zeroScale, Quaternion.Identity(), Vector3.Zero(), tmpMat);
          tmpMat.copyToArray(vortexMatrices, vSlot * 16);
          vSlot++;
        }
      }
      if (vortexMesh.isEnabled() !== anyVortex) vortexMesh.setEnabled(anyVortex);
      if (anyVortex) vortexMesh.thinInstanceBufferUpdated('matrix');

      // Titanium underbody skid-block spark showers when GT3 floors compress hard at > 105 km/h
      let anySparks = false;
      if (inRace) {
        let spSlot = 0;
        for (const d of s.drivers) {
          if (spSlot + sparksPerCar > maxSparks) break;
          const maxComp = Math.max(
            d.wheelCompressionM[0] ?? 0,
            d.wheelCompressionM[1] ?? 0,
            d.wheelCompressionM[2] ?? 0,
            d.wheelCompressionM[3] ?? 0,
          );
          const kerbBottom = d.surface === 'kerb' && d.speed > 28 && maxComp > 0.072;
          const aeroBottom = d.speed > 44 && maxComp > 0.088;
          const sparking = kerbBottom || aeroBottom;
          const sn = Math.sin(d.yaw),
            cs = Math.cos(d.yaw);
          for (let k = 0; k < sparksPerCar; k++) {
            if (!sparking) {
              Matrix.ComposeToRef(zeroScale, Quaternion.Identity(), Vector3.Zero(), tmpMat);
            } else {
              anySparks = true;
              const phase = (clock * 8.5 + k / sparksPerCar + d.id * 0.31) % 1;
              const fan = ((k * 73) % 19) / 18 - 0.5;
              const back = 1.9 + phase * (2.6 + d.speed * 0.09);
              const lateral = fan * (0.45 + phase * 1.45);
              const arcY = 0.06 + phase * (0.34 + Math.abs(fan) * 0.32) - phase * phase * 0.24;
              tmpPos.set(d.x - sn * back + cs * lateral, d.y + Math.max(0.03, arcY), d.z - cs * back - sn * lateral);
              const len = (1 - phase * 0.65) * (0.9 + d.speed * 0.025);
              tmpScale.set(1, 1, len);
              Quaternion.RotationYawPitchRollToRef(d.yaw + fan * 0.35, -0.08 + phase * 0.22, 0, tmpQuat);
              Matrix.ComposeToRef(tmpScale, tmpQuat, tmpPos, tmpMat);
            }
            tmpMat.copyToArray(sparkMatrices, spSlot * 16);
            spSlot++;
          }
        }
        while (spSlot < maxSparks) {
          Matrix.ComposeToRef(zeroScale, Quaternion.Identity(), Vector3.Zero(), tmpMat);
          tmpMat.copyToArray(sparkMatrices, spSlot * 16);
          spSlot++;
        }
      }
      if (sparkMesh.isEnabled() !== anySparks) sparkMesh.setEnabled(anySparks);
      if (anySparks) sparkMesh.thinInstanceBufferUpdated('matrix');
    },
  };
}
