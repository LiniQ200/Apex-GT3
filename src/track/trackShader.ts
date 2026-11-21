import { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import type { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';

class PorousSurfaceDefines extends MaterialDefines {
  POROUS_SURFACE = false;
  POROUS_ROAD = false;
  POROUS_TRACK_STATE = false;
  POROUS_HEX_BOMB = false;
}

const glslDefs = `#ifdef POROUS_SURFACE
#ifdef POROUS_TRACK_STATE
uniform sampler2D trackStateSampler;
#endif
vec2 porousHash2(vec2 p) {
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}
float porousNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
#ifdef POROUS_ROAD
// Animated raindrop concentric ripple normal perturbation inside standing asphalt puddles
vec2 porousRainRipples(vec2 wp, float t) {
  vec2 cell = floor(wp * 2.3);
  vec2 f = fract(wp * 2.3) - 0.5;
  vec2 rnd = porousHash2(cell);
  float phase = fract(t * 1.15 + rnd.x);
  vec2 center = (rnd - 0.5) * 0.45;
  vec2 d = f - center;
  float dist = length(d) + 1e-4;
  float wave = sin((dist - phase * 0.48) * 44.0) * exp(-dist * 7.5) * (1.0 - phase) * smoothstep(0.0, 0.08, phase);
  return (d / dist) * wave;
}
#endif
#ifdef POROUS_HEX_BOMB
// Fast 2-tap Hex-Grid Stochastic Texture Bombing with analytical derivatives (preserves 16x AF, eliminates tiling)
vec4 porousHexSample(sampler2D samp, vec2 uv) {
  vec2 duvdx = dFdx(uv);
  vec2 duvdy = dFdy(uv);
  const mat2 toHex = mat2(1.1547005, 0.0, 0.5773503, 1.0);
  vec2 h = toHex * (uv * 0.45);
  vec2 i = floor(h);
  vec2 f = fract(h);
  vec2 c1 = i;
  vec2 c2 = i + vec2(1.0, 1.0);
  vec2 c3 = i + (f.x > f.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec3 w = f.x > f.y ? vec3(1.0 - f.x, f.y, f.x - f.y) : vec3(1.0 - f.y, f.x, f.y - f.x);
  vec2 oA = c1; float wA = w.x;
  vec2 oB = c2; float wB = w.y;
  if (w.z > wA && wA <= wB) { oA = c3; wA = w.z; }
  else if (w.z > wB) { oB = c3; wB = w.z; }
  float pA = wA * wA * wA;
  float pB = wB * wB * wB;
  if (wA >= 0.82) return textureGrad(samp, uv + porousHash2(oA), duvdx, duvdy);
  if (wB >= 0.82) return textureGrad(samp, uv + porousHash2(oB), duvdx, duvdy);
  float inv = 1.0 / max(1e-4, pA + pB);
  return textureGrad(samp, uv + porousHash2(oA), duvdx, duvdy) * (pA * inv)
       + textureGrad(samp, uv + porousHash2(oB), duvdx, duvdy) * (pB * inv);
}
#endif
#endif`;

const wgslDefs = `#ifdef POROUS_SURFACE
#ifdef POROUS_TRACK_STATE
var trackStateSamplerSampler: sampler;
var trackStateSampler: texture_2d<f32>;
#endif
fn porousHash2(p: vec2f) -> vec2f {
  return fract(sin(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)))) * 43758.5453);
}
fn porousNoise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  let a = fract(sin(dot(i, vec2f(127.1, 311.7))) * 43758.5453);
  let b = fract(sin(dot(i + vec2f(1.0, 0.0), vec2f(127.1, 311.7))) * 43758.5453);
  let c = fract(sin(dot(i + vec2f(0.0, 1.0), vec2f(127.1, 311.7))) * 43758.5453);
  let d = fract(sin(dot(i + vec2f(1.0, 1.0), vec2f(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
#ifdef POROUS_ROAD
fn porousRainRipples(wp: vec2f, t: f32) -> vec2f {
  let cell = floor(wp * 2.3);
  let f = fract(wp * 2.3) - 0.5;
  let rnd = porousHash2(cell);
  let phase = fract(t * 1.15 + rnd.x);
  let center = (rnd - 0.5) * 0.45;
  let d = f - center;
  let dist = length(d) + 1e-4;
  let wave = sin((dist - phase * 0.48) * 44.0) * exp(-dist * 7.5) * (1.0 - phase) * smoothstep(0.0, 0.08, phase);
  return (d / dist) * wave;
}
#endif
#ifdef POROUS_HEX_BOMB
fn porousHexSample(tex: texture_2d<f32>, samp: sampler, uv: vec2f) -> vec4f {
  let duvdx = dpdx(uv);
  let duvdy = dpdy(uv);
  let h = mat2x2f(1.1547005, 0.0, 0.5773503, 1.0) * (uv * 0.45);
  let i = floor(h);
  let f = fract(h);
  let c1 = i;
  let c2 = i + vec2f(1.0, 1.0);
  let c3 = i + select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), f.x > f.y);
  let w = select(vec3f(1.0 - f.y, f.x, f.y - f.x), vec3f(1.0 - f.x, f.y, f.x - f.y), f.x > f.y);
  var oA = c1; var wA = w.x;
  var oB = c2; var wB = w.y;
  if (w.z > wA && wA <= wB) { oA = c3; wA = w.z; }
  else if (w.z > wB) { oB = c3; wB = w.z; }
  let pA = wA * wA * wA;
  let pB = wB * wB * wB;
  if (wA >= 0.82) { return textureSampleGrad(tex, samp, uv + porousHash2(oA), duvdx, duvdy); }
  if (wB >= 0.82) { return textureSampleGrad(tex, samp, uv + porousHash2(oB), duvdx, duvdy); }
  let inv = 1.0 / max(1e-4, pA + pB);
  return textureSampleGrad(tex, samp, uv + porousHash2(oA), duvdx, duvdy) * (pA * inv)
       + textureSampleGrad(tex, samp, uv + porousHash2(oB), duvdx, duvdy) * (pB * inv);
}
#endif
#endif`;

// Apply Beer-Lambert porous water darkening, crushed-stone micro-aggregate, live rubbering-in,
// off-line marbles, dynamic drying groove, cloud shadow dappling, and mirror-like raindrop puddles.
const glslApply = `#ifdef POROUS_SURFACE
{
  float pWet = porousParams.x;
  float pTime = porousParams.z;
  float pCloud = porousParams.w;
  float pRubber = 0.0;
  float pDryGroove = 0.0;
  float pMarbles = 0.0;
#ifdef POROUS_TRACK_STATE
  vec4 ts = texture2D(trackStateSampler, vDetailUV);
  pWet = clamp(ts.r, 0.0, 1.0);
  pRubber = ts.g;
  pDryGroove = ts.b;
  pMarbles = ts.a;
#endif
  float effWet = clamp(pWet * (1.0 - 0.52 * pDryGroove), 0.0, 1.0);
  float macroVar = 0.87 + 0.26 * porousNoise(vPositionW.xz * 0.036);
  float fineGrain = 0.88 + 0.24 * porousNoise(vPositionW.xz * 2.8 + vec2(3.1, 7.4));
  float poreDarken = mix(1.0, 0.36, pow(effWet, 0.72));
  float rubberDarken = mix(1.0, 0.62, pRubber * (1.0 - 0.45 * effWet));
  float dryLift = 1.0 + 0.36 * pDryGroove * step(0.10, pWet);
  float marbleSpeck = 1.0 - 0.16 * pMarbles * (0.5 + 0.5 * sin(vPositionW.x * 13.7 + vPositionW.z * 11.1));
  float cloudField = porousNoise(vPositionW.xz * 0.0028 + vec2(pTime * 0.018, pTime * 0.009));
  float cloudDapple = mix(1.0, 0.78, smoothstep(0.46, 0.78, cloudField) * pCloud);
  surfaceAlbedo *= macroVar * fineGrain * poreDarken * rubberDarken * dryLift * marbleSpeck * cloudDapple;

#ifdef POROUS_ROAD
  vec3 vDir = normalize(vEyePosition.xyz - vPositionW);
  float ndv = clamp(dot(geometricNormalW, vDir), 0.0, 1.0);
  float grazing = pow(1.0 - ndv, 2.6);
  float grainRnd = porousHash2(floor(vPositionW.xz * 30.0)).x;
  float drySparkle = step(0.87, grainRnd) * (1.0 - effWet * 0.9) * (0.07 + 0.12 * grazing);
  surfaceAlbedo += vec3(drySparkle);

  float dryRough = clamp(roughness * mix(0.95, 0.74, pRubber) * (0.90 + 0.18 * fineGrain), 0.52, 0.88);
  if (effWet > 0.12) {
    float puddleField = porousNoise(vPositionW.xz * 0.072 + vec2(4.1, 8.7)) * 0.78 + (fineGrain - 0.88) * 0.92;
    float puddle = smoothstep(0.36, 0.72, effWet + (puddleField - 0.44) * 0.44);
    float wetFilm = smoothstep(0.12, 0.76, effWet);
    float wetRough = mix(0.28, 0.085, wetFilm);
    wetRough = mix(wetRough, 0.48, pDryGroove * 0.70);
    wetRough = mix(wetRough, 0.02, puddle * 0.94);
    roughness = mix(dryRough, wetRough, smoothstep(0.06, 0.26, pWet));
    microSurface = 1.0 - roughness;
    float schlick = pow(1.0 - ndv, 3.6);
    float waterF0 = mix(0.05, 0.34, clamp(wetFilm * 0.38 + puddle * 0.85, 0.0, 1.0) * (0.45 + 0.55 * schlick));
    reflectivityOut.reflectanceF0 = max(reflectivityOut.reflectanceF0, waterF0);
    reflectivityOut.colorReflectanceF0 = max(reflectivityOut.colorReflectanceF0, vec3(waterF0 * 0.96, waterF0, waterF0 * 1.05));
    float flatAmt = clamp(wetFilm * 0.54 + puddle * 0.42, 0.0, 0.96);
    vec3 flatN = normalize(mix(normalW, geometricNormalW, flatAmt));
    float rippleHighlight = 0.0;
    if (puddle > 0.02 && effWet > 0.38) {
      vec2 rip = porousRainRipples(vPositionW.xz, pTime) * (puddle * smoothstep(0.38, 0.78, effWet) * 0.24);
      flatN = normalize(flatN + vec3(rip.x, 0.0, rip.y));
      rippleHighlight = length(rip) * 0.36;
    }
    normalW = flatN;
    float skyMirror = puddle * schlick * smoothstep(0.20, 0.72, effWet) * (0.11 + rippleHighlight);
    surfaceAlbedo += vec3(0.46, 0.51, 0.58) * skyMirror;
  } else {
    roughness = dryRough;
    microSurface = 1.0 - roughness;
  }
#else
  float sideWet = smoothstep(0.10, 0.85, effWet);
  roughness = clamp(mix(roughness, mix(0.42, 0.14, sideWet), effWet), 0.14, 0.96);
  microSurface = 1.0 - roughness;
  if (sideWet > 0.1) {
    float sideF0 = mix(0.04, 0.10, sideWet);
    reflectivityOut.reflectanceF0 = max(reflectivityOut.reflectanceF0, sideF0);
    reflectivityOut.colorReflectanceF0 = max(reflectivityOut.colorReflectanceF0, vec3(sideF0));
  }
#endif
}
#endif
#include<pbrBlockGeometryInfo>`;

const wgslApply = `#ifdef POROUS_SURFACE
{
  var pWet: f32 = uniforms.porousParams.x;
  let pTime: f32 = uniforms.porousParams.z;
  let pCloud: f32 = uniforms.porousParams.w;
  var pRubber: f32 = 0.0;
  var pDryGroove: f32 = 0.0;
  var pMarbles: f32 = 0.0;
#ifdef POROUS_TRACK_STATE
  let ts = textureSample(trackStateSampler, trackStateSamplerSampler, fragmentInputs.vDetailUV);
  pWet = clamp(ts.r, 0.0, 1.0);
  pRubber = ts.g;
  pDryGroove = ts.b;
  pMarbles = ts.a;
#endif
  let effWet = clamp(pWet * (1.0 - 0.52 * pDryGroove), 0.0, 1.0);
  let macroVar = 0.87 + 0.26 * porousNoise(input.vPositionW.xz * 0.036);
  let fineGrain = 0.88 + 0.24 * porousNoise(input.vPositionW.xz * 2.8 + vec2f(3.1, 7.4));
  let poreDarken = mix(1.0, 0.36, pow(effWet, 0.72));
  let rubberDarken = mix(1.0, 0.62, pRubber * (1.0 - 0.45 * effWet));
  let dryLift = 1.0 + 0.36 * pDryGroove * step(0.10, pWet);
  let marbleSpeck = 1.0 - 0.16 * pMarbles * (0.5 + 0.5 * sin(input.vPositionW.x * 13.7 + input.vPositionW.z * 11.1));
  let cloudField = porousNoise(input.vPositionW.xz * 0.0028 + vec2f(pTime * 0.018, pTime * 0.009));
  let cloudDapple = mix(1.0, 0.78, smoothstep(0.46, 0.78, cloudField) * pCloud);
  surfaceAlbedo *= macroVar * fineGrain * poreDarken * rubberDarken * dryLift * marbleSpeck * cloudDapple;

#ifdef POROUS_ROAD
  let vDir = normalize(scene.vEyePosition.xyz - input.vPositionW);
  let ndv = clamp(dot(geometricNormalW, vDir), 0.0, 1.0);
  let grazing = pow(1.0 - ndv, 2.6);
  let grainRnd = porousHash2(floor(input.vPositionW.xz * 30.0)).x;
  let drySparkle = step(0.87, grainRnd) * (1.0 - effWet * 0.9) * (0.07 + 0.12 * grazing);
  surfaceAlbedo += vec3f(drySparkle);

  let dryRough = clamp(roughness * mix(0.95, 0.74, pRubber) * (0.90 + 0.18 * fineGrain), 0.52, 0.88);
  if (effWet > 0.12) {
    let puddleField = porousNoise(input.vPositionW.xz * 0.072 + vec2f(4.1, 8.7)) * 0.78 + (fineGrain - 0.88) * 0.92;
    let puddle = smoothstep(0.36, 0.72, effWet + (puddleField - 0.44) * 0.44);
    let wetFilm = smoothstep(0.12, 0.76, effWet);
    var wetRough = mix(0.28, 0.085, wetFilm);
    wetRough = mix(wetRough, 0.48, pDryGroove * 0.70);
    wetRough = mix(wetRough, 0.02, puddle * 0.94);
    roughness = mix(dryRough, wetRough, smoothstep(0.06, 0.26, pWet));
    microSurface = 1.0 - roughness;
    let schlick = pow(1.0 - ndv, 3.6);
    let waterF0 = mix(0.05, 0.34, clamp(wetFilm * 0.38 + puddle * 0.85, 0.0, 1.0) * (0.45 + 0.55 * schlick));
    reflectivityOut.reflectanceF0 = max(reflectivityOut.reflectanceF0, waterF0);
    reflectivityOut.colorReflectanceF0 = max(reflectivityOut.colorReflectanceF0, vec3f(waterF0 * 0.96, waterF0, waterF0 * 1.05));
    let flatAmt = clamp(wetFilm * 0.54 + puddle * 0.42, 0.0, 0.96);
    var flatN = normalize(mix(normalW, geometricNormalW, flatAmt));
    var rippleHighlight: f32 = 0.0;
    if (puddle > 0.02 && effWet > 0.38) {
      let rip = porousRainRipples(input.vPositionW.xz, pTime) * (puddle * smoothstep(0.38, 0.78, effWet) * 0.24);
      flatN = normalize(flatN + vec3f(rip.x, 0.0, rip.y));
      rippleHighlight = length(rip) * 0.36;
    }
    normalW = flatN;
    let skyMirror = puddle * schlick * smoothstep(0.20, 0.72, effWet) * (0.11 + rippleHighlight);
    surfaceAlbedo += vec3f(0.46, 0.51, 0.58) * skyMirror;
  } else {
    roughness = dryRough;
    microSurface = 1.0 - roughness;
  }
#else
  let sideWet = smoothstep(0.10, 0.85, effWet);
  roughness = clamp(mix(roughness, mix(0.42, 0.14, sideWet), effWet), 0.14, 0.96);
  microSurface = 1.0 - roughness;
  if (sideWet > 0.1) {
    let sideF0 = mix(0.04, 0.10, sideWet);
    reflectivityOut.reflectanceF0 = max(reflectivityOut.reflectanceF0, sideF0);
    reflectivityOut.colorReflectanceF0 = max(reflectivityOut.colorReflectanceF0, vec3f(sideF0));
  }
#endif
}
#endif
#include<pbrBlockGeometryInfo>`;

export class PorousSurfacePlugin extends MaterialPluginBase {
  ambientWetness = 0;
  time = 0;
  cloudShadowStrength = 0.42;
  readonly isRoad: boolean;
  readonly hexBomb: boolean;
  trackStateTexture: RawTexture | null;

  constructor(
    material: PBRMaterial,
    options: { isRoad?: boolean; hexBomb?: boolean; trackStateTexture?: RawTexture | null } = {},
  ) {
    super(material, 'PorousSurface', 200, new PorousSurfaceDefines());
    this.isRoad = options.isRoad ?? false;
    this.hexBomb = options.hexBomb ?? true;
    this.trackStateTexture = options.trackStateTexture ?? null;
    this._enable(true);
  }

  override isCompatible(_shaderLanguage: ShaderLanguage) {
    return true;
  }

  override getClassName() {
    return 'PorousSurfacePlugin';
  }

  override prepareDefines(defines: PorousSurfaceDefines) {
    defines.POROUS_SURFACE = true;
    defines.POROUS_ROAD = this.isRoad;
    defines.POROUS_TRACK_STATE = Boolean(this.isRoad && this.trackStateTexture);
    defines.POROUS_HEX_BOMB = this.hexBomb;
  }

  override getUniforms(shaderLanguage = ShaderLanguage.GLSL) {
    return {
      ubo: [{ name: 'porousParams', size: 4, type: 'vec4' }],
      fragment:
        shaderLanguage === ShaderLanguage.WGSL
          ? `#ifdef POROUS_SURFACE\nuniform porousParams: vec4f;\n#endif`
          : `#ifdef POROUS_SURFACE\nuniform vec4 porousParams;\n#endif`,
    };
  }

  override getSamplers(samplers: string[]) {
    if (this.isRoad && this.trackStateTexture) samplers.push('trackStateSampler');
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene) {
    uniformBuffer.updateFloat4(
      'porousParams',
      this.ambientWetness,
      this.isRoad ? 1 : 0,
      this.time,
      this.cloudShadowStrength,
    );
    if (this.isRoad && this.trackStateTexture) {
      uniformBuffer.setTexture('trackStateSampler', this.trackStateTexture);
    }
  }

  override getCustomCode(shaderType: string, shaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== 'fragment') return null;
    if (shaderLanguage === ShaderLanguage.WGSL) {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: wgslDefs,
        '!var albedoTexture: vec4f=textureSample\\(albedoSampler,albedoSamplerSampler,fragmentInputs\\.vAlbedoUV\\+uvOffset\\);':
          `#ifdef POROUS_HEX_BOMB\nvar albedoTexture: vec4f=porousHexSample(albedoSampler,albedoSamplerSampler,fragmentInputs.vAlbedoUV+uvOffset);\n#else\nvar albedoTexture: vec4f=textureSample(albedoSampler,albedoSamplerSampler,fragmentInputs.vAlbedoUV+uvOffset);\n#endif`,
        '!#include<pbrBlockGeometryInfo>': wgslApply,
      };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: glslDefs,
      '!vec4 albedoTexture=texture2D\\(albedoSampler,vAlbedoUV\\+uvOffset\\);':
        `#ifdef POROUS_HEX_BOMB\nvec4 albedoTexture=porousHexSample(albedoSampler,vAlbedoUV+uvOffset);\n#else\nvec4 albedoTexture=texture2D(albedoSampler,vAlbedoUV+uvOffset);\n#endif`,
      '!#include<pbrBlockGeometryInfo>': glslApply,
    };
  }
}
