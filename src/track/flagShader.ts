import { MaterialDefines } from '@babylonjs/core/Materials/materialDefines';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { ShaderLanguage } from '@babylonjs/core/Materials/shaderLanguage';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer';
import type { Scene } from '@babylonjs/core/scene';

class ClothFlagDefines extends MaterialDefines {
  CLOTH_FLAG = false;
}

const flagGlslVertex = `#ifdef CLOTH_FLAG
{
  // Pin cloth along hoist edge (uv.x == 0); propagate multi-frequency travelling waves toward fly tip
  float pin = clamp(uv.x, 0.0, 1.0);
  float amp = pin * pin * flagWind.y;
  float phase = flagWind.x * flagWind.z - pin * 6.4 + positionUpdated.x * 0.25 + positionUpdated.z * 0.25;
  float wave = sin(phase) * 0.72 + sin(phase * 2.15 + uv.y * 3.1) * 0.28;
  positionUpdated.z += wave * amp;
  positionUpdated.y += sin(phase * 1.4 + 0.8) * amp * 0.22;
}
#endif
#include<morphTargetsVertexGlobal>`;

const flagWgslVertex = `#ifdef CLOTH_FLAG
{
  let pin = clamp(vertexInputs.uv.x, 0.0, 1.0);
  let amp = pin * pin * uniforms.flagWind.y;
  let phase = uniforms.flagWind.x * uniforms.flagWind.z - pin * 6.4 + positionUpdated.x * 0.25 + positionUpdated.z * 0.25;
  let wave = sin(phase) * 0.72 + sin(phase * 2.15 + vertexInputs.uv.y * 3.1) * 0.28;
  positionUpdated.z += wave * amp;
  positionUpdated.y += sin(phase * 1.4 + 0.8) * amp * 0.22;
}
#endif
#include<morphTargetsVertexGlobal>`;

/** Cross-backend GPU vertex-animated cloth ripple plugin for circuit & FIA flags. */
export class ClothFlagShaderPlugin extends MaterialPluginBase {
  time = 0;
  amplitude = 0.22;
  speed = 5.4;

  constructor(material: PBRMaterial) {
    super(material, 'ClothFlag', 212, new ClothFlagDefines());
    this._enable(true);
  }
  override isCompatible(_shaderLanguage: ShaderLanguage) {
    return true;
  }
  override getClassName() {
    return 'ClothFlagShaderPlugin';
  }
  override prepareDefines(defines: ClothFlagDefines) {
    defines.CLOTH_FLAG = true;
  }
  override getUniforms(shaderLanguage = ShaderLanguage.GLSL) {
    return {
      ubo: [{ name: 'flagWind', size: 4, type: 'vec4' }],
      vertex:
        shaderLanguage === ShaderLanguage.WGSL
          ? `#ifdef CLOTH_FLAG\nuniform flagWind: vec4f;\n#endif`
          : `#ifdef CLOTH_FLAG\nuniform vec4 flagWind;\n#endif`,
    };
  }
  override bindForSubMesh(uniformBuffer: UniformBuffer, _scene: Scene) {
    uniformBuffer.updateFloat4('flagWind', this.time, this.amplitude, this.speed, 0);
  }
  override getCustomCode(shaderType: string, shaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== 'vertex') return null;
    return {
      '!#include<morphTargetsVertexGlobal>':
        shaderLanguage === ShaderLanguage.WGSL ? flagWgslVertex : flagGlslVertex,
    };
  }
}
