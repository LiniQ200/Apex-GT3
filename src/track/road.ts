import type { Circuit, CollisionMesh, TrackPoint } from '../types';
import {
  hasKerb,
  isInPitBranch,
  kerbRamp,
  kerbWidth,
  PIT_BOX_D,
  PIT_WALL_D,
  PIT_WALL_END_S,
  PIT_WALL_START_BACK,
  pitBoxStation,
  trapSide,
  wallOffset,
} from './circuit';

export type Vec = [number, number, number];
export interface Geometry {
  positions: number[];
  indices: number[];
  uvs: number[];
  uv2: number[];
  colors: number[];
}
export const geometry = (): Geometry => ({ positions: [], indices: [], uvs: [], uv2: [], colors: [] });
export function point(p: TrackPoint, d: number, h = 0): Vec {
  return [p.x + Math.cos(p.yaw) * d, p.y + Math.tan(p.bank) * d + h, p.z - Math.sin(p.yaw) * d];
}
type UV = [number, number];
export function vertex(g: Geometry, v: Vec, uv: UV = [0, 0], color: Vec = [1, 1, 1], uv2?: UV) {
  const id = g.positions.length / 3;
  g.positions.push(...v);
  g.uvs.push(...uv);
  g.colors.push(...color, 1);
  if (uv2) g.uv2.push(...uv2);
  return id;
}
export function quad(g: Geometry, a: number, b: number, c: number, d: number) {
  g.indices.push(a, b, c, a, c, d);
}
const white: Vec = [0.87, 0.86, 0.79],
  red: Vec = [0.76, 0.046, 0.034];
// All Geometry windings are conventional right-hand cross products. Publication to
// Babylon reverses them; Jolt receives the original. Normals therefore agree exactly.
export function makeRoad(circuit: Circuit) {
  const repeatV = (s: number, metres: number) => (s / circuit.length) * Math.round(circuit.length / metres);
  const meshes = {
    road: geometry(),
    pitApron: geometry(),
    grass: geometry(),
    gravel: geometry(),
    kerb: geometry(),
    paint: geometry(),
    wall: geometry(),
    pitWall: geometry(),
    absorber: geometry(),
  };
  const wallCollision = geometry(),
    pitWallCollision = geometry(),
    runoffCollision = geometry(),
    pitCollision = geometry();
  // Integer stations keep all joints and material transitions on identical coordinates;
  // the final residual interval terminates at the exact first row of the next lap.
  const stations: number[] = [];
  for (let s = 0; s < circuit.length; s += 2) stations.push(s);
  stations.push(circuit.length);
  for (const s of [
    855, 1560, 1595, 1810, 2360, 2560, 2650, 3150, 3265, 3970, 4245,
    PIT_WALL_END_S,
    Math.round(circuit.length - PIT_WALL_START_BACK),
  ])
    if (!stations.includes(s)) stations.push(s);
  stations.sort((a, b) => a - b);
  let prev: number[] | null = null;
  for (const s of stations) {
    const p = circuit.at(s),
      row: number[] = [];
    for (let j = 0; j <= 4; j++) {
      const d = p.halfWidth * (j / 2 - 1),
        v = point(p, d);
      const k =
        0.94 +
        0.038 * Math.sin(v[0] * 0.124 + v[2] * 0.047) +
        0.024 * Math.cos(v[0] * 0.247 - v[2] * 0.115) +
        0.017 * Math.sin(v[0] * 0.061 - v[2] * 0.023);
      row.push(vertex(meshes.road, v, [d / 3.5, repeatV(s, 3.5)], [k, k, k], [j / 4, s / circuit.length]));
    }
    if (prev) for (let j = 0; j < 4; j++) quad(meshes.road, prev[j], row[j], row[j + 1], prev[j + 1]);
    prev = row;
  }
  // Path-accurate surface patches: two station frames times a transverse profile.
  type Profile = (p: TrackPoint) => [number, number][];
  function ribbon(
    g: Geometry,
    p: TrackPoint,
    q: TrackPoint,
    end: number,
    profile: Profile,
    reverse: boolean,
    color: Vec,
    scale: number,
  ) {
    const u = profile(p),
      v = profile(q),
      base = g.positions.length / 3;
    for (const [frame, section, s] of [
      [p, u, p.s],
      [q, v, end],
    ] as const)
      for (const [d, h] of section) {
        const pos = point(frame, d, h);
        vertex(g, pos, [(d + h) / scale, repeatV(s, scale)], color);
      }
    for (let j = 0; j < u.length - 1; j++) {
      const a = base + j,
        b = base + u.length + j;
      if (reverse) quad(g, a, a + 1, b + 1, b);
      else quad(g, a, b, b + 1, a + 1);
    }
  }
  for (let i = 1; i < stations.length; i++) {
    const start = stations[i - 1],
      end = stations[i],
      m = (start + end) / 2,
      p = circuit.at(start),
      q = circuit.at(end);
    for (const side of [-1, 1]) {
      const kerb = hasKerb(m),
        trap = trapSide(m) === side;
      const edge = (p: TrackPoint, delta: number) => side * (p.halfWidth + delta),
        wall = (p: TrackPoint) => side * wallOffset(p, side, circuit.length);
      const kerbEdge = kerb ? kerbWidth : 0;
      if (kerb) {
        const height = (s: number) => 0.086 + 0.014 * Math.cos((Math.PI * s) / 2);
        ribbon(
          meshes.kerb,
          p,
          q,
          end,
          (t) => [
            [edge(t, 0), 0],
            [edge(t, 0.24), 0.04 * kerbRamp(t.s)],
            [edge(t, 1.01), height(t.s) * kerbRamp(t.s)],
            [edge(t, kerbWidth), 0],
          ],
          side < 0,
          Math.floor(start / 2) % 2 ? red : white,
          2.1,
        );
      }
      const grassTint = 0.87 + 0.045 * Math.sin(m * 0.21) + 0.04 * Math.cos(m * 0.024);
      const pitBranch = side === 1 && isInPitBranch(m, circuit.length);
      const pitWallActive = side === 1 && (m < PIT_WALL_END_S || m > circuit.length - PIT_WALL_START_BACK);
      const shoulder: Profile = (t) => [
        [edge(t, kerbEdge), 0],
        [trap ? edge(t, 2.65) : wall(t), 0],
      ];
      if (pitBranch) {
        if (pitWallActive) {
          // Trackside grass verge between main-straight white line and concrete pit wall
          const verge: Profile = (t) => [
            [edge(t, kerbEdge), 0],
            [PIT_WALL_D, 0],
          ];
          ribbon(meshes.grass, p, q, end, verge, false, [grassTint, grassTint, grassTint], 4.8);
          ribbon(runoffCollision, p, q, end, verge, false, [1, 1, 1], 1);
          // Paved concrete pit lane behind the pit wall
          const pitLane: Profile = (t) => [
            [PIT_WALL_D + 0.68, 0],
            [wall(t), 0],
          ];
          ribbon(meshes.pitApron, p, q, end, pitLane, false, [0.92, 0.91, 0.88], 3.8);
          ribbon(pitCollision, p, q, end, pitLane, false, [1, 1, 1], 1);
        } else {
          // Open paved pit-entry and pit-exit merge apron
          ribbon(meshes.pitApron, p, q, end, shoulder, false, [0.92, 0.91, 0.88], 3.8);
          ribbon(pitCollision, p, q, end, shoulder, false, [1, 1, 1], 1);
        }
      } else {
        ribbon(meshes.grass, p, q, end, shoulder, side < 0, [grassTint, grassTint, grassTint], 4.8);
        ribbon(
          runoffCollision,
          p,
          q,
          end,
          (t) => [
            [edge(t, kerbEdge), 0],
            [wall(t), 0],
          ],
          side < 0,
          [1, 1, 1],
          1,
        );
      }
      if (trap)
        ribbon(
          meshes.gravel,
          p,
          q,
          end,
          (t) => [
            [edge(t, 2.65), 0],
            [wall(t), 0],
          ],
          side < 0,
          [0.95, 0.92, 0.87],
          2.25,
        );
      // Behind the crash barrier an embankment meets the general valley floor; never
      // stretch a large flat ground through a banked corner or leave its edges hanging.
      ribbon(
        meshes.grass,
        p,
        q,
        end,
        (t) => [
          [wall(t), 0],
          [wall(t) + side * 3, -0.3],
          [wall(t) + side * 8, -t.y - 2.4 - Math.tan(t.bank) * (wall(t) + side * 8)],
        ],
        side < 0,
        [0.8, 0.78, 0.71],
        5.8,
      );
      if (!pitBranch) {
        ribbon(
          meshes.paint,
          p,
          q,
          end,
          (t) => [
            [edge(t, -0.28), 0.014],
            [edge(t, -0.115), 0.014],
          ],
          side < 0,
          white,
          1,
        );
      } else {
        // Dashed pit blend line on entry/exit, solid white line alongside pit wall
        if (pitWallActive || Math.floor(m / 4) % 2 === 0) {
          ribbon(
            meshes.paint,
            p,
            q,
            end,
            (t) => [
              [edge(t, -0.28), 0.014],
              [edge(t, -0.115), 0.014],
            ],
            false,
            white,
            1,
          );
        }
        // Fast-lane white divider & working-box amber line inside the pit corridor
        if (pitWallActive) {
          ribbon(
            meshes.paint,
            p,
            q,
            end,
            () => [
              [11.35, 0.016],
              [11.55, 0.016],
            ],
            false,
            white,
            1,
          );
          ribbon(
            meshes.paint,
            p,
            q,
            end,
            () => [
              [15.45, 0.016],
              [15.68, 0.016],
            ],
            false,
            [0.95, 0.72, 0.22],
            1,
          );
        }
      }
      // Single-sided continuous outer impact face. Right wall normals face left and vice versa.
      const inside: Profile = (t) => [
        [wall(t), -0.16],
        [wall(t), 1.03],
      ];
      ribbon(wallCollision, p, q, end, inside, side < 0, [1, 1, 1], 2.2);
      if (pitWallActive) {
        // Double-sided concrete FIA pit wall separating main straight from the drivable pit lane
        ribbon(
          meshes.pitWall,
          p,
          q,
          end,
          () => [
            [PIT_WALL_D, -0.12],
            [PIT_WALL_D, 0.2],
            [PIT_WALL_D + 0.12, 0.55],
            [PIT_WALL_D + 0.13, 1.04],
            [PIT_WALL_D + 0.56, 1.04],
            [PIT_WALL_D + 0.57, 0.55],
            [PIT_WALL_D + 0.68, 0.2],
            [PIT_WALL_D + 0.68, -0.12],
          ],
          false,
          [0.92, 0.89, 0.84],
          2,
        );
        // Track-facing & pit-lane-facing Jolt colliders for the separating pit wall
        ribbon(
          pitWallCollision,
          p,
          q,
          end,
          () => [
            [PIT_WALL_D, -0.16],
            [PIT_WALL_D, 1.04],
          ],
          false,
          [1, 1, 1],
          2,
        );
        ribbon(
          pitWallCollision,
          p,
          q,
          end,
          () => [
            [PIT_WALL_D + 0.68, -0.16],
            [PIT_WALL_D + 0.68, 1.04],
          ],
          true,
          [1, 1, 1],
          2,
        );
      } else if (trap) {
        const k = Math.floor(m / 2) % 8,
          col: Vec = k < 4 ? [0.65, 0.055, 0.036] : [0.74, 0.72, 0.65],
          tone = k % 2 ? 0.91 : 1;
        ribbon(
          meshes.absorber,
          p,
          q,
          end,
          (t) => [
            [wall(t) + side * 0.08, -0.04],
            [wall(t), 0.09],
            [wall(t), 0.88],
            [wall(t) + side * 0.12, 1.03],
            [wall(t) + side * 0.96, 1.03],
          ],
          side < 0,
          [col[0] * tone, col[1] * tone, col[2] * tone],
          2.1,
        );
      } else {
        // Continuous pressed W-beam: alternating ridges catch narrow strips of sky.
        ribbon(
          meshes.wall,
          p,
          q,
          end,
          (t) => [
            [wall(t) + side * 0.1, 0.28],
            [wall(t), 0.37],
            [wall(t) + side * 0.07, 0.48],
            [wall(t), 0.57],
            [wall(t) + side * 0.11, 0.69],
            [wall(t), 0.78],
            [wall(t) + side * 0.07, 0.89],
            [wall(t), 0.98],
            [wall(t) + side * 0.12, 1.03],
          ],
          side < 0,
          [0.64, 0.67, 0.67],
          2.2,
        );
      }
    }
  }
  // The physical surface network welds coincident render vertices (including sawteeth
  // and the lap seam) so Jolt can classify internal edges and skip phantom wheel hits.
  const collider = (g: Geometry, kind: CollisionMesh['kind']): CollisionMesh => {
    const positions: number[] = [],
      indices: number[] = [],
      ids = new Map<string, number>();
    for (const old of g.indices) {
      const i = old * 3,
        x = g.positions[i],
        y = g.positions[i + 1],
        z = g.positions[i + 2],
        key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = positions.length / 3;
        positions.push(x, y, z);
        ids.set(key, id);
      }
      indices.push(id);
    }
    return { positions, indices, kind };
  };
  // Painted pit boxes for all 10 teams (Bay 01 Player Box highlighted in FIA signal amber/red)
  const addFlatQuad = (s0: number, s1: number, d0: number, d1: number, col: Vec, h = 0.018) => {
    const p0 = circuit.at(s0), p1 = circuit.at(s1);
    const a = vertex(meshes.paint, point(p0, d0, h), [0, 0], col);
    const b = vertex(meshes.paint, point(p1, d0, h), [0, 1], col);
    const c = vertex(meshes.paint, point(p1, d1, h), [1, 1], col);
    const d = vertex(meshes.paint, point(p0, d1, h), [1, 0], col);
    quad(meshes.paint, a, b, c, d);
  };
  for (let bay = 0; bay < 10; bay++) {
    const bs = pitBoxStation(bay);
    const col: Vec = bay === 0 ? [0.95, 0.34, 0.14] : white;
    // Front & rear box bars + outer rails
    addFlatQuad(bs - 3.1, bs - 2.9, PIT_BOX_D - 1.55, PIT_BOX_D + 1.55, col);
    addFlatQuad(bs + 2.9, bs + 3.1, PIT_BOX_D - 1.55, PIT_BOX_D + 1.55, col);
    addFlatQuad(bs - 3.1, bs + 3.1, PIT_BOX_D - 1.55, PIT_BOX_D - 1.38, col);
    addFlatQuad(bs - 3.1, bs + 3.1, PIT_BOX_D + 1.38, PIT_BOX_D + 1.55, col);
    if (bay === 0) {
      // Bold illuminated stop stripe at nose of Player Pit Box
      addFlatQuad(bs + 2.1, bs + 2.45, PIT_BOX_D - 1.3, PIT_BOX_D + 1.3, [0.98, 0.76, 0.18], 0.02);
    }
  }
  // 60 km/h pit-entry and pit-exit FIA speed limit transverse lines
  addFlatQuad(circuit.length - PIT_WALL_START_BACK - 2, circuit.length - PIT_WALL_START_BACK - 1.4, PIT_WALL_D + 0.7, 21.8, [0.95, 0.76, 0.2]);
  addFlatQuad(PIT_WALL_END_S - 0.6, PIT_WALL_END_S, PIT_WALL_D + 0.7, 21.8, [0.22, 0.85, 0.45]);

  return {
    meshes,
    colliders: [
      collider(meshes.road, 'road'),
      collider(meshes.pitApron, 'pit'),
      collider(meshes.kerb, 'kerb'),
      collider(runoffCollision, 'runoff'),
      collider(wallCollision, 'wall'),
      collider(pitWallCollision, 'pitWall'),
    ],
  };
}
