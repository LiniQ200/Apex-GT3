import type { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Circuit, RaceState } from '../types';
import { buildShowroom } from './showroom';
import { createCockpit } from './cockpit';

const clamp = (x: number, min: number, max: number) => Math.max(min, Math.min(max, x));
const wrapAngle = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));

/** Analytic critical damping; no overshoot even after a long software-rendered frame. */
function spring() {
  let value = 0,
    velocity = 0;
  return {
    at(target: number, omega: number, dt: number, cut: boolean) {
      if (cut) {
        value = target;
        velocity = 0;
        return value;
      }
      const error = value - target,
        v = velocity + omega * error,
        decay = Math.exp(-omega * dt);
      velocity = (velocity - omega * v * dt) * decay;
      return (value = target + (error + v * dt) * decay);
    },
  };
}

export function createCameras(
  scene: Scene,
  circuit: Circuit,
): { update(state: RaceState, lookBack: boolean, dt: number): void } {
  const camera = new FreeCamera('APEX broadcast camera', new Vector3(-7, 2.4, 5), scene);
  camera.inputs.clear();
  camera.minZ = 0.055;
  camera.maxZ = 5500;
  scene.activeCamera = camera;
  const showroom = buildShowroom(scene),
    cockpit = createCockpit(scene),
    canvas = scene.getEngine().getRenderingCanvas();
  const target = new Vector3(),
    local = new Vector3(),
    rotation = Matrix.Identity();
  let lastShot = '',
    lastX = 0,
    lastZ = 0,
    lastSpeed = 0,
    lastYaw = 0,
    lastElapsed = -1,
    holdSide = 0,
    holdDip = 0,
    holdPull = 0,
    holdLookBias = 0,
    holdLat = 0,
    holdShakeX = 0,
    holdShakeY = 0,
    followYaw = 0,
    garageClock = 0,
    rumbleClock = 0,
    orbitYaw = 0,
    orbitPitch = 0,
    orbitDragging = false,
    orbitLastX = 0,
    orbitLastY = 0;
  const sway = spring(),
    heave = spring(),
    surge = spring(),
    lens = spring(),
    apexLook = spring();
  const reducedMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Interactive Competition Garage Bay 01 orbit drag so players can inspect their GT3 from every angle
  if (canvas) {
    const onDown = (e: PointerEvent) => {
      if (lastShot !== 'garage' || e.button !== 0) return;
      orbitDragging = true;
      orbitLastX = e.clientX;
      orbitLastY = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!orbitDragging) return;
      orbitYaw = clamp(orbitYaw - (e.clientX - orbitLastX) * 0.0055, -2.4, 2.4);
      orbitPitch = clamp(orbitPitch + (e.clientY - orbitLastY) * 0.0035, -0.09, 0.28);
      orbitLastX = e.clientX;
      orbitLastY = e.clientY;
    };
    const onUp = () => {
      orbitDragging = false;
    };
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    scene.onDisposeObservable.addOnce(() => {
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    });
  }

  function garage(dt: number) {
    garageClock += dt;
    if (!orbitDragging) {
      orbitYaw *= Math.exp(-0.22 * dt);
      orbitPitch *= Math.exp(-0.35 * dt);
    }
    const w = canvas?.clientWidth || window.innerWidth || 1280,
      h = canvas?.clientHeight || window.innerHeight || 720,
      aspect = w / h;
    const compact = w <= 760 && aspect <= 1.2;
    const edge = w <= 760 ? 12 : w <= 900 ? 17 : clamp(w * 0.027, 18, 48);
    const panel = w <= 760 ? 244 : w <= 900 ? 263 : clamp(w * 0.254, 278, 365);
    const free = compact ? w : w - panel - 2 * edge;
    const centreX = compact ? w * 0.5 : edge + free * 0.5,
      centreY = h * (compact ? 0.325 : 0.535);
    const angle = -0.91 + orbitYaw + (reducedMotion ? 0 : 0.16 * Math.sin(garageClock * 0.135));
    const sx = Math.sin(angle),
      sz = Math.cos(angle),
      elev = clamp(0.195 + orbitPitch + (reducedMotion ? 0 : 0.017 * Math.sin(garageClock * 0.11)), 0.09, 0.48);
    const se = Math.sin(elev),
      ce = Math.cos(elev);
    camera.fov = 0.66;
    const focal = h / (2 * Math.tan(camera.fov / 2));
    const targetWidth = Math.min(free * (compact ? 0.85 : 0.81), h * (compact ? 1.5 : 1.07));
    const r = Math.max(
      5.2,
      (focal * (4.74 * Math.abs(sx) + 2.08 * Math.abs(sz))) / Math.max(80, targetWidth),
    );
    // Shift the entire camera parallel to its screen, not its yaw. The product
    // stays undistorted and remains in the left gallery / upper mobile viewport.
    const dx = ((w * 0.5 - centreX) * r) / focal,
      dy = ((centreY - h * 0.5) * r) / focal;
    const tx = -sz * dx - sx * se * dy,
      tz = sx * dx - sz * se * dy,
      ty = 0.63 + ce * dy;
    target.set(tx, ty, tz);
    camera.position.set(tx + sx * r * ce, ty + r * se, tz + sz * r * ce);
    camera.setTarget(target);
  }
  garage(0);

  return {
    update(s, lookBack, rawDt) {
      const dt = clamp(Number.isFinite(rawDt) ? rawDt : 0, 0, 0.2),
        inGarage = s.phase === 'garage';
      if (showroom.isEnabled() !== inGarage) showroom.setEnabled(inGarage);
      const car = s.drivers.find((d) => d.id === 0);
      let sprayAhead = 0;
      if (car && (s.settings.weather === 'rain' || s.settings.weather === 'damp')) {
        for (const r of s.drivers) {
          if (r.id === car.id || r.speed < 12) continue;
          let gap = r.s - car.s;
          if (gap < -circuit.length * 0.5) gap += circuit.length;
          else if (gap > circuit.length * 0.5) gap -= circuit.length;
          if (gap > 2.5 && gap < 28 && Math.abs(r.d - car.d) < 3.2) {
            sprayAhead = Math.max(sprayAhead, clamp((28 - gap) / 22, 0, 1) * clamp(r.speed / 55, 0, 1));
          }
        }
      }
      const eye = cockpit(
        car,
        !inGarage && !lookBack && s.camera === 'cockpit',
        s.phase === 'race' || s.phase === 'lights',
        s.settings.weather,
        dt,
        s.delta,
        s.tc,
        s.abs,
        sprayAhead,
      );
      if (inGarage) {
        garage(dt);
        lastShot = 'garage';
        return;
      }
      if (!car) return;
      const shot = lookBack ? 'reverse' : s.camera;
      const movedDist = Math.hypot(car.x - lastX, car.z - lastZ);
      const jump = movedDist > Math.max(18, car.speed * Math.max(dt, 0.05) * 3.5);
      const cut = lastShot !== shot || jump || lastElapsed < 0 || s.elapsed < lastElapsed;
      const simDt = cut ? 0 : Math.max(0, Math.min(0.25, s.elapsed - lastElapsed));
      const stepped = cut || simDt > 0.0001 || movedDist > 0.001;
      if (stepped) {
        const effDt = simDt > 0.0001 ? simDt : dt;
        const deltaYaw = cut ? 0 : wrapAngle(car.yaw - lastYaw),
          acc = cut || effDt < 0.001 ? 0 : (car.speed - lastSpeed) / effDt;
        holdLat = cut || effDt < 0.001 ? 0 : (car.speed * deltaYaw) / effDt;
        holdSide = sway.at(clamp(-holdLat * 0.015, -0.24, 0.24), 10.5, effDt, cut);
        holdDip = heave.at(clamp(acc * 0.012, -0.14, 0.12), 9, effDt, cut);
        holdPull = surge.at(clamp(acc * 0.035, -0.37, 0.33), 6.8, effDt, cut);
        const speedNorm = clamp(car.speed / 85, 0, 1);
        const moving = movedDist > 0.001 && !cut;
        if (moving) rumbleClock += effDt * (24 + 42 * speedNorm);
        const surfaceAmp =
          reducedMotion || !moving || car.speed < 4
            ? 0
            : car.surface === 'kerb'
              ? 0.016 * (0.4 + 0.6 * speedNorm)
              : car.surface === 'gravel' || car.surface === 'grass'
                ? 0.024 * (0.4 + 0.6 * speedNorm)
                : 0.0016 * speedNorm * speedNorm;
        holdShakeY = surfaceAmp * Math.sin(rumbleClock * 1.9);
        holdShakeX = surfaceAmp * 0.55 * Math.cos(rumbleClock * 1.3);
        holdLookBias = apexLook.at(shot === 'cockpit' ? clamp(car.steer * 5.2, -2.4, 2.4) : 0, 7.5, effDt, cut);
        lastShot = shot;
        lastYaw = car.yaw;
        lastSpeed = car.speed;
        lastX = car.x;
        lastZ = car.z;
        lastElapsed = s.elapsed;
      }
      const sin = Math.sin(car.yaw),
        cos = Math.cos(car.yaw),
        speed = clamp(car.speed / 85, 0, 1);
      const effSpringDt = simDt > 0.0001 ? simDt : cut ? 0 : 0;

      if (shot === 'chase' || shot === 'reverse') {
        const back = shot === 'reverse';
        const desired = car.yaw + (back ? Math.PI : 0);
        followYaw = cut
          ? desired
          : stepped
            ? followYaw + wrapAngle(desired - followYaw) * (1 - Math.exp(-10.5 * (simDt > 0.0001 ? simDt : dt)))
            : followYaw;
        const fs = Math.sin(followYaw),
          fc = Math.cos(followYaw),
          dist = 5.85 + speed * 0.55 + holdPull * 0.85,
          height = 2.08 + speed * 0.16 + holdDip + holdShakeY * 0.7;
        camera.position.set(
          car.x - fs * dist + fc * (holdSide + holdShakeX),
          car.y + height + (back ? -1 : 1) * dist * Math.sin(car.pitch) * 0.85,
          car.z - fc * dist - fs * (holdSide + holdShakeX),
        );
        target.set(
          car.x + fs * 2.55,
          car.y + 0.94 - (back ? -1 : 1) * 2.55 * Math.sin(car.pitch),
          car.z + fc * 2.55,
        );
        camera.fov = lens.at(0.84 + 0.14 * speed, 6.5, effSpringDt, cut);
        camera.setTarget(target);
        camera.rotation.z = clamp(car.roll * 0.22 + holdSide * 0.025, -0.03, 0.03);
        return;
      }
      if (shot === 'hood' || shot === 'cockpit') {
        const helmet = shot === 'cockpit',
          central = s.settings.chassis === 'concept';
        Matrix.RotationYawPitchRollToRef(car.yaw, car.pitch, car.roll, rotation);
        if (eye) {
          camera.position.copyFrom(eye);
          camera.position.y += holdShakeY * 0.40 - (helmet ? holdDip * 0.10 : 0);
        } else {
          // Provisional helmet pose while a new rig is loading behind the curtain.
          local.set(
            helmet && !central ? -0.315 : 0,
            (helmet ? (central ? 1.11 : 0.96) : 1.06) + holdShakeY * 0.40,
            helmet ? (central ? 0.24 : -0.16) : 1.21,
          );
          Vector3.TransformCoordinatesToRef(local, rotation, camera.position);
          camera.position.addInPlaceFromFloats(car.x, car.y, car.z);
        }
        local.set(holdLookBias, (helmet ? -1.05 : -1.92) - holdDip * 0.85, 24);
        Vector3.TransformNormalToRef(local, rotation, target);
        target.addInPlace(camera.position);
        camera.fov = lens.at(helmet ? 1.05 + 0.045 * speed : 0.935 + 0.065 * speed, 8, effSpringDt, cut);
        camera.setTarget(target);
        camera.rotation.z = car.roll + (helmet ? clamp(-holdLat * 0.0012, -0.022, 0.022) : 0);
        return;
      }
      // A chain of fixed tripod positions cuts between high stand, low apex and
      // long-lens shots by track station. Camera pans independently of its support.
      const stations = 26,
        span = circuit.length / stations,
        s0 = ((car.s % circuit.length) + circuit.length) % circuit.length;
      const brakingCamera = s0 >= 610 && s0 < 705;
      const sector = Math.floor(s0 / span),
        station = brakingCamera ? 678 : (sector + 0.61) * span;
      const road = circuit.at(station);
      const sideOfRoad = Math.abs(road.kappa) > 0.001 ? -Math.sign(road.kappa) : sector % 2 ? 1 : -1;
      const post = circuit.at(station, sideOfRoad * (road.halfWidth + (sector % 3 === 2 ? 10 : 5)));
      camera.position.set(
        post.x,
        Math.max(post.y, road.y) +
          (brakingCamera ? 1.95 : sector % 3 === 0 ? 7.1 : sector % 3 === 1 ? 3.7 : 5.2),
        post.z,
      );
      const lead = Math.min(1.15, car.speed * 0.025);
      target.set(car.x + sin * lead, car.y + 0.67, car.z + cos * lead);
      const distance = Vector3.Distance(camera.position, target);
      camera.fov = clamp(2 * Math.atan((brakingCamera ? 2.35 : 4.5) / distance), 0.135, 0.87);
      camera.setTarget(target);
    },
  };
}
