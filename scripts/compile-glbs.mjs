#!/usr/bin/env node
/**
 * Compile and optimize Blender CAD/botanical kits and downloaded Poly Haven
 * photogrammetry biome GLTFs into clean, compact, runtime-ready GLBs using
 * @gltf-transform + sharp + gltfpack (vertex welding, dedup, prune, cache opt).
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { dedup, flatten, join as joinMeshes, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const ua = { 'User-Agent': 'AmpGT3Sim/1.0' };
const io = new NodeIO();

async function optimizeKit(rawPath, outPath) {
  const doc = await io.read(rawPath);
  await doc.transform(dedup(), weld({ tolerance: 1e-4 }), prune({ keepAttributes: true }));
  // Verify every single mesh retains TEXCOORD_0 so foliage/architecture never lose UVs!
  for (const m of doc.getRoot().listMeshes()) {
    for (const p of m.listPrimitives()) {
      if (!p.getAttribute('TEXCOORD_0')) throw Error(`${rawPath} mesh ${m.getName()} missing TEXCOORD_0`);
    }
  }
  await io.write(outPath, doc);
  const s = await stat(outPath);
  console.log(`Compiled ${outPath} (${(s.size / 1024).toFixed(1)} KiB) [UV + AO verified]`);
}

async function fetchAndCompilePolyhavenModel(id, outPath, { maxTex = 512, ratio = 0.32 } = {}) {
  const work = resolve('.amp/in/orb-backup/ph-biome', id);
  await mkdir(work, { recursive: true });
  const meta = await (await fetch(`https://api.polyhaven.com/files/${id}`, { headers: ua })).json();
  const gltfEntry = meta?.gltf?.['1k']?.gltf ?? meta?.gltf?.['2k']?.gltf;
  if (!gltfEntry?.url) throw Error(`No 1k gltf for Poly Haven model ${id}`);

  const gltfLocal = join(work, `${id}.gltf`);
  const downloadIfNeeded = async (url, dest) => {
    try {
      const s = await stat(dest);
      if (s.size > 0) return;
    } catch {}
    await mkdir(dirname(dest), { recursive: true });
    const r = await fetch(url, { headers: ua, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw Error(`HTTP ${r.status} for ${url}`);
    await writeFile(dest, Buffer.from(await r.arrayBuffer()));
  };

  await downloadIfNeeded(gltfEntry.url, gltfLocal);
  for (const [rel, info] of Object.entries(gltfEntry.include ?? {})) {
    await downloadIfNeeded(info.url, join(work, rel));
  }

  const doc = await io.read(gltfLocal);
  await MeshoptSimplifier.ready;

  // Compress embedded textures cleanly with sharp to compact JPEG/PNG (preserve alpha if present)
  for (const tex of doc.getRoot().listTextures()) {
    const img = tex.getImage();
    if (!img) continue;
    const metaImg = await sharp(img).metadata();
    const hasAlpha = Boolean(metaImg.hasAlpha) && (metaImg.channels ?? 3) >= 4;
    const w = Math.min(maxTex, metaImg.width || maxTex);
    const h = Math.min(maxTex, metaImg.height || maxTex);
    let outBuf, mime;
    if (hasAlpha) {
      // Check if alpha channel is actually non-opaque
      const raw = await sharp(img).resize(w, h, { fit: 'inside' }).ensureAlpha().raw().toBuffer();
      let transparent = false;
      for (let i = 3; i < raw.length; i += 4) if (raw[i] < 250) { transparent = true; break; }
      if (transparent) {
        outBuf = await sharp(img).resize(w, h, { fit: 'inside' }).png({ compressionLevel: 9, palette: false }).toBuffer();
        mime = 'image/png';
      } else {
        outBuf = await sharp(img).resize(w, h, { fit: 'inside' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
        mime = 'image/jpeg';
      }
    } else {
      outBuf = await sharp(img).resize(w, h, { fit: 'inside' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
      mime = 'image/jpeg';
    }
    tex.setImage(new Uint8Array(outBuf));
    tex.setMimeType(mime);
  }

  await doc.transform(
    dedup(),
    weld({ tolerance: 1e-4 }),
    simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.015 }),
    prune(),
  );
  await mkdir(dirname(outPath), { recursive: true });
  await io.write(outPath, doc);
  const s = await stat(outPath);
  console.log(`Compiled Poly Haven photogrammetry ${id} -> ${outPath} (${(s.size / 1024).toFixed(1)} KiB)`);
}

await optimizeKit('assets/kit/botanical.raw.glb', 'assets/kit/botanical.glb');
await optimizeKit('assets/kit/trackside.raw.glb', 'assets/kit/trackside.glb');
await rm('assets/kit/botanical.raw.glb', { force: true });
await rm('assets/kit/trackside.raw.glb', { force: true });

if (!process.argv.includes('--kit-only')) {
  for (const [id, name, opts] of [
    ['rock_moss_set_01', 'rock_moss', { maxTex: 512, ratio: 0.08 }],
    ['fern_02', 'fern', { maxTex: 512, ratio: 0.18 }],
    ['shrub_sorrel_01', 'shrub', { maxTex: 512, ratio: 0.35 }],
    ['grass_medium_01', 'grass_clump', { maxTex: 512, ratio: 0.14 }],
  ]) {
    await fetchAndCompilePolyhavenModel(id, `assets/biome/${name}.glb`, opts);
  }
}
