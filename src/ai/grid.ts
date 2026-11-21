import type { Circuit, Driver, Settings } from '../types';
import { STEP, clamp, wrapAngle, type Controls } from '../physics/world';
import {
  PIT_BOX_D,
  PIT_ENTRY_START_BACK,
  PIT_FAST_LANE_D,
  PIT_SPEED_LIMIT_MS,
  PIT_WALL_END_S,
  PIT_WALL_START_BACK,
} from '../track/circuit';

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
  const plans: { startLane: number; lane: number; rival: number; side: number; wantPit: boolean }[] = [];
  const gapTo = (d: Driver, r: Driver) => {
    const gap = r.s - d.s;
    return gap > track.length / 2 ? gap - track.length : gap < -track.length / 2 ? gap + track.length : gap;
  };
  const hasPitLane = track.length >= 1000;

  function pilot(d: Driver, grid: Driver[], opts: Settings): Controls {
    const plan = (plans[d.id] ??= { startLane: d.d, lane: d.d, rival: -1, side: 0, wantPit: false });

    // Weather-smart AI pit strategy: swap dry slicks <-> wet treaded when conditions mismatch
    if (hasPitLane && d.id !== 0) {
      const wetTrack = opts.weather === 'rain' || opts.weather === 'damp';
      const wrongTires =
        (opts.weather === 'rain' && d.compound !== 'wet') ||
        ((opts.weather === 'clear' || opts.weather === 'golden') && d.compound === 'wet') ||
        Math.min(...d.tireWear) < 0.28 ||
        d.fuelL < 5;
      // Stagger AI pit entries so the entire grid doesn't queue in pit entry at once
      if (wrongTires && d.pitState === 'track' && d.distance > 1800 && d.s > track.length - 420 && d.s < track.length - 140) {
        if ((d.id + Math.floor(d.completedLaps)) % 2 === 0 || opts.weather === 'rain') {
          plan.wantPit = true;
        }
      }
      if (!wrongTires && d.pitState === 'track') plan.wantPit = false;

      // Guide car smoothly through pit entry, 60 km/h pit lane, assigned pit box, and pit exit merge
      if (d.pitState !== 'track' || (plan.wantPit && d.s > track.length - PIT_ENTRY_START_BACK - 15)) {
        if (d.pitState === 'servicing') {
          plan.wantPit = false;
          return { right: 0, throttle: 0, brake: 1, handbrake: 1, draft: 0 };
        }
        let targetD = PIT_FAST_LANE_D;
        let targetSpeed = PIT_SPEED_LIMIT_MS - 0.5;
        if (d.pitState === 'exit') {
          targetD = d.s > PIT_WALL_END_S + 8 ? 5.2 : PIT_FAST_LANE_D;
          targetSpeed = d.s > PIT_WALL_END_S + 2 ? 32 : PIT_SPEED_LIMIT_MS - 0.5;
        } else if (d.s < PIT_WALL_END_S && d.pitState !== 'track') {
          const distBox = d.pitBoxS - d.s;
          if (distBox < 24 && distBox > -3) {
            targetD = PIT_BOX_D;
            targetSpeed = distBox < 2.2 ? 0 : clamp(distBox * 0.62, 1.5, 11);
          }
        } else if (d.s > track.length - PIT_WALL_START_BACK - 45) {
          targetD = PIT_FAST_LANE_D;
          targetSpeed = PIT_SPEED_LIMIT_MS - 1.0;
        }
        const lookPit = 11;
        const aim = track.at(d.s + lookPit, targetD);
        const bearing = wrapAngle(Math.atan2(aim.x - d.x, aim.z - d.z) - d.yaw);
        const steer = Math.atan2(2 * 2.64 * Math.sin(bearing), lookPit) * 2.1;
        const err = targetSpeed - d.speed;
        const hold = targetSpeed < 0.6 && d.speed < 2.0;
        return {
          right: clamp(steer, -1, 1),
          throttle: hold ? 0 : clamp(err * 0.45, 0, 0.75),
          brake: hold ? 1 : clamp(-err * 0.48, 0, 1),
          handbrake: 0,
          draft: 0,
        };
      }
    }

    const at = Math.floor(d.s / spacing) % count,
      pace = { clubman: 0.86, pro: 0.96, platinum: 1.02 }[opts.pace],
      variation = d.id === 0 ? 1 : 1 + ((d.id % 4) - 1.5) * 0.012;
    const weatherPace = opts.weather === 'rain' ? 0.855 : opts.weather === 'damp' ? 0.935 : 1.0;
    let speed = limit[(at + 1) % count] * pace * variation * weatherPace,
      draft = 0;
    const look = clamp(5 + d.speed * 0.48, 7, 38),
      bend = track.at(d.s + look),
      edge = bend.halfWidth - 1.6,
      clearance = 3.35,
      opening = clamp((850 - d.distance) / 110, 0, 1);
    // In Heavy Rain, real GT3 drivers offset slightly off the slick rubbered centerline groove into fresher outer aggregate
    const wetOffset =
      opts.weather === 'rain' && opening === 0 && Math.abs(bend.kappa) > 0.0028
        ? -Math.sign(bend.kappa) * 1.15
        : 0;
    const line = clamp(
      opening * plan.startLane + (1 - opening) * (clamp(bend.kappa * 125, -2.5, 2.5) + wetOffset),
      -edge,
      edge,
    );
    let left = -edge,
      right = edge,
      nearest = Infinity;
    let passing: Driver | undefined;
    let towTarget: Driver | undefined;
    let towGap = Infinity;
    let defendBias = 0;
    const approachingCorner = track.at(d.s + 68);
    const inBrakeApproach = Math.abs(approachingCorner.kappa) > 0.0042 && d.speed > 32 && opening === 0;
    for (const r of grid) {
      if (r === d || r.pitState !== 'track') continue;
      const gap = gapTo(d, r),
        lateral = r.d - d.d,
        closing = d.speed - r.speed;
      if (r.id === plan.rival && gap >= -10 && gap < 110) passing = r;
      if (gap > 4.5 && gap < 35 && Math.abs(lateral) < 2.3) draft = Math.max(draft, (35 - gap) / 30);
      // Hunt aerodynamic tow on straights when 13..34 m behind a car before pulling out to pass
      if (
        opening === 0 &&
        Math.abs(bend.kappa) < 0.0022 &&
        d.speed > 42 &&
        gap > 13 &&
        gap < 34 &&
        gap < towGap &&
        Math.abs(lateral) < 3.4 &&
        r.speed > 34
      ) {
        towGap = gap;
        towTarget = r;
      }
      // Fair one-move defensive inside-line positioning when a faster car closes into a braking zone
      if (inBrakeApproach && gap < -3.5 && gap > -18 && r.speed > d.speed + 1.4 && Math.abs(lateral) < 4.0) {
        defendBias = Math.sign(approachingCorner.kappa) * 1.35;
      }
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
        if (r === d || r === target || r.pitState !== 'track') return false;
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
        for (const target of grid) {
          if (target === d || target.pitState !== 'track' || Math.abs(gapTo(d, target) - nearest) > 5) continue;
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
    const baseWanted = towTarget ? towTarget.d : defendBias !== 0 ? clamp(line + defendBias, -edge, edge) : line;
    const wanted = passing ? passing.d + plan.side * clearance : baseWanted;
    const lane = left <= right ? clamp(wanted, left, right) : clamp(d.d, -edge, edge);
    plan.lane += clamp(lane - plan.lane, -STEP * 3.5, STEP * 3.5);
    const width = 2.35 + Math.min(0.4, d.speed * 0.008);
    for (const r of grid) {
      if (r === d || r.pitState !== 'track') continue;
      const gap = gapTo(d, r);
      if (
        gap <= 0 ||
        gap > 220 ||
        r.d < Math.min(d.d, plan.lane) - width ||
        r.d > Math.max(d.d, plan.lane) + width
      )
        continue;
      const standOff = r.speed < 1 ? (passing && Math.abs(r.d - lane) > 2.7 ? 4.9 : 19) : 6.2;
      const room = gap - (standOff + 0.11 * d.speed),
        decel = opts.weather === 'rain' ? 6.2 : opts.weather === 'damp' ? 7.4 : 8.4;
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
