import {
  defaults,
  teams,
  type Circuit,
  type Driver,
  type GridWheelLayouts,
  type PitStrategy,
  type RaceState,
  type TireCompound,
} from '../types';
import { createWorld, factoryAssists, STEP, type Controls } from './world';
import { COMPOUNDS } from './tires';
import { createPilots } from '../ai/grid';
import {
  isInPitCorridor,
  PIT_BOX_D,
  PIT_ENTRY_START_BACK,
  PIT_WALL_D,
  pitBoxStation,
  sprintGrid,
} from '../track/circuit';
import { TrackSurfaceGrid, weatherBaseWetness, weatherSurfaceTempC } from '../track/surfaceState';

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

export function driver(id: number, livery: number, compound: TireCompound = 'soft'): Driver {
  const startTemp = COMPOUNDS[compound].blanketTempC;
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
    tireTempC: [startTemp, startTemp, startTemp, startTemp],
    brakeTempC: [170, 170, 154, 154],
    compound,
    tireWear: [1, 1, 1, 1],
    fuelL: 36,
    maxFuelL: 110,
    damage: 0,
    pitState: 'track',
    pitLimiter: false,
    airJackLiftM: 0,
    pitTimer: 0,
    pitDuration: 0,
    pitBoxS: pitBoxStation(id),
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
    surfaceTempC: weatherSurfaceTempC[defaults.weather],
    trackWetness: weatherBaseWetness[defaults.weather],
    pitStrategy: { compound: 'medium', changeTires: true, refuelL: 30, repair: true },
    pitMfdOpen: false,
    pitEvent: { type: 'none', seq: 0 },
    peakSpeedKmh: 0,
    maxGearReached: 1,
    maxBrakeTempC: 0,
    nanDetected: false,
  };
}

export function createRace(
  track: Circuit,
  world: Awaited<ReturnType<typeof createWorld>>,
  state: RaceState,
  surfaceGrid?: TrackSurfaceGrid,
) {
  const { pilot, reset: resetPilots } = createPilots(track),
    stopped = { throttle: 0, brake: 1, right: 0, handbrake: 1, draft: 0 };
  const gatesPerSector = Math.ceil(track.length / 3 / 10),
    gatesPerLap = 3 * gatesPerSector;
  const crossings: { driver: Driver; time: number }[] = [];
  const tickDistances: number[] = [];
  let countdown = 0,
    chequeredAt = Infinity,
    lapStart = 0,
    reference: number[] = [],
    splits: number[] = [0],
    pitCooldown: number[] = [],
    gunTick = 0,
    pitActive = track.length >= 1000;
  const stalled: number[] = [];
  const grid = () => (state.settings.mode === 'sprint' ? sprintGrid : [{ s: 0, d: 0 }]);

  function emitPitEvent(type: RaceState['pitEvent']['type']) {
    state.pitEvent = { type, seq: state.pitEvent.seq + 1 };
  }

  function start(skipLights = false, wheelLayouts?: GridWheelLayouts) {
    world.clear();
    resetPilots();
    surfaceGrid?.reset(state.settings.weather);
    stalled.length = 0;
    pitCooldown = [];
    state.drivers = [];
    countdown = 0;
    chequeredAt = Infinity;
    lapStart = 0;
    reference = [];
    splits = [0];
    const startCompound: TireCompound =
      state.settings.weather === 'rain' ? 'wet' : state.settings.compound;
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
      surfaceTempC: weatherSurfaceTempC[state.settings.weather],
      trackWetness: surfaceGrid?.getMeanWetness() ?? weatherBaseWetness[state.settings.weather],
      pitMfdOpen: false,
      pitEvent: { type: 'none', seq: state.pitEvent.seq },
      peakSpeedKmh: 0,
      maxGearReached: 1,
      maxBrakeTempC: 170,
      nanDetected: false,
    });
    for (const [i, box] of grid().entries()) {
      const comp: TireCompound =
        i === 0
          ? startCompound
          : state.settings.weather === 'rain'
            ? 'wet'
            : i % 2 === 0
              ? 'soft'
              : 'medium';
      const d = driver(i, (i + state.settings.livery) % 5, comp);
      d.distance = box.s;
      world.add(d, box.s, box.d, wheelLayouts?.(i));
      state.drivers.push(d);
      stalled.push(0);
      pitCooldown.push(0);
    }
    for (let n = 0; n < 65; n++) {
      for (const d of state.drivers) world.control(d, stopped, state);
      world.step();
      for (const d of state.drivers) world.read(d);
    }
  }

  function updatePitLaneAndService(d: Driver) {
    if (!pitActive) return;
    if (pitCooldown[d.id] > 0) pitCooldown[d.id] = Math.max(0, pitCooldown[d.id] - STEP);
    const inEntry = d.s >= track.length - PIT_ENTRY_START_BACK && d.d > PIT_WALL_D + 0.2;
    const inCorridor = inEntry || isInPitCorridor(d.s, d.d, track.length);

    if (d.pitState === 'servicing') {
      // Lift smoothly on pneumatic air-jacks (~7 cm) during service, then drop smoothly at end
      const elapsed = d.pitDuration - d.pitTimer;
      const targetLift = d.pitTimer > 0.45 ? 0.072 : 0;
      d.airJackLiftM += (targetLift - d.airJackLiftM) * Math.min(1, STEP * 11);
      d.pitTimer = Math.max(0, d.pitTimer - STEP);

      if (d.id === 0) {
        // Trigger 4 pneumatic wheel-gun bursts spaced through the tire-change window
        if (state.pitStrategy.changeTires && elapsed > 0.55 && elapsed < d.pitDuration - 0.55) {
          gunTick += STEP;
          if (gunTick >= 0.68) {
            gunTick = 0;
            emitPitEvent('gun');
          }
        }
        if (d.pitTimer <= 0.45 && d.pitTimer + STEP > 0.45) {
          emitPitEvent('jack_down');
        }
      }

      if (d.pitTimer <= 0) {
        // Apply strategy directly to the 120 Hz vehicle model!
        const strat: PitStrategy =
          d.id === 0
            ? state.pitStrategy
            : {
                compound: state.settings.weather === 'rain' || state.settings.weather === 'damp' ? 'wet' : 'medium',
                changeTires: true,
                refuelL: 25,
                repair: true,
              };
        if (strat.changeTires) {
          d.compound = strat.compound;
          d.tireWear = [1, 1, 1, 1];
          const warm = COMPOUNDS[strat.compound].blanketTempC;
          d.tireTempC = [warm, warm, warm, warm];
        }
        if (strat.refuelL > 0) {
          d.fuelL = Math.min(d.maxFuelL, d.fuelL + strat.refuelL);
        }
        if (strat.repair) {
          d.damage = 0;
        }
        d.airJackLiftM = 0;
        d.pitState = 'exit';
        d.pitLimiter = true;
        pitCooldown[d.id] = 18;
      }
      return;
    }

    // Smoothly settle air-jacks to 0 if not servicing
    if (d.airJackLiftM > 0) d.airJackLiftM = Math.max(0, d.airJackLiftM - STEP * 0.45);

    if (inCorridor) {
      if (d.pitState === 'track' || d.pitState === 'entry') {
        d.pitState = 'lane';
        d.pitLimiter = true;
        if (d.id === 0) state.pitMfdOpen = true;
      }
      // Check if car has pulled into its assigned pit box and stopped
      const boxDistS = Math.abs(d.s - d.pitBoxS);
      const boxDistD = Math.abs(d.d - PIT_BOX_D);
      const inBox = boxDistS < 5.0 && boxDistD < 3.4;
      if (inBox && d.pitState !== 'exit' && pitCooldown[d.id] <= 0) {
        d.pitState = 'box';
        if (d.speed < 1.8) {
          const strat: PitStrategy =
            d.id === 0
              ? state.pitStrategy
              : { compound: 'wet', changeTires: true, refuelL: 20, repair: d.damage > 0.05 };
          const duration =
            1.1 +
            (strat.changeTires ? 2.6 : 0) +
            (strat.refuelL > 0 ? Math.min(2.8, strat.refuelL * 0.055) : 0) +
            (strat.repair && d.damage > 0.02 ? 1.5 : 0);
          d.pitState = 'servicing';
          d.pitDuration = duration;
          d.pitTimer = duration;
          gunTick = 0;
          if (d.id === 0) emitPitEvent('jack_up');
        }
      } else if (d.pitState === 'box' && !inBox) {
        d.pitState = 'lane';
      }
    } else if (d.pitState !== 'track') {
      // Exited pit corridor cleanly: release pit limiter!
      d.pitState = 'track';
      d.pitLimiter = false;
    }
  }

  function resetAtStation(d: Driver, lane: number, allowAlternate = false) {
    const centre = track.at(d.s),
      sn = Math.sin(centre.yaw),
      cs = Math.cos(centre.yaw);
    const edge = centre.halfWidth - 1.2,
      occupied: number[] = [];
    for (const r of state.drivers) {
      if (r === d) continue;
      const dx = r.x - centre.x,
        dz = r.z - centre.z;
      if (Math.abs(dx * sn + dz * cs) <= 7) occupied.push(dx * cs - dz * sn);
    }
    const clear = (l: number) => Math.abs(l) <= edge && occupied.every((other) => Math.abs(other - l) > 3.5);
    if (!clear(lane)) {
      if (!allowAlternate) return false;
      occupied.sort((a, b) => a - b);
      const slots = [-edge, edge, d.d];
      for (let i = 1; i < occupied.length; i++) slots.push((occupied[i - 1] + occupied[i]) / 2);
      const alternate = slots.sort((a, b) => Math.abs(a - d.d) - Math.abs(b - d.d)).find(clear);
      if (alternate === undefined) return false;
      lane = alternate;
    }
    world.reset(d, d.s, lane);
    d.pitState = 'track';
    d.pitLimiter = false;
    d.airJackLiftM = 0;
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
      state.lights = Math.min(5, 1 + Math.floor(countdown / 0.54));
      if (countdown > 3.15) {
        state.phase = 'race';
        state.lights = 0;
      }
    }
    for (const d of state.drivers) {
      let cmd: Controls;
      if (state.phase === 'lights' || d.pitState === 'servicing') cmd = stopped;
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
      if (d.id !== 0 && state.phase === 'race' && d.pitState === 'track') {
        const tryingToDrive = cmd.throttle > 0.1 && cmd.brake === 0 && cmd.handbrake === 0;
        stalled[d.id] = d.speed < 2 && tryingToDrive ? stalled[d.id] + STEP : 0;
      }
      world.control(d, cmd, state);
    }
    const p = state.drivers[0],
      playerFrom = p.distance,
      tickStart = state.elapsed;
    let playerCrossing = Infinity;
    world.step();
    for (const d of state.drivers) {
      const from = (tickDistances[d.id] = d.distance);
      world.read(d);
      if (state.phase === 'race') updatePitLaneAndService(d);
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

    // Evolve dynamic TrackSurfaceGrid (live rubbering-in + dynamic drying wheel tracks)
    if (surfaceGrid) {
      surfaceGrid.evolve(state.drivers, STEP);
      state.trackWetness = surfaceGrid.getMeanWetness();
      state.surfaceTempC = surfaceGrid.getSurfaceTempC();
    }

    for (const d of state.drivers) {
      if (stalled[d.id] > 4 && d.speed < 2 && d.pitState === 'track' && resetAtStation(d, 0)) stalled[d.id] = 0;
    }
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
      const gate = splits.length,
        line = (state.lap - 1 + gate / gatesPerLap) * track.length;
      if (!(playerFrom < line && line <= p.distance)) break;
      const at = crossingTime(tickStart, playerFrom, p.distance, line),
        lapTime = at - lapStart;
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
        const fraction = (p.finishTime - tickStart) / STEP;
        for (const d of state.drivers)
          if (d.finishTime === null)
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

  /** Helper for QA / player quick pit-lane entry check without breaking physics invariants. */
  function teleportToPitEntry() {
    if (!pitActive || state.phase !== 'race') return false;
    const p = state.drivers[0];
    world.reset(p, track.length - 85, PIT_WALL_D + 4.2);
    p.pitState = 'entry';
    p.pitLimiter = true;
    state.pitMfdOpen = true;
    return true;
  }

  return { state, start, advance, resetPlayer, teleportToPitEntry };
}
