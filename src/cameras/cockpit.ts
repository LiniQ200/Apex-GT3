import type { Scene } from '@babylonjs/core/scene';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import type { Material } from '@babylonjs/core/Materials/material';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Driver, Weather } from '../types';
import { WindshieldRainPlugin } from '../materials/windshieldShader';
import { createRearVision } from './rearVision';

// Instrument pod, in metres. Three octagonal rings give the aluminium flange,
// sloping bezel and inset display different highlights without extra draws.
function pod(
  name: string,
  mount: TransformNode,
  w: number,
  h: number,
  shell: StandardMaterial,
  display: Material,
) {
  const scene = mount.getScene(),
    housing = new Mesh(name + ' case', scene);
  const positions: number[] = [],
    indices: number[] = [],
    normals: number[] = [];
  for (const [margin, depth] of [
    [0.004, 0.025],
    [0.01, 0.004],
    [0.005, -0.002],
  ]) {
    const x = w / 2 + margin,
      y = h / 2 + margin,
      c = 0.009;
    for (const [a, b] of [
      [-x + c, -y],
      [x - c, -y],
      [x, -y + c],
      [x, y - c],
      [x - c, y],
      [-x + c, y],
      [-x, y - c],
      [-x, -y + c],
    ])
      positions.push(a, b, depth);
  }
  for (let ring = 0; ring < 2; ring++)
    for (let i = 0; i < 8; i++) {
      const a = ring * 8 + i,
        b = ring * 8 + ((i + 1) % 8);
      indices.push(a, b, a + 8, b, b + 8, a + 8);
    }
  for (let i = 1; i < 7; i++) indices.push(16, 16 + i, 17 + i);
  VertexData.ComputeNormals(positions, indices, normals);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.applyToMesh(housing);
  housing.parent = mount;
  housing.material = shell;
  const face = CreatePlane(name + ' screen', { width: w, height: h }, scene);
  face.parent = housing;
  face.position.z = -0.003;
  face.material = display;
  for (const m of [housing, face]) {
    m.isPickable = false;
    m.metadata = { noShadowCaster: true };
  }
  return housing;
}

function instruments(scene: Scene, concept: boolean) {
  const texture = new DynamicTexture(
    'race cluster pixels',
    { width: 704, height: 256 },
    scene,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  const c = texture.getContext() as unknown as CanvasRenderingContext2D;
  let next = 0,
    last = '';
  const rect = (color: string, x: number, y: number, w: number, h: number) => {
    c.fillStyle = color;
    c.fillRect(x, y, w, h);
  };
  const text = (value: string, x: number, baseline: number, size: number, color: string, italic = false) => {
    c.fillStyle = color;
    c.font = `${italic ? 'italic ' : ''}bold ${size}px sans-serif`;
    c.fillText(value, x, baseline);
  };
  return {
    texture,
    update(d: Driver, now: number, delta = 0, tc = 3, abs = 2) {
      if (now < next) return;
      next = now + 50;
      const rpm = Math.round(d.rpm / 50) * 50,
        speed = Math.round(d.speed * 3.6),
        brake = Math.round(Math.min(1, Math.max(0, d.brake)) * 100);
      const limFlash = d.pitLimiter ? Math.floor(now / 200) % 2 : -1;
      const deltaTenth = Number.isFinite(delta) ? Math.round(delta * 10) : 0;
      const readout = [
        d.gear,
        rpm,
        speed,
        brake,
        d.absActive,
        d.tcActive,
        d.compound,
        tc,
        abs,
        deltaTenth,
        limFlash,
      ].join('/');
      if (last === readout) return;
      last = readout;
      rect('#0d141a', 0, 0, 704, 256);
      // Shift rail flashes blue/amber under 60 km/h pit limiter; otherwise tracks 8080 rpm shift
      for (let i = 0; i < 14; i++) {
        if (d.pitLimiter) {
          const on = (i % 2 === 0) === (limFlash === 0);
          rect(on ? (i % 2 === 0 ? '#3da9fc' : '#ffd662') : '#232e38', 31 + i * 46, 12, 39, 18);
        } else {
          const on = rpm >= 4650 + i * 255;
          rect(on ? (i < 6 ? '#71f0ac' : i < 10 ? '#ffd662' : '#ff573d') : '#283139', 31 + i * 46, 12, 39, 18);
        }
      }
      rect('#26383e', 24, 44, 656, 2);
      // Keep the gear and both units inside the clear arc of the rotating rim.
      rect(rpm >= 7950 ? '#fe744f' : '#dbeadc', 283, 51, 128, 125);
      c.textAlign = 'center';
      text('GEAR', 347, 73, 20, '#294044');
      text(d.gear < 0 ? 'R' : d.gear === 0 ? 'N' : String(d.gear), 346, 163, 106, '#0e2026', true);
      text('RPM', 170, 86, 27, '#add1cc');
      text(String(rpm), 169, 153, 66, '#f5f5e6', true);
      text('KM/H', 529, 86, 27, '#add1cc');
      text(String(speed), 529, 153, 70, '#f5f5e6', true);
      c.textAlign = 'left';
      const hot = d.absActive ? '#ffbb47' : '#ff6d58';
      text(d.absActive ? 'ABS' : 'BRK', 62, 210, 29, brake || d.absActive ? hot : '#96aeac');
      for (let i = 0; i < 16; i++) rect(brake > i * 6.25 ? hot : '#314048', 145 + i * 25, 188, 21, 19);
      c.textAlign = 'right';
      text(`${brake}%`, 651, 210, 31, brake ? hot : '#c0cdc7');
      c.textAlign = 'left';
      rect('#233438', 24, 226, 656, 2);
      // Live GT3 telemetry footer arranged inside the left/right cutouts of the steering wheel rim
      const compColor = d.compound === 'wet' ? '#4db8ff' : d.compound === 'medium' ? '#ffd662' : '#ff6b57';
      const compLabel = d.compound === 'wet' ? 'WET' : d.compound === 'medium' ? 'MED' : 'SOFT';
      text(concept ? 'P/01' : 'GT/08', 26, 249, 15, '#8ba2a2');
      rect(compColor, 84, 232, 54, 20);
      c.textAlign = 'center';
      text(compLabel, 111, 247, 14, '#0c1519');
      rect(d.tcActive ? '#ffb84d' : '#1b2830', 146, 232, 56, 20);
      text(`TC${tc}`, 174, 247, 14, d.tcActive ? '#0c1519' : '#9bb3b3');
      rect(d.absActive ? '#ff6d58' : '#1b2830', 208, 232, 62, 20);
      text(`ABS${abs}`, 239, 247, 14, d.absActive ? '#0c1519' : '#9bb3b3');
      c.textAlign = 'right';
      const deltaStr =
        deltaTenth === 0
          ? 'Δ 0.0s'
          : `${deltaTenth > 0 ? '+' : '−'}${(Math.abs(deltaTenth) / 10).toFixed(1)}s`;
      text(deltaStr, 578, 249, 16, deltaTenth < 0 ? '#71f0ac' : deltaTenth > 0 ? '#ff6d58' : '#b7c7c4');
      text(`${Math.round(d.fuelL)}L`, 676, 249, 16, d.fuelL < 8 ? '#ff6d58' : '#8ba2a2');
      c.textAlign = 'left';
      texture.update(true);
    },
  };
}

// The 458 has three silvered faces in the donor's metal batch. Transfer only
// the triangles in their measured recesses: no rectangular overlay or spill
// across the surround. All three sample different crops of ONE mirrored image.
function fit458Mirrors(mount: TransformNode, body: TransformNode, glass: Material) {
  const metal = body.getChildMeshes(true).find((m) => m.name.endsWith('.body.metal'));
  const p = metal?.getVerticesData('position'),
    ids = metal?.getIndices();
  if (!p || !ids) return false;
  const positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = [],
    normals: number[] = [];
  let centre = false;
  for (const side of [0, -1, 1]) {
    const group: number[] = [];
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (let i = 0; i < ids.length; i += 3) {
      const tri = [3 * ids[i], 3 * ids[i + 1], 3 * ids[i + 2]];
      if (
        !tri.every((j) => {
          const x = p[j],
            y = p[j + 1] - mount.position.y,
            z = p[j + 2] - mount.position.z;
          return side
            ? side * x > 0.82 && y > -0.025 && y < 0.145 && z > -0.05 && z < 0.19
            : Math.abs(x) < 0.15 && y > 0.23 && y < 0.355 && z > -0.11 && z < 0.03;
        })
      )
        continue;
      for (const j of tri) {
        group.push(j);
        minX = Math.min(minX, p[j]);
        maxX = Math.max(maxX, p[j]);
        minY = Math.min(minY, p[j + 1]);
        maxY = Math.max(maxY, p[j + 1]);
      }
    }
    if (!group.length) continue;
    if (!side) centre = true;
    for (const j of group) {
      const x = (p[j] - minX) / (maxX - minX),
        y = (p[j + 1] - minY) / (maxY - minY);
      indices.push(indices.length);
      positions.push(
        p[j] - mount.position.x - 0.002 * side,
        p[j + 1] - mount.position.y,
        p[j + 2] - mount.position.z - 0.003,
      );
      normals.push(0, 0, -1);
      uvs.push(side < 0 ? 1 - 0.47 * x : side > 0 ? 0.47 * (1 - x) : 1 - x, y);
    }
  }
  if (positions.length) {
    const faces = new Mesh('silvered rear and wing mirror inserts', mount.getScene()),
      v = new VertexData();
    v.positions = positions;
    v.indices = indices;
    v.normals = normals;
    v.uvs = uvs;
    v.applyToMesh(faces);
    faces.parent = mount;
    faces.material = glass;
    faces.isPickable = false;
    faces.metadata = { noShadowCaster: true };
  }
  return centre;
}

/**
 * Extract the donor's exact front windshield triangles facing inward toward the driver eye
 * (for crisp WGSL + GLSL raindrops & wiper arc with zero dry-weather overdraw) and mount
 * a synchronized 3D GT3 single-arm carbon wiper blade along the windshield rake.
 */
function fitWindshieldRain(
  scene: Scene,
  mount: TransformNode,
  body: TransformNode,
  shell: StandardMaterial,
  concept: boolean,
) {
  const unitTex = RawTexture.CreateRGBATexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  unitTex.name = 'cockpit windshield rain uv anchor';
  const rainMat = new PBRMaterial('cockpit windshield rain', scene);
  rainMat.unlit = true;
  rainMat.albedoColor = Color3.Black();
  rainMat.albedoTexture = unitTex;
  rainMat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  rainMat.disableDepthWrite = true;
  rainMat.backFaceCulling = false;
  rainMat.maxSimultaneousLights = 0;
  const plugin = new WindshieldRainPlugin(rainMat);

  const glassMesh = body.getChildMeshes(true).find((m) => m.name.endsWith('.body.glass'));
  const p = glassMesh?.getVerticesData('position');
  const n = glassMesh?.getVerticesData('normal');
  const ids = glassMesh?.getIndices();

  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;

  if (p && n && ids) {
    const kept: number[] = [];
    for (let i = 0; i < ids.length; i += 3) {
      const a = 3 * ids[i],
        b = 3 * ids[i + 1],
        c = 3 * ids[i + 2];
      const avgNz = (n[a + 2] + n[b + 2] + n[c + 2]) / 3;
      const avgNy = (n[a + 1] + n[b + 1] + n[c + 1]) / 3;
      const avgZ = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
      const avgY = (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
      // Front raked windshield faces forward (+Z) and upward (+Y) in front of the steering column
      if (avgNz > 0.22 && avgNy > 0.18 && avgZ > mount.position.z - 0.18 && avgY > mount.position.y - 0.14) {
        kept.push(a, b, c);
        for (const j of [a, b, c]) {
          minX = Math.min(minX, p[j]);
          maxX = Math.max(maxX, p[j]);
          minY = Math.min(minY, p[j + 1]);
          maxY = Math.max(maxY, p[j + 1]);
          minZ = Math.min(minZ, p[j + 2]);
          maxZ = Math.max(maxZ, p[j + 2]);
        }
      }
    }
    const spanX = Math.max(0.4, maxX - minX);
    const spanY = Math.max(0.25, maxY - minY);
    for (let i = 0; i < kept.length; i += 3) {
      // Reverse winding so inward face confronts driver helmet cleanly
      const tri = [kept[i], kept[i + 2], kept[i + 1]];
      for (const j of tri) {
        indices.push(indices.length);
        positions.push(
          p[j] - mount.position.x - n[j] * 0.005,
          p[j + 1] - mount.position.y - n[j + 1] * 0.005,
          p[j + 2] - mount.position.z - n[j + 2] * 0.005,
        );
        normals.push(-n[j], -n[j + 1], -n[j + 2]);
        uvs.push((p[j] - minX) / spanX, (p[j + 1] - minY) / spanY);
      }
    }
  }

  let rainMesh: Mesh;
  let wiperOrigin: Vector3;
  let wiperRake: number;
  let wiperLen: number;

  if (positions.length > 0) {
    rainMesh = new Mesh('cockpit windshield rain layer', scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.normals = normals;
    vd.uvs = uvs;
    vd.indices = indices;
    vd.applyToMesh(rainMesh);
    rainMesh.parent = mount;
    wiperOrigin = new Vector3(
      0.5 * (minX + maxX) - mount.position.x,
      minY - mount.position.y + 0.015,
      maxZ - mount.position.z - 0.012,
    );
    const dy = Math.max(0.22, maxY - minY);
    const dz = Math.max(0.25, maxZ - minZ);
    wiperRake = Math.atan2(dz, dy);
    wiperLen = Math.min(0.68, Math.hypot(dy, dz) * 0.84);
  } else {
    // Fallback raked windshield quad if donor glass had no separated front pane
    rainMesh = CreatePlane('cockpit windshield rain layer', { width: 1.18, height: 0.62 }, scene);
    rainMesh.parent = mount;
    rainMesh.position.set(0, concept ? 0.56 : 0.25, concept ? 0.24 : 0.34);
    rainMesh.rotation.x = 0.96;
    wiperOrigin = new Vector3(0, concept ? 0.38 : 0.06, concept ? 0.48 : 0.58);
    wiperRake = 0.96;
    wiperLen = 0.52;
  }
  rainMesh.material = rainMat;
  rainMesh.isPickable = false;
  rainMesh.metadata = { noShadowCaster: true };
  rainMesh.setEnabled(false);

  // 3D GT3 Endurance Single-Arm Carbon Wiper mounted on cowl rake
  const wiperMount = new TransformNode('cockpit wiper rake', scene);
  wiperMount.parent = mount;
  wiperMount.position.copyFrom(wiperOrigin);
  wiperMount.rotation.x = -wiperRake;

  const wiperPivot = new TransformNode('cockpit wiper pivot', scene);
  wiperPivot.parent = wiperMount;

  const arm = CreateBox('cockpit wiper arm', { width: 0.014, height: wiperLen * 0.62, depth: 0.01 }, scene);
  arm.parent = wiperPivot;
  arm.position.set(0, wiperLen * 0.31, -0.008);
  arm.material = shell;
  arm.isPickable = false;
  arm.metadata = { noShadowCaster: true };

  const blade = CreateBox('cockpit wiper blade', { width: 0.011, height: wiperLen * 0.56, depth: 0.014 }, scene);
  blade.parent = wiperPivot;
  blade.position.set(0, wiperLen * 0.68, -0.004);
  blade.material = shell;
  blade.isPickable = false;
  blade.metadata = { noShadowCaster: true };

  wiperMount.setEnabled(false);

  let rainClock = 0;
  let wiperClock = 0;
  let lastAngle = 0;

  return {
    update(weather: Weather, speedMs: number, dt: number, sprayAhead: number) {
      const isRain = weather === 'rain';
      const isDamp = weather === 'damp';
      const wet = isRain || isDamp;
      if (rainMesh.isEnabled() !== wet) rainMesh.setEnabled(wet);
      if (wiperMount.isEnabled() !== wet) wiperMount.setEnabled(wet);
      if (!wet) return;

      const step = Math.max(0, Math.min(0.1, dt));
      rainClock += step;
      // Continuous fast endurance sweep in Heavy Rain; crisp intermittent wipe every 3.4s in Damp
      let angle = -1.04;
      let dir = 1;
      let active = 0;
      if (isRain) {
        wiperClock += step * 2.15;
        angle = Math.sin(wiperClock) * 1.04;
        dir = Math.cos(wiperClock) >= 0 ? 1 : -1;
        active = 1;
      } else {
        wiperClock += step;
        const cycle = wiperClock % 3.4;
        if (cycle < 1.25) {
          const u = cycle / 1.25;
          angle = -Math.cos(u * Math.PI * 2) * 1.04;
          dir = u < 0.5 ? 1 : -1;
          active = 0.85;
        } else {
          angle = -1.04;
          dir = 1;
          active = 0.35;
        }
      }
      if (Math.abs(angle - lastAngle) > 1e-4) {
        dir = angle >= lastAngle ? 1 : -1;
      }
      lastAngle = angle;

      wiperPivot.rotation.z = -angle;
      plugin.time = rainClock;
      plugin.intensity = isRain ? 0.94 : 0.44;
      plugin.speedNorm = Math.max(0, Math.min(1, speedMs / 72));
      plugin.wiperAngle = angle;
      plugin.wiperActive = active;
      plugin.wiperDir = dir;
      plugin.sprayBoost = sprayAhead;
      if (isRain) plugin.skyColor = [0.56, 0.62, 0.70];
      else plugin.skyColor = [0.76, 0.81, 0.88];
    },
    dispose() {
      unitTex.dispose();
      if (scene.materials.includes(rainMat)) rainMat.dispose();
    },
  };
}

function fitCockpit(scene: Scene, column: TransformNode) {
  const body = column.parent as TransformNode,
    concept = body.parent!.metadata.sourceChassis === 'concept';
  // A sibling of the rotating steering joint, not a child. Rig rebuilds and
  // scene/device disposal release the entire installation with the donor.
  const mount = new TransformNode('competition cockpit', scene);
  mount.parent = body;
  mount.position.copyFrom(column.position);
  const shell = new StandardMaterial('instrument bezel / graphite', scene);
  shell.diffuseColor.set(0.064, 0.074, 0.081);
  shell.specularColor.set(0.2, 0.23, 0.25);
  const cluster = instruments(scene, concept),
    rear = createRearVision(scene, mount),
    windshield = fitWindshieldRain(scene, mount, body, shell, concept);
  const lcd = new StandardMaterial('instrument anti-glare LCD', scene);
  lcd.disableLighting = true;
  lcd.emissiveColor = Color3.White();
  lcd.specularColor = Color3.Black();
  lcd.diffuseTexture = cluster.texture;
  // Tone-map the rear scene before storing it in RGBA8. The silvered faces
  // reproduce those display values without lighting or grading them a second time.
  const glass = new StandardMaterial('rear vision glass', scene);
  glass.disableLighting = true;
  glass.fogEnabled = false;
  glass.emissiveTexture = rear.target;
  glass.imageProcessingConfiguration = new ImageProcessingConfiguration();
  glass.imageProcessingConfiguration.isEnabled = false;
  glass.backFaceCulling = false;
  const dash = pod('competition cluster', mount, 0.335, 0.122, shell, lcd);
  dash.position.set(0, concept ? 0.292 : 0.058, concept ? 0 : 0.155);
  dash.rotation.x = 0.15;
  if (concept || !fit458Mirrors(mount, body, glass)) {
    const monitor = pod('console rear monitor', mount, 0.266, 0.08, shell, glass);
    monitor.position.set(0.34, concept ? 0.36 : 0.075, 0.13);
    monitor.rotation.set(0.11, 0.24, 0);
    const foot = CreateBox('rear monitor pedestal', { width: 0.042, height: 0.066, depth: 0.034 }, scene);
    foot.parent = monitor;
    foot.position.set(0, -0.065, 0.026);
    foot.material = shell;
    foot.isPickable = false;
    foot.metadata = { noShadowCaster: true };
    rear.target.uScale = -1;
    rear.target.uOffset = 1;
  }
  const eye = new Vector3(0, concept ? 0.545 : 0.185, concept ? -0.745 : -0.515);
  const worldEye = new Vector3();
  mount.onDisposeObservable.addOnce(() => {
    rear.dispose();
    windshield.dispose();
    cluster.texture.dispose();
    // Scene disposal may already have released materials before its nodes.
    if (scene.materials.includes(lcd)) {
      lcd.dispose();
      glass.dispose();
      shell.dispose();
    }
  });
  return {
    mount,
    update(
      driver: Driver,
      live: boolean,
      weather: Weather,
      dt: number,
      delta: number,
      tc: number,
      abs: number,
      sprayAhead: number,
    ) {
      if (!mount.isEnabled()) mount.setEnabled(true);
      Vector3.TransformCoordinatesToRef(eye, mount.computeWorldMatrix(true), worldEye);
      const now = performance.now();
      cluster.update(driver, now, delta, tc, abs);
      rear.refresh(now, live);
      windshield.update(weather, driver.speed, live ? dt : 0, sprayAhead);
      return worldEye;
    },
    suspend() {
      if (mount.isEnabled()) {
        mount.setEnabled(false);
        rear.dequeue();
      }
    },
  };
}

export function createCockpit(scene: Scene) {
  let installed: ReturnType<typeof fitCockpit> | undefined;
  return (
    driver: Driver | undefined,
    active: boolean,
    live: boolean,
    weather: Weather = 'golden',
    dt = 0,
    delta = 0,
    tc = 3,
    abs = 2,
    sprayAhead = 0,
  ) => {
    if (!active || !driver) {
      installed?.suspend();
      return;
    }
    if (!installed) {
      const column = scene.transformNodes.find(
        (n) =>
          n.name === 'driver steering column' &&
          n.parent?.parent?.metadata?.number === driver.number &&
          n.isEnabled(),
      );
      if (!column) return;
      installed = fitCockpit(scene, column);
      installed.mount.onDisposeObservable.addOnce(() => {
        installed = undefined;
      });
    }
    return installed.update(driver, live, weather, dt, delta, tc, abs, sprayAhead);
  };
}
