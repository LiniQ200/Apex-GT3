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
  const plans: { startLane: number; lane: number; rival: number; side: number }[] = [];
  const gapTo = (d: Driver, r: Driver) => {
    const gap = r.s - d.s;
    return gap > track.length / 2 ? gap - track.length : gap < -track.length / 2 ? gap + track.length : gap;
  };
  function pilot(d: Driver, grid: Driver[], opts: Settings): Controls {
    const at = Math.floor(d.s / spacing) % count,
      pace = { clubman: 0.86, pro: 0.96, platinum: 1.02 }[opts.pace],
      variation = d.id === 0 ? 1 : 1 + ((d.id % 4) - 1.5) * 0.012;
    let speed = limit[(at + 1) % count] * pace * variation * (opts.weather === 'damp' ? 0.943 : 1),
      draft = 0;
    const look = clamp(5 + d.speed * 0.48, 7, 38),
      bend = track.at(d.s + look),
      edge = bend.halfWidth - 1.6,
      clearance = 3.35,
      opening = clamp((850 - d.distance) / 110, 0, 1),
      plan = (plans[d.id] ??= { startLane: d.d, lane: d.d, rival: -1, side: 0 }),
      line = opening * plan.startLane + (1 - opening) * clamp(bend.kappa * 125, -2.5, 2.5);
    let left = -edge,
      right = edge,
      nearest = Infinity;
    let passing: Driver | undefined;
    for (const r of grid) {
      if (r === d) continue;
      const gap = gapTo(d, r),
        lateral = r.d - d.d,
        closing = d.speed - r.speed;
      if (r.id === plan.rival && gap >= -10 && gap < 110) passing = r;
      if (gap > 4.5 && gap < 35 && Math.abs(lateral) < 2.3) draft = Math.max(draft, (35 - gap) / 30);
      // Keep an overlap, including a faster car about to reach our rear quarter.
      if (gap > -8 - Math.max(0, -closing) * 0.9 && gap < 7 && Math.abs(lateral) > 0.65) {
        if (lateral > 0) right = Math.min(right, r.d - clearance);
        else left = Math.max(left, r.d + clearance);
      }
      const closingIn = d.speed > 4 && (closing > 1.3 || (opening === 0 && speed > r.speed + 3 && gap < 19));
      const queued = gap < 22 && r.speed < 1;
      if (
        gap > 0 &&
        gap < nearest &&
        gap < clamp(26 + 2.4 * closing, 25, 125) &&
        Math.abs(lateral) < clearance &&
        (closingIn || queued)
      )
        nearest = gap;
    }
    function available(lane: number, target: Driver) {
      if (lane < left || lane > right) return false;
      const front = gapTo(d, target) + 7;
      return !grid.some((r) => {
        if (r === d || r === target) return false;
        const gap = gapTo(d, r),
          projected = gap + (r.speed - d.speed) * 1.2;
        if (Math.abs(r.d - lane) < 2.7)
          return Math.max(gap, projected) > -8 && Math.min(gap, projected) < front;
        const crosses = (r.d - d.d) * (lane - r.d) > 0;
        return crosses && Math.max(gap, projected) > -8 && Math.min(gap, projected) < 8;
      });
    }
    if (passing && gapTo(d, passing) > 8 && !available(passing.d + plan.side * clearance, passing))
      passing = undefined;
    if (!passing) {
      plan.rival = -1;
      if (Number.isFinite(nearest)) {
        let best = Infinity;
        // Two cars abreast can close both sides of the nearest car while
        // leaving a clear route around the outside of the second one.
        for (const target of grid) {
          if (target === d || Math.abs(gapTo(d, target) - nearest) > 5) continue;
          for (const side of [-1, 1]) {
            const lane = target.d + side * clearance;
            if (!available(lane, target)) continue;
            const cost = Math.abs(lane - d.d) + 0.45 * Math.abs(lane - line);
            if (cost < best || (cost === best && target.id < plan.rival)) {
              best = cost;
              plan.side = side;
              plan.rival = target.id;
              passing = target;
            }
          }
        }
      }
    }
    const wanted = passing ? passing.d + plan.side * clearance : line;
    const lane = left <= right ? clamp(wanted, left, right) : clamp(d.d, -edge, edge);
    plan.lane += clamp(lane - plan.lane, -STEP * 3.5, STEP * 3.5);
    // At walking speed two aligned GT3s can fit more closely; at racing
    // speed allow for yaw, tyre slip and the time needed to steer away.
    const width = 2.35 + Math.min(0.4, d.speed * 0.008);
    for (const r of grid) {
      if (r === d) continue;
      const gap = gapTo(d, r);
      if (
        gap <= 0 ||
        gap > 220 ||
        r.d < Math.min(d.d, plan.lane) - width ||
        r.d > Math.max(d.d, plan.lane) + width
      )
        continue;
      // Brake for the available distance even when a pass is planned: asking to
      // change lane is not the same as already clearing the other car's body.
      // Leave enough room to steer out from behind a stopped queue when it opens.
      const standOff = r.speed < 1 ? (passing && Math.abs(r.d - lane) > 2.7 ? 4.9 : 19) : 6.2;
      const room = gap - (standOff + 0.11 * d.speed),
        decel = opts.weather === 'damp' ? 7.4 : 8.4;
      speed = Math.min(
        speed,
        Math.max(0, r.speed + room * 0.88),
        Math.sqrt(r.speed ** 2 + 2 * decel * Math.max(0, room)),
      );
    }
    const aim = track.at(d.s + look, plan.lane),
      bearing = wrapAngle(Math.atan2(aim.x - d.x, aim.z - d.z) - d.yaw);
    const steer = Math.atan2(2 * 2.64 * Math.sin(bearing), look) * 2.05;
    const err = speed - d.speed,
      hold = speed < 0.9 && d.speed < 2;
    return {
      right: clamp(steer, -1, 1),
      throttle: hold ? 0 : clamp(err * 0.55, 0, 1),
      brake: hold ? 1 : clamp(-err * 0.42, 0, 1),
      handbrake: 0,
      draft,
    };
  }
  return {
    pilot,
    reset: () => {
      plans.length = 0;
    },
  };
}
