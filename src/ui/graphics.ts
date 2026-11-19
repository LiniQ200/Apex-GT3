import type { Circuit } from '../types';

const paths = {
  arrow: '<path d="M3 12h16m-6-7 7 7-7 7"/>',
  angle: '<path d="m8 5 7 7-7 7"/>',
  down: '<path d="m7 10 5 5 5-5"/>',
  sound: '<path d="M11 5 6 9H3v6h3l5 4zm4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  silent: '<path d="M11 5 6 9H3v6h3l5 4zm5 4 6 6m0-6-6 6"/>',
  keys: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 9h1m2 0h1m2 0h1m2 0h1m2 0h1M5 12h1m2 0h1m2 0h1m2 0h1m2 0h1M8 15h8"/>',
  flag: '<path d="M4 21V3m1 1c5-4 9 5 16 0v10c-6 5-11-4-16 0"/><path d="m7 7 2 1m2 1 2 1m2 1h2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
  cloud: '<path d="M5 15a4 4 0 0 1 1-8 6 6 0 0 1 11-1 5 5 0 1 1 1 10H6m1 2-1 3m6-3-1 3m6-3-1 3"/>',
  tune: '<path d="M3 6h18M3 12h18M3 18h18"/><path d="M8 3v6m9 0v6m-7 0v6" stroke-width="3.2"/>',
  car: '<path d="m2 15 1-4 3-1 4-4h7l3 4 2 2v4h-2m-5 0H9m-5 0H2"/><circle cx="6.5" cy="15.5" r="2"/><circle cx="17.5" cy="15.5" r="2"/>',
  signal: '<path d="M3 20v-3m5 3v-7m5 7V9m5 11V4" stroke-width="2.6"/>',
  clock: '<circle cx="12" cy="13" r="8"/><path d="M12 13V8m-3-6h6m2 4 2-2"/>',
  map: '<path d="m3 6 5-2 8 3 5-2v14l-5 2-8-3-5 2zm5-2v14m8-11v14"/>',
  close: '<path d="m5 5 14 14m0-14L5 19"/>',
};

export function icon(name: keyof typeof paths): string {
  return `<svg class="ax-icon" aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" stroke-linejoin="round">${paths[name]}</svg>`;
}

export const insignia =
  '<svg aria-hidden="true" class="ax-insignia" viewBox="0 0 56 38"><path fill="currentColor" d="M0 34 25 3h12L13 34zM31 14l5-7 16 27H38l-3-6H22l6-8h4z"/></svg>';

export function circuitGraphic(circuit: Circuit) {
  const pts = circuit.samples;
  let xmin = Infinity,
    xmax = -Infinity,
    zmin = Infinity,
    zmax = -Infinity;
  for (const p of pts) {
    xmin = Math.min(xmin, p.x);
    xmax = Math.max(xmax, p.x);
    zmin = Math.min(zmin, p.z);
    zmax = Math.max(zmax, p.z);
  }
  if (!pts.length) xmin = xmax = zmin = zmax = 0;
  const k = Math.min(168 / Math.max(1, xmax - xmin), 84 / Math.max(1, zmax - zmin));
  const x = (v: number) => 96 + (v - (xmin + xmax) * 0.5) * k;
  const y = (v: number) => 51 - (v - (zmin + zmax) * 0.5) * k;
  const step = Math.max(1, Math.floor(pts.length / 270));
  const line =
    pts
      .filter((_, i) => i % step === 0)
      .map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.z).toFixed(1)}`)
      .join('') + 'Z';
  const p0 = pts[0];
  const start = p0
    ? `<rect x="${x(p0.x) - 1.9}" y="${y(p0.z) - 1.9}" width="3.8" height="3.8" fill="#ff633d" stroke="#101415" stroke-width=".7"/>`
    : '';
  const svg = `<svg class="ax-outline" viewBox="0 0 192 102" aria-label="Circuit outline" role="img"><path d="${line}" stroke="currentColor" stroke-width="2.8" stroke-linejoin="round" fill="none"/>${start}<g data-map-points></g></svg>`;
  return { svg, x, y };
}
