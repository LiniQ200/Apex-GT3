import { Color3 } from '@babylonjs/core/Maths/math.color';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { Scene } from '@babylonjs/core/scene';
import { teams } from '../types';
import type { Studio } from '../vehicles/studio';

type Ctx = CanvasRenderingContext2D;
export function pbr(scene: Scene, name: string, hex: string, metallic: number, roughness: number) {
  const m = new PBRMaterial('GT3.' + name, scene);
  m.albedoColor = Color3.FromHexString(hex).toLinearSpace();
  m.metallic = metallic;
  m.roughness = roughness;
  // Use scene.environmentTexture implicitly so a weather switch replaces the
  // reflection on every car; do not pin materials to a disposed sky probe.
  return m;
}

function canvasMap(scene: Scene, name: string, w: number, h: number, draw: (c: Ctx) => void) {
  const t = new DynamicTexture(name, { width: w, height: h }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  t.anisotropicFilteringLevel = 8;
  draw(t.getContext() as unknown as Ctx);
  t.update(false);
  return t;
}
function poly(c: Ctx, color: string, ...points: number[]) {
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2) c.lineTo(points[i], points[i + 1]);
  c.closePath();
  c.fill();
}
function type(
  c: Ctx,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  weight = 'bold',
  align: CanvasTextAlign = 'left',
) {
  c.fillStyle = color;
  c.font = `${weight} ${size}px Arial, sans-serif`;
  c.textAlign = align;
  c.fillText(text, x, y);
}

// The UVs computed from the actual normalized panels in studio.ts correspond
// to a plan view on the left and a metric side elevation on the right. Every
// marque gets an authored design, not just a recolor of one stripe texture.
function paintAtlas(scene: Scene, k: number) {
  const [raceNumber, team, base, accent] = teams[k];
  const ink = '#111820',
    ivory = '#fff4d8';
  return canvasMap(scene, 'Factory.wrap.' + team, 2048, 2048, (c) => {
    c.fillStyle = base;
    c.fillRect(0, 0, 2048, 2048);
    c.save();
    c.translate(0.015 * 2048, 0.02 * 2048);
    c.scale((0.47 * 2048) / 1000, (0.96 * 2048) / 2000);
    // Space is now the bonnet, greenhouse and engine cover, nose at the top.
    const line = (x: number, w: number, col: string) => {
      c.fillStyle = col;
      c.fillRect(x, -45, w, 2090);
    };
    switch (k) {
      case 0:
        line(326, 79, ivory);
        line(415, 9, ivory);
        line(318, 3, '#b99d64');
        break;
      case 1:
        poly(c, ink, 610, -45, 790, -45, 506, 1250, 615, 2040, 483, 2040, 420, 1180);
        poly(c, accent, 753, -45, 838, -45, 552, 1250, 643, 2040, 601, 2040, 501, 1250);
        break;
      case 2:
        line(433, 11, accent);
        line(461, 78, '#163e36');
        line(555, 11, accent);
        line(416, 3, ivory);
        line(580, 3, ivory);
        break;
      case 3:
        line(380, 240, '#1a303d');
        line(390, 220, accent);
        line(369, 4, ivory);
        line(628, 4, ivory);
        break;
      default:
        poly(c, '#3e434a', 70, -45, 260, -45, 670, 1320, 800, 2040, 602, 2040, 440, 1390);
        poly(c, accent, 254, -45, 282, -45, 718, 1330, 829, 2040, 796, 2040, 661, 1320);
    }
    // Nose maker's shield and rear engine cover wordmark. Offset the roof
    // class mark from the center stripe like a scrutineering stencil.
    poly(c, ink, 470, 265, 530, 265, 527, 304, 500, 327, 473, 304);
    poly(c, accent, 478, 272, 522, 272, 519, 301, 500, 317, 481, 301);
    type(c, 'A', 500, 302, 31, ink, 'italic 900', 'center');
    type(c, 'GT3  /  ' + raceNumber, 650, 970, 35, ivory, 'italic 900', 'center');
    type(c, 'A P E X', 500, 1770, 35, k === 1 ? ink : ivory, 'bold', 'center');
    c.restore();
    c.save();
    c.translate(0.51 * 2048, 0.04 * 2048);
    c.scale((0.48 * 2048) / 1000, (0.92 * 2048) / 313);
    // Side chart has the same metric aspect as the real car. Keep the
    // sweeping beltline below the independently illuminated door light box.
    poly(
      c,
      k === 1 ? '#333941' : '#171d24',
      -5,
      253,
      145,
      245,
      342,
      266,
      642,
      252,
      834,
      222,
      1005,
      194,
      1005,
      324,
      -5,
      324,
    );
    poly(
      c,
      accent,
      -5,
      246,
      144,
      238,
      344,
      258,
      641,
      245,
      843,
      214,
      1005,
      187,
      1005,
      196,
      834,
      223,
      642,
      254,
      343,
      267,
      143,
      248,
      -5,
      256,
    );
    if (k === 3) poly(c, accent, 0, 180, 150, 169, 316, 253, 253, 252, 134, 199, 0, 206);
    if (k === 4)
      for (let j = 0; j < 5; j++)
        poly(c, accent, 188 + j * 24, 214, 202 + j * 24, 214, 164 + j * 24, 246, 150 + j * 24, 246);
    if (k === 0)
      for (const [i, col] of ['#168060', '#eeeada', '#d83440'].entries())
        poly(c, col, 188 + i * 15, 224, 201 + i * 15, 224, 189 + i * 15, 243, 176 + i * 15, 243);
    type(c, team.toUpperCase(), 495, 279, 12, ivory, 'italic 900', 'center');
    type(c, 'AX /  COMPETIZIONE', 246, 222, 9, k === 1 ? ink : ivory, 'bold', 'center');
    type(c, 'VALLE  •  MOTORSPORT', 735, 212, 10, k === 1 ? ink : ivory, 'italic bold', 'center');
    c.restore();
    // Deterministic, sub-pixel metallic flake without an extra detail sampler.
    let seed = 2113;
    c.fillStyle = 'rgba(255,255,255,.10)';
    for (let i = 0; i < 17000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const x = seed & 2047,
        y = (seed >>> 13) & 2047;
      c.fillRect(x, y, 1, 1);
    }
  });
}

function lightBox(scene: Scene, number: string, team: string) {
  const t = canvasMap(scene, 'Illuminated.door.' + number, 512, 384, (c) => {
    c.fillStyle = '#11161a';
    c.fillRect(0, 0, 512, 384);
    c.fillStyle = '#eeeccb';
    c.fillRect(7, 7, 498, 370);
    c.fillStyle = '#172323';
    c.fillRect(7, 7, 498, 64);
    c.fillStyle = '#e9b752';
    c.fillRect(7, 71, 498, 9);
    type(c, 'A P E X   /   R A C I N G', 29, 49, 27, '#f8f5ea', '900');
    type(c, 'GT3', 479, 49, 31, '#e9b752', 'italic 900', 'right');
    c.save();
    c.translate(252, 306);
    c.scale(0.96, 1.12);
    type(c, number, 0, 0, 234, '#162025', 'italic 900', 'center');
    c.restore();
    type(c, team.toUpperCase(), 255, 355, 22, '#344348', 'bold', 'center');
  });
  const m = pbr(scene, 'door lightbox ' + number, '#ffffff', 0.08, 0.32);
  m.albedoTexture = t;
  m.emissiveTexture = t;
  m.emissiveColor.set(0.16, 0.15, 0.11);
  m.zOffset = -2;
  m.zOffsetUnits = -2;
  return m;
}

function sharedMaterials(scene: Scene) {
  const trim = pbr(scene, 'composite and upholstery', '#34383c', 0.1, 0.55);
  const metal = pbr(scene, 'polished titanium', '#b5b7ba', 0.88, 0.24);
  const glass = pbr(scene, 'smoke laminated glass', '#8caeb9', 0.2, 0.12);
  glass.alpha = 0.43;
  glass.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  // Write depth in the blended draw; Babylon 9.0's separate prepass retains both shader variants.
  glass.forceDepthWrite = true;
  const headlight = pbr(scene, 'projector arrays', '#f0f9ff', 0.2, 0.16);
  headlight.emissiveColor.set(1.75, 1.83, 2.05);
  const tire = pbr(scene, 'vulcanized slick', '#202124', 0, 0.82);
  const rim = pbr(scene, 'forged magnesium', '#8e949a', 0.83, 0.27);
  rim.anisotropy.isEnabled = true;
  rim.anisotropy.intensity = 0.48;
  // Babylon 9.0's clustered anisotropic lighting reads the clearcoat response.
  rim.clearCoat.isEnabled = true;
  rim.clearCoat.intensity = 0.24;
  rim.clearCoat.roughness = 0.23;
  const caliper = pbr(scene, 'ceramic caliper', '#ce9b38', 0.56, 0.31),
    badge = pbr(scene, 'enamel crest', '#dbb438', 0.44, 0.26);
  const carbon = pbr(scene, '2x2 twill', '#ffffff', 0.46, 0.34);
  const weave = canvasMap(scene, 'carbon.2x2', 128, 128, (c) => {
    c.fillStyle = '#24292b';
    c.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const a = (x + y) % 4 < 2;
        c.fillStyle = a ? '#414748' : '#34393c';
        c.fillRect(x * 8, y * 8, 8, 8);
        c.fillStyle = a ? '#4a4e50' : '#242a2c';
        for (let j = 0; j < 4; j++)
          if (a) c.fillRect(x * 8 + j * 2, y * 8, 1, 8);
          else c.fillRect(x * 8, y * 8 + j * 2, 8, 1);
      }
  });
  weave.uScale = 4;
  weave.vScale = 4;
  carbon.albedoTexture = weave;
  carbon.backFaceCulling = false;
  const foil = pbr(scene, 'carbon mainplane', '#ffffff', 0.42, 0.34);
  foil.albedoTexture = canvasMap(scene, 'rear wing stencil', 1024, 256, (c) => {
    c.fillStyle = '#272c2e';
    c.fillRect(0, 0, 1024, 256);
    for (let i = -260; i < 1024; i += 8) poly(c, '#2e3437', i, 0, i + 3, 0, i + 259, 256, i + 256, 256);
    type(c, 'A P E X    R A C I N G', 512, 165, 78, '#dfdfd5', 'italic 900', 'center');
    for (const x of [55, 918]) {
      poly(c, '#dbb556', x, 87, x + 12, 87, x - 9, 168, x - 21, 168);
      poly(c, '#dfdfd5', x + 21, 87, x + 32, 87, x + 11, 168, x - 1, 168);
    }
  });
  foil.backFaceCulling = false;
  const discMap = canvasMap(scene, 'ventilated ceramic disc faces', 256, 256, (c) => {
    c.fillStyle = '#a6a4a0';
    c.fillRect(0, 0, 256, 256);
    for (let r = 56; r < 123; r += 2) {
      c.beginPath();
      c.arc(128, 128, r, 0, 2 * Math.PI);
      c.strokeStyle = r % 4 ? '#939290' : '#a19e9b';
      c.lineWidth = 0.7;
      c.stroke();
    }
    for (let j = 0; j < 26; j++)
      for (let h = 0; h < 3; h++) {
        const a = ((j + h * 0.26) * 2 * Math.PI) / 26,
          r = 66 + h * 17;
        c.beginPath();
        c.arc(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, 2.3, 0, 2 * Math.PI);
        c.fillStyle = '#2b2c2d';
        c.fill();
      }
    c.beginPath();
    c.arc(128, 128, 49, 0, 2 * Math.PI);
    c.fillStyle = '#454546';
    c.fill();
  });
  const flame = pbr(scene, 'exhaust mantle', '#ffad47', 0, 0.8);
  flame.emissiveColor.set(3.5, 1, 0.09);
  flame.unlit = false;
  const core = pbr(scene, 'exhaust inner cone', '#84bbff', 0, 0.8);
  core.emissiveColor.set(0.6, 1.7, 4);
  return { trim, metal, glass, headlight, tire, rim, caliper, badge, carbon, foil, discMap, flame, core };
}
interface Bank {
  common: ReturnType<typeof sharedMaterials>;
  paint: Map<number, PBRMaterial>;
  panels: Map<string, PBRMaterial>;
  shadows: Map<string, StandardMaterial>;
}
const banks = new WeakMap<Scene, Bank>();
export function carFinish(scene: Scene, idx: number, number: string) {
  let bank = banks.get(scene);
  if (!bank) {
    bank = { common: sharedMaterials(scene), paint: new Map(), panels: new Map(), shadows: new Map() };
    banks.set(scene, bank);
  }
  const k = ((idx % 5) + 5) % 5,
    team = teams[k];
  let paint = bank.paint.get(k);
  if (!paint) {
    paint = pbr(scene, team[1], '#ffffff', 0.48, 0.26);
    paint.albedoTexture = paintAtlas(scene, k);
    paint.clearCoat.isEnabled = true;
    paint.clearCoat.intensity = 1;
    paint.clearCoat.roughness = 0.03;
    paint.clearCoat.indexOfRefraction = 1.5;
    bank.paint.set(k, paint);
  }
  const key = `${k}:${number}`;
  let panel = bank.panels.get(key);
  if (!panel) {
    panel = lightBox(scene, number, team[1]);
    bank.panels.set(key, panel);
  }
  return { ...bank.common, paint, panel };
}

export function contactShadow(scene: Scene, s: Studio) {
  const b = banks.get(scene)!;
  let m = b.shadows.get(s.source);
  if (m) return m;
  const w = 2.6,
    h = 5.12,
    pix = 256;
  const map = canvasMap(scene, 'five contact patches ' + s.source, pix, 512, (c) => {
    const ellipse = (x: number, y: number, rx: number, ry: number, opacity: number) => {
      c.save();
      c.translate(pix * (0.5 + x / w), 512 * (0.5 + y / h));
      c.scale((rx * pix) / w, (ry * 512) / h);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, `rgba(0,0,0,${opacity})`);
      g.addColorStop(0.52, `rgba(0,0,0,${opacity * 0.78})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(-1, -1, 2, 2);
      c.restore();
    };
    ellipse(0, 0, 1.2, 2.5, 0.62);
    for (const p of s.hubs) ellipse(p.x, p.z, 0.31, 0.45, 0.83);
  });
  map.hasAlpha = true;
  m = new StandardMaterial('contact attenuation ' + s.source, scene);
  m.disableLighting = true;
  m.diffuseTexture = map;
  m.useAlphaFromDiffuseTexture = true;
  m.emissiveColor.set(0, 0, 0);
  m.specularColor.set(0, 0, 0);
  m.disableDepthWrite = true;
  m.backFaceCulling = false;
  b.shadows.set(s.source, m);
  return m;
}
