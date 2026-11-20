import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Circuit, Driver, Settings } from '../types';
import * as rules from './race';
import { STEP, type Controls } from './world';

const length = 300;
const track: Circuit = {
  length,
  samples: [],
  at: (m, d = 0) => ({ s: (m % length + length) % length, x: d, y: 0, z: m % length, yaw: 0, slope: 0, bank: 0, kappa: 0, halfWidth: 8 }),
  nearest: (x, z) => ({ s: z, d: x, surface: 'asphalt' }),
};
const coasting = { throttle: 0, brake: 0, right: 0, handbrake: 0, draft: 0 };

// Replay measured stations through world.read. Race logic, the 120 Hz clock,
// grid, pilots and start/advance interface are all the production versions.
function session(mode: Settings['mode'] = 'sprint') {
  let stations: number[] = [];
  const resets: number[] = [];
  const race = rules.createRace(track, {
    add(d: Driver, s: number, lane: number) { Object.assign(d, track.at(s, lane), { d: lane }); },
    read(d: Driver) {
      const m = stations[d.id];
      if (m !== undefined) Object.assign(d, track.at(m, d.d), { distance: m, speed: 40 });
    },
    clear() { stations = []; },
    control(d: Driver, cmd: Controls) { d.throttle = cmd.throttle; d.brake = cmd.brake; },
    reset(d, s = d.s, lane = 0) { resets.push(d.id); Object.assign(d, track.at(s, lane), { d: lane }); },
    step() {}, shift() {}, dispose() {}, freeMemory: () => 0,
  }, rules.createRaceState('timing test'));
  race.state.settings.mode = mode;
  race.start(true);
  function move(ticks: number, ...end: number[]) {
    const from = race.state.drivers.map(d => d.distance);
    for (let i = 1; i <= ticks; i++) {
      stations = end.map((m, id) => from[id] + (m - from[id]) * i / ticks);
      race.advance(coasting);
    }
  }
  return { ...race, move, resets };
}

function near(actual: number | null, expected: number) {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-8, `expected ${expected}, got ${actual}`);
}

test('line time, not array order or post-flag distance, classifies each car once', () => {
  const { state, move } = session();
  const [player, second, winner, lapped] = state.drivers;
  move(2400, 820, 899.25, 899.75, 599.75);
  const before = state.elapsed;
  move(1, 821, 900.25, 900.75, 600.125);
  near(winner.finishTime, before + STEP / 4);
  near(second.finishTime, before + 3 * STEP / 4);
  near(lapped.finishTime, before + 2 * STEP / 3);
  assert.equal(lapped.completedLaps, 2);
  assert.equal(state.phase, 'race');
  const places = () => rules.raceOrder(state.drivers).slice(0, 4).map(d => d.id);
  // The still-racing player is on lap three, ahead of the flagged two-lap car.
  assert.deepEqual(places(), [winner.id, second.id, player.id, lapped.id]);
  move(120, 880, 940, 920, 650);
  assert.ok(second.distance > winner.distance);
  assert.deepEqual(places(), [winner.id, second.id, player.id, lapped.id]);
  move(120, 900.2, 980, 950, 700);
  assert.equal(state.phase, 'finished');
  assert.deepEqual(places(), [winner.id, second.id, player.id, lapped.id]);
  near(winner.finishTime, before + STEP / 4);
  near(second.finishTime, before + 3 * STEP / 4);
  assert.equal(state.drivers[0], player); // never reorder the physics/rig grid
});

test('a larger finish-line overshoot does not win a photo finish; exact ties use grid ID', () => {
  const { state, move } = session();
  move(2400, 820, 899.25, 899.875, 899.875);
  move(1, 820.5, 900.75, 900.375, 900.375);
  assert.ok(state.drivers[1].distance > state.drivers[2].distance);
  assert.deepEqual(rules.raceOrder(state.drivers).slice(0, 3).map(d => d.id), [2, 3, 1]);
});

test('player can win at three laps; no invented finish for the nine cars still racing', () => {
  const { state, start, move } = session();
  move(2400, 899.75, 899.25, 850, 849.75);
  const before = state.elapsed;
  // The rival crosses 4.167 ms after the player. The next pair also swap places after the flag.
  move(1, 900.75, 900.25, 850.5, 850.75);
  assert.equal(state.phase, 'finished');
  const [winner, ...field] = rules.raceOrder(state.drivers);
  assert.equal(winner.id, 0);
  near(winner.finishTime, before + STEP / 4);
  assert.equal(winner.completedLaps, 3);
  assert.ok(field.every(d => d.finishTime === null));
  assert.equal(field[0].completedLaps, 2);
  assert.deepEqual(field.slice(0, 3).map(d => d.id), [1, 2, 3]);
  near(state.elapsed, winner.finishTime!);
  const atFlag = structuredClone(state);
  move(20, 905, 901, 805);
  assert.deepEqual(state, atFlag);
  start();
  assert.equal(state.phase, 'lights');
  assert.ok(state.drivers.every(d => d.completedLaps === 0 && d.finishTime === null));
  assert.deepEqual(state.lastSectors, []);
  move(100, 0, 6, 12);
  assert.equal(state.elapsed, 0);
});

test('a lapped player takes the next flag, not a third lap or a backwards recross', () => {
  const late = session();
  late.move(2100, 599.25, 899.5, 850);
  const before = late.state.elapsed;
  late.move(1, 600.25, 900.5, 850.5); // player reaches L2 after leader reaches L3
  assert.equal(late.state.phase, 'finished');
  assert.equal(late.state.lap, 2);
  near(late.state.drivers[0].finishTime, before + 3 * STEP / 4);
  assert.deepEqual(rules.raceOrder(late.state.drivers).slice(0, 3).map(d => d.id), [1, 2, 0]);

  const early = session();
  early.move(2100, 599.75, 899.5);
  early.move(1, 600.75, 900.5); // same physics tick, but crossed *before* the winner
  assert.equal(early.state.phase, 'race');
  assert.equal(early.state.lap, 3);
  early.move(10, 599);
  early.move(10, 601);
  assert.equal(early.state.drivers[0].finishTime, null);
  early.move(650, 900);
  assert.equal(early.state.phase, 'finished');
  assert.equal(early.state.drivers[0].completedLaps, 3);
});

test('a rollover keeps all three measured sectors and the fraction of the tick on the new lap', () => {
  const { state, move } = session('hotlap');
  move(600, 299.75);
  assert.equal(state.sectors.length, 2);
  const sector = 100 / 299.75 * 600 * STEP;
  near(state.sectors[0], sector);
  near(state.sectors[1], sector);
  move(1, 300.25);
  assert.equal(state.lap, 2);
  assert.deepEqual(state.sectors, []);
  near(state.lapTime, STEP / 2);
  near(state.bestLap, 600.5 * STEP);
  near(state.lastSectors[2], state.bestLap - 2 * sector);
  near(state.lastSectors.reduce((a, b) => a + b), state.bestLap);
  move(599, 599.75);
  move(1, 600.25);
  assert.equal(state.lap, 3);
  near(state.lapTime, STEP / 2);
  near(state.delta, 0); // compare the new lap at 0.25 m, not the old one at 300 m
});

test('hotlap stays single-car and unlimited beyond three completed laps', () => {
  const { state, move } = session('hotlap');
  move(2400, 1200);
  assert.equal(state.drivers.length, 1);
  assert.equal(state.phase, 'race');
  assert.equal(state.lap, 5);
  assert.equal(state.drivers[0].completedLaps, 4);
  assert.equal(state.drivers[0].finishTime, null);
  near(state.bestLap, 600 * STEP);
  near(state.delta, 0);
});

function park(d: Driver, station: number, lane: number) {
  Object.assign(d, track.at(station, lane), { distance: station, d: lane, speed: 0 });
}

test('waiting on the brake does not accumulate recovery time; a car trying to drive can still recover', () => {
  const { state, move, resets } = session();
  const car = state.drivers[1];
  for (const d of state.drivers) park(d, 230, 0);
  park(car, 100, 0);
  // A wall of stopped cars 12 m ahead: no passing lane, but beyond the 7 m reset clearance.
  for (const [i, lane] of [-6, -3, 0, 3, 6].entries()) park(state.drivers[2 + i], 112, lane);
  move(720);
  assert.equal(car.throttle, 0);
  assert.ok(car.brake > 0);
  assert.ok(!resets.includes(car.id), 'a deliberately queued car must not be reset');
  for (const d of state.drivers) if (d !== car) park(d, 230, 0);
  move(360);
  assert.ok(car.throttle > 0 && car.brake === 0);
  assert.ok(!resets.includes(car.id), 'the four seconds start when throttle is demanded');
  move(125);
  assert.deepEqual(resets.filter(id => id === car.id), [car.id]);
});

test('stalled recovery waits for the proposed centreline position to clear', () => {
  const { state, move, resets } = session();
  const [blocker, car] = state.drivers;
  for (const d of state.drivers) park(d, 230, 0);
  park(blocker, 100, 0);
  park(car, 100, -12);
  move(600);
  assert.ok(car.throttle > 0 && car.brake === 0);
  assert.ok(!resets.includes(car.id), 'the stranded car is clear but its destination is occupied');
  park(blocker, 130, 0);
  move(1);
  assert.deepEqual(resets.filter(id => id === car.id), [car.id]);
  assert.equal(car.d, 0);
});

test('manual reset keeps the assigned grid lane during lights and cannot rejoin from pause', () => {
  const race = session();
  race.start();
  const [p, other] = race.state.drivers;
  const gridLane = p.d;
  park(p, 0, -5);
  assert.equal(race.resetPlayer(), true);
  assert.equal(p.d, gridLane);
  park(other, 0, gridLane);
  park(p, 0, -5);
  assert.equal(race.resetPlayer(), false); // an occupied grid box is not an invitation to change lanes
  assert.equal(p.d, -5);
  race.state.phase = 'paused';
  assert.equal(race.resetPlayer(), false);
});

test('manual rejoin can avoid an occupied centreline but never moves station or forces a blocked slot', () => {
  const race = session();
  const [p, middle, left, right] = race.state.drivers;
  for (const d of race.state.drivers) park(d, 230, 0);
  park(p, 100, -12);
  park(middle, 100, 0);
  assert.equal(race.resetPlayer(), true);
  assert.ok(p.d < -3 && p.d > -track.at(p.s).halfWidth + 1);
  assert.equal(p.s, 100);
  assert.equal(p.distance, 100);

  // Centre and both edges blocked, but there is a pocket between the two left-hand cars.
  park(left, 100, -7.5);
  park(right, 100, 5);
  park(p, 100, -12);
  assert.equal(race.resetPlayer(), true);
  assert.ok(p.d < -3 && p.d > -4.5);
  park(left, 100, -5);
  park(p, 100, -12);
  const before = structuredClone(p);
  assert.equal(race.resetPlayer(), false);
  assert.deepEqual(p, before);
});
