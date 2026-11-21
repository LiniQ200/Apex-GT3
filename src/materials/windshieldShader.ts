import { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';

class WindshieldRainDefines extends MaterialDefines {
  WINDSHIELD_RAIN = false;
}

const rainGlslDefs = `#ifdef WINDSHIELD_RAIN
vec2 wrHash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}

// Compute a single procedural raindrop layer returning (coverage, dx, dy, trailMask).
// Negative flow slides downward under gravity; positive flow streams upward along GT3 aero rake!
vec4 wrDropLayer(vec2 uv, vec2 grid, float t, float flowDir, float density) {
  vec2 st = uv * grid;
  // Stagger odd columns so rivulets never march in robotic rows
  float colId = floor(st.x);
  vec2 colRnd = wrHash2(vec2(colId, grid.x));
  float colSpeed = (0.65 + 0.70 * colRnd.x) * (0.35 + abs(flowDir) * 1.15);
  float shift = t * colSpeed * (flowDir >= 0.0 ? -1.0 : 1.0) + colRnd.y * 19.3;
  st.y += shift;
  vec2 cell = floor(st);
  vec2 f = fract(st) - 0.5;

  vec2 rnd = wrHash2(cell + vec2(grid.x * 1.7, grid.y * 3.1));
  if (rnd.x > density) return vec4(0.0);

  // Subtle sinuous wobble as droplets slip across laminated racing polycarbonate
  float wobble = sin(st.y * 1.8 + rnd.y * 6.2831) * 0.16;
  float dropX = (rnd.x / max(0.01, density) - 0.5) * 0.56 + wobble * 0.25;
  float phase = fract(t * (0.28 + 0.42 * rnd.y) + rnd.x * 7.3);
  // Smooth pulse lifecycle so drops bead up, stream, and detach naturally
  float life = smoothstep(0.0, 0.12, phase) * (1.0 - smoothstep(0.86, 1.0, phase));
  float dropY = (rnd.y - 0.5) * 0.48;

  vec2 d = f - vec2(dropX, dropY);
  // Elongate along flow direction at higher racing speeds
  float stretch = 1.0 + clamp(abs(flowDir) * 0.65, 0.0, 0.85);
  vec2 scaled = vec2(d.x * 1.28, d.y / stretch);
  float r = length(scaled);
  float radius = (0.14 + 0.13 * fract(rnd.x * 13.7)) * (0.65 + 0.35 * life);
  float head = (1.0 - smoothstep(radius * 0.38, radius, r)) * life;

  // Tapering wet rivulet wake behind the moving droplet head
  float behind = flowDir >= 0.0 ? -d.y : d.y;
  float wake = 0.0;
  if (behind > 0.0 && behind < 0.42 && abs(flowDir) > 0.12) {
    float wakeWidth = radius * 0.52 * (1.0 - behind / 0.42);
    float microBead = 0.55 + 0.45 * sin(behind * 36.0 + rnd.y * 12.0);
    wake = (1.0 - smoothstep(wakeWidth * 0.2, max(wakeWidth, 0.001), abs(d.x))) * (1.0 - behind / 0.42) * microBead * life * 0.65;
  }

  vec2 grad = (head > 0.01) ? (scaled / max(0.001, radius)) : vec2(0.0);
  return vec4(max(head, wake), grad.x * head, grad.y * head, wake);
}
#endif`;

const rainWgslDefs = `#ifdef WINDSHIELD_RAIN
fn wrHash2(pIn: vec2f) -> vec2f {
  let p = vec2f(dot(pIn, vec2f(127.1, 311.7)), dot(pIn, vec2f(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}

fn wrDropLayer(uv: vec2f, grid: vec2f, t: f32, flowDir: f32, density: f32) -> vec4f {
  var st = uv * grid;
  let colId = floor(st.x);
  let colRnd = wrHash2(vec2f(colId, grid.x));
  let colSpeed = (0.65 + 0.70 * colRnd.x) * (0.35 + abs(flowDir) * 1.15);
  let shift = t * colSpeed * select(1.0, -1.0, flowDir >= 0.0) + colRnd.y * 19.3;
  st.y += shift;
  let cell = floor(st);
  let f = fract(st) - 0.5;

  let rnd = wrHash2(cell + vec2f(grid.x * 1.7, grid.y * 3.1));
  if (rnd.x > density) { return vec4f(0.0); }

  let wobble = sin(st.y * 1.8 + rnd.y * 6.2831) * 0.16;
  let dropX = (rnd.x / max(0.01, density) - 0.5) * 0.56 + wobble * 0.25;
  let phase = fract(t * (0.28 + 0.42 * rnd.y) + rnd.x * 7.3);
  let life = smoothstep(0.0, 0.12, phase) * (1.0 - smoothstep(0.86, 1.0, phase));
  let dropY = (rnd.y - 0.5) * 0.48;

  let d = f - vec2f(dropX, dropY);
  let stretch = 1.0 + clamp(abs(flowDir) * 0.65, 0.0, 0.85);
  let scaled = vec2f(d.x * 1.28, d.y / stretch);
  let r = length(scaled);
  let radius = (0.14 + 0.13 * fract(rnd.x * 13.7)) * (0.65 + 0.35 * life);
  let head = (1.0 - smoothstep(radius * 0.38, radius, r)) * life;

  let behind = select(d.y, -d.y, flowDir >= 0.0);
  var wake: f32 = 0.0;
  if (behind > 0.0 && behind < 0.42 && abs(flowDir) > 0.12) {
    let wakeWidth = radius * 0.52 * (1.0 - behind / 0.42);
    let microBead = 0.55 + 0.45 * sin(behind * 36.0 + rnd.y * 12.0);
    wake = (1.0 - smoothstep(wakeWidth * 0.2, max(wakeWidth, 0.001), abs(d.x))) * (1.0 - behind / 0.42) * microBead * life * 0.65;
  }

  let grad = select(vec2f(0.0), scaled / max(0.001, radius), head > 0.01);
  return vec4f(max(head, wake), grad.x * head, grad.y * head, wake);
}
#endif`;

const rainGlslApply = `#ifdef WINDSHIELD_RAIN
{
  float intensity = clamp(rainTime.y, 0.0, 1.0);
  if (intensity < 0.01) {
    finalEmissive = vec3(0.0);
    alpha = 0.0;
  } else {
    vec2 uv = vAlbedoUV;
    float t = rainTime.x;
    float speedNorm = clamp(rainTime.z, 0.0, 1.0);
    float wiperAngle = rainTime.w;
    float wiperActive = rainMeta.x;
    float wiperDir = rainMeta.y;
    float sprayBoost = rainMeta.z;

    // Below ~75 km/h gravity pulls droplets down (-0.35); above ~90 km/h aero airflow drives rivulets UP (+1.0)!
    float flowDir = mix(-0.38, 1.15, smoothstep(0.18, 0.58, speedNorm));

    // Synchronized GT3 endurance single-arm wiper arc anchored at bottom-center cowl (0.5, -0.06)
    vec2 rel = vec2((uv.x - 0.5) * 1.48, uv.y + 0.06);
    float rad = length(rel);
    float ang = atan(rel.x, max(0.001, rel.y)); // -1.15 .. +1.15 rad
    float inArc = smoothstep(0.14, 0.20, rad) * (1.0 - smoothstep(0.86, 0.94, rad)) * (1.0 - smoothstep(1.04, 1.15, abs(ang)));

    float clearMask = 1.0;
    float bowWave = 0.0;
    if (wiperActive > 0.01 && inArc > 0.01) {
      // Signed angular distance behind the moving wiper blade (0 just wiped -> 1.0 stale)
      float delta = (wiperAngle - ang) * wiperDir;
      // Map sweep arc [-1.1, +1.1] into clean freshness ramp so swept glass stays crystal clear and slowly re-beads
      float freshness = delta >= 0.0
        ? clamp(delta / 2.25, 0.0, 1.0)
        : clamp(1.0 + delta / 2.25, 0.0, 1.0);
      float cleared = mix(0.04, 0.88, pow(freshness, 1.35));
      clearMask = mix(1.0, cleared, inArc * wiperActive);
      // Thin bright meniscus ridge pushed directly ahead of the rubber blade
      float ahead = -delta;
      bowWave = (1.0 - smoothstep(0.0, 0.065, abs(ahead - 0.02))) * inArc * wiperActive * intensity;
    }

    // Outside wiper sweep arc (upper corners / A-pillar edges) water accumulates denser for authentic cockpit framing
    float edgeAccum = mix(1.22, 0.95, inArc);
    float dens = clamp(intensity * edgeAccum * (0.65 + 0.35 * sprayBoost), 0.0, 1.0);

    vec4 dLarge = wrDropLayer(uv, vec2(11.0, 6.5), t, flowDir, dens * 0.78);
    vec4 dMid   = wrDropLayer(uv + vec2(0.37, 0.19), vec2(22.0, 13.0), t * 1.08, flowDir * 0.75, dens * 0.88);
    vec4 dFine  = wrDropLayer(uv + vec2(0.71, 0.63), vec2(44.0, 26.0), t * 0.45, flowDir * 0.25, dens * 0.92);

    float dropCov = clamp((dLarge.x * 1.0 + dMid.x * 0.78 + dFine.x * 0.52) * clearMask, 0.0, 1.0);
    vec2 domeN = (dLarge.yz * 1.15 + dMid.yz * 0.75 + dFine.yz * 0.45) * clearMask;

    // Physically-inspired optical glass bead shading (bright sky upper highlight + crisp dark refracted lower meniscus)
    float specTop = pow(clamp(dot(normalize(vec3(domeN, 0.48)), normalize(vec3(0.24, 0.80, 0.54))), 0.0, 1.0), 12.0);
    float rimFresnel = smoothstep(0.20, 0.86, length(domeN)) * dropCov;
    float darkBottom = (1.0 - smoothstep(-0.74, -0.10, domeN.y)) * dropCov;
    // Subtle corner mist film strictly outside the wiped zone in heavy rain
    float cornerFilm = (1.0 - inArc) * intensity * (0.07 + 0.06 * sprayBoost);

    vec3 skyCol = rainSkyCol.rgb;
    vec3 dropRgb = mix(skyCol * 0.24, skyCol * 1.52 + vec3(0.42, 0.46, 0.52), clamp(specTop * 1.65 + rimFresnel * 0.62, 0.0, 1.0));
    dropRgb *= (1.0 - 0.62 * darkBottom);
    dropRgb += (skyCol * 1.05 + vec3(0.28)) * (bowWave * 0.82);

    float outAlpha = clamp(dropCov * (0.44 + 0.36 * rimFresnel + 0.28 * specTop) + bowWave * 0.48 + cornerFilm, 0.0, 0.84);
    finalEmissive = dropRgb;
    alpha = outAlpha;
  }
}
#endif`;

const rainWgslApply = `#ifdef WINDSHIELD_RAIN
{
  let intensity = clamp(uniforms.rainTime.y, 0.0, 1.0);
  if (intensity < 0.01) {
    finalEmissive = vec3f(0.0);
    alpha = 0.0;
  } else {
    let uv = fragmentInputs.vAlbedoUV;
    let t = uniforms.rainTime.x;
    let speedNorm = clamp(uniforms.rainTime.z, 0.0, 1.0);
    let wiperAngle = uniforms.rainTime.w;
    let wiperActive = uniforms.rainMeta.x;
    let wiperDir = uniforms.rainMeta.y;
    let sprayBoost = uniforms.rainMeta.z;

    let flowDir = mix(-0.38, 1.15, smoothstep(0.18, 0.58, speedNorm));

    let rel = vec2f((uv.x - 0.5) * 1.48, uv.y + 0.06);
    let rad = length(rel);
    let ang = atan2(rel.x, max(0.001, rel.y));
    let inArc = smoothstep(0.14, 0.20, rad) * (1.0 - smoothstep(0.86, 0.94, rad)) * (1.0 - smoothstep(1.04, 1.15, abs(ang)));

    var clearMask: f32 = 1.0;
    var bowWave: f32 = 0.0;
    if (wiperActive > 0.01 && inArc > 0.01) {
      let delta = (wiperAngle - ang) * wiperDir;
      let freshness = select(clamp(1.0 + delta / 2.25, 0.0, 1.0), clamp(delta / 2.25, 0.0, 1.0), delta >= 0.0);
      let cleared = mix(0.04, 0.88, pow(freshness, 1.35));
      clearMask = mix(1.0, cleared, inArc * wiperActive);
      let ahead = -delta;
      bowWave = (1.0 - smoothstep(0.0, 0.065, abs(ahead - 0.02))) * inArc * wiperActive * intensity;
    }

    let edgeAccum = mix(1.22, 0.95, inArc);
    let dens = clamp(intensity * edgeAccum * (0.65 + 0.35 * sprayBoost), 0.0, 1.0);

    let dLarge = wrDropLayer(uv, vec2f(11.0, 6.5), t, flowDir, dens * 0.78);
    let dMid   = wrDropLayer(uv + vec2f(0.37, 0.19), vec2f(22.0, 13.0), t * 1.08, flowDir * 0.75, dens * 0.88);
    let dFine  = wrDropLayer(uv + vec2f(0.71, 0.63), vec2f(44.0, 26.0), t * 0.45, flowDir * 0.25, dens * 0.92);

    let dropCov = clamp((dLarge.x * 1.0 + dMid.x * 0.78 + dFine.x * 0.52) * clearMask, 0.0, 1.0);
    let domeN = (dLarge.yz * 1.15 + dMid.yz * 0.75 + dFine.yz * 0.45) * clearMask;

    let specTop = pow(clamp(dot(normalize(vec3f(domeN, 0.48)), normalize(vec3f(0.24, 0.80, 0.54))), 0.0, 1.0), 12.0);
    let rimFresnel = smoothstep(0.20, 0.86, length(domeN)) * dropCov;
    let darkBottom = (1.0 - smoothstep(-0.74, -0.10, domeN.y)) * dropCov;
    let cornerFilm = (1.0 - inArc) * intensity * (0.07 + 0.06 * sprayBoost);

    let skyCol = uniforms.rainSkyCol.rgb;
    var dropRgb = mix(skyCol * 0.24, skyCol * 1.52 + vec3f(0.42, 0.46, 0.52), clamp(specTop * 1.65 + rimFresnel * 0.62, 0.0, 1.0));
    dropRgb *= (1.0 - 0.62 * darkBottom);
    dropRgb += (skyCol * 1.05 + vec3f(0.28)) * (bowWave * 0.82);

    let outAlpha = clamp(dropCov * (0.44 + 0.36 * rimFresnel + 0.28 * specTop) + bowWave * 0.48 + cornerFilm, 0.0, 0.84);
    finalEmissive = dropRgb;
    alpha = outAlpha;
  }
}
#endif`;

/**
 * 7th Cross-Backend WGSL + GLSL Shader Plugin:
 * Real-time cockpit windshield raindrop beads, airflow-driven rivulets,
 * and synchronized GT3 single-arm wiper clearing arc with zero screen-space blur.
 */
export class WindshieldRainPlugin extends MaterialPluginBase {
  time = 0;
  intensity = 0;
  speedNorm = 0;
  wiperAngle = 0;
  wiperActive = 0;
  wiperDir = 1;
  sprayBoost = 0;
  skyColor: [number, number, number] = [0.68, 0.74, 0.82];

  constructor(material: PBRMaterial) {
    super(material, 'WindshieldRain', 230, new WindshieldRainDefines());
    this._enable(true);
  }
  override isCompatible(_shaderLanguage: ShaderLanguage) {
    return true;
  }
  override getClassName() {
    return 'WindshieldRainPlugin';
  }
  override prepareDefines(defines: WindshieldRainDefines) {
    defines.WINDSHIELD_RAIN = true;
  }
  override getUniforms(shaderLanguage = ShaderLanguage.GLSL) {
    const ubo = [
      { name: 'rainTime', size: 4, type: 'vec4' },
      { name: 'rainMeta', size: 4, type: 'vec4' },
      { name: 'rainSkyCol', size: 4, type: 'vec4' },
    ];
    if (shaderLanguage === ShaderLanguage.WGSL) {
      return {
        ubo,
        fragment: `#ifdef WINDSHIELD_RAIN
uniform rainTime: vec4f;
uniform rainMeta: vec4f;
uniform rainSkyCol: vec4f;
#endif`,
      };
    }
    return {
      ubo,
      fragment: `#ifdef WINDSHIELD_RAIN
uniform vec4 rainTime;
uniform vec4 rainMeta;
uniform vec4 rainSkyCol;
#endif`,
    };
  }
  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene) {
    uniformBuffer.updateFloat4('rainTime', this.time, this.intensity, this.speedNorm, this.wiperAngle);
    uniformBuffer.updateFloat4('rainMeta', this.wiperActive, this.wiperDir, this.sprayBoost, 0);
    uniformBuffer.updateFloat4('rainSkyCol', this.skyColor[0], this.skyColor[1], this.skyColor[2], 1);
  }
  override getCustomCode(shaderType: string, shaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: shaderLanguage === ShaderLanguage.WGSL ? rainWgslDefs : rainGlslDefs,
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION:
        shaderLanguage === ShaderLanguage.WGSL ? rainWgslApply : rainGlslApply,
    };
  }
}
