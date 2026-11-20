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
  // Blend the two dominant hex cells with cubic sharpening (eliminates tiling at 2/3 the bandwidth)
  vec2 oA = c1; float wA = w.x;
  vec2 oB = c2; float wB = w.y;
  if (w.z > wA && wA <= wB) { oA = c3; wA = w.z; }
  else if (w.z > wB) { oB = c3; wB = w.z; }
  float pA = wA * wA * wA;
  float pB = wB * wB * wB;
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
  let inv = 1.0 / max(1e-4, pA + pB);
  return textureSampleGrad(tex, samp, uv + porousHash2(oA), duvdx, duvdy) * (pA * inv)
       + textureSampleGrad(tex, samp, uv + porousHash2(oB), duvdx, duvdy) * (pB * inv);
}
#endif`;

// Apply Beer-Lambert porous water darkening, aggregate roughness clamping (never mirror glass!),
// live rubbering-in, off-line marbles, and dynamic lighter/grittier drying racing groove.
const glslApply = `#ifdef POROUS_SURFACE
{
  float pWet = porousParams.x;
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
  // Effective moisture in asphalt pores (reduced along actively swept drying racing groove)
  float effWet = clamp(pWet * (1.0 - 0.55 * pDryGroove), 0.0, 1.0);
  // Beer-Lambert internal scattering in wet stone pores: darkens dry grey asphalt 45-58% realistically
  float poreDarken = mix(1.0, 0.44, pow(effWet, 0.78));
  // Dry vulcanized rubber darkens the racing groove; dusty marbles lift/mottle off-line
  float rubberDarken = mix(1.0, 0.78, pRubber * (1.0 - 0.5 * effWet));
  float dryLift = 1.0 + 0.24 * pDryGroove * step(0.12, pWet);
  float marbleSpeck = 1.0 - 0.08 * pMarbles * (0.5 + 0.5 * sin(vPositionW.x * 11.3 + vPositionW.z * 9.7));
  surfaceAlbedo *= poreDarken * rubberDarken * dryLift * marbleSpeck;

  // Crushed-stone aggregate roughness stays tactile (0.34-0.58 wet, 0.72-0.92 dry) — NEVER a mirror slab!
  if (porousParams.y > 0.5) {
    float dryRough = clamp(roughness * mix(1.0, 0.90, pRubber), 0.64, 0.95);
    // Standing water pockets only form subtly in low camber depressions at heavy rain (effWet > 0.78)
    float puddle = smoothstep(0.76, 0.98, effWet);
    float wetRough = mix(0.56, 0.34, clamp(effWet * 1.15, 0.0, 1.0));
    wetRough = mix(wetRough, 0.64, pDryGroove * 0.72); // Drying groove is visibly grittier
    wetRough = mix(wetRough, 0.28, puddle * 0.45);
    roughness = mix(dryRough, wetRough, smoothstep(0.02, 0.25, pWet));
    microSurface = 1.0 - roughness;
    // Subtly relax normal relief only inside localized high-rain camber pockets
    if (puddle > 0.01) {
      normalW = normalize(mix(normalW, geometricNormalW, puddle * 0.45));
    }
  } else {
    // Non-road porous stone/gravel/concrete: darken pores and modestly lower roughness when damp
    roughness = clamp(mix(roughness, max(0.46, roughness * 0.74), effWet), 0.42, 0.98);
    microSurface = 1.0 - roughness;
  }
}
#endif
#include<pbrBlockGeometryInfo>`;

const wgslApply = `#ifdef POROUS_SURFACE
{
  var pWet: f32 = uniforms.porousParams.x;
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
  let poreDarken = mix(1.0, 0.44, pow(effWet, 0.78));
  let rubberDarken = mix(1.0, 0.78, pRubber * (1.0 - 0.5 * effWet));
  let dryLift = 1.0 + 0.24 * pDryGroove * step(0.12, pWet);
  let marbleSpeck = 1.0 - 0.08 * pMarbles * (0.5 + 0.5 * sin(input.vPositionW.x * 11.3 + input.vPositionW.z * 9.7));
  surfaceAlbedo *= poreDarken * rubberDarken * dryLift * marbleSpeck;

  if (uniforms.porousParams.y > 0.5) {
    let dryRough = clamp(roughness * mix(1.0, 0.90, pRubber), 0.64, 0.95);
    let puddle = smoothstep(0.76, 0.98, effWet);
    var wetRough = mix(0.56, 0.34, clamp(effWet * 1.15, 0.0, 1.0));
    wetRough = mix(wetRough, 0.64, pDryGroove * 0.72);
    wetRough = mix(wetRough, 0.28, puddle * 0.45);
    roughness = mix(dryRough, wetRough, smoothstep(0.02, 0.25, pWet));
    microSurface = 1.0 - roughness;
    if (puddle > 0.01) {
      normalW = normalize(mix(normalW, geometricNormalW, puddle * 0.45));
    }
  } else {
    roughness = clamp(mix(roughness, max(0.46, roughness * 0.74), effWet), 0.42, 0.98);
    microSurface = 1.0 - roughness;
  }
}
#endif
#include<pbrBlockGeometryInfo>`;

export class PorousSurfacePlugin extends MaterialPluginBase {
  ambientWetness = 0;
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
    uniformBuffer.updateFloat4('porousParams', this.ambientWetness, this.isRoad ? 1 : 0, 0, 0);
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
