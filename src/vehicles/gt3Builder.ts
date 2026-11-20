import type { BuildVehicle } from '../types';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { Quaternion } from '@babylonjs/core/Maths/math.vector';
import { carFinish, contactShadow, pbr } from '../materials/carFinish';
import { corners, detailBands, studio } from './studio';

const restCompression = 0.03,
  maxSteer = (28 * Math.PI) / 180;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Metres. Y up, +Z forward, +X right. Root origin lies on the road under
 * the centre of the homologated footprint; all imported transforms are
 * already baked into the relevant body's or hub's local coordinate system. */
export const buildVehicle: BuildVehicle = async (scene, chassis, livery, number) => {
  const s = await studio(scene, chassis),
    f = carFinish(scene, livery, number);
  const root = new TransformNode(`GT3 #${number} ${chassis}`, scene);
  root.metadata = { chassis, sourceChassis: s.source, number, wheelOrder: corners };
  const joint = (name: string, parent: TransformNode) => {
    const n = new TransformNode(name, scene);
    n.parent = parent;
    return n;
  };
  const body = joint('chassis', root),
    column = joint('driver steering column', body);
  column.position.copyFrom(s.column);
  column.rotationQuaternion = Quaternion.Identity();
  const wheels = corners.map((k, i) => {
    const hub = joint('hub.' + k, root),
      steer = joint('steer.' + k, hub),
      spin = joint('spin.' + k, steer);
    hub.position.copyFrom(s.hubs[i]);
    return { hub, steer, spin };
  });
  const tail = pbr(scene, number + '.LED tail', '#a91623', 0.25, 0.19);
  tail.emissiveColor.set(0.55, 0.006, 0.005);
  const rain = pbr(scene, number + '.rain', '#ab182c', 0.14, 0.21);
  rain.emissiveColor.set(2.1, 0.008, 0.002);
  const rotors = corners.map((k) => {
    const m = pbr(scene, `${number}.${k}.disc`, '#73757a', 0.7, 0.46);
    m.albedoTexture = f.discMap;
    m.emissiveTexture = f.discMap;
    return m;
  });
  const exhaust: Mesh[] = [];
  const pieces = s.parts.map((part) => {
    const { slot, wheel, joint: at } = part,
      parent = at === 'column' ? column : at === 'body' ? body : wheels[wheel][at];
    const name = `${number}.${at}.${wheel < 0 ? '' : corners[wheel] + '.'}${slot === 'paint' ? 'bodywork' : slot}`;
    const mesh = new Mesh(part.label ?? name, scene);
    mesh.parent = parent;
    mesh.material =
      slot === 'rotor'
        ? rotors[Math.max(0, wheel)]
        : slot === 'taillight'
          ? tail
          : slot === 'rain'
            ? rain
            : f[slot];
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    // Keep the authored role even for named kit pieces and merged LOD batches.
    // Camera passes must not infer roofs, glazing or wheels from display names.
    mesh.metadata = { noShadowCaster: true, rigPart: { joint: at, slot, wheel } };
    const transient = slot === 'flame' || slot === 'core';
    if (transient) exhaust.push(mesh);
    return { mesh, levels: part.levels, transient };
  });
  const proxy = new Mesh(number + '.sun silhouette', scene);
  s.shadow.applyToMesh(proxy);
  proxy.parent = body;
  proxy.layerMask = 0;
  proxy.material = f.shadowHull;
  proxy.isPickable = false;
  proxy.metadata = { shadowProxy: true };
  const footprint = { width: s.fit.width + 0.56, height: s.fit.length + 0.49 };
  const shadow = CreateGround('ambient contact shadow decal', footprint, scene);
  shadow.parent = root;
  shadow.position.y = 0.025;
  shadow.material = contactShadow(scene, s, footprint);
  shadow.isPickable = false;
  shadow.metadata = { noShadowCaster: true };
  let clock = 0,
    flash = 0,
    lastGear = 0,
    lastThrottle = 0,
    flaming = false,
    detail = 0;
  function show(level: number) {
    for (const { mesh, levels, transient } of pieces) {
      const g = levels[level] ?? (level > 3 ? levels[3] : undefined);
      if (g && mesh.geometry !== g) {
        mesh.releaseSubMeshes();
        g.applyToMesh(mesh);
      }
      mesh.setEnabled(!!g && (!transient || flaming));
    }
    detail = level;
  }
  show(0);
  let flashLight: PointLight | null = null;
  return {
    root,
    update(d, dt) {
      root.position.set(d.x, d.y, d.z);
      root.rotation.set(d.pitch, d.yaw, d.roll);
      const cam = scene.activeCamera;
      if (cam) {
        cam.getViewMatrix(); // sync globalPosition after a cut, including a parented camera
        const eye = cam.globalPosition,
          lens = cam.getProjectionMatrix().m;
        const distance = Math.hypot(eye.x - d.x, eye.y - d.y - 0.6, eye.z - d.z);
        const pixels =
          (scene.getEngine().getRenderHeight(true) * cam.viewport.height * Math.abs(lens[5]) * 0.5) /
          (lens[15] === 1 ? 1 : Math.max(0.1, distance));
        let next = detail;
        // Preserve the inspection car even in a narrow garage viewport, and
        // the actual dashboard/column when the camera is inside the vehicle.
        if (distance < 3 || (d.id === 0 && d.speed === 0 && pixels > 24)) next = 0;
        else {
          while (next < detailBands.length && pixels < detailBands[next] * 0.92) next++;
          while (next > 0 && pixels > detailBands[next - 1] * 1.08) next--;
          // Reconstruction/upscaling magnifies cracks long before a nearby
          // physical panel or moving wheel should simplify to a fixed batch.
          if (distance < 15) next = Math.min(next, 1);
        }
        if (next !== detail) show(next);
      }
      const steer = clamp(d.steer, -maxSteer, maxSteer),
        co = d.wheelCompressionM;
      if (detail === 0) Quaternion.RotationAxisToRef(s.columnAxis, -steer * 5.6, column.rotationQuaternion!);
      let red = 0,
        green = 0,
        blue = 0;
      for (let i = 0; i < 4; i++) {
        // Temperatures come from the solver's actual brake impulse * speed
        // and convective cooling. Leave unheated carbon ceramic charcoal-grey.
        const t = clamp(((d.brakeTempC[i] ?? 20) - 320) / 460, 0, 1.35),
          hot = Math.max(0, t - 0.25),
          r = t * (0.55 + 2.8 * t),
          g = hot * hot * 0.99,
          b = hot * hot * 0.065;
        if (detail < 2) {
          const w = wheels[i];
          w.hub.position.y = s.hubs[i].y + clamp(co[i] ?? restCompression, 0, 0.15) - restCompression;
          w.steer.rotation.y = i < 2 ? steer : 0;
          w.spin.rotation.x = d.wheelAngles?.[i] ?? d.wheelAngle;
          rotors[i].emissiveColor.set(r, g, b);
        } else {
          red += r;
          green += g;
          blue += b;
        }
      }
      if (detail >= 2) rotors[0].emissiveColor.set(red * 0.25, green * 0.25, blue * 0.25);
      const avg = (co[0] + co[1] + co[2] + co[3]) * 0.25;
      shadow.position.y = 0.025 + clamp(avg - restCompression, -0.02, 0.085);
      shadow.rotation.x = clamp(
        (-(co[0] + co[1] - (co[2] + co[3])) * 0.5) / (s.hubs[0].z - s.hubs[2].z),
        -0.1,
        0.1,
      );
      shadow.rotation.z = clamp(
        ((co[1] + co[3] - (co[0] + co[2])) * 0.5) / (s.hubs[1].x - s.hubs[0].x),
        -0.1,
        0.1,
      );
      shadow.visibility = clamp(0.84 + (avg - restCompression) * 1.8, 0.74, 1);
      clock += Math.max(0, dt);
      rain.emissiveIntensity = (clock + d.id * 0.07) % 1.2 < 0.35 ? 1 : 0.09;
      tail.emissiveIntensity = 0.83 + 4.2 * clamp(d.brake, 0, 1);
      if (lastGear > 0 && d.gear > lastGear && d.speed > 8) flash = 0.105;
      else if (lastThrottle > 0.58 && d.throttle < 0.13 && d.rpm > 4900 && d.speed > 14) flash = 0.065;
      const on = flash > 0;
      if (on !== flaming) {
        for (const mesh of exhaust) mesh.setEnabled(on);
        flaming = on;
      }
      if (d.id === 0 && on && !flashLight) {
        flashLight = new PointLight('player side exhaust flash', s.exhaustPort.clone(), scene);
        flashLight.parent = body;
        flashLight.range = 2.5;
        flashLight.diffuse.set(1, 0.38, 0.07);
      }
      if (flashLight) flashLight.intensity = on ? 8 * (flash / 0.105) : 0;
      flash = Math.max(0, flash - dt);
      lastGear = d.gear;
      lastThrottle = d.throttle;
    },
    dispose() {
      flashLight?.dispose();
      // Geometry belongs to the scene/chassis cache, not to its last car.
      for (const { mesh } of pieces) mesh.geometry?.releaseForMesh(mesh);
      s.shadow.releaseForMesh(proxy);
      root.dispose();
      tail.dispose();
      rain.dispose();
      for (const r of rotors) r.dispose();
    },
  };
};
