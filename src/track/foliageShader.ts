import { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';

class FoliageAtmosphericDefines extends MaterialDefines {
  FOLIAGE_ATMOS = false;
  FOLIAGE_WIND = false;
}

const glslVertexApply = `#ifdef FOLIAGE_WIND
{
  // World-space multi-frequency wind gust wave weighted by height above base (v.y)
  float hFactor = clamp(positionUpdated.y * foliageWind.z, 0.0, 1.0);
  float flex = hFactor * hFactor;
  vec3 worldBase = vec3(finalWorld[3][0], finalWorld[3][1], finalWorld[3][2]);
  float phase = foliageWind.x * 1.45 + worldBase.x * 0.085 + worldBase.z * 0.072;
  float gust = sin(phase) * 0.65 + sin(phase * 2.13 + positionUpdated.x * 1.9) * 0.35;
  float flutter = sin(foliageWind.x * 3.7 + worldBase.x * 0.31 + positionUpdated.y * 2.4 + positionUpdated.z * 1.7);
  float amp = foliageWind.y * flex;
  positionUpdated.x += (gust * 0.72 + flutter * 0.16) * amp;
  positionUpdated.z += (gust * 0.44 - flutter * 0.14) * amp;
  positionUpdated.y -= abs(gust) * amp * 0.09;
}
#endif
#include<morphTargetsVertexGlobal>`;

const wgslVertexApply = `#ifdef FOLIAGE_WIND
{
  let hFactor = clamp(positionUpdated.y * uniforms.foliageWind.z, 0.0, 1.0);
  let flex = hFactor * hFactor;
  let worldBase = vec3f(finalWorld[3].x, finalWorld[3].y, finalWorld[3].z);
  let phase = uniforms.foliageWind.x * 1.45 + worldBase.x * 0.085 + worldBase.z * 0.072;
  let gust = sin(phase) * 0.65 + sin(phase * 2.13 + positionUpdated.x * 1.9) * 0.35;
  let flutter = sin(uniforms.foliageWind.x * 3.7 + worldBase.x * 0.31 + positionUpdated.y * 2.4 + positionUpdated.z * 1.7);
  let amp = uniforms.foliageWind.y * flex;
  positionUpdated.x += (gust * 0.72 + flutter * 0.16) * amp;
  positionUpdated.z += (gust * 0.44 - flutter * 0.14) * amp;
  positionUpdated.y -= abs(gust) * amp * 0.09;
}
#endif
#include<morphTargetsVertexGlobal>`;

// View-dependent sunlit subsurface translucency + subtle world-space organic tonal variety
// + gentle sunlit crown lift so Mediterranean trees read lush, volumetric, and never muddy!
const glslFragmentApply = `#ifdef FOLIAGE_ATMOS
{
  vec3 toSun = normalize(foliageSun.xyz);
  vec3 toCam = normalize(vEyePosition.xyz - vPositionW);
  // Subtle per-tree warm/cool organic variation based on coarse world position
  float patchTone = sin(vPositionW.x * 0.047 + vPositionW.z * 0.039) * 0.065
                  + cos(vPositionW.x * 0.11 - vPositionW.z * 0.09) * 0.035;
  surfaceAlbedo *= vec3(1.0 + patchTone * 0.9, 1.0 + patchTone * 0.65, 1.0 - patchTone * 0.45);
  // Forward-scattered sun translucency when looking toward the sun through leaves
  float backLight = pow(clamp(dot(-toCam, toSun), 0.0, 1.0), 3.2);
  float wrapSun = clamp(dot(normalW, toSun) * 0.45 + 0.55, 0.0, 1.0);
  float sss = (backLight * 0.78 + wrapSun * 0.22) * foliageSun.w;
  // Wet-weather darkening & subtle leaf sheen when damp/rainy
  float wetF = foliageColor.w;
  surfaceAlbedo *= mix(1.0, 0.74, wetF);
  roughness = clamp(mix(roughness, 0.48, wetF * 0.75), 0.38, 0.96);
  microSurface = 1.0 - roughness;
  // Inject warm-green backlit leaf transmission directly into albedo bounce before final lighting
  surfaceAlbedo += surfaceAlbedo * foliageColor.rgb * (sss * 0.62);
}
#endif
#include<pbrBlockGeometryInfo>`;

const wgslFragmentApply = `#ifdef FOLIAGE_ATMOS
{
  let toSun = normalize(uniforms.foliageSun.xyz);
  let toCam = normalize(scene.vEyePosition.xyz - input.vPositionW);
  let patchTone = sin(input.vPositionW.x * 0.047 + input.vPositionW.z * 0.039) * 0.065
                + cos(input.vPositionW.x * 0.11 - input.vPositionW.z * 0.09) * 0.035;
  surfaceAlbedo *= vec3f(1.0 + patchTone * 0.9, 1.0 + patchTone * 0.65, 1.0 - patchTone * 0.45);
  let backLight = pow(clamp(dot(-toCam, toSun), 0.0, 1.0), 3.2);
  let wrapSun = clamp(dot(normalW, toSun) * 0.45 + 0.55, 0.0, 1.0);
  let sss = (backLight * 0.78 + wrapSun * 0.22) * uniforms.foliageSun.w;
  let wetF = uniforms.foliageColor.w;
  surfaceAlbedo *= mix(1.0, 0.74, wetF);
  roughness = clamp(mix(roughness, 0.48, wetF * 0.75), 0.38, 0.96);
  microSurface = 1.0 - roughness;
  surfaceAlbedo += surfaceAlbedo * uniforms.foliageColor.rgb * (sss * 0.62);
}
#endif
#include<pbrBlockGeometryInfo>`;

export class FoliageAtmosphericPlugin extends MaterialPluginBase {
  time = 0;
  windStrength = 0.18;
  invHeight = 0.085;
  sunDir: [number, number, number] = [0.65, 0.28, 0.71];
  sssIntensity = 0.55;
  sssColor: [number, number, number] = [0.78, 0.95, 0.34];
  wetness = 0;
  readonly windEnabled: boolean;

  constructor(
    material: PBRMaterial,
    options: { wind?: boolean; invHeight?: number; sssIntensity?: number } = {},
  ) {
    super(material, 'FoliageAtmospheric', 210, new FoliageAtmosphericDefines());
    this.windEnabled = options.wind ?? true;
    this.invHeight = options.invHeight ?? 0.085;
    this.sssIntensity = options.sssIntensity ?? 0.55;
    this._enable(true);
  }

  override isCompatible(_shaderLanguage: ShaderLanguage) {
    return true;
  }

  override getClassName() {
    return 'FoliageAtmosphericPlugin';
  }

  override prepareDefines(defines: FoliageAtmosphericDefines) {
    defines.FOLIAGE_ATMOS = true;
    defines.FOLIAGE_WIND = this.windEnabled;
  }

  override getUniforms(shaderLanguage = ShaderLanguage.GLSL) {
    const ubo = [
      { name: 'foliageWind', size: 4, type: 'vec4' },
      { name: 'foliageSun', size: 4, type: 'vec4' },
      { name: 'foliageColor', size: 4, type: 'vec4' },
    ];
    if (shaderLanguage === ShaderLanguage.WGSL) {
      return {
        ubo,
        vertex: `#ifdef FOLIAGE_WIND\nuniform foliageWind: vec4f;\n#endif`,
        fragment: `#ifdef FOLIAGE_ATMOS\nuniform foliageSun: vec4f;\nuniform foliageColor: vec4f;\n#endif`,
      };
    }
    return {
      ubo,
      vertex: `#ifdef FOLIAGE_WIND\nuniform vec4 foliageWind;\n#endif`,
      fragment: `#ifdef FOLIAGE_ATMOS\nuniform vec4 foliageSun;\nuniform vec4 foliageColor;\n#endif`,
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene) {
    uniformBuffer.updateFloat4('foliageWind', this.time, this.windStrength, this.invHeight, 0);
    uniformBuffer.updateFloat4('foliageSun', this.sunDir[0], this.sunDir[1], this.sunDir[2], this.sssIntensity);
    uniformBuffer.updateFloat4('foliageColor', this.sssColor[0], this.sssColor[1], this.sssColor[2], this.wetness);
  }

  override getCustomCode(shaderType: string, shaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType === 'vertex') {
      return {
        '!#include<morphTargetsVertexGlobal>':
          shaderLanguage === ShaderLanguage.WGSL ? wgslVertexApply : glslVertexApply,
      };
    }
    if (shaderType === 'fragment') {
      return {
        '!#include<pbrBlockGeometryInfo>':
          shaderLanguage === ShaderLanguage.WGSL ? wgslFragmentApply : glslFragmentApply,
      };
    }
    return null;
  }
}
