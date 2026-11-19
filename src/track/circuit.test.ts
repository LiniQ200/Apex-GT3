import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createCircuit } from './circuit';
import { makeRoad } from './road';

const circuit = createCircuit();

test('closed survey, 550 m back straight, crest and independent clearance bound', () => {
  const { length, samples, at } = circuit,
    n = samples.length,
    step = length / n;
  assert.ok(Math.abs(length - 4300) < 50 && Math.abs(step - 1) < 0.001);
  assert.deepEqual(at(0), at(length));
  assert.deepEqual(at(-0.125), at(length - 0.125));
  assert.equal(Math.max(...samples.map((p) => p.y)), 18);
  let min = Infinity,
    maxChord = 0,
    straight = 0;
  for (let i = 0; i < n; i++) {
    const a = samples[i],
      b = samples[(i + 1) % n];
    assert.ok(Math.abs(a.slope) <= 0.09);
    maxChord = Math.max(maxChord, Math.hypot(a.x - b.x, a.z - b.z));
    if (a.x >= 590 && a.x <= 1140 && Math.abs(a.z + 60) < 1e-7 && Math.abs(a.kappa) < 1e-9) straight++;
    // Brute force, deliberately independent of the production spatial hash. Any
    // pair of points in the two segments is >= endpoint distance - two chord lengths.
    for (let j = i + 1; j < n; j++) {
      const gap = Math.min(j - i, n - (j - i));
      if (gap * step <= 60) continue;
      const b = samples[j];
      min = Math.min(min, (b.x - a.x) ** 2 + (b.z - a.z) ** 2);
    }
  }
  assert.ok(straight * step >= 549);
  assert.ok(Math.sqrt(min) - 2 * maxChord > 38);
  const before = at(-0.01),
    after = at(0.01);
  assert.ok(Math.abs(before.yaw - after.yaw) < 0.001 && Math.abs(before.kappa - after.kappa) < 1e-5);
});

test('spatial projection preserves station and signed width through turns and seam', () => {
  for (let i = 0; i < 16000; i++) {
    const s = (317.115363 * i) % circuit.length,
      d = 13 * Math.sin(i * 0.78),
      p = circuit.at(s, d),
      n = circuit.nearest(p.x, p.z),
      ds = Math.abs(n.s - s);
    assert.ok(Math.min(ds, circuit.length - ds) < 0.004);
    assert.ok(Math.abs(n.d - d) < 1e-5);
  }
  for (const [s, d, expected] of [
    [0, 0, 'groove'],
    [0, 3, 'asphalt'],
    [700, 7, 'kerb'],
    [701, -10, 'gravel'],
    [240, 8.9, 'grass'],
  ] as const) {
    const p = circuit.at(s, d);
    assert.equal(circuit.nearest(p.x, p.z).surface, expected);
  }
});

test('every contact triangle has the required Jolt front face', () => {
  for (const { positions: p, indices: ii, kind } of makeRoad(circuit).colliders)
    for (let i = 0; i < ii.length; i += 3) {
      const a = 3 * ii[i],
        b = 3 * ii[i + 1],
        c = 3 * ii[i + 2];
      const ux = p[b] - p[a],
        uy = p[b + 1] - p[a + 1],
        uz = p[b + 2] - p[a + 2],
        vx = p[c] - p[a],
        vy = p[c + 1] - p[a + 1],
        vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx,
        len = Math.hypot(nx, ny, nz);
      assert.ok(Number.isFinite(len) && len > 1e-6);
      if (kind !== 'wall') {
        assert.ok(ny / len > 0.9);
        continue;
      }
      const x = (p[a] + p[b] + p[c]) / 3,
        z = (p[a + 2] + p[b + 2] + p[c + 2]) / 3,
        nearest = circuit.at(circuit.nearest(x, z).s);
      const dx = nearest.x - x,
        dz = nearest.z - z;
      assert.ok((nx * dx + nz * dz) / (len * Math.hypot(dx, dz)) > 0.9);
    }
});
