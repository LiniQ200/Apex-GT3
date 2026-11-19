import type { Circuit, Driver, Settings } from '../types';
import { STEP, clamp, wrapAngle, type Controls } from '../physics/world';

export function createPilots(track: Circuit) {
  // Integrate the braking envelope backwards; a blind bend beyond the current
  // lookahead must already constrain the speed at the end of a long straight.
  const count = Math.ceil(track.length / 3),
    spacing = track.length / count;
  const limit = Float32Array.from({ length: count }, (_, i) =>
    Math.min(82, Math.sqrt(12.4 / Math.max(0.0001, Math.abs(track.at(i * spacing).kappa)))),
  );
  for (let i = count * 2 - 1; i >= 0; i--) {
    const n = i % count;
    limit[n] = Math.min(limit[n], Math.sqrt(limit[(n + 1) % count] ** 2 + 2 * 10.4 * spacing));
  }
  const lanes: number[] = [];
  function pilot(d: Driver, grid: Driver[], opts: Settings): Controls {
    const at = Math.floor(d.s / spacing) % count,
      pace = { clubman: 0.86, pro: 0.96, platinum: 1.02 }[opts.pace],
      variation = d.id === 0 ? 1 : 1 + ((d.id % 4) - 1.5) * 0.012;
    let speed = limit[(at + 1) % count] * pace * variation * (opts.weather === 'damp' ? 0.943 : 1),
      draft = 0;
    const look = clamp(5 + d.speed * 0.48, 7, 38),
      bend = track.at(d.s + look);
    let lane = clamp(bend.kappa * 125, -2.5, 2.5);
    const packStart = d.distance < 850;
    if (packStart) lane = (d.id % 2 === 0 ? -1 : 1) * 2.8;
    let closest = Infinity;
    for (const rival of grid) {
      if (rival === d) continue;
      let gap = rival.s - d.s;
      if (gap < -track.length / 2) gap += track.length;
      if (gap > track.length / 2) gap -= track.length;
      if (gap > 4.5 && gap < 35 && Math.abs(rival.d - d.d) < 2.3) draft = Math.max(draft, (35 - gap) / 30);
      if (gap > 0 && gap < 24 && Math.abs(rival.d - d.d) < 2.45)
        speed = Math.min(speed, rival.speed + clamp((gap - 8) * 0.95, -4, 14));
      if (packStart || gap < -3.6 || gap > 27 || gap > closest) continue;
      closest = gap;
      if (Math.abs(rival.d - lane) < 2.6) {
        const side = Math.abs(rival.d - d.d) > 0.5 ? Math.sign(d.d - rival.d) : rival.d > 0 ? -1 : 1;
        lane = clamp(rival.d + side * 3.25, -4.6, 4.6);
      }
    }
    lanes[d.id] ??= d.d;
    lanes[d.id] += clamp(lane - lanes[d.id], -STEP * 2.8, STEP * 2.8);
    const aim = track.at(d.s + look, lanes[d.id]),
      bearing = wrapAngle(Math.atan2(aim.x - d.x, aim.z - d.z) - d.yaw);
    const steer = Math.atan2(2 * 2.64 * Math.sin(bearing), look) * 2.05;
    const err = speed - d.speed;
    return {
      right: clamp(steer, -1, 1),
      throttle: clamp(err * 0.55, 0, 1),
      brake: clamp(-err * 0.42, 0, 1),
      handbrake: 0,
      draft,
    };
  }
  return {
    pilot,
    reset: () => {
      lanes.length = 0;
    },
  };
}
