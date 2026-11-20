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
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Driver } from '../types';
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
    update(d: Driver, now: number) {
      if (now < next) return;
      next = now + 50;
      const rpm = Math.round(d.rpm / 50) * 50,
        speed = Math.round(d.speed * 3.6),
        brake = Math.round(Math.min(1, Math.max(0, d.brake)) * 100);
      const limFlash = d.pitLimiter ? Math.floor(now / 200) % 2 : -1;
      const readout = [d.gear, rpm, speed, brake, d.absActive, limFlash].join('/');
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
      rect('#233438', 24, 228, 656, 2);
      text(concept ? 'P / 01     ENDURANCE' : 'GT / 08     CORSA', 29, 249, 16, '#8ba2a2');
      c.textAlign = 'right';
      text('RACE   •   DATA SYSTEMS', 676, 249, 16, '#8ba2a2');
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
    rear = createRearVision(scene, mount);
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
    update(driver: Driver, live: boolean) {
      if (!mount.isEnabled()) mount.setEnabled(true);
      Vector3.TransformCoordinatesToRef(eye, mount.computeWorldMatrix(true), worldEye);
      const now = performance.now();
      cluster.update(driver, now);
      rear.refresh(now, live);
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
  return (driver: Driver | undefined, active: boolean, live: boolean) => {
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
    return installed.update(driver, live);
  };
}
