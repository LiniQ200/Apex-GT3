import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Circuit, CollisionMesh, Weather, WheelLayout } from '../types';
import { createCircuit } from '../track/circuit';
import { makeRoad } from '../track/road';
import { createRaceState } from './race';
import { createWorld, STEP, type Controls } from './world';

const coast = { throttle: 0, brake: 0, right: 0, handbrake: 0, draft: 0 };
const launch = { ...coast, throttle: 1 }, brake = { ...coast, brake: 1 };
type World = Awaited<ReturnType<typeof createWorld>>;

function car(world: World, station: number, lane: number, weather: Weather = 'golden', layout?: WheelLayout) {
  const state = createRaceState('Jolt'), d = state.drivers[0];
  state.tc = state.abs = 0;
  state.settings.weather = weather;
  world.add(d, station, lane, layout);
  const tick = (cmd: Controls) => { world.control(d, cmd, state); world.step(); world.read(d); };
  for (let i = 0; i < 65; i++) tick(brake);
  return { d, tick };
}

test('split-grip braking follows each wheel at both edges; damp extends the on-road stop', async (t) => {
  const track = createCircuit(), world = await createWorld(track, makeRoad(track).colliders);
  try {
    for (const lane of [-7.8, 7.8]) {
      const { d, tick } = car(world, 120, lane);
      for (let i = 0; i < 250; i++) tick(launch);
      assert.equal(d.surface, 'asphalt');
      const before = [...d.brakeTempC], inside = lane < 0 ? 1 : 0;
      for (let i = 0; i < 100; i++) tick(brake);
      const heat = d.brakeTempC.map((t, i) => t - before[i]);
      assert.ok(heat[inside] > heat[1 - inside] + 5, `front asphalt/grass brake work, lane ${lane}: ${heat}`);
      assert.ok(heat[2 + inside] > heat[3 - inside] + 3, `rear asphalt/grass brake work, lane ${lane}: ${heat}`);
      t.diagnostic(`lane ${lane} m: rotor rises FL/FR/RL/RR ${heat.map(x => x.toFixed(1))} °C`);
      world.clear();
    }

    const stops: number[] = [];
    for (const weather of ['golden', 'damp'] as const) {
      const { d, tick } = car(world, 120, 0, weather);
      for (let i = 0; i < 700 && d.speed < 20; i++) tick(launch);
      assert.ok(d.speed >= 20 && d.speed < 20.15);
      const start = d.distance, before = d.brakeTempC[0];
      for (let i = 0; i < 450 && d.speed > 0.75; i++) tick(brake);
      assert.ok(d.speed <= 0.75 && d.brakeTempC[0] > before + 20);
      stops.push(d.distance - start);
      world.clear();
    }
    assert.ok(stops[1] > stops[0] * 1.04, `braking from 20 m/s: dry/damp ${stops}`);
    t.diagnostic(`20 m/s braking distance, dry/damp: ${stops.map(x => x.toFixed(2))} m`);
  } finally { world.dispose(); }
});

// Same flat Jolt mesh on both sides until z=85, then nothing under the right
// tyres. Full suspension extension plus being beyond this edge identifies a
// genuinely airborne tyre; the wheel on its left is still transmitting force.
const strip: Circuit = {
  length: 500, samples: [],
  at: (s, d = 0) => ({ s, x: d, y: 0, z: s, yaw: 0, slope: 0, bank: 0, kappa: 0, halfWidth: 16 }),
  nearest: (x, z) => ({ s: z, d: x, surface: 'asphalt' }),
};
function slab(left: number, right: number, end: number): CollisionMesh {
  return { kind: 'road', positions: [left, 0, 0, left, 0, end, right, 0, end, right, 0, 0], indices: [0, 1, 2, 0, 2, 3] };
}

test('each measured tyre rests on its own banked pad in the reported rig frame', async () => {
  // Four small pads, no continuous road. Generic rays miss them. Distinct
  // radii and hub heights catch axle averaging and assuming hub.y === radius.
  const layout: WheelLayout = [
    { x: -1.08, z: 1.48, radius: 0.36, y: 0.362 }, { x: 1.04, z: 1.51, radius: 0.35, y: 0.35 },
    { x: -1.03, z: -1.66, radius: 0.39, y: 0.39 }, { x: 1.1, z: -1.61, radius: 0.38, y: 0.384 },
  ];
  const station = 40, height = (x: number, z: number) => 0.055 * x + 0.016 * (z - station);
  const pads = layout.map(({ x, z }): CollisionMesh => ({
    kind: 'kerb', indices: [0, 1, 2, 0, 2, 3],
    positions: [[-1, -1], [-1, 1], [1, 1], [1, -1]].flatMap(([a, b]) => {
      const X = x + 0.08 * a, Z = station + z + 0.08 * b;
      return [X, height(X, Z), Z];
    }),
  }));
  const world = await createWorld(strip, pads);
  try {
    const { d, tick } = car(world, station, 0, 'golden', layout);
    for (let i = 0; i < 120; i++) tick(brake);
    assert.ok(Math.abs(d.roll) > 0.035 && Math.abs(d.pitch) > 0.008);
    for (const [i, wheel] of layout.entries()) {
      assert.ok(d.wheelCompressionM[i] > 0.01, `tyre ${i} missed its pad`);
      // Rebuild the rig's tread centre from public pose and compression only:
      // transform the local bottom of this wheel by roll, pitch, then yaw.
      const y = wheel.y + d.wheelCompressionM[i] - 0.03 - wheel.radius;
      const rx = wheel.x * Math.cos(d.roll) - y * Math.sin(d.roll);
      const ry = wheel.x * Math.sin(d.roll) + y * Math.cos(d.roll);
      const rz = ry * Math.sin(d.pitch) + wheel.z * Math.cos(d.pitch);
      const X = d.x + rx * Math.cos(d.yaw) + rz * Math.sin(d.yaw);
      const Y = d.y + ry * Math.cos(d.pitch) - wheel.z * Math.sin(d.pitch);
      const Z = d.z - rx * Math.sin(d.yaw) + rz * Math.cos(d.yaw);
      assert.ok(Math.abs(Y - height(X, Z)) < 0.00025, `tyre ${i} is ${Y - height(X, Z)} m off its pad`);
    }
    world.reset(d, station, 0);
    const resetY = d.y;
    assert.equal(d.pitch, 0);
    assert.equal(d.roll, 0);
    world.read(d); // immediate pose must already agree, before a new spring step
    assert.ok(Math.abs(d.y - resetY) < 1e-6);
  } finally { world.dispose(); }
});

test('a recessed authored hub does not cross-load the opposite brakes on a flat straight', async () => {
  const radius = 0.37, recess = 0.004;
  const layout: WheelLayout = [
    { x: -0.9, z: 1.3, radius, y: radius }, { x: 0.9, z: 1.3, radius, y: radius + recess },
    { x: -0.9, z: -1.4, radius, y: radius }, { x: 0.9, z: -1.4, radius, y: radius },
  ];
  const world = await createWorld(strip, [slab(-12, 12, 250)]);
  try {
    const { d, tick } = car(world, 40, 0, 'golden', layout);
    assert.ok(Math.abs(d.wheelCompressionM[0] - d.wheelCompressionM[1] - recess) < 0.00025);
    for (let i = 0; i < 650 && d.speed < 22; i++) tick(launch);
    assert.ok(d.speed >= 22);
    const before = [...d.brakeTempC];
    for (let i = 0; i < 120; i++) tick(brake);
    const rise = d.brakeTempC.map((temp, i) => temp - before[i]);
    for (const axle of [0, 2]) {
      assert.ok(rise[axle] > 10 && Math.abs(rise[axle] - rise[axle + 1]) < 1, `split brake work: ${rise}`);
    }
  } finally { world.dispose(); }
});

test('a slipping left wheel cannot heat a right wheel that has run out of road', async (t) => {
  const world = await createWorld(strip, [slab(-20, 0, 250), slab(0, 20, 85)]);
  try {
    const { d, tick } = car(world, 40, 0);
    let observed = 0;
    for (let i = 0; i < 600 && d.z < 100; i++) {
      const before = d.tireTempC[3];
      tick(d.z < 88 ? launch : brake);
      if (d.z < 88 || d.wheelCompressionM[3] > 1e-6 || d.wheelCompressionM[2] < 0.01 || d.slip < 0.1) continue;
      const coolingOnly = before - STEP * (before - 32) * 0.0019;
      assert.ok(Math.abs(d.tireTempC[3] - coolingOnly) < 1e-8, `airborne RR heated with car slip ${d.slip}`);
      observed++;
    }
    assert.ok(observed >= 5, `expected sustained loaded-left/airborne-right slip, saw ${observed} ticks`);
    t.diagnostic(`loaded-left/airborne-right slip with passive RR cooling: ${observed} ticks`);

    world.reset(d, 110, 30); // outside both slabs
    const tires = [...d.tireTempC], rotors = [...d.brakeTempC];
    for (let i = 0; i < 120; i++) tick(i < 60 ? launch : brake);
    assert.ok(d.y < -4 && d.speed > 8 && d.wheelCompressionM.every(x => Math.abs(x) < 1e-6));
    assert.equal(d.slip, 0);
    assert.ok(d.tireTempC.every((temp, i) => temp < tires[i]));
    assert.ok(d.brakeTempC.every((temp, i) => temp < rotors[i]));
  } finally { world.dispose(); }
});

test('coasting into mirrored turns heats the outside front tread without touching the brakes', async (t) => {
  const world = await createWorld(strip, [slab(-40, 40, 250)]);
  try {
    for (const right of [-1, 1]) {
      const { d, tick } = car(world, 40, 0);
      for (let i = 0; i < 650 && d.speed < 25; i++) tick(launch);
      assert.ok(d.speed >= 25);
      const initial = [...d.tireTempC], rotors = [...d.brakeTempC], turn = { ...coast, right };
      for (let i = 0; i < 50; i++) tick(turn);
      const outside = right > 0 ? 0 : 1, heat = d.tireTempC.map((t, i) => t - initial[i]);
      assert.ok(heat[outside] > heat[1 - outside] + 0.1, `outside front, steer ${right}: ${heat}`);
      assert.ok(d.brakeTempC.every((t, i) => t < rotors[i]));
      t.diagnostic(`steer ${right}: front tread changes L/R ${heat.slice(0, 2).map(x => x.toFixed(2))} °C`);
      world.clear();
    }
  } finally { world.dispose(); }
});
