import type { Scene } from '@babylonjs/core/scene';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { Circuit, Weather } from '../types';
import { groove } from './circuit';
import { TrackSurfaceGrid, weatherBaseWetness } from './surfaceState';
import { PorousSurfacePlugin } from './trackShader';
import { TerrainTriplanarPlugin } from './terrainShader';

export function randomSource(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
export function plain(scene: Scene, name: string, roughness = 0.8, metallic = 0) {
  const m = new PBRMaterial('venue.' + name, scene);
  m.roughness = roughness;
  m.metallic = metallic;
  return m;
}
function surfaceData(m: PBRMaterial, orm: PBRMaterial['metallicTexture']) {
  m.metallicTexture = orm;
  m.useAmbientOcclusionFromMetallicTextureRed = true;
  m.useRoughnessFromMetallicTextureAlpha = false;
  m.useRoughnessFromMetallicTextureGreen = true;
  m.useMetallnessFromMetallicTextureBlue = true;
  m.ambientTextureStrength = 0.6;
}
function mapped(scene: Scene, name: string) {
  const m = plain(scene, name),
    map = (part: 'albedo' | 'normal' | 'orm') => {
      const color = part === 'albedo';
      const t = new Texture(`${import.meta.env.BASE_URL}assets/${name}/${part}.jpg`, scene, {
        noMipmap: false,
        samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
        gammaSpace: color,
        useSRGBBuffer: color,
      });
      // Pin-sharp 16x anisotropic filtering on road/kerb/concrete albedo & normals; 8x on secondary ORM/metal
      t.anisotropicFilteringLevel = color || name === 'asphalt' || name === 'kerb' || name === 'concrete' ? 16 : 8;
      return t;
    };
  m.albedoTexture = map('albedo');
  m.bumpTexture = map('normal');
  m.bumpTexture.level = 0.62;
  surfaceData(m, map('orm'));
  m.roughness = 1;
  return m;
}

function lapSurface(scene: Scene, c: Circuit) {
  // Static high-frequency tyre marks, braking skids, and resurfacing bands on UV2.
  const engine = scene.getEngine(),
    w = 192,
    h = Math.min(4096, engine.getCaps().maxTextureSize);
  const ctx = engine.createCanvas(w, h).getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D,
    rand = randomSource(41);
  const stationX = (s: number, offset: number) => {
    const p = c.at(s);
    return (0.5 + (groove(p) + offset) / (2 * p.halfWidth)) * w;
  };
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  const grad = ctx.createLinearGradient(-1, 0, 1, 0);
  for (const [u, v] of [
    [0, 255],
    [0.15, 237],
    [0.32, 204],
    [0.39, 185],
    [0.47, 201],
    [0.58, 192],
    [0.67, 180],
    [0.82, 225],
    [1, 255],
  ])
    grad.addColorStop(u, `rgb(${v},${v},${v})`);
  ctx.fillStyle = grad;
  for (let y = 0; y < h; y += 3) {
    const p = c.at((y / h) * c.length),
      x = (0.5 + groove(p) / (2 * p.halfWidth)) * w,
      r = (w / p.halfWidth) * (1.44 + 0.16 * Math.min(1, 50 * Math.abs(p.kappa)));
    ctx.setTransform(r, 0, 0, 1, x, 0);
    ctx.fillRect(-1, y, 2, 3);
  }
  ctx.resetTransform();
  const paving = randomSource(513);
  for (const side of [-1, 1])
    for (let y = 0; y < h; ) {
      const run = 35 + paving() * 170,
        band = (0.17 + 0.13 * paving()) * w;
      ctx.fillStyle = `rgba(79,79,79,${0.025 + 0.045 * paving()})`;
      ctx.fillRect(side < 0 ? 0 : w - band, y, band, run);
      const metres = ((y + 0.5) / h) * c.length,
        across = w / (2 * c.at(metres).halfWidth);
      const edge = (side < 0 ? band : w - band) / across;
      ctx.save();
      ctx.scale(across, h / c.length);
      ctx.strokeStyle = 'rgba(42,40,38,.41)';
      ctx.lineWidth = 0.035 + 0.035 * paving();
      ctx.beginPath();
      ctx.moveTo(edge, metres);
      for (let s = 2; s < (run * 0.56 * c.length) / h; s += 2)
        ctx.lineTo(edge + 0.05 * Math.sin(s * 0.34) + 0.06 * paving(), metres + s);
      ctx.stroke();
      ctx.restore();
      y += run + 6 + paving() * 64;
    }
  for (const apex of [697, 1695, 2490, 2840]) {
    const across = w / (2 * c.at(apex).halfWidth);
    ctx.save();
    ctx.scale(across, h / c.length);
    for (let pass = 0; pass < 30; pass++) {
      const s0 = apex - 155 + rand() * 119,
        dist = 15 + rand() * 55,
        off = (rand() - 0.5) * 3.2,
        sway = (rand() - 0.5) * 0.83;
      for (const tire of [-0.81, 0.81]) {
        ctx.strokeStyle = `rgba(106,107,107,${0.12 + rand() * 0.2})`;
        ctx.lineWidth = 0.12 + rand() * 0.15;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let j = 0; j <= 12; j++) {
          const u = j / 12,
            s = s0 + u * dist,
            x = stationX(s, off + tire + sway * u * u) / across;
          if (j) ctx.lineTo(x, s);
          else ctx.moveTo(x, s);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  for (let i = 0; i < 10; i++) {
    const p = c.at(i * 6),
      across = w / (2 * p.halfWidth),
      along = h / c.length;
    const start = Math.max(0, p.s - 1.35),
      length = 4.5 + rand() * 5,
      drift = (rand() - 0.5) * 0.17;
    ctx.save();
    ctx.scale(across, along);
    for (const tire of [-0.78, 0.78]) {
      const x = p.halfWidth + (i % 2 ? 2.8 : -2.8) + tire,
        end = start + length + rand();
      const fade = ctx.createLinearGradient(0, start, 0, end);
      fade.addColorStop(0, 'rgba(72,72,72,0)');
      fade.addColorStop(0.2, 'rgba(72,72,72,.28)');
      fade.addColorStop(0.55, 'rgba(72,72,72,.20)');
      fade.addColorStop(1, 'rgba(72,72,72,0)');
      ctx.strokeStyle = fade;
      ctx.lineWidth = 0.23;
      ctx.beginPath();
      ctx.moveTo(x, start);
      ctx.quadraticCurveTo(x, start + length * 0.45, x + drift, end);
      ctx.stroke();
    }
    ctx.restore();
  }
  const { data } = ctx.getImageData(0, 0, w, h);
  const dye = Float32Array.from({ length: 256 }, (_, value) => 127.5 * Math.sqrt(value / 255));
  for (let i = 0; i < data.length; i += 4) {
    data[i] = dye[data[i]];
    data[i + 1] = data[i + 3] = 128;
    data[i + 2] = 128;
  }
  const t = RawTexture.CreateRGBATexture(data, w, h, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  t.name = 'lap rubber wear — UV2';
  t.coordinatesIndex = 1;
  t.gammaSpace = false;
  t.wrapU = Texture.CLAMP_ADDRESSMODE;
  t.wrapV = Texture.WRAP_ADDRESSMODE;
  t.anisotropicFilteringLevel = 16;
  return t;
}

export function roadMaterials(scene: Scene, c: Circuit, surfaceGrid?: TrackSurfaceGrid) {
  const road = mapped(scene, 'asphalt'),
    grass = mapped(scene, 'terrain'),
    kerb = mapped(scene, 'kerb'),
    concrete = mapped(scene, 'concrete'),
    gravel = mapped(scene, 'gravel'),
    metal = mapped(scene, 'metal');

  // Dynamic Track-State GPU Data Texture (16 lanes x 256 sectors RGBA)
  const grid = surfaceGrid ?? new TrackSurfaceGrid(c);
  grid.syncBytes();
  const stateTex = RawTexture.CreateRGBATexture(
    grid.rgba,
    grid.width,
    grid.height,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  stateTex.name = 'dynamic track state grid';
  stateTex.gammaSpace = false;
  stateTex.wrapU = Texture.CLAMP_ADDRESSMODE;
  stateTex.wrapV = Texture.WRAP_ADDRESSMODE;

  road.detailMap.texture = lapSurface(scene, c);
  road.detailMap.bumpLevel = 0;
  road.detailMap.roughnessBlendLevel = 0;
  road.detailMap.diffuseBlendLevel = 0.85;
  road.detailMap.isEnabled = true;

  // Cross-backend WGSL + GLSL Hex-Grid Stochastic Anti-Tiling + raindrop ripples on hero asphalt;
  // multi-biome limestone-slope & cloud-shadow shader on Tuscan grass & hills;
  // porous wetness darkening on gravel/concrete.
  const roadPlugin = new PorousSurfacePlugin(road, { isRoad: true, hexBomb: true, trackStateTexture: stateTex });
  const terrainPlugin = new TerrainTriplanarPlugin(grass);
  const gravelPlugin = new PorousSurfacePlugin(gravel, { isRoad: false, hexBomb: false });
  const concretePlugin = new PorousSurfacePlugin(concrete, { isRoad: false, hexBomb: false });
  const hillPlugins: TerrainTriplanarPlugin[] = [terrainPlugin];

  kerb.albedoTexture!.level = 1.16;
  grass.albedoColor = new Color3(0.62, 0.92, 0.64);
  grass.bumpTexture!.level = 0.62;
  gravel.albedoColor = new Color3(0.95, 0.87, 0.74);
  gravel.bumpTexture!.level = 0.76;

  const paint = plain(scene, 'track enamel', 0.68);
  const wall = metal;
  wall.albedoColor = new Color3(0.88, 0.90, 0.91);
  wall.metallic = 0.58;
  wall.roughness = 0.52;
  wall.bumpTexture!.level = 0.28;

  let shaderClock = 0;
  const setWeather = (w: Weather) => {
    const wet = w === 'damp' || w === 'rain';
    const rain = w === 'rain';
    const ambWet = weatherBaseWetness[w];
    const cloudStr = w === 'clear' ? 0.24 : w === 'golden' ? 0.44 : w === 'dusk' ? 0.52 : w === 'damp' ? 0.56 : 0.34;
    roadPlugin.ambientWetness = ambWet;
    roadPlugin.cloudShadowStrength = cloudStr;
    gravelPlugin.ambientWetness = ambWet * 0.85;
    gravelPlugin.cloudShadowStrength = cloudStr;
    concretePlugin.ambientWetness = ambWet * 0.9;
    concretePlugin.cloudShadowStrength = cloudStr;
    for (const hp of hillPlugins) {
      hp.wetness = ambWet * 0.8;
      hp.cloudShadowStrength = cloudStr;
    }

    // Preserve sun-weathered mineral stone albedo; PorousSurfacePlugin drives Beer-Lambert darkening & wet Fresnel reflections
    road.albedoColor.setAll(wet ? 1.04 : 1.24);
    road.indexOfRefraction = 1.5;
    road.roughness = 1;
    road.bumpTexture!.level = rain ? 0.44 : wet ? 0.60 : 0.92;
    kerb.roughness = rain ? 0.18 : wet ? 0.34 : 0.86;
    paint.roughness = rain ? 0.16 : wet ? 0.32 : 0.70;
    if (grid.syncBytes()) stateTex.update(grid.rgba);
  };

  let uploadCooldown = 0;
  const syncSurface = (dt: number) => {
    const clamped = Math.max(0, Math.min(0.1, dt));
    shaderClock += clamped;
    roadPlugin.time = shaderClock;
    gravelPlugin.time = shaderClock;
    concretePlugin.time = shaderClock;
    for (const hp of hillPlugins) hp.time = shaderClock;

    uploadCooldown -= clamped;
    if (uploadCooldown <= 0) {
      uploadCooldown = 0.22; // ~4.5 Hz live GPU update for drying groove & rubbering-in
      if (grid.syncBytes()) stateTex.update(grid.rgba);
    }
  };

  setWeather('golden');
  return {
    road,
    grass,
    kerb,
    concrete,
    gravel,
    paint,
    wall,
    setWeather,
    syncSurface,
    grid,
    attachTerrainShader(mat: PBRMaterial) {
      const p = new TerrainTriplanarPlugin(mat);
      p.wetness = terrainPlugin.wetness;
      p.cloudShadowStrength = terrainPlugin.cloudShadowStrength;
      p.time = shaderClock;
      hillPlugins.push(p);
      return p;
    },
  };
}

// One mipmapped print sheet: all billboards, suites, distance boards and garage
// numbers can be drawn as a single opaque batch without a material per inscription.
export function signage(scene: Scene) {
  const w = 2048,
    h = 2048,
    t = new DynamicTexture(
      'Autodromo signwriter master',
      { width: w, height: h },
      scene,
      true,
      Texture.TRILINEAR_SAMPLINGMODE,
    );
  const ctx = t.getContext() as CanvasRenderingContext2D;
  type Rect = [number, number, number, number];
  const signs: Record<string, Rect> = {};
  const field = (id: string, x: number, y: number, ww: number, hh: number, bg: string) => {
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, ww, hh);
    signs[id] = [x + 2, y + 2, ww - 4, hh - 4];
  };
  const label = (
    str: string,
    x: number,
    y: number,
    size: number,
    col: string,
    max: number,
    italic = false,
  ) => {
    ctx.fillStyle = col;
    ctx.font = `${italic ? 'italic ' : ''}900 ${size}px Arial, sans-serif`;
    ctx.fillText(str, x, y, max);
  };
  const bars = (x: number, y: number, hh: number, col: string) => {
    ctx.fillStyle = col;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.moveTo(x + k * 34, y + hh);
      ctx.lineTo(x + k * 34 + 24, y + hh);
      ctx.lineTo(x + k * 34 + 60, y);
      ctx.lineTo(x + k * 34 + 36, y);
      ctx.closePath();
      ctx.fill();
    }
  };
  const red = '#ed4436',
    gold = '#efb747',
    cream = '#f6efe0',
    ink = '#101921';
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, w, h);
  field('hero', 0, 0, w, 220, ink);
  bars(36, 42, 130, red);
  label('AUTODROMO INTERNAZIONALE    /    ITALIA', 204, 52, 35, '#dbc7a0', 1400);
  label('VALLE D’ORO', 185, 180, 149, cream, 1380, true);
  ctx.fillStyle = red;
  ctx.fillRect(1635, 0, 413, 220);
  label('GT3', 1683, 158, 139, cream, 320, true);
  for (const [j, col] of ['#209b64', '#f7f3e5', '#d73d34'].entries()) {
    ctx.fillStyle = col;
    ctx.fillRect(j * 545, 209, 545, 11);
  }
  for (const [i, [id, name, sub, bg, fg, accent]] of [
    ['apex', 'APEX  //  GT3', 'WORLD ENDURANCE SERIES', ink, cream, red],
    ['vet', 'VETTORE', 'P N E U M A T I C I', red, '#ffffed', ink],
    ['oro', 'D’ORO  CORSE', 'COMPETIZIONE   DAL   1962', gold, ink, '#fff3ce'],
    ['off', 'OFFICINA  ITALIA', 'REPARTO   CORSE', '#135449', cream, '#e8b757'],
    ['pits', 'VALLE  MOTORSPORT', 'PIT LANE    /    CORSIA BOX', cream, ink, red],
    ['tribuna', 'TRIBUNA  CENTRALE', 'AUTODROMO   VALLE   D’ORO', ink, cream, gold],
  ].entries()) {
    const x = (i % 2) * 1024,
      y = 220 + Math.floor(i / 2) * 128;
    field(id, x, y, 1024, 128, bg);
    bars(x + 13, y + 25, 70, accent);
    label(name, x + 164, y + 82, 72, fg, 837, true);
    label(sub, x + 172, y + 112, 22, fg, 775);
  }
  for (let j = 0; j < 4; j++) {
    const x = j * 512,
      y = 612,
      n = ['150', '100', '50', '60'][j];
    field('board' + n, x, y, 512, 232, j === 3 ? '#f4d35e' : cream);
    ctx.fillStyle = red;
    ctx.fillRect(x, y, 24, 232);
    label(j === 3 ? '60 PIT' : n, x + 45, y + 184, j === 3 ? 132 : 195, ink, 435, true);
  }
  for (let i = 0; i < 16; i++) {
    const x = (i % 8) * 256,
      y = 860 + Math.floor(i / 8) * 110;
    field('bay' + i, x, y, 256, 110, i === 0 ? '#9c2219' : ink);
    ctx.fillStyle = [red, gold, '#428b84', '#d9dfcc'][i % 4];
    ctx.fillRect(x, y, 18, 110);
    label(i === 0 ? 'YOU' : 'BOX', x + 30, y + 38, 23, cream, 68);
    label(String(i + 1).padStart(2, '0'), x + 85, y + 85, 79, cream, 156);
  }
  field('tower', 0, 1100, 410, 880, ink);
  label('VDO', 25, 106 + 1100, 94, gold, 360, true);
  label('CRONOMETRI', 24, 1257, 36, cream, 360);
  for (const [i, word] of [
    'GT3  CLASS',
    'S1   28.39',
    'S2   36.04',
    'S3   31.06',
    '1:35.490',
    'LAP RECORD',
  ].entries()) {
    ctx.fillStyle = i === 4 ? red : '#25343e';
    ctx.fillRect(14, 1300 + i * 94, 380, 80);
    label(word, 27, 1358 + i * 94, i === 4 ? 60 : 47, i === 4 ? cream : gold, 354);
  }
  field('turn1', 420, 1100, 1570, 215, '#113c35');
  label('01', 446, 1272, 170, gold, 240, true);
  label('TORNANTE  ORO', 728, 1256, 124, cream, 1200, true);
  field('chicane', 420, 1330, 1570, 215, ink);
  label('07 / 08', 452, 1495, 121, red, 440, true);
  label('LA  VARIANTE', 951, 1495, 110, cream, 988, true);
  field('pitexit', 420, 1560, 1570, 215, cream);
  label('PIT  ENTRY  60 KM/H', 442, 1720, 116, ink, 1050, true);
  bars(1540, 1595, 132, red);
  t.anisotropicFilteringLevel = 16;
  t.update(true);
  const mat = plain(scene, 'graphic panels', 0.73);
  mat.albedoTexture = t;
  mat.emissiveTexture = t;
  mat.emissiveColor = new Color3(0.13, 0.13, 0.13);
  return {
    mat,
    uv(id: string) {
      const [x, y, ww, hh] = signs[id];
      return [x / w, 1 - (y + hh) / h, (x + ww) / w, 1 - y / h] as const;
    },
  };
}
