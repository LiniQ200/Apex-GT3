import type { Scene } from '@babylonjs/core/scene';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Geometry } from '@babylonjs/core/Meshes/geometry';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';

/** Fit a closed section hull to the inspected donor and its roof, not a box
 * enlarged to include the wing. Sunlight still passes underneath the wing,
 * nose and floor; four grounded slicks cast at their measured axle stations. */
export function shadowHull(
  scene: Scene,
  name: string,
  skin: ArrayLike<number>[],
  length: number,
  hubs: Vector3[],
  radii: number[],
  widths: number[],
  aero: { p: number[]; idx: number[] }[],
) {
  const positions: number[] = [],
    indices: number[] = [];
  const sides = 12,
    stations = 24,
    halfLength = length / 2;
  const directions = Array.from({ length: sides }, (_, i) => {
    const angle = ((i + 0.5) * Math.PI * 2) / sides;
    return [Math.cos(angle), Math.sin(angle)];
  });
  const rings = Array.from({ length: stations }, () => directions.map(() => [-Infinity, 0, 0]));
  for (const p of skin)
    for (let j = 0; j < p.length; j += 3) {
      const x = p[j],
        y = p[j + 1],
        z = p[j + 2];
      const station = Math.min(
        stations - 1,
        Math.max(0, Math.round((z / (2 * halfLength) + 0.5) * (stations - 1))),
      );
      for (let i = 0; i < sides; i++) {
        const [nx, ny] = directions[i],
          v = nx * x + ny * y,
          best = rings[station][i];
        if (v > best[0]) {
          best[0] = v;
          best[1] = x;
          best[2] = y;
        }
      }
    }
  function bridge(start: number, count: number) {
    for (let i = 0; i < count; i++) {
      const a = start + i,
        b = start + ((i + 1) % count);
      indices.push(a, a + count, b, b, a + count, b + count);
    }
  }
  function cap(start: number, count: number, end: boolean) {
    for (let i = 1; i + 1 < count; i++) {
      if (end) indices.push(start, start + i + 1, start + i);
      else indices.push(start, start + i, start + i + 1);
    }
  }
  for (let j = 0; j < stations; j++) {
    if (!Number.isFinite(rings[j][0][0])) continue;
    const start = positions.length / 3,
      z = halfLength * ((2 * j) / (stations - 1) - 1);
    for (const [, x, y] of rings[j]) positions.push(x, y, z);
    if (start) bridge(start - sides, sides);
  }
  cap(0, sides, false);
  cap(positions.length / 3 - sides, sides, true);
  hubs.forEach(({ x, y, z }, k) => {
    const start = positions.length / 3;
    for (const dx of [-0.5, 0.5])
      for (let j = 0; j < sides; j++) {
        const theta = (j * Math.PI * 2) / sides;
        positions.push(x + dx * widths[k], y + Math.cos(theta) * radii[k], z + Math.sin(theta) * radii[k]);
      }
    bridge(start, sides);
    cap(start, sides, false);
    cap(start + sides, sides, true);
  });
  for (const { p, idx } of aero) {
    const start = positions.length / 3;
    positions.push(...p);
    for (const index of idx) indices.push(index + start);
  }
  const data = new VertexData(),
    normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  data.positions = positions;
  data.normals = normals;
  data.indices = indices;
  const geometry = new Geometry(name + '.sun silhouette', scene, data);
  scene.pushGeometry(geometry);
  return geometry;
}
