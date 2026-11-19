import type { BuildVehicle } from '../types';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { Quaternion } from '@babylonjs/core/Maths/math.vector';
import { carFinish, contactShadow, pbr } from '../materials/carFinish';
import { corners, studio } from './studio';
import { aero, caliper } from './aero';

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
  const nearFar: { mesh: (typeof s.parts)[number]['mesh']; part: (typeof s.parts)[number] }[] = [];
  for (const part of s.parts) {
    const { slot, wheel, joint: at } = part,
      parent = at === 'column' ? column : at === 'body' ? body : wheels[wheel][at];
    const mat = slot === 'rotor' ? rotors[wheel] : slot === 'taillight' ? tail : f[slot];
    const mesh = part.mesh.clone(
      `${number}.${at}.${wheel < 0 ? '' : corners[wheel] + '.'}${slot === 'paint' ? 'bodywork' : slot}`,
      parent,
      true,
    );
    mesh.setEnabled(true);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    nearFar.push({ mesh, part });
  }
  if (s.source === '458')
    for (let i = 0; i < 4; i++)
      caliper(scene, wheels[i].steer, Math.sign(s.hubs[i].x), s.radii[i], f.caliper);
  const kit = aero(scene, body, s, f, rain, chassis === 'concept');
  const shadow = CreateGround('ambient contact shadow decal', { width: 2.6, height: 5.12 }, scene);
  shadow.parent = root;
  shadow.position.y = 0.025;
  shadow.material = contactShadow(scene, s);
  shadow.isPickable = false;
  shadow.metadata = { noShadowCaster: true };
  let clock = 0,
    flash = 0,
    lastGear = 0,
    lastThrottle = 0,
    flaming = false,
    far = false;
  let flashLight: PointLight | null = null;
  return {
    root,
    update(d, dt) {
      root.position.set(d.x, d.y, d.z);
      root.rotation.set(d.pitch, d.yaw, d.roll);
      const steer = clamp(d.steer, -maxSteer, maxSteer),
        co = d.wheelCompressionM;
      Quaternion.RotationAxisToRef(s.columnAxis, -steer * 5.6, column.rotationQuaternion!);
      for (let i = 0; i < 4; i++) {
        const w = wheels[i];
        w.hub.position.y = s.hubs[i].y + clamp(co[i] ?? restCompression, 0, 0.15) - restCompression;
        w.steer.rotation.y = i < 2 ? steer : 0;
        w.spin.rotation.x = d.wheelAngle;
        // Temperatures come from the solver's actual brake impulse * speed
        // and convective cooling. Leave unheated carbon ceramic charcoal-grey.
        const t = clamp(((d.brakeTempC[i] ?? 20) - 320) / 460, 0, 1.35),
          hot = Math.max(0, t - 0.25);
        rotors[i].emissiveColor.set(t * (0.55 + 2.8 * t), hot * hot * 0.99, hot * hot * 0.065);
      }
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
        for (const mesh of kit.exhaust) mesh.setEnabled(on);
        flaming = on;
      }
      if (d.id === 0 && on && !flashLight) {
        flashLight = new PointLight('player side exhaust flash', kit.exhaustPort.clone(), scene);
        flashLight.parent = body;
        flashLight.range = 2.5;
        flashLight.diffuse.set(1, 0.38, 0.07);
      }
      if (flashLight) flashLight.intensity = on ? 8 * (flash / 0.105) : 0;
      flash = Math.max(0, flash - dt);
      lastGear = d.gear;
      lastThrottle = d.throttle;
      // Switch geometry once per car as it crosses the band. Unlike one LOD
      // node per mesh, this does not double scene traversal or shadow casters.
      const cp = scene.activeCamera?.globalPosition;
      if (cp) {
        const ds = (cp.x - d.x) ** 2 + (cp.y - d.y) ** 2 + (cp.z - d.z) ** 2,
          next = ds > (far ? 28 : 35) ** 2;
        if (next !== far) {
          far = next;
          for (const { mesh, part } of nearFar) {
            mesh.releaseSubMeshes();
            (far ? part.far : part.mesh).geometry!.applyToMesh(mesh);
          }
        }
      }
    },
    dispose() {
      flashLight?.dispose();
      root.dispose();
      tail.dispose();
      rain.dispose();
      for (const r of rotors) r.dispose();
    },
  };
};
