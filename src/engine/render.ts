import { Engine } from '@babylonjs/core/Engines/engine';
import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { _CommonDispose } from '@babylonjs/core/Engines/engine.common';
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine';
import '@babylonjs/core/Engines/WebGPU/Extensions/index';
import '@babylonjs/core/Engines/Extensions/engine.rawTexture';
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent';
import '@babylonjs/core/Lights/Clustered/clusteredLightingSceneComponent';
import { Scene } from '@babylonjs/core/scene';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Frustum } from '@babylonjs/core/Maths/math.frustum';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { DracoDecoder } from '@babylonjs/core/Meshes/Compression/dracoDecoder';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { SpotLight } from '@babylonjs/core/Lights/spotLight';
import { PointLight } from '@babylonjs/core/Lights/pointLight';
import { ClusteredLightContainer } from '@babylonjs/core/Lights/Clustered/clusteredLightContainer';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { CubeTexture } from '@babylonjs/core/Materials/Textures/cubeTexture';
import { GetEnvInfo } from '@babylonjs/core/Misc/environmentTextureTools';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { BackgroundMaterial } from '@babylonjs/core/Materials/Background/backgroundMaterial';
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration';
import { GetEnvironmentBRDFTexture } from '@babylonjs/core/Misc/brdfTextureTools';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { RaceState, Settings, VehicleRig, Weather } from '../types';
import { GraphicsUnavailable } from './view';

const asset = (name: string) =>
  new URL(`${import.meta.env.BASE_URL}assets/${name}`, window.location.href).href;

class DrivingScene extends Scene {
  override attachControl() {}
}

export function whenSceneReady(scene: Scene) {
  return new Promise<void>((resolve, reject) => {
    const timeout = scene.onReadyTimeoutObservable.addOnce(() => finish(Error('Timed out preparing the scene.')));
    const disposed = scene.onDisposeObservable.addOnce(() => finish(Error('Scene disposed.')));
    const missing = (name: string) =>
      Error(`Could not load ${name.startsWith('data:') ? 'an embedded texture' : name}. Check your connection and retry launch.`);
    const failed = Texture.OnTextureLoadErrorObservable.add((t) => {
      if (t.getScene() === scene) finish(missing(t.name));
    });
    function finish(error?: Error) {
      timeout.remove();
      disposed.remove();
      failed.remove();
      if (error) reject(error);
      else resolve();
    }
    const bad = scene.textures.find((t) => t.loadingError);
    if (bad) finish(missing(bad.name));
    else scene.executeWhenReady(() => finish());
  });
}

export async function bootstrap(canvas: HTMLCanvasElement, reason = '') {
  let engine: WebGPUEngine | Engine | undefined,
    gpu: WebGPUEngine | undefined;
  const watchdog =
    !reason && navigator.gpu
      ? window.setTimeout(() => {
          const next = new URL(location.href);
          next.searchParams.set('renderer', 'webgl2');
          location.replace(next.href);
        }, 12_000)
      : undefined;
  try {
    if (!reason && (await WebGPUEngine.IsSupportedAsync)) {
      gpu = new WebGPUEngine(canvas, {
        antialias: true,
        doNotHandleContextLost: true,
        setMaximumLimits: true,
        glslangOptions: { jsPath: asset('glslang/glslang.js'), wasmPath: asset('glslang/glslang.wasm') },
        twgslOptions: { jsPath: asset('twgsl/twgsl.js'), wasmPath: asset('twgsl/twgsl.wasm') },
      });
      await gpu.initAsync();
      engine = gpu;
    } else if (!reason) reason = 'WebGPU adapter unavailable';
  } catch (e) {
    reason = String(e);
    console.warn('WebGPU initialization failed; using WebGL2', reason);
    if (gpu) {
      try {
        gpu.dispose();
      } catch {
        gpu._device?.destroy();
        _CommonDispose(gpu, canvas);
        AbstractEngine.prototype.dispose.call(gpu);
      }
    }
    const replacement = canvas.cloneNode() as HTMLCanvasElement;
    canvas.replaceWith(replacement);
    canvas = replacement;
  } finally {
    window.clearTimeout(watchdog);
  }
  if (!engine) {
    const options: WebGLContextAttributes = {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      stencil: true,
      powerPreference: 'high-performance',
    };
    if (canvas.getContext('webgl2', options)) {
      const gl = new Engine(canvas, true, options);
      if (gl.webGLVersion === 2) engine = gl;
      else gl.dispose();
    }
    if (!engine)
      throw new GraphicsUnavailable(
        '3D graphics could not start. Open this link in a current browser with WebGPU or WebGL 2. Enable graphics acceleration if available, then retry.',
      );
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
    numWorkers: 0,
  };
  try {
    const scene = new DrivingScene(engine);
    scene.clearColor = new Color4(0.28, 0.36, 0.44, 1);
    scene.skipPointerMovePicking = true;
    const brdf = GetEnvironmentBRDFTexture(scene);
    const lookup = { isReady: () => brdf.isReadyOrNotBlocking() };
    scene.addIsReadyCheck(lookup);
    const deviceLost = engine instanceof WebGPUEngine ? engine._device.lost : undefined;
    const ready = whenSceneReady(scene);
    if (deviceLost)
      await Promise.race([
        ready,
        deviceLost.then(() => {
          throw new GraphicsUnavailable('Graphics disconnected during startup. Retry launch.');
        }),
      ]);
    else await ready;
    scene.removeIsReadyCheck(lookup);
    return { engine, scene, canvas, backend, adapter, reason, software, deviceLost };
  } catch (e) {
    engine.dispose();
    throw e;
  }
}

interface BakedSky {
  tex: CubeTexture;
  skyView: CubeTexture;
  source: Vector3;
}

const SKY_FILE: Record<Weather, string> = {
  clear: 'clear_midday',
  golden: 'golden_hour',
  damp: 'overcast_race',
  rain: 'heavy_rain',
};

const WEATHER_LIGHTING: Record<
  Weather,
  {
    sunElevDeg: number | null;
    sunIntensity: number;
    sunColor: [number, number, number];
    fillIntensity: number;
    envIntensity: number;
    skyTint: [number, number, number];
    fogDensity: number;
    fogColor: [number, number, number];
    shadowDarkness: number;
    exposure: number;
  }
> = {
  clear: {
    sunElevDeg: 48,
    sunIntensity: 2.9,
    sunColor: [1.0, 0.985, 0.945],
    fillIntensity: 0.28,
    envIntensity: 1.06,
    skyTint: [0.98, 0.99, 1.0],
    fogDensity: 0.00026,
    fogColor: [0.70, 0.80, 0.92],
    shadowDarkness: 0.16,
    exposure: 1.0,
  },
  golden: {
    sunElevDeg: 16,
    sunIntensity: 2.7,
    sunColor: [1.0, 0.84, 0.67],
    fillIntensity: 0.24,
    envIntensity: 0.96,
    skyTint: [1.0, 0.965, 0.91],
    fogDensity: 0.00046,
    fogColor: [0.84, 0.80, 0.72],
    shadowDarkness: 0.14,
    exposure: 1.02,
  },
  damp: {
    sunElevDeg: null,
    sunIntensity: 0.58,
    sunColor: [0.88, 0.93, 1.0],
    fillIntensity: 0.37,
    envIntensity: 1.12,
    skyTint: [0.83, 0.89, 0.95],
    fogDensity: 0.00084,
    fogColor: [0.68, 0.72, 0.76],
    shadowDarkness: 0.48,
    exposure: 1.02,
  },
  rain: {
    sunElevDeg: null,
    sunIntensity: 0.26,
    sunColor: [0.74, 0.82, 0.92],
    fillIntensity: 0.34,
    envIntensity: 0.94,
    skyTint: [0.64, 0.71, 0.79],
    fogDensity: 0.00142,
    fogColor: [0.46, 0.51, 0.58],
    shadowDarkness: 0.66,
    exposure: 1.08,
  },
};

export function lighting(scene: Scene) {
  const camera = scene.activeCamera!,
    engine = scene.getEngine();
  const sun = new DirectionalLight('Valle sunlight', new Vector3(-0.65, -0.276, -0.708).normalize(), scene);
  sun.renderPriority = 9;
  const fill = new HemisphericLight('sky bounce', Vector3.Up(), scene);
  fill.intensity = 0.28;
  fill.groundColor = new Color3(0.32, 0.29, 0.26);
  fill.renderPriority = 8;
  scene.fogMode = Scene.FOGMODE_EXP2;

  // Direct Forward PBR with Khronos PBR Neutral tone mapping — strictly zero blur/post-FX
  const image = scene.imageProcessingConfiguration;
  image.toneMappingEnabled = true;
  image.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
  image.exposure = 1.02;
  image.contrast = 1.07;
  // Opaque skybox fills the background; skip redundant full-screen MSAA color clear
  scene.autoClear = false;
  scene.autoClearDepthAndStencil = true;

  const skies: Partial<Record<Weather, BakedSky>> = {},
    sky = CreateBox('weather dome', { size: 1400 }, scene),
    skyMaterial = new BackgroundMaterial('HDR sky', scene);
  sky.infiniteDistance = true;
  sky.material = skyMaterial;
  sky.isPickable = false;
  sky.applyFog = false;
  skyMaterial.backFaceCulling = false;
  skyMaterial.transparencyMode = BackgroundMaterial.MATERIAL_OPAQUE;
  skyMaterial.disableDepthWrite = true;
  skyMaterial.maxSimultaneousLights = 0;

  async function loadSky(w: Weather, signal: AbortSignal): Promise<BakedSky> {
    const url = asset(`skies/${SKY_FILE[w]}.env`);
    const response = await fetch(url, { signal });
    if (!response.ok) throw Error(`Cannot load ${w} sky: HTTP ${response.status}`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    signal.throwIfAborted();
    const info = GetEnvInfo(buffer) as { gt3?: { sun: number[]; radianceScale: number } } | null;
    const meta = info?.gt3;
    if (
      !meta ||
      !Array.isArray(meta.sun) ||
      meta.sun.length !== 3 ||
      !meta.sun.every(Number.isFinite) ||
      !Number.isFinite(meta.radianceScale) ||
      meta.radianceScale <= 0
    )
      throw Error(`Invalid baked ${w} sky`);
    const tex = await new Promise<CubeTexture>((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      const cube = new CubeTexture(url, scene, {
        buffer,
        onLoad: () => {
          signal.removeEventListener('abort', cancel);
          if (signal.aborted) {
            if (!scene.isDisposed) cube.dispose();
          } else resolve(cube);
        },
        onError: (message, e) => {
          signal.removeEventListener('abort', cancel);
          cube.dispose();
          reject(e ?? Error(message));
        },
      });
    });
    if (scene.isDisposed) throw Error('Scene disposed.');
    tex.level = meta.radianceScale;
    const skyView = tex.clone();
    skyView.coordinatesMode = Texture.SKYBOX_MODE;
    return { tex, skyView, source: Vector3.FromArray(meta.sun).normalize() };
  }

  let loading: AbortController | undefined;
  scene.onDisposeObservable.addOnce(() => loading?.abort());

  async function setWeather(w: Weather) {
    loading?.abort();
    loading = undefined;
    let loaded = skies[w];
    if (!loaded) {
      const request = (loading = new AbortController());
      scene.addPendingData(request);
      const deadline = setTimeout(() => request.abort(Error(`Timed out loading the ${w} sky. Retry launch.`)), 45_000);
      try {
        loaded = await loadSky(w, request.signal);
        if (loading !== request || scene.isDisposed) return;
        skies[w] = loaded;
      } catch (error) {
        if (loading !== request || scene.isDisposed) return;
        throw request.signal.aborted ? request.signal.reason : error;
      } finally {
        clearTimeout(deadline);
        scene.removePendingData(request);
        if (loading === request) loading = undefined;
      }
    }
    const preset = WEATHER_LIGHTING[w];
    const { tex, skyView, source } = loaded;
    const disc = source.clone();
    let transform = Matrix.Identity();
    if (preset.sunElevDeg !== null) {
      const horiz = Math.hypot(disc.x, disc.z);
      if (horiz > 1e-3) {
        const rad = (preset.sunElevDeg * Math.PI) / 180;
        disc.y = 0;
        disc.normalize().scaleInPlace(Math.cos(rad));
        disc.y = Math.sin(rad);
        const axis = Vector3.Cross(disc, source);
        if (axis.lengthSquared() > 1e-8) {
          transform = Matrix.RotationAxis(axis.normalize(), Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(disc, source)))));
        }
      }
    }
    sun.direction.copyFrom(disc).negateInPlace();
    scene.metadata = { ...(scene.metadata ?? {}), sunDir: disc.clone().normalize() };
    tex.setReflectionTextureMatrix(transform);
    scene.environmentTexture = tex;
    skyView.setReflectionTextureMatrix(transform);
    skyMaterial.reflectionTexture = skyView;
    skyMaterial.primaryColor = Color3.FromArray(preset.skyTint);
    scene.environmentIntensity = preset.envIntensity;
    scene.fogDensity = preset.fogDensity;
    scene.fogColor = Color3.FromArray(preset.fogColor);
    sun.intensity = preset.sunIntensity;
    sun.diffuse = Color3.FromArray(preset.sunColor);
    fill.intensity = preset.fillIntensity;
    image.exposure = preset.exposure;
    if (shadows) shadows.darkness = preset.shadowDarkness;
  }

  const caps = engine.getCaps();
  const gpu = engine instanceof WebGPUEngine ? engine.currentLimits : undefined;
  const samplers = Math.min(
    caps.maxTexturesImageUnits,
    caps.maxCombinedTexturesImageUnits,
    gpu?.maxSamplersPerShaderStage ?? Infinity,
  );
  const maxMap = Math.min(caps.maxTextureSize, caps.maxRenderTextureSize);
  const adapterInfo =
    engine instanceof WebGPUEngine
      ? Object.values(engine.getInfo()).join(' / ')
      : engine.extractDriverInfo();
  const isSoftware = /swiftshader|llvmpipe|software|lavapipe/i.test(adapterInfo);
  const mapSize = Math.min(isSoftware ? 1024 : 2048, maxMap);
  // Road binds albedo, normal, ORM, lap detail, dynamic TrackState, sky and BRDF (7 samplers)
  const materialSamplers = 7;
  const shadowSampler = caps.depthTextureExtension && samplers > materialSamplers;
  const cascades =
    shadowSampler &&
    CascadedShadowGenerator.IsSupported &&
    caps.texture2DArrayMaxLayerCount >= 4 &&
    caps.maxVaryingVectors >= (gpu ? 20 : 15)
      ? new CascadedShadowGenerator(mapSize, sun, false, camera)
      : null;
  const shadows = cascades ?? (shadowSampler ? new ShadowGenerator(mapSize, sun, false, camera) : null);
  const planes = Frustum.GetPlanes(Matrix.Identity());
  const visibleCasters: AbstractMesh[] = [];
  let cast: AbstractMesh[] = [];

  function casters(meshes: AbstractMesh[]) {
    cast = meshes.filter((m) => {
      if (m === sky || !m.isEnabled() || !m.getTotalVertices() || m.metadata?.noShadowCaster || m.metadata?.trackShadowCaster === false)
        return false;
      if (m.metadata?.shadowProxy) return true;
      for (let parent = m.parent; parent; parent = parent.parent) if (parent.metadata?.chassis) return false;
      return !m.material?.needAlphaBlendingForMesh(m);
    });
    if (shadows) shadows.getShadowMap()!.renderList = cast;
  }

  if (cascades) {
    // 3 tight texel-stabilized cascades on hardware GPU (2048px, 155m range) for razor-sharp
    // car, gantry, grandstand, and roadside tree shadows; 2 crisp cascades on software adapters.
    cascades.numCascades = isSoftware ? 2 : 3;
    cascades.lambda = isSoftware ? 0.78 : 0.82;
    cascades.stabilizeCascades = true;
    cascades.cascadeBlendPercentage = 0.14;
    cascades.shadowMaxZ = isSoftware ? 105 : 155;
  } else if (shadows) {
    sun.shadowFrustumSize = 96;
    sun.shadowMinZ = 0.1;
    sun.shadowMaxZ = 240;
    scene.onBeforeRenderObservable.add(() => {
      sun.direction.scaleToRef(-110, sun.position);
      sun.position.addInPlace(camera.globalPosition);
    });
  }
  if (shadows) {
    shadows.usePercentageCloserFiltering = true;
    // Babylon 9.0.0 WGSL CSM PCF1 (QUALITY_LOW) has an upstream syntax bug (',,shadowTexture0Sampler').
    // QUALITY_MEDIUM (PCF3) generates valid WGSL and GLSL on both backends.
    shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    shadows.bias = 0.00028;
    shadows.normalBias = 0.018;
    shadows.darkness = 0.16;
  }

  function bindShadowVolumes() {
    if (!shadows) return;
    const map = shadows.getShadowMap()!;
    map.renderList = cast;
    map.getCustomRenderList = (layer, list, length) => {
      const matrix = cascades ? cascades.getCascadeTransformMatrix(layer) : shadows.getTransformMatrix();
      if (!matrix || !list) return null;
      Frustum.GetPlanesToRef(matrix, planes);
      visibleCasters.length = 0;
      for (let i = 0; i < length; i++) {
        const m = list[i];
        // On hardware GPUs, near-track trees cast crisp shadows in Cascades 0 & 1;
        // on software CPU rasterizers (SwiftShader), skip alpha-tested tree shadow passes to keep QA snappy.
        if ((isSoftware || layer >= 2) && m.metadata?.nearTreeShadow) continue;
        m.computeWorldMatrix();
        const { minimumWorld: lo, maximumWorld: hi } = m.getBoundingInfo().boundingBox;
        let p = 2;
        for (; p < 6; p++) {
          const { normal: n, d } = planes[p];
          if (d + n.x * (n.x < 0 ? lo.x : hi.x) + n.y * (n.y < 0 ? lo.y : hi.y) + n.z * (n.z < 0 ? lo.z : hi.z) < 0)
            break;
        }
        if (p === 6) visibleCasters.push(m);
      }
      return visibleCasters;
    };
  }
  bindShadowVolumes();

  let lamps: ReturnType<typeof raceLights> | undefined;
  let garage = true;

  // Single locked Native 1080p pixel density on hardware GPUs — ZERO adaptive downscaling into blur!
  // Software CPU rasterizers (SwiftShader/llvmpipe) stay at 1x CSS pixel density so CI/VM runs stay snappy.
  function resize() {
    const canvas = engine.getRenderingCanvas()!;
    const w = Math.max(1, canvas.clientWidth),
      h = Math.max(1, canvas.clientHeight);
    const budget = 1920 * 1080;
    const ratio = isSoftware
      ? 1
      : Math.min(window.devicePixelRatio || 1, Math.max(1, Math.sqrt(budget / (w * h))), maxMap / Math.max(w, h));
    const scale = 1 / ratio;
    if (Math.abs(scale - engine.getHardwareScalingLevel()) > 0.001) engine.setHardwareScalingLevel(scale);
    else engine.resize();
  }

  function stage(inGarage: boolean) {
    if (!inGarage) lamps ??= raceLights(scene, sky, samplers - materialSamplers - Number(!!shadows));
    if (garage === inGarage) return;
    garage = inGarage;
    resize();
  }

  function quality(_q: Settings['graphics']) {
    // Single locked Native 1080p direct forward preset
    bindShadowVolumes();
    resize();
  }

  function update(s: RaceState, rigs: VehicleRig[], _frameMs: number) {
    lamps?.update(s, rigs);
  }

  return { quality, setWeather, casters, stage, resize, update };
}

function raceLights(scene: Scene, sky: AbstractMesh, freeSamplers: number) {
  const engine = scene.getEngine(),
    caps = engine.getCaps();
  const gl = engine instanceof Engine ? engine._gl : undefined;
  const gpu = engine instanceof WebGPUEngine ? engine.currentLimits : undefined;
  const lightSlots = gpu
    ? gpu.maxUniformBuffersPerShaderStage - 6
    : gl && engine.supportsUniformBuffers
      ? Math.min(
          gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_BLOCKS) - 4,
          gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS) - 5,
        )
      : 2;
  if (lightSlots < 1) return { update() {} };
  const lamps: { spot: SpotLight[]; tail?: PointLight }[] = [];
  let cluster: ClusteredLightContainer | undefined;
  function projector(i: number, k: number) {
    const light = new SpotLight(`projector ${i}.${k}`, Vector3.Zero(), Vector3.Forward(), 0.48, 4, scene);
    light.range = 62;
    light.diffuse = new Color3(0.88, 0.95, 1);
    return light;
  }
  const first = projector(0, 0);
  const fragmentStorage =
    gpu && 'maxStorageBuffersInFragmentStage' in gpu
      ? Number(gpu.maxStorageBuffersInFragmentStage)
      : gpu?.maxStorageBuffersPerShaderStage;
  const clustered =
    ClusteredLightContainer.IsLightSupported(first) &&
    caps.textureFloat &&
    caps.maxVertexTextureImageUnits >= 1 &&
    freeSamplers >= (gpu ? 1 : 2) &&
    (!gpu || ((fragmentStorage ?? 0) >= 1 && gpu.maxStorageBufferBindingSize >= 32768));
  for (let i = 0; i < (clustered ? 10 : 1); i++) {
    const spot = [i === 0 ? first : projector(i, 0)];
    if (clustered) spot.push(projector(i, 1));
    const tail = clustered || lightSlots >= 2 ? new PointLight(`brake pool ${i}`, Vector3.Zero(), scene) : undefined;
    if (tail) {
      tail.range = 5;
      tail.diffuse = new Color3(1, 0.023, 0.008);
    }
    lamps.push({ spot, tail });
  }
  if (clustered) {
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
      [...lamps.flatMap((l) => [...l.spot, l.tail!]), ...floods],
      scene,
    );
    cluster.excludedMeshes.push(sky);
    cluster.renderPriority = 7;
  }
  scene.onDisposeObservable.addOnce(() => cluster?.dispose(false, true));
  function update(s: RaceState, rigs: VehicleRig[]) {
    const wet = s.settings.weather === 'damp' || s.settings.weather === 'rain';
    // Only run the 33-light clustered headlamp pass in Damp / Rain when road beams are visible;
    // in bright daylight, emissive lenses + sun + HDR IBL stay crisp with zero clustered light overhead!
    const on = s.phase !== 'garage' && wet;
    if (cluster && cluster.isEnabled() !== on) cluster.setEnabled(on);
    if (!on) return;
    const wetHeadlamps = s.settings.weather === 'rain' ? 38 : 24;
    for (let i = 0; i < lamps.length; i++) {
      const d = s.drivers[i],
        l = lamps[i];
      const active = !!d && s.phase !== 'garage' && !!rigs[i];
      const sn = Math.sin(d?.yaw || 0),
        cs = Math.cos(d?.yaw || 0);
      l.spot.forEach((p, k) => {
        p.intensity = active ? wetHeadlamps * (clustered ? 1 : 2) : 0;
        if (d) {
          const side = clustered ? (k === 0 ? -0.72 : 0.72) : 0;
          p.position.set(d.x + 1.92 * sn + side * cs, d.y + 0.49, d.z + 1.92 * cs - side * sn);
          p.direction.set(sn, -0.12, cs);
        }
      });
      if (l.tail) {
        l.tail.intensity = active && d.brake > 0.02 ? 5 * d.brake : 0;
        if (d) l.tail.position.set(d.x - 2.15 * sn, d.y + 0.37, d.z - 2.15 * cs);
      }
    }
  }
  return { update };
}
