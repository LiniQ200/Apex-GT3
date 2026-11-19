import { Engine } from '@babylonjs/core/Engines/engine';
import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { _CommonDispose } from '@babylonjs/core/Engines/engine.common';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import '@babylonjs/core/Engines/WebGPU/Extensions/index';
import '@babylonjs/core/Engines/Extensions/engine.rawTexture';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import '@babylonjs/core/Lights/Clustered/clusteredLightingSceneComponent';
import '@babylonjs/core/Rendering/depthRendererSceneComponent';
import '@babylonjs/core/Rendering/prePassRendererSceneComponent';
import '@babylonjs/core/Rendering/geometryBufferRendererSceneComponent';
import '@babylonjs/core/PostProcesses/RenderPipeline/postProcessRenderPipelineManagerSceneComponent';
import { Scene } from '@babylonjs/core/scene';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { DracoDecoder } from '@babylonjs/core/Meshes/Compression/dracoDecoder';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { SpotLight } from '@babylonjs/core/Lights/spotLight';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { ClusteredLightContainer } from '@babylonjs/core/Lights/Clustered/clusteredLightContainer';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator';
import { HDRCubeTexture } from '@babylonjs/core/Materials/Textures/hdrCubeTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { BackgroundMaterial } from '@babylonjs/core/Materials/Background/backgroundMaterial';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { GetEnvironmentBRDFTexture } from '@babylonjs/core/Misc/brdfTextureTools';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';
import { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline';
import { SSRRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssrRenderingPipeline';
import { MotionBlurPostProcess } from '@babylonjs/core/PostProcesses/motionBlurPostProcess';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { RaceState, Settings, VehicleRig, Weather } from '../types';

const asset = (name: string) =>
  new URL(`${import.meta.env.BASE_URL}assets/${name}`, window.location.href).href;

class DrivingScene extends Scene {
  // controls.ts owns input. Scene's constructor otherwise installs a second
  // device manager that reads gamepads even when the embedding policy denies it.
  override attachControl() {}
}

// Babylon drops whenReadyAsync's callback on timeout instead of rejecting it.
export function whenSceneReady(scene: Scene) {
  return new Promise<void>((resolve, reject) => {
    const timeout = scene.onReadyTimeoutObservable.addOnce(() => reject(Error('Timed out preparing the scene.')));
    const disposed = scene.onDisposeObservable.addOnce(() => reject(Error('Scene disposed.')));
    scene.executeWhenReady(() => {
      timeout.remove();
      disposed.remove();
      resolve();
    });
  });
}

export async function bootstrap(canvas: HTMLCanvasElement) {
  let engine: WebGPUEngine | Engine | undefined,
    gpu: WebGPUEngine | undefined,
    reason = '';
  try {
    if (await WebGPUEngine.IsSupportedAsync) {
      gpu = new WebGPUEngine(canvas, {
        antialias: true,
        setMaximumLimits: true,
        glslangOptions: { jsPath: asset('glslang/glslang.js'), wasmPath: asset('glslang/glslang.wasm') },
        twgslOptions: { jsPath: asset('twgsl/twgsl.js'), wasmPath: asset('twgsl/twgsl.wasm') },
      });
      await gpu.initAsync();
      engine = gpu;
    } else reason = 'WebGPU adapter unavailable';
  } catch (e) {
    reason = String(e);
    console.warn('WebGPU initialization failed; using WebGL2', reason);
    if (gpu) {
      try {
        gpu.dispose();
      } catch {
        // Babylon 9's dispose assumes initAsync reached the GPU query manager.
        // A rejected device request still owns DOM listeners and an engine-store entry.
        gpu._device?.destroy();
        _CommonDispose(gpu, canvas);
        AbstractEngine.prototype.dispose.call(gpu);
      }
    }
    const replacement = canvas.cloneNode() as HTMLCanvasElement;
    canvas.replaceWith(replacement);
    canvas = replacement;
  }
  if (!engine) {
    const options: WebGLContextAttributes = {
      antialias: true,
      preserveDrawingBuffer: true,
      stencil: true,
      powerPreference: 'high-performance',
    };
    // Avoid constructing a partially registered engine on WebGL1-only/disabled
    // browsers. Pass the canvas so Babylon still owns context-loss restoration.
    if (canvas.getContext('webgl2', options)) {
      const gl = new Engine(canvas, true, options);
      if (gl.webGLVersion === 2) engine = gl;
      else gl.dispose();
    }
    if (!engine) throw Error('This simulator requires WebGL 2 or WebGPU.');
  }
  const backend = engine instanceof WebGPUEngine ? 'WebGPU' : 'WebGL2',
    adapter =
      engine instanceof WebGPUEngine
        ? Object.values(engine.getInfo()).join(' / ')
        : engine.extractDriverInfo();
  const software = /swiftshader|llvmpipe|software|lavapipe/i.test(adapter);
  DracoDecoder.DefaultConfiguration = {
    wasmUrl: asset('draco/draco_wasm_wrapper.js'),
    wasmBinaryUrl: asset('draco/draco_decoder.wasm'),
    fallbackUrl: asset('draco/draco_decoder.js'),
  };
  try {
    const scene = new DrivingScene(engine);
    scene.clearColor = new Color4(0.28, 0.36, 0.44, 1);
    scene.skipPointerMovePicking = true;
    // Babylon's asynchronous BRDF decode dereferences its scene even after
    // disposal. Finish this shared PBR lookup before handing out the scene.
    const brdf = GetEnvironmentBRDFTexture(scene);
    const lookup = { isReady: () => brdf.isReadyOrNotBlocking() };
    scene.addIsReadyCheck(lookup);
    await whenSceneReady(scene);
    scene.removeIsReadyCheck(lookup);
    return { engine, scene, canvas, backend, adapter, reason, software };
  } catch (e) {
    engine.dispose();
    throw e;
  }
}

class OvercastSky extends HDRCubeTexture {
  protected override async _getCubeMapTextureDataAsync(
    buffer: ArrayBuffer,
    size: number,
    supersample: boolean,
  ) {
    const cube = await super._getCubeMapTextureDataAsync(buffer, size, supersample);
    // This partly cloudy plate contains an uncovered solar disc above 72,000.
    // Diffuse it through cloud before half-float filtering (max finite 65,504).
    for (const face of [cube.right, cube.left, cube.up, cube.down, cube.front, cube.back]) {
      const rgb = face as Float32Array;
      for (let i = 0; i < rgb.length; i += 3) {
        const y = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
        const transmittance = y > 2 ? (2 + 0.48 * Math.log1p(y - 2)) / y : 1;
        for (let j = 0; j < 3; j++) rgb[i + j] = transmittance * (0.25 * rgb[i + j] + 0.75 * y);
      }
    }
    return cube;
  }
}

export function lighting(scene: Scene, software: boolean) {
  const camera = scene.activeCamera!,
    engine = scene.getEngine();
  const sun = new DirectionalLight('Valle sunlight', new Vector3(-0.65, -0.276, -0.708).normalize(), scene);
  sun.renderPriority = 9;
  const fill = new HemisphericLight('sky bounce', Vector3.Up(), scene);
  fill.intensity = 0.31;
  fill.groundColor = new Color3(0.32, 0.29, 0.26);
  fill.renderPriority = 8;
  scene.fogMode = Scene.FOGMODE_EXP2;
  const image = scene.imageProcessingConfiguration;
  image.toneMappingEnabled = true;
  image.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  image.exposure = 1.05;
  image.contrast = 1.12;
  const skies: Partial<Record<Weather, Promise<{ tex: HDRCubeTexture; skyView: HDRCubeTexture }>>> = {},
    sky = CreateBox('weather dome', { size: 1400 }, scene),
    skyMaterial = new BackgroundMaterial('HDR sky', scene);
  sky.infiniteDistance = true;
  sky.ignoreCameraMaxZ = true;
  sky.material = skyMaterial;
  sky.isPickable = false;
  sky.applyFog = false;
  skyMaterial.backFaceCulling = false;
  function loadSky(w: Weather) {
    const wet = w === 'damp';
    const Sky = wet ? OvercastSky : HDRCubeTexture;
    return new Promise<{ tex: HDRCubeTexture; skyView: HDRCubeTexture }>((resolve, reject) => {
      const tex = new Sky(
        asset(`skies/${wet ? 'overcast_race' : 'golden_hour'}.hdr`), scene, software ? 256 : 512,
        false, true, false, !software,
        () => {
          // The prefilter replaces the GPU texture in place. Bind neither sky nor IBL
          // until it completes, so WebGPU never caches a view of the released input.
          if (scene.isDisposed) {
            reject(Error('Scene disposed.'));
            return;
          }
          const skyView = tex.clone() as HDRCubeTexture;
          skyView.coordinatesMode = Texture.SKYBOX_MODE;
          resolve({ tex, skyView });
        },
        (message, e) => reject(e ?? new Error(message)),
      );
    });
  }
  let selected: Weather;
  async function setWeather(w: Weather) {
    selected = w;
    const wet = w === 'damp', plate = skies[w] ??= loadSky(w);
    scene.addPendingData(plate);
    const loaded = await plate.catch((e: unknown) => {
      if (skies[w] === plate) delete skies[w];
      if (selected === w && !scene.isDisposed) throw e;
    }).finally(() => scene.removePendingData(plate));
    if (!loaded || selected !== w || scene.isDisposed) return;
    const { tex, skyView } = loaded;
    // Peak luminance measured in the two decoded HDR cubemaps. Apply the
    // same rotation to illumination and sky so the dry sun sits at 16°.
    const source = wet ? new Vector3(0.37825, 0.73917, 0.55727) : new Vector3(0.61552, 0.13645, 0.77622);
    source.normalize();
    const disc = source.clone();
    if (!wet) {
      disc.y = 0;
      disc.normalize().scaleInPlace(Math.cos((16 * Math.PI) / 180));
      disc.y = Math.sin((16 * Math.PI) / 180);
    }
    const transform = wet
      ? Matrix.Identity()
      : Matrix.RotationAxis(Vector3.Cross(disc, source).normalize(), Math.acos(Vector3.Dot(disc, source)));
    sun.direction.copyFrom(disc).negateInPlace();
    tex.setReflectionTextureMatrix(transform);
    scene.environmentTexture = tex;
    skyView.setReflectionTextureMatrix(transform);
    skyMaterial.reflectionTexture = skyView;
    skyMaterial.primaryColor = wet ? new Color3(0.72, 0.81, 0.92) : new Color3(1, 0.94, 0.85);
    scene.environmentIntensity = wet ? 1.25 : 0.92;
    scene.fogDensity = wet ? 0.00112 : 0.0007;
    scene.fogColor = wet ? new Color3(0.53, 0.6, 0.65) : new Color3(0.76, 0.72, 0.6);
    sun.intensity = wet ? 1.1 : 3.05;
    sun.diffuse = wet ? new Color3(0.82, 0.9, 1) : new Color3(1, 0.835, 0.63);
    fill.intensity = wet ? 0.44 : 0.27;
  }
  let shadows: CascadedShadowGenerator | undefined,
    ssao: SSAO2RenderingPipeline | undefined,
    ssr: SSRRenderingPipeline | undefined,
    blur: MotionBlurPostProcess | undefined;
  const cast = new Set<AbstractMesh>();
  const pipeline = new DefaultRenderingPipeline('Broadcast finish', true, scene, [camera], false);
  pipeline.fxaaEnabled = true;
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 1.15;
  pipeline.bloomWeight = 0.25;
  pipeline.bloomKernel = 32;
  pipeline.chromaticAberrationEnabled = true;
  pipeline.chromaticAberration.aberrationAmount = 0;
  pipeline.prepare();
  function casters(meshes: AbstractMesh[]) {
    cast.clear();
    for (const m of meshes) {
      if (
        m === sky ||
        m.isDisposed() ||
        !m.isEnabled() ||
        !m.getTotalVertices() ||
        m.metadata?.noShadowCaster ||
        m.metadata?.trackShadowCaster === false ||
        m.material?.needAlphaBlendingForMesh(m)
      )
        continue;
      cast.add(m);
    }
    const map = shadows?.getShadowMap();
    if (map) map.renderList = [...cast];
  }
  function quality(q: Settings['graphics']) {
    const size = q === 'ultra' ? 4096 : q === 'high' ? 2048 : 1024;
    engine.setHardwareScalingLevel(
      q === 'balanced' ? 1.22 : software ? 1 : 1 / Math.min(1.5, window.devicePixelRatio),
    );
    shadows?.dispose();
    if (CascadedShadowGenerator.IsSupported) {
      shadows = new CascadedShadowGenerator(software ? Math.min(1024, size) : size, sun, false, camera);
      shadows.numCascades = !software && engine.getCaps().maxVaryingVectors < 20 ? 2 : 4;
      shadows.lambda = 0.72;
      shadows.stabilizeCascades = true;
      shadows.shadowMaxZ = 135;
      shadows.usePercentageCloserFiltering = true;
      shadows.bias = 0.0004;
      shadows.normalBias = 0.028;
      shadows.darkness = 0.13;
      shadows.getShadowMap()!.renderList = [...cast];
    }
    ssao?.dispose();
    ssao = undefined;
    ssr?.dispose();
    ssr = undefined;
    blur?.dispose();
    blur = undefined;
    if (!software && q !== 'balanced') {
      if (SSAO2RenderingPipeline.IsSupported) {
        ssao = new SSAO2RenderingPipeline('contact occlusion', scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [
          camera,
        ]);
        ssao.totalStrength = 0.72;
        ssao.radius = 1.7;
        ssao.samples = q === 'ultra' ? 12 : 8;
        ssao.maxZ = 60;
      }
      ssr = new SSRRenderingPipeline('damp & clearcoat reflections', scene, [camera]);
      ssr.strength = 0.4;
      ssr.maxDistance = 42;
      ssr.step = 2;
      ssr.thickness = 0.18;
      ssr.maxSteps = q === 'ultra' ? 96 : 52;
      ssr.ssrDownsample = 1;
      blur = new MotionBlurPostProcess('speed shutter', scene, 1, camera);
      blur.isObjectBased = false;
      blur.motionBlurSamples = 6;
      blur.motionStrength = 0;
    }
    pipeline.samples = software || q === 'balanced' ? 1 : 4;
    pipeline.prepare();
  }
  const lamps: { spot: SpotLight[]; tail: PointLight }[] = [];
  let cluster: ClusteredLightContainer | undefined;
  for (let i = 0; i < (software ? 1 : 10); i++) {
    const spot = [-1, 1].map((_, k) => {
      const light = new SpotLight(`projector ${i}.${k}`, Vector3.Zero(), Vector3.Forward(), 0.48, 4, scene);
      light.range = 58;
      light.diffuse = new Color3(0.86, 0.94, 1);
      return light;
    });
    const tail = new PointLight(`brake pool ${i}`, Vector3.Zero(), scene);
    tail.range = 5;
    tail.diffuse = new Color3(1, 0.023, 0.008);
    lamps.push({ spot, tail });
  }
  if (!software && ClusteredLightContainer.IsLightSupported(lamps[0].tail)) {
    const floods = [-50, 44, 138].map((z, i) => {
      const l = new SpotLight(
        `pit apron flood ${i}`,
        new Vector3(41, 14.5 + (i % 4) * 1.1, z),
        new Vector3(-0.78, -0.62, 0),
        1.15,
        2,
        scene,
      );
      l.diffuse = new Color3(0.94, 0.97, 1);
      l.intensity = 155;
      l.range = 54;
      return l;
    });
    cluster = new ClusteredLightContainer(
      'race lighting',
      [...lamps.flatMap((l) => [...l.spot, l.tail]), ...floods],
      scene,
    );
    cluster.renderPriority = 7;
  }
  function update(s: RaceState, rigs: VehicleRig[]) {
    const speed = s.phase === 'race' ? s.drivers[0].speed : 0;
    if (cluster) cluster.setEnabled(s.phase !== 'garage');
    pipeline.chromaticAberration.aberrationAmount = Math.min(3.5, Math.max(0, speed - 48.6) * 0.11);
    if (blur) blur.motionStrength = Math.min(0.35, Math.max(0, speed - 48.6) * 0.009);
    for (let i = 0; i < lamps.length; i++) {
      const d = s.drivers[i],
        l = lamps[i];
      const active = !!d && s.phase !== 'garage' && !!rigs[i];
      const sn = Math.sin(d?.yaw || 0),
        cs = Math.cos(d?.yaw || 0);
      l.spot.forEach((p, k) => {
        p.intensity = active ? (s.settings.weather === 'damp' ? 24 : 8) : 0;
        if (d) {
          const side = k === 0 ? -0.72 : 0.72;
          p.position.set(d.x + 1.92 * sn + side * cs, d.y + 0.49, d.z + 1.92 * cs - side * sn);
          p.direction.set(sn, -0.12, cs);
        }
      });
      l.tail.intensity = active && d.brake > 0.02 ? 5 * d.brake : 0;
      if (d) l.tail.position.set(d.x - 2.15 * sn, d.y + 0.37, d.z - 2.15 * cs);
    }
  }
  return { quality, setWeather, casters, update };
}
