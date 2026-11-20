import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';

// jpeg-js (already used by offline preparation) writes full-resolution 4:4:4
// chroma. In particular, don't run the normal or packed data maps through a
// photo encoder that blurs the two tangent axes / AO and roughness together.
const linear = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});
const srgb = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function reduce({ data, width, height }, side, kind, out) {
  for (let y = 0; y < side; y++) {
    const top = Math.floor(y * height / side), bottom = Math.max(top + 1, Math.floor((y + 1) * height / side));
    for (let x = 0; x < side; x++) {
      const left = Math.floor(x * width / side), right = Math.max(left + 1, Math.floor((x + 1) * width / side));
      const dst = 4 * (y * side + x), n = (right - left) * (bottom - top);
      let r = 0, g = 0, b = 0;
      for (let row = top; row < bottom; row++) {
        let i = 3 * (row * width + left);
        for (let col = left; col < right; col++, i += 3) {
          if (kind === 'diff') {
            r += linear[data[i]]; g += linear[data[i + 1]]; b += linear[data[i + 2]];
          } else {
            r += data[i];
            if (kind === 'nor_gl') { g += data[i + 1]; b += data[i + 2]; }
          }
        }
      }
      if (kind === 'diff') {
        out[dst] = srgb(r / n); out[dst + 1] = srgb(g / n); out[dst + 2] = srgb(b / n);
      } else if (kind === 'nor_gl') {
        r -= 127.5 * n; g -= 127.5 * n; b -= 127.5 * n;
        const scale = 127.5 / (Math.hypot(r, g, b) || 1);
        out[dst] = 127.5 + r * scale; out[dst + 1] = 127.5 + g * scale; out[dst + 2] = 127.5 + b * scale;
      } else {
        out[dst + (kind === 'rough' ? 1 : 0)] = r / n;
      }
      out[dst + 3] = 255;
    }
  }
}

// asphalt_02 has a black fissure that runs the entire height of the scan.
// Repeating it every 3.5 m makes the circuit look like parallel tram tracks.
// Where a centimetre-scale neighbourhood is notably darker than a clean
// donor, borrow intact scanned aggregate (the same UV offset in all maps).
// Long repairs and tyre marks then live on the nonrepeating lap mask instead.
function asphaltDressing(diffuse) {
  const n = 128, dx = 49, dy = 37, thumb = new Uint8ClampedArray(n * n * 4);
  reduce(diffuse, n, 'diff', thumb);
  const at = (x, y) => (y & (n - 1)) * n + (x & (n - 1));
  const lum = i => (thumb[4 * i] + 2 * thumb[4 * i + 1] + thumb[4 * i + 2]) / 4;
  const mask = Float32Array.from({ length: n * n }, (_, i) =>
    Math.max(0, Math.min(1, (lum(at(i % n + dx, Math.floor(i / n) + dy)) - lum(i) - 3) / 11)));
  return (pixels, side, normal) => {
    const src = pixels.slice(), ox = Math.round(dx * side / n), oy = Math.round(dy * side / n);
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const u = (x + 0.5) * n / side - 0.5, v = (y + 0.5) * n / side - 0.5;
      const a = Math.floor(u), b = Math.floor(v), fx = u - a, fy = v - b;
      const t = (1 - fy) * ((1 - fx) * mask[at(a, b)] + fx * mask[at(a + 1, b)]) +
        fy * ((1 - fx) * mask[at(a, b + 1)] + fx * mask[at(a + 1, b + 1)]);
      if (t <= 0) continue;
      const i = 4 * (y * side + x), j = 4 * (((y + oy) % side) * side + (x + ox) % side);
      for (let k = 0; k < 3; k++) pixels[i + k] = src[i + k] + t * (src[j + k] - src[i + k]);
      if (normal) {
        const r = pixels[i] - 127.5, g = pixels[i + 1] - 127.5, b = pixels[i + 2] - 127.5;
        const f = 127.5 / (Math.hypot(r, g, b) || 1);
        pixels[i] = 127.5 + r * f; pixels[i + 1] = 127.5 + g * f; pixels[i + 2] = 127.5 + b * f;
      }
    }
  };
}

export async function prepareTrackMaps({ root, assets, previous, cached, save }) {
  for (const [set, detail] of [['asphalt', 1024], ['terrain', 1024], ['concrete', 512], ['kerb', 512]]) {
    let dress;
    const decode = async part => jpeg.decode(await readFile(`${root}${set}/${part}.jpg`), { useTArray: true, formatAsRGBA: false });
    for (const [name, parts, limit, quality] of [
      ['albedo', ['diff'], detail, 84],
      ['normal', ['nor_gl'], detail, 89],
      ['orm', ['ao', 'rough'], detail / 2, 91],
    ]) {
      const path = `${set}/${name}.jpg`, recipe = `track-444-v2/${limit}/q${quality}`;
      const sources = set === 'asphalt' && !parts.includes('diff') ? [...parts, 'diff'] : parts;
      const inputs = sources.map(part => {
        const path = `${set}/${part}.jpg`, { source, sha256 } = assets[path];
        assets[path].sourceOnly = true;
        return { path, source, sha256 };
      });
      const old = previous[path];
      if (old?.recipe === recipe && JSON.stringify(old.inputs) === JSON.stringify(inputs) && await cached(path)) continue;

      // One set at a time keeps offline builds bounded. A partial upstream
      // failure can pair a 256px substitute with a genuine 2K channel.
      const images = [];
      for (const part of parts) images.push(await decode(part));
      const side = Math.min(limit, Math.max(...images.map(im => Math.max(im.width, im.height))));
      const pixels = new Uint8ClampedArray(side * side * 4); // ORM blue = zero (dielectric)
      for (let i = 0; i < parts.length; i++) reduce(images[i], side, parts[i], pixels);
      if (set === 'asphalt') {
        dress ??= asphaltDressing(parts[0] === 'diff' ? images[0] : await decode('diff'));
        dress(pixels, side, name === 'normal');
      }
      const result = jpeg.encode({ width: side, height: side, data: pixels }, quality);
      await save(path, result.data, `scripts/track-maps.mjs (${name === 'orm' ? 'R=occlusion, G=roughness, B=metallic' : name})`);
      Object.assign(assets[path], { recipe, inputs });
    }
  }
}
