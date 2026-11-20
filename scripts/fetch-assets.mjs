import { mkdir, readFile, writeFile, copyFile, stat, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import { prepareTrackMaps } from './track-maps.mjs';

const root = 'public/assets/',
  ua = { 'User-Agent': 'AmpGT3Sim/1.0' },
  procedural = 'procedural fallback',
  assets = {};
const previous = JSON.parse(await readFile(root + 'manifest.json', 'utf8').catch(() => '{}')).assets ?? {};
const sha = (b) => createHash('sha256').update(b).digest('hex');
const offline = process.argv.includes('--offline');
// Starting the game should not retry a verified offline substitution. An explicit
// fetch:assets without flags still promotes it to the upstream model or texture.
const keepFallbacks = offline || process.argv.includes('--ensure');
async function cached(path, skipSource) {
  const old = previous[path];
  if (!old || (!keepFallbacks && old.source === skipSource)) return false;
  const b = await readFile(root + path).catch(() => null);
  if (!b || sha(b) !== old.sha256) return false;
  assets[path] = old;
  return true;
}
async function save(path, data, source) {
  await mkdir(dirname(root + path), { recursive: true });
  await writeFile(root + path + '.part', data);
  await rename(root + path + '.part', root + path);
  assets[path] = { bytes: data.length, sha256: sha(data), source };
}
async function request(url) {
  if (offline) throw Error('Offline asset preparation');
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(18000) });
      if (!r.ok) throw Error(`${r.status}: ${url}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      err = e;
      if (i < 2) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** i));
    }
  }
  throw err;
}
async function model(name, sources, substitute) {
  const path = `models/${name}.glb`;
  if (await cached(path, substitute)) return;
  for (const p of substitute ? [...sources, substitute] : sources) {
    if (p === substitute && (await cached(path))) return;
    try {
      const b = p.startsWith('https:') ? await request(p) : await readFile(p);
      if (b.toString('ascii', 0, 4) !== 'glTF' || b.readUInt32LE(8) !== b.length)
        throw Error('Incomplete GLB');
      await save(path, b, p);
      return;
    } catch (e) {
      console.warn(`Model source unavailable: ${p}`);
    }
  }
  throw Error(`No valid ${name} source`);
}
async function inspect() {
  const report = {};
  for (const model of ['ferrari_base', 'car_concept_base']) {
    const b = await readFile(root + `models/${model}.glb`);
    if (b.readUInt32LE(16) !== 0x4e4f534a) throw Error('Missing GLB JSON chunk');
    const g = JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12)));
    report[model] = {
      nodes: g.nodes.map(({ name, children, mesh, rotation, translation, scale, matrix }, index) => ({
        index,
        name,
        mesh,
        children,
        rotation,
        translation,
        scale,
        matrix,
      })),
      meshes: g.meshes.map(({ name, primitives }, index) => ({
        index,
        name,
        primitives: primitives.map((p) => ({
          material: g.materials?.[p.material]?.name,
          position: g.accessors[p.attributes.POSITION],
          draco: !!p.extensions?.KHR_draco_mesh_compression,
        })),
      })),
      asset: g.asset,
    };
  }
  await save(
    'models/glb-rig-report.json',
    Buffer.from(JSON.stringify(report, null, 2)),
    'GLB JSON chunks (bounds in primitive-local coordinates)',
  );
}
function fallbackTexture(set, kind) {
  const size = 256,
    base = {
      asphalt: [77, 75, 74],
      kerb: [165, 158, 151],
      terrain: [103, 108, 58],
      concrete: [148, 141, 129],
    }[set];
  const data = Buffer.alloc(size * size * 4);
  let seed = 42;
  for (let i = 0; i < data.length; i += 4) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    const n = (seed / 4294967296 - 0.5) * 36;
    for (let k = 0; k < 3; k++)
      data[i + k] =
        kind === 'diff'
          ? base[k] + n
          : kind === 'nor_gl'
            ? k === 2
              ? 254
              : 128 + n * 0.35
            : kind === 'rough'
              ? 190 + n
              : 237 + n * 0.3;
    data[i + 3] = 255;
  }
  return jpeg.encode({ width: size, height: size, data }, 90).data;
}
function fallbackSky(damp) {
  const w = 128,
    h = 64,
    pixels = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = 4 * (x + w * y),
        t = Math.min(1, y / (h * 0.5)),
        sun = Math.exp(-((x - 77) ** 2 + (y - 24) ** 2) / 5);
      const rgb = damp
        ? [0.34 + t * 0.3, 0.42 + t * 0.29, 0.53 + t * 0.2]
        : [0.19 + t * 0.64 + 3 * sun, 0.34 + t * 0.38 + 2 * sun, 0.59 + t * 0.08 + sun];
      const e = Math.floor(Math.log2(Math.max(...rgb))) + 1;
      rgb.forEach((v, k) => (pixels[i + k] = Math.round((v * 256) / 2 ** e)));
      pixels[i + 3] = 128 + e;
    }
  return Buffer.concat([Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`), pixels]);
}
async function haven(set, slugs, sky = false) {
  const keys = sky ? ['hdr'] : ['diff', 'rough', 'nor_gl', 'ao'];
  const path = (k) => (sky ? `skies/${set}.hdr` : `${set}/${k}.jpg`);
  let missing = [];
  for (const k of keys) if (!(await cached(path(k), procedural))) missing.push(k);
  for (const slug of slugs) {
    if (!missing.length) break;
    try {
      const json = JSON.parse(await request(`https://api.polyhaven.com/files/${slug}`));
      await Promise.all(
        missing.map(async (k) => {
          const item =
            json[{ diff: 'Diffuse', rough: 'Rough', ao: 'AO', hdr: 'hdri' }[k] ?? k]?.['2k']?.[
              sky ? 'hdr' : 'jpg'
            ];
          if (!item) return;
          try {
            const b = await request(item.url);
            if (b.length !== item.size || createHash('md5').update(b).digest('hex') !== item.md5)
              throw Error('checksum');
            await save(path(k), b, item.url);
          } catch (e) {
            console.warn(String(e));
          }
        }),
      );
      missing = missing.filter((k) => !assets[path(k)]);
    } catch (e) {
      console.warn(String(e));
    }
  }
  for (const k of missing) {
    // The download failed again; retain the verified fallback without rewriting it.
    if (await cached(path(k))) continue;
    await save(path(k), sky ? fallbackSky(set === 'overcast_race') : fallbackTexture(set, k), procedural);
  }
}
await model('ferrari_base', [
  'node_modules/three/examples/models/gltf/ferrari.glb',
  'https://raw.githubusercontent.com/mrdoob/three.js/r180/examples/models/gltf/ferrari.glb',
  'assets/offline/ferrari.glb',
]);
await model(
  'car_concept_base',
  [
    'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/CarConcept/glTF-Binary/CarConcept.glb',
  ],
  root + 'models/ferrari_base.glb',
);
await inspect();
for (const name of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'])
  await save(
    `draco/${name}`,
    await readFile(`node_modules/three/examples/jsm/libs/draco/gltf/${name}`),
    'three@0.180.0',
  );
for (const lib of ['glslang', 'twgsl'])
  for (const ext of ['js', 'wasm']) {
    const p = `${lib}/${lib}.${ext}`;
    await save(p, await readFile('node_modules/@babylonjs/core/assets/' + p), 'Babylon.js 9.0.0');
  }
await Promise.all([
  haven(
    'golden_hour',
    ['kloppenheim_06_puresky', 'evening_road_01_puresky', 'syferfontein_1d_clear_puresky'],
    true,
  ),
  haven('overcast_race', ['kloofendal_48d_partly_cloudy_puresky', 'overcast_soil_puresky'], true),
  haven('asphalt', ['asphalt_02', 'asphalt_04']),
  haven('concrete', ['concrete_layers_02', 'concrete_wall_006']),
  haven('kerb', ['painted_plaster_wall', 'concrete_floor_painted']),
  haven('terrain', ['aerial_grass_rock', 'coast_sand_rocks_02']),
]);
await prepareTrackMaps({ root, assets, previous, cached, save });
const foliage = 'foliage/italian-conifers.webp';
await save(foliage, await readFile(`assets/${foliage}`), 'Valle d’Oro original / scripts/bake-foliage.py (CC0-1.0)');
const notices = [];
for (const [name, file] of [
  ['Babylon.js and included components', 'node_modules/@babylonjs/core/NOTICE.md'],
  ['Babylon.js and Draco', 'node_modules/@babylonjs/core/assets/Draco/draco.license'],
  ['Jolt Physics', 'node_modules/jolt-physics/LICENSE'],
  ['three.js', 'node_modules/three/LICENSE'],
  ['Barlow Condensed', 'src/ui/fonts/OFL.txt'],
]) {
  notices.push(`${name}\n\n${await readFile(new URL(`../${file}`, import.meta.url), 'utf8')}`);
}
await save('third-party-notices.txt', Buffer.from(notices.join('\n\n')), 'Package and font license files');
await writeFile(
  root + 'manifest.json',
  JSON.stringify(
    { assets: Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a.localeCompare(b))) },
    null,
    2,
  ),
);
console.log(
  `Verified ${Object.keys(assets).length} assets, ${(Object.values(assets).reduce((n, v) => n + v.bytes, 0) / 1048576).toFixed(1)} MiB.`,
);
