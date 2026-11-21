import assert from 'node:assert/strict';
import { test } from 'node:test';
import { driver } from '../physics/race';
import { createCircuit } from '../track/circuit';
import type { Driver, Weather } from '../types';
import { createEngineer } from './pitwall';

const circuit = createCircuit();
const car = (s: number, speed = 48, id = 0, d = 0) =>
  Object.assign(driver(id, 0), circuit.at(s, d), { speed, d, distance: s });
function note(engineer: ReturnType<typeof createEngineer>, s: number, speed = 48, weather: Weather = 'golden') {
  const p = car(s, speed), n = engineer.read(p, [p], weather);
  assert.ok(n?.kind === 'corner');
  return n;
}

test('Valle d’Oro gives ten turns in order, including both legs of La Variante', () => {
  const e = createEngineer(circuit), directions: string[] = [];
  let previous = 0;
  for (let s = 0; s < circuit.length; s += 3) {
    const n = note(e, s);
    assert.ok(n.metres >= 0 && n.metres < circuit.length);
    if (n.number !== previous) { directions.push(`${n.number}:${n.side}`); previous = n.number; }
  }
  assert.deepEqual(directions, ['1:right', '2:left', '3:right', '4:left', '5:right', '6:left',
    '7:left', '8:right', '9:right', '10:right', '1:right']);
  const left = note(e, 2300), right = note(e, 2480);
  assert.equal(left.number, 7); assert.equal(right.number, 8);
  assert.ok(right.entrySpeed < left.entrySpeed, 'tighter return needs a lower entry speed');
});

test('timing-line wrap counts down continuously to the same entry, including on later laps', () => {
  const e = createEngineer(circuit), before = note(e, circuit.length - 2), after = note(e, 3);
  assert.equal(before.number, 1); assert.equal(after.number, 1);
  assert.ok(after.metres > 600 && after.metres < 700);
  assert.ok(Math.abs(before.metres - after.metres - 5) < 1e-6);
  assert.deepEqual(note(e, 2 * circuit.length + 3), after);
});

test('moving the timing line into a bend does not split it or pin the guide to the old stations', () => {
  const offset = 636, e = createEngineer({ ...circuit, at: (s, d) => circuit.at(s + offset, d) });
  function cross(s: number) {
    const p = car(s + offset);
    p.s = s;
    const n = e.read(p, [p], 'golden');
    assert.ok(n?.kind === 'corner');
    return n;
  }
  const before = cross(circuit.length - 2), after = cross(3);
  assert.equal(before.number, after.number); assert.equal(after.side, 'right');
  assert.ok(after.metres > 8 && after.metres < 20);
  assert.ok(Math.abs(before.metres - after.metres - 5) < 1e-6);
});

test('braking zone follows approach speed and available grip; no braking for an on-speed entry', () => {
  const e = createEngineer(circuit);
  assert.equal(note(e, 350).cue, 'next');
  const dry = note(e, 500), damp = note(e, 500, 48, 'damp'), rain = note(e, 500, 48, 'rain'), dusk = note(e, 500, 48, 'dusk');
  assert.equal(dry.cue, 'lift'); assert.equal(dusk.cue, 'lift'); assert.equal(damp.cue, 'brake'); assert.equal(rain.cue, 'brake');
  assert.ok(rain.entrySpeed < damp.entrySpeed && damp.entrySpeed < dry.entrySpeed);
  assert.equal(note(e, 540).cue, 'brake');
  assert.equal(note(e, 540, 29).cue, 'next');
  assert.equal(note(e, 646, dry.entrySpeed).cue, 'next');
  assert.equal(note(e, 646, 0, 'damp').cue, 'next');
});

test('small station noise does not chatter at brake, turn-in or handoff', () => {
  const e = createEngineer(circuit);
  assert.equal(note(e, 514).cue, 'lift');
  assert.equal(note(e, 518).cue, 'brake');
  assert.equal(note(e, 514).cue, 'brake');
  e.reset();
  assert.equal(note(e, 514).cue, 'lift');
  assert.equal(note(e, 653).cue, 'turn');
  assert.equal(note(e, 651).cue, 'turn');
  assert.equal(note(e, 706).number, 2);
  assert.equal(note(e, 703).number, 2);
});

function relative(p: Driver, right: number, forward = 0, id = 1) {
  const sn = Math.sin(p.yaw), cs = Math.cos(p.yaw);
  return { ...p, id, x: p.x + cs * right + sn * forward, z: p.z - sn * right + cs * forward };
}

test('spotter preempts a brake call; uses player heading, both sides, and fresh positions each time', () => {
  const e = createEngineer(circuit), p = car(2350, 60); // eastbound back straight
  assert.equal(note(e, 2350, 60).cue, 'brake');
  const left = relative(p, -3), right = relative(p, 3, -1.5, 2);
  // Equal telemetry lane offsets must not mask either physical car.
  const read = (...others: Driver[]) => e.read(p, [...others, p], 'golden');
  assert.deepEqual(read(left), { kind: 'traffic', side: 'left' });
  assert.deepEqual(read(left, right), { kind: 'traffic', side: 'both' });
  assert.deepEqual(read(right), { kind: 'traffic', side: 'right' });
  Object.assign(right, relative(p, -3, 0, right.id));
  assert.deepEqual(read(right), { kind: 'traffic', side: 'left' });
  const clear = read();
  assert.ok(clear?.kind === 'corner' && clear.cue === 'brake');
});

test('spotter sees a lapped car straddling the seam, not a car in line or on the far edge', () => {
  const e = createEngineer(circuit), p = car(circuit.length - 1), r = car(1, 45, 1, -3);
  assert.deepEqual(e.read(p, [r, p], 'golden'), { kind: 'traffic', side: 'left' });
  for (const other of [
    relative(p, 0, 3), relative(p, -3, 8), relative(p, 3, -7), relative(p, 9),
    { ...relative(p, -3), y: p.y + 3 }, { ...relative(p, 3), y: NaN },
    { ...relative(p, -3), yaw: p.yaw + Math.PI / 2 }, { ...relative(p, 3), yaw: p.yaw + Math.PI },
  ]) assert.equal(e.read(p, [p, other], 'golden')?.kind, 'corner');
});

test('overlap release band absorbs bumper jitter but does not invent a new or lingering alert', () => {
  const e = createEngineer(circuit), p = car(400);
  const read = (fore: number, id = 1) => e.read(p, [p, relative(p, -2.6, fore, id)], 'golden')?.kind;
  assert.equal(read(4.5), 'corner');
  assert.equal(read(4.1), 'traffic');
  assert.equal(read(4.5), 'traffic');
  assert.equal(read(4.5, 2), 'corner'); // a different rival cannot inherit the release band
  assert.equal(read(4.5), 'corner');
  assert.equal(read(4.1), 'traffic');
  assert.equal(read(5.2), 'corner');
  assert.equal(read(4.5), 'corner');
  assert.equal(read(4.1), 'traffic');
  e.reset();
  assert.equal(read(4.5), 'corner');
});

test('no forward pace note when off road, reversing, facing back up the circuit or lacking telemetry', () => {
  const e = createEngineer(circuit), p = car(500);
  for (const change of [{ surface: 'grass' }, { surface: 'gravel' }, { gear: -1 },
    { yaw: p.yaw + Math.PI }, { speed: NaN }, { s: NaN }] as const) {
    assert.equal(e.read({ ...p, ...change }, [], 'golden'), null);
  }
  const off = { ...p, surface: 'grass' as const };
  assert.deepEqual(e.read(off, [relative(off, 2.5)], 'golden'), { kind: 'traffic', side: 'right' });
});
