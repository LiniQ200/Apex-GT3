import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants } from 'node:zlib';
import { zipSync } from 'three/addons/libs/fflate.module.js';
import { rigGlb } from './rig-glb.mjs';

// Copy the runtime assets, not the larger source images used by the offline bake.
const [dir, ...bundle] = process.argv.slice(2);
const files = { 'README.md': await readFile('README.md'), 'play.py': await readFile('scripts/play.py') };
const manifest = JSON.parse(await readFile('public/assets/manifest.json', 'utf8'));
const baked = JSON.parse(await readFile('public/assets/skies/baked.json', 'utf8')).assets;
const sources = new Set(Object.values(baked).map(e => e.source));
const runtime = { ...Object.fromEntries(Object.entries(manifest.assets).filter(([path, e]) => !e.sourceOnly && !sources.has(path))), ...baked };
for (const name of ['credits.txt', 'race-plate.webp', ...Object.keys(runtime).map(k => `assets/${k}`)]) {
  files[name] = await readFile(join('public', name));
  if (name === 'assets/models/car_concept_base.glb') {
    const file = files[name] = rigGlb(files[name]), receipt = runtime['models/car_concept_base.glb'];
    receipt.sourceSha256 = receipt.sha256;
    receipt.sha256 = createHash('sha256').update(file).digest('hex');
    receipt.bytes = file.length;
  }
  await mkdir(dirname(join(dir, name)), { recursive: true });
  await writeFile(join(dir, name), files[name]);
}
files['assets/manifest.json'] = Buffer.from(JSON.stringify({ assets: runtime }, null, 2));
await writeFile(join(dir, 'assets/manifest.json'), files['assets/manifest.json']);
for (const name of bundle) files[name] = await readFile(join(dir, name));
// Optional HTTP representations for the hosted game. Keep the canonical bytes
// and their manifest hashes unchanged; the offline ZIP needs no second copy.
for (const [name, bytes] of Object.entries(files)) {
  if (bytes.length < 64 * 1024 || !/\.(?:js|glb|wasm|ttf)$/.test(name)) continue;
  const encoded = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } });
  if (encoded.length >= bytes.length) continue;
  const path = join(dir, 'downloads/encoded', name + '.br');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, encoded);
}
files['studio.html'] = Buffer.from(files['index.html'].toString().replace('<html lang="en">', '<html lang="en" data-archive>'));
files['index.html'] = Buffer.from(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Play APEX GT3</title>
<script>if(location.protocol!=='file:')location.replace('./studio.html'+location.search+location.hash)</script>
<style>html{color-scheme:dark;background:#10181a}main{max-width:38rem;margin:12vh auto;padding:1.5rem;font:1.15rem/1.55 system-ui}b{color:#ff855d}code{white-space:nowrap}</style>
<main><b>APEX MOTORSPORT / GARAGE</b><h1>Start the 3D game</h1><p>Extract the entire ZIP. In that folder, run <code>python3 play.py</code> (Windows: <code>py play.py</code>). Leave the terminal open while racing.</p><p>The launcher uses Python 3 to open the game in your browser. No internet connection is needed. Browsers cannot start the 3D engine directly from a local HTML file.</p></main></html>`);
await mkdir(join(dir, 'downloads'), { recursive: true });
// Bookmarks of the retired edition go to the same 3D game, not a stale build.
await writeFile(join(dir, 'downloads/apex-gt3-lite.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=../"><title>APEX GT3</title><a href="../">Play APEX GT3 in 3D</a>');
const archive = zipSync(files, { level: 4, mtime: new Date(2000, 0, 1) });
await writeFile(join(dir, 'downloads/apex-gt3.zip'), archive);
console.log(`Full 3D release: ${Object.keys(files).length} files, ${(archive.length / 1048576).toFixed(2)} MiB`);
