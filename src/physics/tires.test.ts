import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createCircuit, PIT_BOX_D, PIT_SPEED_LIMIT_MS, pitBoxStation } from '../track/circuit';
import { makeRoad } from '../track/road';
import { TrackSurfaceGrid } from '../track/surfaceState';
import { computeWheelGrip } from './tires';
import { createRace, createRaceState } from './race';
import { createWorld, STEP } from './world';

test('3-compound Pacejka tire model differentiates dry, damp, wet, drying groove, and wet kerbs', () => {
  const dry = { wetness: 0, rubberGrip: 0.7, dryingGroove: 0, marbles: 0 };
  const wetOffLine = { wetness: 0.85, rubberGrip: 0.2, dryingGroove: 0, marbles: 0.2 };
  const wetDrying = { wetness: 0.85, rubberGrip: 0.4, dryingGroove: 0.85, marbles: 0 };

  const softDry = computeWheelGrip('soft', 'groove', dry, 90, 1, 45, 0.04, 0.1);
  const medDry = computeWheelGrip('medium', 'groove', dry, 88, 1, 45, 0.04, 0.1);
  const wetDry = computeWheelGrip('wet', 'groove', dry, 88, 1, 45, 0.04, 0.1);
  assert.ok(softDry > medDry && medDry > wetDry, `dry ordering: ${softDry} > ${medDry} > ${wetDry}`);

  const softFlood = computeWheelGrip('soft', 'asphalt', wetOffLine, 55, 1, 50, 0.04, 0.1);
  const wetFlood = computeWheelGrip('wet', 'asphalt', wetOffLine, 55, 1, 50, 0.04, 0.1);
  assert.ok(wetFlood > softFlood + 0.3, `rain grip advantage: wet=${wetFlood} soft=${softFlood}`);

  const softDrying = computeWheelGrip('soft', 'asphalt', wetDrying, 65, 1, 50, 0.04, 0.1);
  assert.ok(softDrying > softFlood + 0.2, `drying groove restores grip: ${softDrying} > ${softFlood}`);

  const dryKerb = computeWheelGrip('soft', 'kerb', dry, 90, 1, 35, 0.04, 0.1);
  const wetKerb = computeWheelGrip('soft', 'kerb', wetOffLine, 60, 1, 35, 0.04, 0.1);
  assert.ok(wetKerb < dryKerb * 0.55, `wet painted kerb is treacherous on slicks: ${wetKerb} vs ${dryKerb}`);
});

test('pit lane enforces 60 km/h limiter and executes pneumatic air-jack compound + fuel pit stop', async () => {
  const track = createCircuit();
  const grid = new TrackSurfaceGrid(track);
  const world = await createWorld(track, makeRoad(track).colliders, grid);
  try {
    const state = createRaceState('Jolt');
    state.settings.mode = 'hotlap';
    state.settings.weather = 'rain';
    state.settings.compound = 'soft';
    const race = createRace(track, world, state, grid);
    race.start(true);
    const p = state.drivers[0];
    p.compound = 'soft';
    p.tireWear = [0.42, 0.45, 0.39, 0.41];
    p.fuelL = 18;
    p.damage = 0.25;
    state.pitStrategy = { compound: 'wet', changeTires: true, refuelL: 40, repair: true };

    // Enter pit lane and verify 60 km/h limiter caps speed under full throttle
    assert.equal(race.teleportToPitEntry(), true);
    assert.equal(p.pitLimiter, true);
    let maxSpeedInPit = 0;
    for (let i = 0; i < 420; i++) {
      race.advance({ throttle: 1, brake: 0, right: 0, handbrake: 0, draft: 0 });
      maxSpeedInPit = Math.max(maxSpeedInPit, p.speed);
    }
    assert.ok(maxSpeedInPit <= PIT_SPEED_LIMIT_MS + 1.2, `pit limiter capped speed: ${(maxSpeedInPit * 3.6).toFixed(1)} km/h`);

    // Park inside Bay 01 Player Pit Box and verify pneumatic air-jack lift + strategy application
    world.reset(p, pitBoxStation(0), PIT_BOX_D);
    p.pitState = 'lane';
    let peakLift = 0;
    let sawServicing = false;
    const pitState = () => state.drivers[0].pitState;
    for (let i = 0; i < 1200; i++) {
      race.advance({ throttle: 0, brake: 1, right: 0, handbrake: 1, draft: 0 });
      if (pitState() === 'servicing') sawServicing = true;
      peakLift = Math.max(peakLift, p.airJackLiftM);
      if (sawServicing && pitState() === 'exit') break;
    }
    assert.equal(sawServicing, true, 'must enter servicing state in Bay 01');
    assert.ok(peakLift >= 0.06, `pneumatic air-jacks lifted car ${(peakLift * 100).toFixed(1)} cm`);
    assert.equal(pitState(), 'exit');
    assert.equal(p.compound, 'wet');
    assert.deepEqual(p.tireWear, [1, 1, 1, 1]);
    assert.ok(p.fuelL >= 55, `refueled to ${p.fuelL.toFixed(1)} L`);
    assert.equal(p.damage, 0);
  } finally {
    world.dispose();
  }
});
