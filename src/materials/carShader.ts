import { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';

// ---------------------------------------------------------------------------
// 1. Metallic Clearcoat Micro-Flake & Ground-Proximity AO for GT3 Bodywork
// ---------------------------------------------------------------------------
class CarFinishDefines extends MaterialDefines {
  CAR_FINISH_FX = false;
}

const carGlslDefs = `#ifdef CAR_FINISH_FX
float cfHash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
#endif`;

const carWgslDefs = `#ifdef CAR_FINISH_FX
fn cfHash3(pIn: vec3f) -> f32 {
  var p = fract(pIn * 0.3183099 + vec3f(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
#endif`;

const carGlslApply = `#ifdef CAR_FINISH_FX
{
  // Procedural metallic flake micro-glint + rain-slicked clearcoat water beading
  vec3 vDir = normalize(vEyePosition.xyz - vPositionW);
  float ndv = clamp(dot(normalW, vDir), 0.0, 1.0);
  vec3 cell = floor(vPositionW * 420.0);
  float flk = cfHash3(cell);
  float glint = step(0.86, flk) * pow(1.0 - ndv, 1.35) * (0.28 + 0.72 * ndv);
  surfaceAlbedo += surfaceAlbedo * (glint * 0.36);
  // Dynamic wet-weather bodywork sheen & raindrop beading micro-sparkle
  float carWet = carFinishParams.x;
  if (carWet > 0.05) {
    float bead = step(0.90, cfHash3(floor(vPositionW * 165.0)));
    surfaceAlbedo *= mix(1.0, 0.88, carWet);
    roughness = mix(roughness, 0.09, carWet * 0.72);
    microSurface = 1.0 - roughness;
    surfaceAlbedo += vec3(0.14) * (bead * carWet * pow(1.0 - ndv, 1.8));
  }
  // Subtle curved body-bottom ambient occlusion (grounds diffuser, sills, and front splitter)
  float lowAo = smoothstep(0.03, 0.42, max(0.0, vPositionW.y));
  surfaceAlbedo *= mix(0.76, 1.0, lowAo * 0.65 + 0.35);
}
#endif
#include<pbrBlockGeometryInfo>`;

const carWgslApply = `#ifdef CAR_FINISH_FX
{
  let vDir = normalize(scene.vEyePosition.xyz - input.vPositionW);
  let ndv = clamp(dot(normalW, vDir), 0.0, 1.0);
  let cell = floor(input.vPositionW * 420.0);
  let flk = cfHash3(cell);
  let glint = step(0.86, flk) * pow(1.0 - ndv, 1.35) * (0.28 + 0.72 * ndv);
  surfaceAlbedo += surfaceAlbedo * (glint * 0.36);
  let carWet = uniforms.carFinishParams.x;
  if (carWet > 0.05) {
    let bead = step(0.90, cfHash3(floor(input.vPositionW * 165.0)));
    surfaceAlbedo *= mix(1.0, 0.88, carWet);
    roughness = mix(roughness, 0.09, carWet * 0.72);
    microSurface = 1.0 - roughness;
    surfaceAlbedo += vec3f(0.14) * (bead * carWet * pow(1.0 - ndv, 1.8));
  }
  let lowAo = smoothstep(0.03, 0.42, max(0.0, input.vPositionW.y));
  surfaceAlbedo *= mix(0.76, 1.0, lowAo * 0.65 + 0.35);
}
#endif
#include<pbrBlockGeometryInfo>`;

export class CarFinishShaderPlugin extends MaterialPluginBase {
  wetness = 0;

  constructor(material: PBRMaterial) {
    super(material, 'CarFinishFX', 215, new CarFinishDefines());
    this._enable(true);
  }
  override isCompatible(_shaderLanguage: ShaderLanguage) {
    return true;
  }
  override getClassName() {
    return 'CarFinishShaderPlugin';
  }
  override prepareDefines(defines: CarFinishDefines) {
    defines.CAR_FINISH_FX = true;
  }
  override getUniforms(shaderLanguage = ShaderLanguage.GLSL) {
    return {
      ubo: [{ name: 'carFinishParams', size: 4, type: 'vec4' }],
      fragment:
        shaderLanguage === ShaderLanguage.WGSL
          ? `#ifdef CAR_FINISH_FX\nuniform carFinishParams: vec4f;\n#endif`
          : `#ifdef CAR_FINISH_FX\nuniform vec4 carFinishParams;\n#endif`,
    };
  }
  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene) {
    uniformBuffer.updateFloat4('carFinishParams', this.wetness, 0, 0, 0);
  }
  override getCustomCode(shaderType: string, shaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: shaderLanguage === ShaderLanguage.WGSL ? carWgslDefs : carGlslDefs,
      '!#include<pbrBlockGeometryInfo>': shaderLanguage === ShaderLanguage.WGSL ? carWgslApply : carGlslApply,
    };
  }
}

// ---------------------------------------------------------------------------
// 2. Physically-Graded Blackbody Carbon-Ceramic Brake Rotor Thermal Shader
// ---------------------------------------------------------------------------
class BrakeThermalDefines extends MaterialDefines {
  BRAKE_THERMAL = false;
}

const brakeGlslApply = `#ifdef BRAKE_THERMAL
{
  float h = clamp(brakeHeat.x, 0.0, 1.0);
  if (h > 0.01) {
    vec2 duv = vAlbedoUV - vec2(0.5, 0.5);
    float r = length(duv) * 2.0;
    // Concentrate incandescence strictly on the swept carbon-ceramic pad track (r = 0.42..0.96);
    // keep the bolted aluminum center bell cool and let the outer rim cool slightly faster.
    float sweep = smoothstep(0.38, 0.50, r) * (1.0 - smoothstep(0.86, 1.02, r));
    float core = exp(-pow((r - 0.67) / 0.17, 2.0));
    float grooves = 0.84 + 0.16 * sin(r * 74.0);
    float localHeat = clamp(h * sweep * (0.66 + 0.48 * core) * grooves, 0.0, 1.15);
    // Physically motivated blackbody incandescence: deep cherry -> bright vermilion -> molten orange -> white-yellow core
    vec3 cherry = vec3(1.25, 0.045, 0.004);
    vec3 orange = vec3(3.6, 0.62, 0.03);
    vec3 hotCore = vec3(5.8, 2.25, 0.36);
    vec3 glow = mix(cherry, orange, smoothstep(0.10, 0.58, localHeat));
    glow = mix(glow, hotCore, smoothstep(0.58, 1.05, localHeat));
    finalEmissive += glow * smoothstep(0.02, 0.24, localHeat) * (0.50 + 0.90 * h);
  }
}
#endif`;

const brakeWgslApply = `#ifdef BRAKE_THERMAL
{
  let h = clamp(uniforms.brakeHeat.x, 0.0, 1.0);
  if (h > 0.01) {
    let duv = fragmentInputs.vAlbedoUV - vec2f(0.5, 0.5);
    let r = length(duv) * 2.0;
    let sweep = smoothstep(0.38, 0.50, r) * (1.0 - smoothstep(0.86, 1.02, r));
    let core = exp(-pow((r - 0.67) / 0.17, 2.0));
    let grooves = 0.84 + 0.16 * sin(r * 74.0);
    let localHeat = clamp(h * sweep * (0.66 + 0.48 * core) * grooves, 0.0, 1.15);
    let cherry = vec3f(1.25, 0.045, 0.004);
    let orange = vec3f(3.6, 0.62, 0.03);
    let hotCore = vec3f(5.8, 2.25, 0.36);
    var glow = mix(cherry, orange, smoothstep(0.10, 0.58, localHeat));
    glow = mix(glow, hotCore, smoothstep(0.58, 1.05, localHeat));
    finalEmissive += glow * smoothstep(0.02, 0.24, localHeat) * (0.50 + 0.90 * h);
  }
}
#endif`;

export class BrakeRotorThermalPlugin extends MaterialPluginBase {
  heat = 0;

  constructor(material: PBRMaterial) {
    super(material, 'BrakeThermal', 220, new BrakeThermalDefines());
    this._enable(true);
  }
  override isCompatible(_shaderLanguage: ShaderLanguage) {
    return true;
  }
  override getClassName() {
    return 'BrakeRotorThermalPlugin';
  }
  override prepareDefines(defines: BrakeThermalDefines) {
    defines.BRAKE_THERMAL = true;
  }
  override getUniforms(shaderLanguage = ShaderLanguage.GLSL) {
    return {
      ubo: [{ name: 'brakeHeat', size: 4, type: 'vec4' }],
      fragment:
        shaderLanguage === ShaderLanguage.WGSL
          ? `#ifdef BRAKE_THERMAL\nuniform brakeHeat: vec4f;\n#endif`
          : `#ifdef BRAKE_THERMAL\nuniform vec4 brakeHeat;\n#endif`,
    };
  }
  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene) {
    uniformBuffer.updateFloat4('brakeHeat', this.heat, 0, 0, 0);
  }
  override getCustomCode(shaderType: string, shaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION:
        shaderLanguage === ShaderLanguage.WGSL ? brakeWgslApply : brakeGlslApply,
    };
  }
}
