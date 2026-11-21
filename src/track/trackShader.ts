import { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import type { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';

class PorousSurfaceDefines extends MaterialDefines {
  POROUS_SURFACE = false;
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
// Animated raindrop concentric ripple normal perturbation inside standing asphalt puddles
vec2 porousRainRipples(vec2 wp, float t) {
  vec2 cell = floor(wp * 2.2);
  vec2 f = fract(wp * 2.2) - 0.5;
  vec2 rnd = porousHash2(cell);
  float phase = fract(t * 1.15 + rnd.x);
  vec2 center = (rnd - 0.5) * 0.45;
  vec2 d = f - center;
  float dist = length(d) + 1e-4;
  float wave = sin((dist - phase * 0.48) * 44.0) * exp(-dist * 7.5) * (1.0 - phase) * smoothstep(0.0, 0.08, phase);
  return (d / dist) * wave;
}
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
fn porousRainRipples(wp: vec2f, t: f32) -> vec2f {
  let cell = floor(wp * 2.2);
  let f = fract(wp * 2.2) - 0.5;
  let rnd = porousHash2(cell);
  let phase = fract(t * 1.15 + rnd.x);
  let center = (rnd - 0.5) * 0.45;
  let d = f - center;
  let dist = length(d) + 1e-4;
  let wave = sin((dist - phase * 0.48) * 44.0) * exp(-dist * 7.5) * (1.0 - phase) * smoothstep(0.0, 0.08, phase);
  return (d / dist) * wave;
}
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
#endif`;

// Apply Beer-Lambert porous water darkening, aggregate micro-sparkle, live rubbering-in,
// off-line marbles, dynamic drying groove, cloud shadow dappling, and raindrop puddle ripples.
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
  float effWet = clamp(pWet * (1.0 - 0.55 * pDryGroove), 0.0, 1.0);
  // Subtle world-space macro tonal breakup (eliminates repeating asphalt patches at speed)
  float macroVar = 0.93 + 0.14 * porousNoise(vPositionW.xz * 0.042);
  float poreDarken = mix(1.0, 0.54, pow(effWet, 0.78));
  float rubberDarken = mix(1.0, 0.76, pRubber * (1.0 - 0.5 * effWet));
  float dryLift = 1.0 + 0.24 * pDryGroove * step(0.12, pWet);
  float marbleSpeck = 1.0 - 0.09 * pMarbles * (0.5 + 0.5 * sin(vPositionW.x * 11.3 + vPositionW.z * 9.7));
  // Soft cohesive drifting cloud shadows across track & kerbs matching terrain shader
  float cloudField = porousNoise(vPositionW.xz * 0.0028 + vec2(pTime * 0.018, pTime * 0.009));
  float cloudDapple = mix(1.0, 0.80, smoothstep(0.46, 0.78, cloudField) * pCloud);
  surfaceAlbedo *= macroVar * poreDarken * rubberDarken * dryLift * marbleSpeck * cloudDapple;

  if (porousParams.y > 0.5) {
    // Crushed-stone micro-aggregate glint on dry/damp tarmac catching low sun
    vec2 grainCell = floor(vPositionW.xz * 26.0);
    float grainRnd = porousHash2(grainCell).x;
    float drySparkle = step(0.92, grainRnd) * (1.0 - effWet * 0.85) * 0.085;
    surfaceAlbedo += vec3(drySparkle);

    float dryRough = clamp(roughness * mix(1.0, 0.88, pRubber), 0.62, 0.94);
    if (effWet > 0.22) {
      // Localized standing water pockets using organic low-frequency noise + camber wetness
      float puddleNoise = porousNoise(vPositionW.xz * 0.11 + vec2(4.1, 8.7));
      float puddle = smoothstep(0.62, 0.94, effWet + (puddleNoise - 0.46) * 0.28);
      float wetRough = mix(0.54, 0.30, clamp(effWet * 1.18, 0.0, 1.0));
      wetRough = mix(wetRough, 0.62, pDryGroove * 0.72);
      wetRough = mix(wetRough, 0.09, puddle * 0.82); // Standing water puddles reflect crisp sky & brake lights
      roughness = mix(dryRough, wetRough, smoothstep(0.02, 0.24, pWet));
      microSurface = 1.0 - roughness;
      if (puddle > 0.01) {
        vec3 flatN = normalize(mix(normalW, geometricNormalW, puddle * 0.82));
        // Add live expanding raindrop concentric ripple rings inside heavy-rain puddles!
        if (effWet > 0.52) {
          vec2 rip = porousRainRipples(vPositionW.xz, pTime) * (puddle * smoothstep(0.52, 0.85, effWet) * 0.18);
          flatN = normalize(flatN + vec3(rip.x, 0.0, rip.y));
        }
        normalW = flatN;
      }
    } else {
      roughness = dryRough;
      microSurface = 1.0 - roughness;
    }
  } else {
    roughness = clamp(mix(roughness, max(0.44, roughness * 0.72), effWet), 0.40, 0.98);
    microSurface = 1.0 - roughness;
  }
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
  let effWet = clamp(pWet * (1.0 - 0.55 * pDryGroove), 0.0, 1.0);
  let macroVar = 0.93 + 0.14 * porousNoise(input.vPositionW.xz * 0.042);
  let poreDarken = mix(1.0, 0.54, pow(effWet, 0.78));
  let rubberDarken = mix(1.0, 0.76, pRubber * (1.0 - 0.5 * effWet));
  let dryLift = 1.0 + 0.24 * pDryGroove * step(0.12, pWet);
  let marbleSpeck = 1.0 - 0.09 * pMarbles * (0.5 + 0.5 * sin(input.vPositionW.x * 11.3 + input.vPositionW.z * 9.7));
  let cloudField = porousNoise(input.vPositionW.xz * 0.0028 + vec2f(pTime * 0.018, pTime * 0.009));
  let cloudDapple = mix(1.0, 0.80, smoothstep(0.46, 0.78, cloudField) * pCloud);
  surfaceAlbedo *= macroVar * poreDarken * rubberDarken * dryLift * marbleSpeck * cloudDapple;

  if (uniforms.porousParams.y > 0.5) {
    let grainCell = floor(input.vPositionW.xz * 26.0);
    let grainRnd = porousHash2(grainCell).x;
    let drySparkle = step(0.92, grainRnd) * (1.0 - effWet * 0.85) * 0.085;
    surfaceAlbedo += vec3f(drySparkle);

    let dryRough = clamp(roughness * mix(1.0, 0.88, pRubber), 0.62, 0.94);
    if (effWet > 0.22) {
      let puddleNoise = porousNoise(input.vPositionW.xz * 0.11 + vec2f(4.1, 8.7));
      let puddle = smoothstep(0.62, 0.94, effWet + (puddleNoise - 0.46) * 0.28);
      var wetRough = mix(0.54, 0.30, clamp(effWet * 1.18, 0.0, 1.0));
      wetRough = mix(wetRough, 0.62, pDryGroove * 0.72);
      wetRough = mix(wetRough, 0.09, puddle * 0.82);
      roughness = mix(dryRough, wetRough, smoothstep(0.02, 0.24, pWet));
      microSurface = 1.0 - roughness;
      if (puddle > 0.01) {
        var flatN = normalize(mix(normalW, geometricNormalW, puddle * 0.82));
        if (effWet > 0.52) {
          let rip = porousRainRipples(input.vPositionW.xz, pTime) * (puddle * smoothstep(0.52, 0.85, effWet) * 0.18);
          flatN = normalize(flatN + vec3f(rip.x, 0.0, rip.y));
        }
        normalW = flatN;
      }
    } else {
      roughness = dryRough;
      microSurface = 1.0 - roughness;
    }
  } else {
    roughness = clamp(mix(roughness, max(0.44, roughness * 0.72), effWet), 0.40, 0.98);
    microSurface = 1.0 - roughness;
  }
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
