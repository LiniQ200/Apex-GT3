// Run from the project root after fetch-assets.mjs. CPU only; no browser, native
// tools, network or GPU. The .env files are ordinary Babylon 9 RGBD environments.
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { RGBE_ReadHeader, RGBE_ReadPixels } from '@babylonjs/core/Misc/HighDynamicRange/hdr.js';
import { CubeMapToSphericalPolynomialTools } from '@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial.js';

const SIZE = 256,
  LAST = Math.log2(SIZE),
  TAU = 2 * Math.PI;
// Babylon samples lod = log2(faceWidth * alphaG) * scale, alphaG ≈ roughness².
// Roughness 1 lands exactly on a 4px face; keep the complete chain down to 1px.
const LOD_SCALE = (LAST - 2) / LAST;
const faces = ['right', 'left', 'up', 'down', 'front', 'back'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Babylon CubeMapToSphericalPolynomialTools._FileFaces, +X,-X,+Y,-Y,+Z,-Z.
// Before .env's vertical image flip, v increases from the first raw GPU row.
function direction(face, x, y, size) {
  const u = (2 * x) / size - 1,
    v = (2 * y) / size - 1,
    k = 1 / Math.sqrt(1 + u * u + v * v);
  switch (face) {
    case 0:
      return [k, -v * k, -u * k];
    case 1:
      return [-k, -v * k, u * k];
    case 2:
      return [u * k, k, v * k];
    case 3:
      return [u * k, -k, -v * k];
    case 4:
      return [u * k, -v * k, k];
    case 5:
      return [-u * k, -v * k, -k];
  }
}

function panorama(bytes, mode) {
  const wet = mode === 'overcast_race' || mode === 'heavy_rain';
  const storm = mode === 'heavy_rain';
  const clear = mode === 'clear_midday';
  const header = RGBE_ReadHeader(bytes),
    { width, height } = header;
  const data = RGBE_ReadPixels(bytes, header);
  let peak = 0,
    cloudPeak = 0;
  for (let i = 0; i < data.length; i += 3) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    peak = Math.max(peak, l);
    // Diffuse overcast/storm plates' solar disc through cloud in scene-linear
    // light, and softly roll off extreme 100k+ midday sun pixels so 8-bit RGBD
    // preserves crisp blue sky gradients without crushing sky luminance.
    const t = wet && l > (storm ? 1.4 : 2)
      ? ((storm ? 1.4 : 2) + 0.42 * Math.log1p(l - (storm ? 1.4 : 2))) / l
      : clear && l > 24
        ? (24 + 4.5 * Math.log1p(l - 24)) / l
        : 1;
    const stormScale = storm ? 0.56 : 1;
    for (let c = 0; c < 3; c++) {
      if (wet) {
        const tint = storm ? (c === 2 ? 1.12 : c === 0 ? 0.88 : 0.96) : 1;
        data[i + c] = t * stormScale * tint * (0.25 * data[i + c] + 0.75 * l);
      } else if (t !== 1) {
        data[i + c] *= t;
      }
      cloudPeak = Math.max(cloudPeak, data[i + c]);
    }
  }
  if (!Number.isFinite(cloudPeak) || !cloudPeak) throw Error('Empty or non-finite HDR panorama');
  // RGBD tops out at 255. Preserve absolute light even for a hotter replacement
  // HDR: store one exposure for the *whole* cube + SH and restore it on both views.
  const radianceScale = Math.max(1, cloudPeak / 250);
  if (radianceScale !== 1) for (let i = 0; i < data.length; i++) data[i] /= radianceScale;

  const levels = [{ width, height, data }];
  // Source footprint pyramid, NOT the output roughness mips. The area of each
  // latitude band is proportional to sin(colatitude at its centre).
  while (levels.at(-1).height % 2 === 0 && levels.at(-1).width % 2 === 0) {
    const s = levels.at(-1),
      w = s.width / 2,
      h = s.height / 2,
      d = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      const a = Math.sin((Math.PI * (2 * y + 0.5)) / s.height),
        b = Math.sin((Math.PI * (2 * y + 1.5)) / s.height);
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          const i = (2 * y * s.width + 2 * x) * 3 + c,
            j = i + s.width * 3;
          d[(y * w + x) * 3 + c] =
            ((s.data[i] + s.data[i + 3]) * a + (s.data[j] + s.data[j + 3]) * b) / (2 * (a + b));
        }
    }
    levels.push({ width: w, height: h, data: d });
  }
  const latitudeLod = Float32Array.from(
    { length: height },
    (_, y) => -0.5 * Math.log2(Math.sin((Math.PI * (y + 0.5)) / height)),
  );

  // World +Z is panorama longitude zero, +X is east, +Y is the top scanline.
  // This is the orientation of Babylon's HDRCubeTexture, not a glTF yaw guess.
  function sample(x, y, z, equatorLod, weight, sum) {
    const u = 0.5 + Math.atan2(x, z) / TAU,
      v = Math.acos(Math.max(-1, Math.min(1, y))) / Math.PI;
    const lod = Math.max(
      0,
      Math.min(levels.length - 1, equatorLod + latitudeLod[Math.min(height - 1, Math.floor(v * height))]),
    );
    const low = Math.floor(lod),
      frac = lod - low;
    for (let m = low; m <= Math.ceil(lod); m++) {
      const { width: w, height: h, data: d } = levels[m];
      const sx = u * w - 0.5,
        sy = Math.max(0, Math.min(h - 1, v * h - 0.5));
      const ix = Math.floor(sx),
        iy = Math.floor(sy),
        fx = sx - ix,
        fy = sy - iy;
      const x0 = (ix + w) % w,
        x1 = (x0 + 1) % w,
        bottom = Math.min(h - 1, iy + 1) * w;
      const a = (iy * w + x0) * 3,
        b = (iy * w + x1) * 3,
        c = (bottom + x0) * 3,
        e = (bottom + x1) * 3;
      const scale = weight * (m === low ? 1 - frac : frac);
      for (let k = 0; k < 3; k++)
        sum[k] +=
          scale *
          ((d[a + k] * (1 - fx) + d[b + k] * fx) * (1 - fy) + (d[c + k] * (1 - fx) + d[e + k] * fx) * fy);
    }
  }
  return {
    sample,
    texelArea: (TAU * Math.PI) / (width * height),
    radianceScale,
    sourcePeakLuma: peak,
    treatedPeakChannel: cloudPeak,
  };
}

// Deterministic split-sum GGX importance sampling (V=N). The PDF is D(H)/4;
// each sample uses the solid angle it represents to choose a filtered source
// footprint. See Babylon 9 hdrFilteringFunctions.fx::radiance, K=4 for boxes.
function ggxSamples(lod, texelArea) {
  const alpha = Math.min(1, 2 ** (lod / LOD_SCALE) / SIZE),
    a2 = alpha * alpha;
  const count = lod <= 2 ? 256 : 1024,
    samples = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    let xi = 0;
    for (let j = i, f = 0.5; j > 0; j >>>= 1, f *= 0.5) xi += (j & 1) * f;
    const h2 = (1 - xi) / (1 + (a2 - 1) * xi),
      nz = 2 * h2 - 1;
    if (nz <= 0) continue;
    const phi = (TAU * i) / count,
      r = Math.sqrt(1 - nz * nz);
    const pdf = a2 / (4 * Math.PI * ((a2 - 1) * h2 + 1) ** 2);
    samples.push({
      x: r * Math.cos(phi),
      y: r * Math.sin(phi),
      z: nz,
      weight: nz,
      equatorLod: 0.5 * Math.log2(4 / (count * pdf * texelArea)),
    });
    total += nz;
  }
  for (const s of samples) s.weight /= total;
  return samples;
}

function facePixels(source, face, size, samples) {
  const rgb = new Float32Array(size * size * 3),
    sum = [0, 0, 0];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      sum.fill(0);
      if (!samples) {
        // Integrate the mirror/sky texel from the original HDR, not a blurred mip.
        for (const sy of [0.25, 0.75])
          for (const sx of [0.25, 0.75]) {
            const n = direction(face, x + sx, y + sy, size);
            source.sample(n[0], n[1], n[2], -Infinity, 0.25, sum);
          }
      } else {
        const [nx, ny, nz] = direction(face, x + 0.5, y + 0.5, size);
        const [ax, ay, az] = Math.abs(nz) < 0.999 ? [-ny, nx, 0] : [0, -nz, ny];
        const k = 1 / Math.hypot(ax, ay, az),
          tx = ax * k,
          ty = ay * k,
          tz = az * k;
        const bx = ny * tz - nz * ty,
          by = nz * tx - nx * tz,
          bz = nx * ty - ny * tx;
        for (const s of samples)
          source.sample(
            tx * s.x + bx * s.y + nx * s.z,
            ty * s.x + by * s.y + ny * s.z,
            tz * s.x + bz * s.y + nz * s.z,
            s.equatorLod,
            s.weight,
            sum,
          );
      }
      rgb.set(sum, (y * size + x) * 3);
    }
  return rgb;
}

function chunk(type, data) {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

// Lossless RGBA PNG, no color profile or premultiplication. Babylon's toRGBD
// stores pow(linear * divisor, 1/2.2) + a NONZERO integer divisor in alpha.
function rgbdPng(rgb, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = 1 + size * 4,
    data = Buffer.alloc(stride * size),
    last = [0, 0, 0, 0];
  for (let y = 0; y < size; y++) {
    data[y * stride] = 1; // PNG Sub filter
    last.fill(0);
    for (let x = 0; x < size; x++) {
      const i = ((size - 1 - y) * size + x) * 3; // .env images are Y-flipped on upload
      const divisor = Math.min(255, Math.max(1, Math.floor(255 / Math.max(rgb[i], rgb[i + 1], rgb[i + 2]))));
      for (let c = 0; c < 4; c++) {
        const byte =
          c === 3 ? divisor : Math.round(255 * Math.min(1, ((rgb[i + c] * divisor) / 255) ** (1 / 2.2)));
        data[y * stride + 1 + 4 * x + c] = byte - last[c];
        last[c] = byte;
      }
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(data, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function bake(input, mode) {
  const wet = mode === 'overcast_race' || mode === 'heavy_rain';
  const source = panorama(input, mode),
    cube = {
      size: SIZE,
      format: Constants.TEXTUREFORMAT_RGB,
      type: Constants.TEXTURETYPE_FLOAT,
      gammaSpace: false,
    };
  const images = [],
    mipmaps = [],
    peakLumaByMip = [];
  let position = 0,
    solarLuma = -1,
    sun;
  for (let lod = 0; lod <= LAST; lod++) {
    const size = SIZE >> lod,
      samples = lod ? ggxSamples(lod, source.texelArea) : null;
    let peak = 0;
    for (let face = 0; face < 6; face++) {
      const rgb = facePixels(source, face, size, samples);
      if (!lod) cube[faces[face]] = rgb;
      for (let i = 0; i < rgb.length; i += 3) {
        const l = (0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]) * source.radianceScale;
        peak = Math.max(peak, l);
        if (!lod && l > solarLuma) {
          const p = i / 3,
            n = direction(face, (p % size) + 0.5, Math.floor(p / size) + 0.5, size);
          if (n[1] > 0) {
            solarLuma = l;
            sun = n;
          }
        }
      }
      if (!Number.isFinite(peak)) throw Error(`Non-finite lighting at mip ${lod}`);
      const png = rgbdPng(rgb, size);
      images.push(png);
      mipmaps.push({ length: png.length, position });
      position += png.length;
    }
    peakLumaByMip.push(peak);
  }
  // A diffuse-only offline overcast has no solar disc to locate.
  if (wet && solarLuma < 2) sun = [0.37825, 0.73917, 0.55727];
  const sp = CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial(cube);
  const irradiance = Object.fromEntries(
    ['x', 'y', 'z', 'xx', 'yy', 'zz', 'yz', 'zx', 'xy'].map((k) => [k, sp[k].asArray()]),
  );
  const info = {
    version: 2,
    width: SIZE,
    imageType: 'image/png',
    irradiance,
    specular: { lodGenerationScale: LOD_SCALE, mipmaps },
    gt3: { sun, radianceScale: source.radianceScale },
  };
  const bytes = Buffer.concat([
    Buffer.from('86168796f6d69636', 'hex'),
    Buffer.from(JSON.stringify(info) + '\0'),
    ...images,
  ]);
  return {
    bytes,
    peakLumaByMip,
    sourcePeakLuma: source.sourcePeakLuma,
    treatedPeakChannel: source.treatedPeakChannel,
  };
}

const root = 'public/assets/',
  index = root + 'skies/baked.json';
const manifest = JSON.parse(await readFile(root + 'manifest.json', 'utf8')).assets;
const version = JSON.parse(
  await readFile(new URL(import.meta.resolve('@babylonjs/core/package.json')), 'utf8'),
).version;
const recipe = sha(
  Buffer.concat([await readFile(new URL(import.meta.url)), Buffer.from(`${version}:${process.versions.zlib}`)]),
);
async function optional(path, encoding) {
  try {
    return await readFile(path, encoding);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return null;
  }
}
async function replace(path, data) {
  const tmp = `${path}.${process.pid}.part`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
const previous = await optional(index, 'utf8');
let old;
try {
  old = JSON.parse(previous);
} catch {
  /* Interrupted/corrupt cache: rebuild from the verified originals. */
}
const assets = {};
for (const name of ['clear_midday', 'golden_hour', 'overcast_race', 'heavy_rain']) {
  const src = `skies/${name}.hdr`,
    dst = `skies/${name}.env`,
    input = await readFile(root + src),
    source = manifest[src];
  if (!source || sha(input) !== source.sha256 || input.length !== source.bytes)
    throw Error(`Unverified ${src}; run fetch-assets first`);
  const prior = old?.assets?.[dst];
  if (old?.recipe === recipe && prior?.sourceSha256 === source.sha256) {
    const file = await optional(root + dst);
    if (file && file.length === prior.bytes && sha(file) === prior.sha256) {
      assets[dst] = { ...prior, provenance: source.source };
      console.log(`Verified ${dst} (${file.length} bytes)`);
      continue;
    }
  }
  const { bytes, ...stats } = bake(input, name);
  await replace(root + dst, bytes);
  assets[dst] = {
    bytes: bytes.length,
    sha256: sha(bytes),
    source: src,
    sourceSha256: source.sha256,
    provenance: source.source,
    ...stats,
  };
  console.log(`Baked ${src} (${input.length} bytes) → ${dst} (${bytes.length} bytes)`);
}
const next = JSON.stringify({ recipe, assets }, null, 2) + '\n';
if (next !== previous) await replace(index, next);
