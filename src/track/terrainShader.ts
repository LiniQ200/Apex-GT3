import { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';

class TerrainBiomeDefines extends MaterialDefines {
  TERRAIN_BIOME = false;
}

const glslDefs = `#ifdef TERRAIN_BIOME
float tbHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float tbNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(tbHash(i), tbHash(i + vec2(1.0, 0.0)), f.x),
    mix(tbHash(i + vec2(0.0, 1.0)), tbHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
#endif`;

const wgslDefs = `#ifdef TERRAIN_BIOME
fn tbHash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}
fn tbNoise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(tbHash(i), tbHash(i + vec2f(1.0, 0.0)), f.x),
    mix(tbHash(i + vec2f(0.0, 1.0)), tbHash(i + vec2f(1.0, 1.0)), f.x),
    f.y
  );
}
#endif`;

// Multi-biome Tuscan landscape shader:
//  - World-space meadow variation (lush grass vs sun-baked Tuscan straw & olive earth)
//  - Slope-driven limestone cliff strata on steeper hillside cuts
//  - Drifting soft cloud-shadow dappling across the Apennine foothills
//  - Wetness pore darkening in damp/rain
const glslApply = `#ifdef TERRAIN_BIOME
{
  vec2 wp = vPositionW.xz;
  float macro = tbNoise(wp * 0.011);
  float med = tbNoise(wp * 0.048 + vec2(7.3, 2.1));
  float fine = tbNoise(wp * 0.22 + vec2(3.7, 11.4));
  // Rich Mediterranean grass / sun-baked dry straw / olive soil breakup (breaks tiling completely)
  vec3 lushTint = vec3(0.74, 0.88, 0.56);
  vec3 strawTint = vec3(1.16, 1.04, 0.72);
  vec3 earthTint = vec3(0.84, 0.74, 0.58);
  vec3 biomeTint = mix(lushTint, strawTint, smoothstep(0.32, 0.74, macro * 0.7 + med * 0.3));
  biomeTint = mix(biomeTint, earthTint, smoothstep(0.58, 0.88, med) * 0.42);
  surfaceAlbedo *= biomeTint * (0.90 + 0.18 * fine);

  // Slope-driven Apennine limestone cliff rock strata on steeper hills + Tuscan vineyard contour rows
  float slope = 1.0 - clamp(geometricNormalW.y, 0.0, 1.0);
  float rockMask = smoothstep(0.08, 0.24, slope + (med - 0.5) * 0.06);
  if (rockMask > 0.01) {
    float strata = 0.76 + 0.24 * sin(vPositionW.y * 1.65 + med * 4.2 + fine * 1.8);
    vec3 limestone = vec3(0.38, 0.35, 0.30) * strata;
    surfaceAlbedo = mix(surfaceAlbedo, limestone, rockMask * 0.84);
    roughness = mix(roughness, 0.86, rockMask);
  } else if (vPositionW.y > 4.5) {
    // Subtle Tuscan olive/vineyard terraced rows across distant sunny Apennine slopes
    float rows = 0.90 + 0.10 * sin(wp.x * 0.42 + wp.y * 0.28 + macro * 3.5);
    surfaceAlbedo *= mix(1.0, rows, smoothstep(4.5, 18.0, vPositionW.y));
  }

  // Soft drifting cloud-shadow dappling across hills and circuit verges
  float cloudUV = tbNoise(wp * 0.0028 + vec2(terrainParams.x * 0.018, terrainParams.x * 0.009));
  float cloudShadow = mix(1.0, 0.78, smoothstep(0.46, 0.78, cloudUV) * terrainParams.z);
  // Wet soil & grass darkening
  float wet = terrainParams.y;
  surfaceAlbedo *= cloudShadow * mix(1.0, 0.64, wet);
  roughness = clamp(mix(roughness, 0.58, wet * 0.7), 0.48, 0.98);
  microSurface = 1.0 - roughness;
}
#endif
#include<pbrBlockGeometryInfo>`;

const wgslApply = `#ifdef TERRAIN_BIOME
{
  let wp = input.vPositionW.xz;
  let macro = tbNoise(wp * 0.011);
  let med = tbNoise(wp * 0.048 + vec2f(7.3, 2.1));
  let fine = tbNoise(wp * 0.22 + vec2f(3.7, 11.4));
  let lushTint = vec3f(0.74, 0.88, 0.56);
  let strawTint = vec3f(1.16, 1.04, 0.72);
  let earthTint = vec3f(0.84, 0.74, 0.58);
  var biomeTint = mix(lushTint, strawTint, smoothstep(0.32, 0.74, macro * 0.7 + med * 0.3));
  biomeTint = mix(biomeTint, earthTint, smoothstep(0.58, 0.88, med) * 0.42);
  surfaceAlbedo *= biomeTint * (0.90 + 0.18 * fine);

  let slope = 1.0 - clamp(geometricNormalW.y, 0.0, 1.0);
  let rockMask = smoothstep(0.08, 0.24, slope + (med - 0.5) * 0.06);
  if (rockMask > 0.01) {
    let strata = 0.76 + 0.24 * sin(input.vPositionW.y * 1.65 + med * 4.2 + fine * 1.8);
    let limestone = vec3f(0.38, 0.35, 0.30) * strata;
    surfaceAlbedo = mix(surfaceAlbedo, limestone, rockMask * 0.84);
    roughness = mix(roughness, 0.86, rockMask);
  } else if (input.vPositionW.y > 4.5) {
    let rows = 0.90 + 0.10 * sin(wp.x * 0.42 + wp.y * 0.28 + macro * 3.5);
    surfaceAlbedo *= mix(1.0, rows, smoothstep(4.5, 18.0, input.vPositionW.y));
  }

  let cloudUV = tbNoise(wp * 0.0028 + vec2f(uniforms.terrainParams.x * 0.018, uniforms.terrainParams.x * 0.009));
  let cloudShadow = mix(1.0, 0.78, smoothstep(0.46, 0.78, cloudUV) * uniforms.terrainParams.z);
  let wet = uniforms.terrainParams.y;
  surfaceAlbedo *= cloudShadow * mix(1.0, 0.64, wet);
  roughness = clamp(mix(roughness, 0.58, wet * 0.7), 0.48, 0.98);
  microSurface = 1.0 - roughness;
}
#endif
#include<pbrBlockGeometryInfo>`;

export class TerrainTriplanarPlugin extends MaterialPluginBase {
  time = 0;
  wetness = 0;
  cloudShadowStrength = 0.45;

  constructor(material: PBRMaterial) {
    super(material, 'TerrainTriplanar', 205, new TerrainBiomeDefines());
    this._enable(true);
  }

  override isCompatible(_shaderLanguage: ShaderLanguage) {
    return true;
  }

  override getClassName() {
    return 'TerrainTriplanarPlugin';
  }

  override prepareDefines(defines: TerrainBiomeDefines) {
    defines.TERRAIN_BIOME = true;
  }

  override getUniforms(shaderLanguage = ShaderLanguage.GLSL) {
    return {
      ubo: [{ name: 'terrainParams', size: 4, type: 'vec4' }],
      fragment:
        shaderLanguage === ShaderLanguage.WGSL
          ? `#ifdef TERRAIN_BIOME\nuniform terrainParams: vec4f;\n#endif`
          : `#ifdef TERRAIN_BIOME\nuniform vec4 terrainParams;\n#endif`,
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene) {
    uniformBuffer.updateFloat4('terrainParams', this.time, this.wetness, this.cloudShadowStrength, 0);
  }

  override getCustomCode(shaderType: string, shaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: shaderLanguage === ShaderLanguage.WGSL ? wgslDefs : glslDefs,
      '!#include<pbrBlockGeometryInfo>': shaderLanguage === ShaderLanguage.WGSL ? wgslApply : glslApply,
    };
  }
}
