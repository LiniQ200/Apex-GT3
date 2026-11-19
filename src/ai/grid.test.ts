import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createCircuit } from '../track/circuit';
import { makeRoad } from '../track/road';
import { createRace, driver } from '../physics/race';
import { createWorld, STEP } from '../physics/world';
import { createPilots } from './grid';

test('a GT3 waits behind a blocked road and passes on whichever side reopens', async () => {
  const track = createCircuit(),
    world = await createWorld(track, makeRoad(track).colliders);
  const { state } = createRace(track, world, 'test');
  state.settings.weather = 'damp';
  const park = { throttle: 0, brake: 1, right: 0, handbrake: 1, draft: 0 };
  try {
    for (const [marker, side] of [
      [180, 1],
      [track.length + 10, -1],
    ]) {
      const pilots = createPilots(track);
      const grid = (state.drivers = [0, 1, 2, 3].map((i) => driver(i, i)));
      const [blocker, chaser, gate, other] = grid;
      for (const [i, d] of grid.entries()) {
        d.distance = d === chaser ? marker - 75 : marker;
        world.add(d, d.distance, [0, 0, side * 3.45, -side * 3.45][i]);
      }
      const tick = (race: boolean) => {
        for (const d of grid)
          world.control(d, race && d === chaser ? pilots.pilot(d, grid, state.settings) : park, state);
        world.step();
        for (const d of grid) world.read(d);
      };
      for (let n = 0; n < 65; n++) tick(false);
      for (let n = 0; n < 10 / STEP; n++) tick(true);
      assert.ok(chaser.distance < marker - 4 && chaser.speed < 0.2, 'must stop without pushing the queue');
      world.reset(gate, 1000, side * 3.45);
      for (let n = 0; n < 10 / STEP && chaser.distance < marker + 12; n++) {
        tick(true);
        if (Math.abs(chaser.distance - marker) < 4) assert.ok(side * chaser.d > 2, 'use the open lane');
      }
      assert.ok(chaser.distance >= marker + 12, 'must get clear without a reset or a push');
      for (const d of [blocker, other]) assert.ok(Math.abs(d.distance - marker) < 0.05);
      world.clear();
    }
  } finally {
    world.dispose();
  }
});

test('switching off the player’s TC and ABS leaves the opponents’ assists active', async () => {
  const track = createCircuit(), world = await createWorld(track, makeRoad(track).colliders);
  try {
    const { state } = createRace(track, world, 'test');
    state.tc = state.abs = 0;
    state.settings.weather = 'damp';
    const grid = state.drivers = [driver(0, 0), driver(1, 1)];
    grid.forEach((d, i) => world.add(d, 110, i ? 3 : -3));
    const interventions = grid.map(() => new Set<string>());
    for (let tick = 0; tick < 1320; tick++) {
      const launch = tick >= 65 && tick < 1050;
      for (const d of grid) {
        world.control(d, { throttle: +launch, brake: +!launch, right: 0, handbrake: 0, draft: 0 }, state);
        if (d.tcActive) interventions[d.id].add('TC');
        if (d.absActive) interventions[d.id].add('ABS');
      }
      world.step();
      for (const d of grid) world.read(d);
    }
    assert.deepEqual([...interventions[0]], []);
    assert.deepEqual(interventions[1], new Set(['TC', 'ABS']));
  } finally {
    world.dispose();
  }
});
