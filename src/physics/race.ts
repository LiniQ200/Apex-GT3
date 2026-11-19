import { defaults, teams, type Circuit, type Driver, type RaceState } from '../types';
import { createWorld, STEP, type Controls } from './world';
import { createPilots } from '../ai/grid';

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
    speed: 0,
    rpm: 1650,
    gear: 1,
    throttle: 0,
    brake: 0,
    steer: 0,
    slip: 0,
    wheelAngle: 0,
    wheelCompressionM: [0.03, 0.03, 0.03, 0.03],
    tireTempC: [72, 72, 72, 72],
    brakeTempC: [170, 170, 154, 154],
    tcActive: false,
    absActive: false,
    surface: 'asphalt',
  };
}
export function createRace(track: Circuit, world: Awaited<ReturnType<typeof createWorld>>, backend: string) {
  const state: RaceState = {
    phase: 'garage',
    settings: { ...defaults },
    drivers: [driver(0, 0)],
    camera: 'chase',
    elapsed: 0,
    lap: 1,
    lapTime: 0,
    bestLap: 0,
    sectors: [],
    delta: 0,
    lights: 0,
    tc: 3,
    abs: 2,
    muted: false,
    autopilot: false,
    fps: 0,
    backend,
    peakSpeedKmh: 0,
    maxGearReached: 1,
    maxBrakeTempC: 0,
    nanDetected: false,
  };
  const { pilot, reset: resetPilots } = createPilots(track),
    stopped = { throttle: 0, brake: 1, right: 0, handbrake: 1, draft: 0 };
  let countdown = 0,
    sector = 0,
    lastSector = 0,
    nextSector = 0,
    reference: number[] = [],
    splits: number[] = [];
  const stalled: number[] = [];
  function start(skipLights = false) {
    world.clear();
    resetPilots();
    stalled.length = 0;
    state.drivers = [];
    countdown = 0;
    sector = 0;
    lastSector = 0;
    nextSector = track.length / 3;
    reference = [];
    splits = [];
    Object.assign(state, {
      phase: skipLights ? 'race' : 'lights',
      elapsed: 0,
      lap: 1,
      lapTime: 0,
      bestLap: 0,
      sectors: [],
      delta: 0,
      lights: skipLights ? 0 : 1,
      peakSpeedKmh: 0,
      maxGearReached: 1,
      maxBrakeTempC: 170,
      nanDetected: false,
    });
    for (let i = 0; i < (state.settings.mode === 'sprint' ? 10 : 1); i++) {
      const d = driver(i, (i + state.settings.livery) % 5);
      const startS = 6 * i;
      d.distance = startS;
      world.add(d, startS, state.settings.mode === 'hotlap' ? 0 : i % 2 === 0 ? -2.8 : 2.8);
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
      world.control(d, cmd, state);
    }
    world.step();
    for (const d of state.drivers) {
      world.read(d);
      if (
        ![d.x, d.y, d.z, d.yaw, d.speed, d.rpm, ...d.wheelCompressionM, ...d.brakeTempC].every(
          Number.isFinite,
        )
      )
        state.nanDetected = true;
      if (d.id !== 0 && state.phase === 'race') {
        stalled[d.id] = d.speed < 2 ? stalled[d.id] + STEP : 0;
        if (stalled[d.id] > 4) {
          const gap = state.drivers.every((r) => r === d || Math.hypot(r.x - d.x, r.z - d.z) > 7);
          if (gap) {
            world.reset(d, d.s, 0);
            stalled[d.id] = 0;
          }
        }
      }
    }
    if (state.phase !== 'race') return;
    const p = state.drivers[0];
    state.elapsed += STEP;
    state.lapTime += STEP;
    state.peakSpeedKmh = Math.max(state.peakSpeedKmh, p.speed * 3.6);
    state.maxGearReached = Math.max(state.maxGearReached, p.gear);
    state.maxBrakeTempC = Math.max(state.maxBrakeTempC, ...p.brakeTempC);
    const bin = Math.floor(((p.s + track.length) % track.length) / 10);
    if (splits[bin] === undefined) splits[bin] = state.lapTime;
    state.delta = reference[bin] !== undefined ? state.lapTime - reference[bin] : 0;
    if (p.distance >= nextSector) {
      state.sectors[sector++] = state.lapTime - lastSector;
      lastSector = state.lapTime;
      nextSector += track.length / 3;
      if (sector === 3) {
        if (!state.bestLap || state.lapTime < state.bestLap) {
          state.bestLap = state.lapTime;
          reference = splits;
        }
        if (state.lap === 3 && state.settings.mode === 'sprint') {
          state.phase = 'finished';
          return;
        }
        state.lap++;
        sector = 0;
        lastSector = 0;
        state.lapTime = 0;
        state.sectors = [];
        splits = [];
      }
    }
  }
  return { state, start, advance };
}
