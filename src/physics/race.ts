import { defaults, teams, type Circuit, type Driver, type GridWheelLayouts, type RaceState } from '../types';
import { createWorld, factoryAssists, STEP, type Controls } from './world';
import { createPilots } from '../ai/grid';
import { sprintGrid } from '../track/circuit';

export const SPRINT_LAPS = 3;

export function raceOrder(drivers: readonly Driver[]) {
  return [...drivers].sort((a, b) => {
    if (a.completedLaps !== b.completedLaps) return b.completedLaps - a.completedLaps;
    if (a.finishTime === null && b.finishTime === null)
      return (b.distanceAtFlag ?? b.distance) - (a.distanceAtFlag ?? a.distance) || a.id - b.id;
    // On equal laps a car still running crossed this lap line before the flag.
    return (a.finishTime ?? -Infinity) - (b.finishTime ?? -Infinity) || a.id - b.id;
  });
}

const crossingTime = (start: number, from: number, to: number, line: number) =>
  start + STEP * ((line - from) / (to - from));

export function driver(id: number, livery: number): Driver {
  return {
    id,
    name: [
      'You',
      'A. Costa',
      'M. Weber',
      'S. Conti',
      'J. Laurent',
      'L. Bianchi',
      'R. Silva',
      'K. Sato',
      'N. Moretti',
      'T. Evans',
    ][id],
    number: id < 5 ? teams[livery][0] : String(20 + id),
    livery,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    s: 0,
    d: 0,
    distance: 0,
    completedLaps: 0,
    finishTime: null,
    speed: 0,
    rpm: 1650,
    gear: 1,
    throttle: 0,
    brake: 0,
    steer: 0,
    slip: 0,
    wheelAngle: 0,
    wheelAngles: [0, 0, 0, 0],
    wheelCompressionM: [0.03, 0.03, 0.03, 0.03],
    tireTempC: [72, 72, 72, 72],
    brakeTempC: [170, 170, 154, 154],
    tcActive: false,
    absActive: false,
    surface: 'asphalt',
  };
}
export function createRaceState(backend: string): RaceState {
  return {
    phase: 'garage',
    settings: { ...defaults },
    drivers: [driver(0, 0)],
    camera: 'chase',
    elapsed: 0,
    lap: 1,
    lapTime: 0,
    bestLap: 0,
    sectors: [],
    lastSectors: [],
    delta: 0,
    lights: 0,
    ...factoryAssists,
    muted: false,
    autopilot: false,
    fps: 0,
    backend,
    peakSpeedKmh: 0,
    maxGearReached: 1,
    maxBrakeTempC: 0,
    nanDetected: false,
  };
}

export function createRace(track: Circuit, world: Awaited<ReturnType<typeof createWorld>>, state: RaceState) {
  const { pilot, reset: resetPilots } = createPilots(track),
    stopped = { throttle: 0, brake: 1, right: 0, handbrake: 1, draft: 0 };
  // Roughly 10 m timing gates, including the exact three sector boundaries.
  const gatesPerSector = Math.ceil(track.length / 3 / 10), gatesPerLap = 3 * gatesPerSector;
  const crossings: { driver: Driver; time: number }[] = [];
  const tickDistances: number[] = [];
  let countdown = 0,
    chequeredAt = Infinity,
    lapStart = 0,
    reference: number[] = [],
    splits: number[] = [0];
  const stalled: number[] = [];
  const grid = () => state.settings.mode === 'sprint' ? sprintGrid : [{ s: 0, d: 0 }];
  function start(skipLights = false, wheelLayouts?: GridWheelLayouts) {
    world.clear();
    resetPilots();
    stalled.length = 0;
    state.drivers = [];
    countdown = 0;
    chequeredAt = Infinity;
    lapStart = 0;
    reference = [];
    splits = [0];
    Object.assign(state, {
      phase: skipLights ? 'race' : 'lights',
      elapsed: 0,
      lap: 1,
      lapTime: 0,
      bestLap: 0,
      sectors: [],
      lastSectors: [],
      delta: 0,
      lights: skipLights ? 0 : 1,
      peakSpeedKmh: 0,
      maxGearReached: 1,
      maxBrakeTempC: 170,
      nanDetected: false,
    });
    for (const [i, box] of grid().entries()) {
      const d = driver(i, (i + state.settings.livery) % 5);
      d.distance = box.s;
      world.add(d, box.s, box.d, wheelLayouts?.(i));
      state.drivers.push(d);
      stalled.push(0);
    }
    // Settle the starting grid on its springs before the first displayed frame.
    for (let n = 0; n < 65; n++) {
      for (const d of state.drivers) world.control(d, stopped, state);
      world.step();
      for (const d of state.drivers) world.read(d);
    }
  }
  function resetAtStation(d: Driver, lane: number, allowAlternate = false) {
    const centre = track.at(d.s), sn = Math.sin(centre.yaw), cs = Math.cos(centre.yaw);
    const edge = centre.halfWidth - 1.2, occupied: number[] = [];
    for (const r of state.drivers) {
      if (r === d) continue;
      const dx = r.x - centre.x, dz = r.z - centre.z;
      if (Math.abs(dx * sn + dz * cs) <= 7) occupied.push(dx * cs - dz * sn);
    }
    // A track-aligned rejoin needs fore/aft space, but can fit alongside a rival.
    // 3.5 m covers our half-width plus even a sideways rival's half-diagonal.
    const clear = (l: number) => Math.abs(l) <= edge && occupied.every(other => Math.abs(other - l) > 3.5);
    if (!clear(lane)) {
      if (!allowAlternate) return false;
      occupied.sort((a, b) => a - b);
      const slots = [-edge, edge, d.d];
      // Any clear interior gap contains the midpoint between its two neighbours.
      for (let i = 1; i < occupied.length; i++) slots.push((occupied[i - 1] + occupied[i]) / 2);
      const alternate = slots.sort((a, b) => Math.abs(a - d.d) - Math.abs(b - d.d)).find(clear);
      if (alternate === undefined) return false;
      lane = alternate;
    }
    world.reset(d, d.s, lane);
    return true;
  }
  function resetPlayer() {
    if (state.phase === 'lights') return resetAtStation(state.drivers[0], grid()[0].d);
    return state.phase === 'race' && resetAtStation(state.drivers[0], 0, true);
  }
  function advance(player: Controls) {
    if (state.phase !== 'lights' && state.phase !== 'race') return;
    if (state.phase === 'lights') {
      countdown += STEP;
      state.lights = Math.min(5, 1 + Math.floor(countdown / 0.72));
      if (countdown > 4.25) {
        state.phase = 'race';
        state.lights = 0;
      }
    }
    for (const d of state.drivers) {
      let cmd: Controls;
      if (state.phase === 'lights') cmd = stopped;
      else if (d.id !== 0 || state.autopilot) cmd = pilot(d, state.drivers, state.settings);
      else {
        cmd = player;
        cmd.draft = 0;
        for (const r of state.drivers) {
          const gap = (r.s - d.s + track.length) % track.length;
          if (gap > 4 && gap < 30 && Math.abs(r.d - d.d) < 2.2)
            cmd.draft = Math.max(cmd.draft, (30 - gap) / 26);
        }
      }
      if (d.id !== 0 && state.phase === 'race') {
        const tryingToDrive = cmd.throttle > 0.1 && cmd.brake === 0 && cmd.handbrake === 0;
        stalled[d.id] = d.speed < 2 && tryingToDrive ? stalled[d.id] + STEP : 0;
      }
      world.control(d, cmd, state);
    }
    const p = state.drivers[0], playerFrom = p.distance, tickStart = state.elapsed;
    let playerCrossing = Infinity;
    world.step();
    for (const d of state.drivers) {
      const from = tickDistances[d.id] = d.distance;
      world.read(d);
      const line = (d.completedLaps + 1) * track.length;
      if (state.phase === 'race' && d.finishTime === null && from < line && line <= d.distance) {
        if (state.settings.mode === 'sprint') {
          const time = crossingTime(tickStart, from, d.distance, line);
          crossings.push({ driver: d, time });
          if (d === p) playerCrossing = time;
          if (d.completedLaps + 1 === SPRINT_LAPS) chequeredAt = Math.min(chequeredAt, time);
        } else d.completedLaps++;
      }
      if (
        ![d.x, d.y, d.z, d.yaw, d.speed, d.rpm, ...d.wheelCompressionM, ...d.brakeTempC].every(
          Number.isFinite,
        )
      )
        state.nanDetected = true;
    }
    if (state.phase !== 'race') return;
    // Check the proposed centreline slot against everyone's just-read position.
    for (const d of state.drivers) {
      if (stalled[d.id] > 4 && d.speed < 2 && resetAtStation(d, 0)) stalled[d.id] = 0;
    }
    // A lapped car can cross just before or just after the winner in the same tick.
    const cutoff = playerCrossing >= chequeredAt ? playerCrossing : Infinity;
    for (const { driver, time } of crossings) {
      if (time > cutoff) continue;
      driver.completedLaps++;
      if (time >= chequeredAt) driver.finishTime = time;
    }
    crossings.length = 0;
    state.elapsed = Math.min(tickStart + STEP, cutoff);
    state.peakSpeedKmh = Math.max(state.peakSpeedKmh, p.speed * 3.6);
    state.maxGearReached = Math.max(state.maxGearReached, p.gear);
    state.maxBrakeTempC = Math.max(state.maxBrakeTempC, ...p.brakeTempC);
    while (Number.isFinite(p.distance)) {
      const gate = splits.length, line = (state.lap - 1 + gate / gatesPerLap) * track.length;
      if (!(playerFrom < line && line <= p.distance)) break;
      const at = crossingTime(tickStart, playerFrom, p.distance, line), lapTime = at - lapStart;
      splits.push(lapTime);
      if (gate % gatesPerSector !== 0) continue;
      state.sectors.push(lapTime - splits[gate - gatesPerSector]);
      if (gate !== gatesPerLap) continue;
      state.lastSectors = state.sectors;
      state.delta = state.bestLap ? lapTime - state.bestLap : 0;
      if (!state.bestLap || lapTime < state.bestLap) {
        state.bestLap = lapTime;
        reference = splits;
      }
      if (p.finishTime !== null) {
        // Freeze the timing order at the flag, without rewinding Jolt's rendered poses.
        const fraction = (p.finishTime - tickStart) / STEP;
        for (const d of state.drivers) if (d.finishTime === null)
          d.distanceAtFlag = tickDistances[d.id] + fraction * (d.distance - tickDistances[d.id]);
        state.lapTime = lapTime;
        state.phase = 'finished';
        return;
      }
      state.lap++;
      lapStart = at;
      state.sectors = [];
      splits = [0];
    }
    state.lapTime = state.elapsed - lapStart;
    if (reference.length) {
      const pos = Math.max(0, Math.min(gatesPerLap, (p.distance / track.length - (state.lap - 1)) * gatesPerLap));
      const i = Math.min(gatesPerLap - 1, Math.floor(pos));
      state.delta = state.lapTime - (reference[i] + (pos - i) * (reference[i + 1] - reference[i]));
    }
  }
  return { state, start, advance, resetPlayer };
}
