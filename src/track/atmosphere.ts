import type { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Weather } from '../types';

class CloudSkyDefines extends MaterialDefines {
  CLOUD_DOME = false;
}

const cloudGlslDefs = `#ifdef CLOUD_DOME
float cdHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float cdNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(cdHash(i), cdHash(i + vec2(1.0, 0.0)), f.x),
    mix(cdHash(i + vec2(0.0, 1.0)), cdHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
// Fast 3-octave FBM cumulus/cirrus field (2x faster than 4-octave while retaining crisp cloud puffs)
float cdFbm(vec2 p) {
  float v = 0.0, a = 0.54;
  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 3; i++) {
    v += a * cdNoise(p);
    p = rot * p * 2.06 + vec2(13.1, 7.7);
    a *= 0.48;
  }
  return v;
}
#endif`;

const cloudWgslDefs = `#ifdef CLOUD_DOME
fn cdHash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
}
fn cdNoise(p: vec2f) -> f32 {
  let i = floor(p);
  var f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(cdHash(i), cdHash(i + vec2f(1.0, 0.0)), f.x),
    mix(cdHash(i + vec2f(0.0, 1.0)), cdHash(i + vec2f(1.0, 1.0)), f.x),
    f.y
  );
}
fn cdFbm(pIn: vec2f) -> f32 {
  var p = pIn;
  var v = 0.0;
  var a = 0.54;
  let rot = mat2x2f(0.80, -0.60, 0.60, 0.80);
  for (var i = 0; i < 3; i++) {
    v += a * cdNoise(p);
    p = rot * p * 2.06 + vec2f(13.1, 7.7);
    a *= 0.48;
  }
  return v;
}
#endif`;

const cloudGlslApply = `#ifdef CLOUD_DOME
{
  vec3 dir = normalize(vPositionW - vEyePosition.xyz);
  float elev = max(0.0, dir.y);
  // Perspective sky plane projection for realistic horizon convergence
  vec2 skyUV = dir.xz / (elev + 0.16);
  float t = cloudTime.x;
  vec2 wind = vec2(t * cloudTime.y, t * cloudTime.y * 0.42);
  float n1 = cdFbm(skyUV * 0.64 + wind);
  float n2 = cdNoise(skyUV * 1.95 - wind * 0.72 + vec2(4.2, 9.1));
  float dens = n1 * 0.78 + n2 * 0.22;
  float cov = cloudTime.z;
  float cloudMask = smoothstep(cov - 0.14, cov + 0.24, dens);
  // Soft horizon fade so clouds dissolve seamlessly into distant haze well above the horizon
  float horizonFade = smoothstep(0.09, 0.36, elev);
  // Sunlit forward-scattering rim & cloud top illumination + storm lightning flash
  vec3 sunDir = normalize(cloudSun.xyz);
  float sunCos = clamp(dot(dir, sunDir), 0.0, 1.0);
  float silver = pow(sunCos, 5.5) * cloudSun.w;
  float edgeLit = smoothstep(0.24, 0.76, n1 - n2 * 0.28 + 0.30);
  vec3 cloudCol = mix(cloudShadowCol.rgb, cloudLightCol.rgb, clamp(edgeLit * 0.82 + silver * 0.45, 0.0, 1.0));
  cloudCol += cloudSunCol.rgb * (silver * 0.92 * (1.0 - cloudMask * 0.42));
  // Subtle storm sheet-lightning pulse in heavy rain (cloudSunCol.w carries live flash pulse 0..1)
  cloudCol += vec3(0.72, 0.84, 1.15) * (cloudSunCol.w * smoothstep(0.45, 0.85, n1));
  // Subtle atmospheric Mie solar corona when sunny (clear/golden)
  float corona = (pow(sunCos, 38.0) * 0.50 + pow(sunCos, 280.0) * 1.65) * cloudSun.w * smoothstep(0.04, 0.14, elev);
  float alphaOut = clamp(cloudMask * horizonFade * cloudTime.w + corona * 0.26, 0.0, 0.78);
  vec3 outRgb = cloudCol * (cloudMask * horizonFade * cloudTime.w) + cloudSunCol.rgb * corona;
  finalEmissive = outRgb / max(0.001, alphaOut);
  alpha = alphaOut;
}
#endif`;

const cloudWgslApply = `#ifdef CLOUD_DOME
{
  let dir = normalize(input.vPositionW - scene.vEyePosition.xyz);
  let elev = max(0.0, dir.y);
  let skyUV = dir.xz / (elev + 0.16);
  let t = uniforms.cloudTime.x;
  let wind = vec2f(t * uniforms.cloudTime.y, t * uniforms.cloudTime.y * 0.42);
  let n1 = cdFbm(skyUV * 0.64 + wind);
  let n2 = cdNoise(skyUV * 1.95 - wind * 0.72 + vec2f(4.2, 9.1));
  let dens = n1 * 0.78 + n2 * 0.22;
  let cov = uniforms.cloudTime.z;
  let cloudMask = smoothstep(cov - 0.14, cov + 0.24, dens);
  let horizonFade = smoothstep(0.09, 0.36, elev);
  let sunDir = normalize(uniforms.cloudSun.xyz);
  let sunCos = clamp(dot(dir, sunDir), 0.0, 1.0);
  let silver = pow(sunCos, 5.5) * uniforms.cloudSun.w;
  let edgeLit = smoothstep(0.24, 0.76, n1 - n2 * 0.28 + 0.30);
  var cloudCol = mix(uniforms.cloudShadowCol.rgb, uniforms.cloudLightCol.rgb, clamp(edgeLit * 0.82 + silver * 0.45, 0.0, 1.0));
  cloudCol += uniforms.cloudSunCol.rgb * (silver * 0.92 * (1.0 - cloudMask * 0.42));
  cloudCol += vec3f(0.72, 0.84, 1.15) * (uniforms.cloudSunCol.w * smoothstep(0.45, 0.85, n1));
  let corona = (pow(sunCos, 38.0) * 0.50 + pow(sunCos, 280.0) * 1.65) * uniforms.cloudSun.w * smoothstep(0.04, 0.14, elev);
  let alphaOut = clamp(cloudMask * horizonFade * uniforms.cloudTime.w + corona * 0.26, 0.0, 0.78);
  let outRgb = cloudCol * (cloudMask * horizonFade * uniforms.cloudTime.w) + uniforms.cloudSunCol.rgb * corona;
  finalEmissive = outRgb / max(0.001, alphaOut);
  alpha = alphaOut;
}
#endif`;

class CloudSkyPlugin extends MaterialPluginBase {
  time = 0;
  speed = 0.012;
  coverage = 0.56;
  opacity = 0.46;
  sunDir = new Vector3(0.65, 0.28, 0.71);
  sunStrength = 0.9;
  lightCol = new Color3(1.0, 0.97, 0.92);
  shadowCol = new Color3(0.55, 0.62, 0.74);
  sunCol = new Color3(1.15, 0.92, 0.64);
  lightning = 0;

  constructor(material: PBRMaterial) {
    super(material, 'CloudSky', 225, new CloudSkyDefines());
    this._enable(true);
  }
  override isCompatible(_shaderLanguage: ShaderLanguage) {
    return true;
  }
  override getClassName() {
    return 'CloudSkyPlugin';
  }
  override prepareDefines(defines: CloudSkyDefines) {
    defines.CLOUD_DOME = true;
  }
  override getUniforms(shaderLanguage = ShaderLanguage.GLSL) {
    const ubo = [
      { name: 'cloudTime', size: 4, type: 'vec4' },
      { name: 'cloudSun', size: 4, type: 'vec4' },
      { name: 'cloudLightCol', size: 4, type: 'vec4' },
      { name: 'cloudShadowCol', size: 4, type: 'vec4' },
      { name: 'cloudSunCol', size: 4, type: 'vec4' },
    ];
    if (shaderLanguage === ShaderLanguage.WGSL) {
      return {
        ubo,
        fragment: `#ifdef CLOUD_DOME
uniform cloudTime: vec4f;
uniform cloudSun: vec4f;
uniform cloudLightCol: vec4f;
uniform cloudShadowCol: vec4f;
uniform cloudSunCol: vec4f;
#endif`,
      };
    }
    return {
      ubo,
      fragment: `#ifdef CLOUD_DOME
uniform vec4 cloudTime;
uniform vec4 cloudSun;
uniform vec4 cloudLightCol;
uniform vec4 cloudShadowCol;
uniform vec4 cloudSunCol;
#endif`,
    };
  }
  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene) {
    uniformBuffer.updateFloat4('cloudTime', this.time, this.speed, this.coverage, this.opacity);
    uniformBuffer.updateFloat4('cloudSun', this.sunDir.x, this.sunDir.y, this.sunDir.z, this.sunStrength);
    uniformBuffer.updateFloat4('cloudLightCol', this.lightCol.r, this.lightCol.g, this.lightCol.b, 1);
    uniformBuffer.updateFloat4('cloudShadowCol', this.shadowCol.r, this.shadowCol.g, this.shadowCol.b, 1);
    uniformBuffer.updateFloat4('cloudSunCol', this.sunCol.r, this.sunCol.g, this.sunCol.b, this.lightning);
  }
  override getCustomCode(shaderType: string, shaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: shaderLanguage === ShaderLanguage.WGSL ? cloudWgslDefs : cloudGlslDefs,
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION:
        shaderLanguage === ShaderLanguage.WGSL ? cloudWgslApply : cloudGlslApply,
    };
  }
}

const WEATHER_CLOUDS: Record<
  Weather,
  {
    speed: number;
    coverage: number;
    opacity: number;
    sunStrength: number;
    light: [number, number, number];
    shadow: [number, number, number];
    sun: [number, number, number];
  }
> = {
  clear: {
    speed: 0.008,
    coverage: 0.62,
    opacity: 0.38,
    sunStrength: 0.95,
    light: [1.05, 1.04, 1.02],
    shadow: [0.64, 0.72, 0.85],
    sun: [1.25, 1.16, 0.98],
  },
  golden: {
    speed: 0.011,
    coverage: 0.54,
    opacity: 0.52,
    sunStrength: 1.15,
    light: [1.14, 0.88, 0.64],
    shadow: [0.46, 0.44, 0.52],
    sun: [1.45, 0.86, 0.42],
  },
  damp: {
    speed: 0.018,
    coverage: 0.40,
    opacity: 0.62,
    sunStrength: 0.20,
    light: [0.76, 0.80, 0.86],
    shadow: [0.44, 0.48, 0.54],
    sun: [0.85, 0.88, 0.95],
  },
  rain: {
    speed: 0.032,
    coverage: 0.28,
    opacity: 0.74,
    sunStrength: 0.04,
    light: [0.48, 0.52, 0.58],
    shadow: [0.24, 0.28, 0.34],
    sun: [0.55, 0.60, 0.68],
  },
};

/**
 * Animated volumetric sky cloud dome with sunlit Mie corona & storm sheet-lightning.
 * Works identically on WebGPU (WGSL) and WebGL2 (GLSL) with zero post-process passes.
 */
export function createDynamicAtmosphere(scene: Scene) {
  const dome = new Mesh('weather.cloudDome', scene);
  const segs = 24,
    rings = 8,
    radius = 1220;
  const pos: number[] = [],
    nor: number[] = [],
    uv: number[] = [],
    idx: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * (Math.PI * 0.52);
    const y = Math.cos(phi) * radius;
    const rr = Math.sin(phi) * radius;
    for (let s = 0; s <= segs; s++) {
      const th = (s / segs) * Math.PI * 2;
      const x = Math.cos(th) * rr;
      const z = Math.sin(th) * rr;
      pos.push(x, y, z);
      nor.push(-x / radius, -y / radius, -z / radius);
      uv.push(s / segs, r / rings);
    }
  }
  const stride = segs + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * stride + s;
      const b = a + stride;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const vd = new VertexData();
  vd.positions = pos;
  vd.normals = nor;
  vd.uvs = uv;
  vd.indices = idx;
  vd.applyToMesh(dome);

  const mat = new PBRMaterial('weather.cloudDomeMat', scene);
  mat.unlit = true;
  mat.albedoColor = Color3.Black();
  mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true;
  mat.maxSimultaneousLights = 0;
  const plugin = new CloudSkyPlugin(mat);

  dome.material = mat;
  dome.infiniteDistance = true;
  dome.applyFog = false;
  dome.isPickable = false;
  dome.receiveShadows = false;
  dome.alwaysSelectAsActiveMesh = true;
  dome.metadata = { noShadowCaster: true };

  let currentWeather: Weather = 'golden';

  return {
    mesh: dome,
    setWeather(w: Weather, sunSource?: Vector3) {
      currentWeather = w;
      const p = WEATHER_CLOUDS[w];
      plugin.speed = p.speed;
      plugin.coverage = p.coverage;
      plugin.opacity = p.opacity;
      plugin.sunStrength = p.sunStrength;
      plugin.lightCol.set(p.light[0], p.light[1], p.light[2]);
      plugin.shadowCol.set(p.shadow[0], p.shadow[1], p.shadow[2]);
      plugin.sunCol.set(p.sun[0], p.sun[1], p.sun[2]);
      if (sunSource) plugin.sunDir.copyFrom(sunSource).normalize();
    },
    setEnabled(on: boolean) {
      dome.setEnabled(on);
    },
    update(dt: number) {
      plugin.time += dt;
      // Subtle atmospheric sheet-lightning pulse every ~11s in Heavy Rain
      if (currentWeather === 'rain') {
        const cycle = plugin.time % 11.4;
        const flash =
          cycle > 10.65 && cycle < 10.82
            ? Math.sin(((cycle - 10.65) / 0.17) * Math.PI) * 1.15
            : cycle > 10.88 && cycle < 11.0
              ? Math.sin(((cycle - 10.88) / 0.12) * Math.PI) * 0.72
              : 0;
        plugin.lightning = flash;
      } else {
        plugin.lightning = 0;
      }
    },
  };
}
