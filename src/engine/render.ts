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
  // controls.ts owns input. Scene's constructor otherwise installs a second
  // device manager that reads gamepads even when the embedding policy denies it.
  override attachControl() {}
}

// Babylon considers a failed albedo non-blocking, but can wait indefinitely for
// a failed normal map. Neither result is a race-ready surface.
export function whenSceneReady(scene: Scene) {
  return new Promise<void>((resolve, reject) => {
    const timeout = scene.onReadyTimeoutObservable.addOnce(() => finish(Error('Timed out preparing the scene.')));
    const disposed = scene.onDisposeObservable.addOnce(() => finish(Error('Scene disposed.')));
    const missing = (name: string) => Error(`Could not load ${name.startsWith('data:') ? 'an embedded texture' : name}. Check your connection and retry launch.`);
    const failed = Texture.OnTextureLoadErrorObservable.add(t => { if (t.getScene() === scene) finish(missing(t.name)); });
    function finish(error?: Error) {
      timeout.remove();
      disposed.remove();
      failed.remove();
      if (error) reject(error); else resolve();
    }
    const bad = scene.textures.find(t => t.loadingError);
    if (bad) finish(missing(bad.name));
    else scene.executeWhenReady(() => finish());
  });
}

export async function bootstrap(canvas: HTMLCanvasElement, reason = '') {
  let engine: WebGPUEngine | Engine | undefined,
    gpu: WebGPUEngine | undefined;
  // A driver can leave either requestAdapter or requestDevice pending forever.
  // Those requests cannot be cancelled: restart the document on the other API
  // rather than racing a half-initialized engine against a second canvas owner.
  const watchdog = !reason && navigator.gpu ? window.setTimeout(() => {
    const next = new URL(location.href);
    next.searchParams.set('renderer', 'webgl2');
    location.replace(next.href);
  }, 12_000) : undefined;
  try {
    if (!reason && await WebGPUEngine.IsSupportedAsync) {
      gpu = new WebGPUEngine(canvas, {
        antialias: true,
        // Babylon 9.0 rebuilds buffers before its replacement GPU device is
        // ready. Recreate the view on WebGL2 instead, retaining the Jolt race.
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
    // Avoid constructing a partially registered engine on WebGL1-only/disabled
    // browsers. Pass the canvas so Babylon still owns context-loss restoration.
    if (canvas.getContext('webgl2', options)) {
      const gl = new Engine(canvas, true, options);
      if (gl.webGLVersion === 2) engine = gl;
      else gl.dispose();
    }
    if (!engine) throw new GraphicsUnavailable('3D graphics could not start. Open this link in a current browser with WebGPU or WebGL 2. Enable graphics acceleration if available, then retry.');
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
    // Decode the one compressed donor once per scene. Babylon's blob worker
    // pool never settles a queued decode when an embed forbids its workers.
    numWorkers: 0,
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
    const deviceLost = engine instanceof WebGPUEngine ? engine._device.lost : undefined;
    const ready = whenSceneReady(scene);
    if (deviceLost) await Promise.race([ready, deviceLost.then(() => { throw new GraphicsUnavailable('Graphics disconnected during startup. Retry launch.'); })]);
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

export function lighting(scene: Scene) {
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
  // Shade in linear light; apply the display transform once, in each material.
  // MSAA resolves geometry coverage, without filtering already shaded pixels.
  image.toneMappingEnabled = true;
  image.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  image.exposure = 1.0;
  image.contrast = 1.04;
  const skies: Partial<Record<Weather, BakedSky>> = {},
    sky = CreateBox('weather dome', { size: 1400 }, scene),
    skyMaterial = new BackgroundMaterial('HDR sky', scene);
  sky.infiniteDistance = true;
  sky.material = skyMaterial;
  sky.isPickable = false;
  sky.applyFog = false;
  skyMaterial.backFaceCulling = false;
  // BackgroundMaterial defaults to the alpha-test queue, after the opaque
  // hills. Draw the sky with the opaque set, before the circuit, and never
  // write its finite box depth over ridgelines or alpha-tested needles.
  skyMaterial.transparencyMode = BackgroundMaterial.MATERIAL_OPAQUE;
  skyMaterial.disableDepthWrite = true;
  skyMaterial.maxSimultaneousLights = 0;
  async function loadSky(w: Weather, signal: AbortSignal): Promise<BakedSky> {
    const url = asset(`skies/${w === 'damp' ? 'overcast_race' : 'golden_hour'}.env`);
    const response = await fetch(url, { signal });
    if (!response.ok) throw Error(`Cannot load ${w} sky: HTTP ${response.status}`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    signal.throwIfAborted();
    // The optional application field lives in the same .env header as its SH.
    // A promoted download or procedural sky never inherits another plate's sun.
    const info = GetEnvInfo(buffer) as { gt3?: { sun: number[]; radianceScale: number } } | null;
    const meta = info?.gt3;
    if (!meta || !Array.isArray(meta.sun) || meta.sun.length !== 3 || !meta.sun.every(Number.isFinite) ||
        !Number.isFinite(meta.radianceScale) || meta.radianceScale <= 0) throw Error(`Invalid baked ${w} sky`);
    const tex = await new Promise<CubeTexture>((resolve, reject) => {
      const cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      const cube = new CubeTexture(url, scene, {
        buffer,
        onLoad: () => {
          signal.removeEventListener('abort', cancel);
          // An in-flight Babylon upload cannot be interrupted. Release it
          // after the driver finishes, never while it is writing mip faces.
          if (signal.aborted) { if (!scene.isDisposed) cube.dispose(); }
          else resolve(cube);
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
    const skyView = tex.clone(); // SKYBOX_MODE view of the same internal GPU texture
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
      const request = loading = new AbortController();
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
    const wet = w === 'damp', { tex, skyView, source } = loaded;
    // Rotate both lookups from world to plate; the dry disc and key stay at 16°.
    const disc = source.clone();
    if (!wet) {
      disc.y = 0;
      disc.normalize().scaleInPlace(Math.cos((16 * Math.PI) / 180));
      disc.y = Math.sin((16 * Math.PI) / 180);
    }
    const transform = wet
      ? Matrix.Identity()
      : Matrix.RotationAxis(Vector3.Cross(disc, source).normalize(), Math.acos(Math.min(1, Vector3.Dot(disc, source))));
    sun.direction.copyFrom(disc).negateInPlace();
    tex.setReflectionTextureMatrix(transform);
    scene.environmentTexture = tex;
    skyView.setReflectionTextureMatrix(transform);
    skyMaterial.reflectionTexture = skyView;
    skyMaterial.primaryColor = wet ? new Color3(0.83, 0.89, 0.95) : new Color3(1, 0.965, 0.91);
    // Open shade stays lit by the measured sky. In damp conditions the key
    // is weaker and shadows lift; haze separates ridges, not the next car.
    scene.environmentIntensity = wet ? 1.12 : 0.93;
    scene.fogDensity = wet ? 0.00089 : 0.00052;
    scene.fogColor = wet ? new Color3(0.68, 0.72, 0.76) : new Color3(0.84, 0.8, 0.72);
    sun.intensity = wet ? 0.54 : 2.65;
    sun.diffuse = wet ? new Color3(0.88, 0.93, 1) : new Color3(1, 0.84, 0.67);
    fill.intensity = wet ? 0.37 : 0.24;
    if (shadows) shadows.darkness = wet ? 0.48 : 0.14;
  }
  const caps = engine.getCaps();
  const gpu = engine instanceof WebGPUEngine ? engine.currentLimits : undefined;
  const samplers = Math.min(caps.maxTexturesImageUnits, caps.maxCombinedTexturesImageUnits, gpu?.maxSamplersPerShaderStage ?? Infinity);
  const maxMap = Math.min(caps.maxTextureSize, caps.maxRenderTextureSize), mapSize = Math.min(1024, maxMap);
  // The road binds albedo, normal, ORM, lap detail, sky and BRDF in both weathers.
  const materialSamplers = 6;
  const shadowSampler = caps.depthTextureExtension && samplers > materialSamplers;
  // Even a two-cascade Babylon WGSL shader declares four position/depth
  // pairs. Keep the single shadow on devices with a tight varying budget.
  const cascades = shadowSampler && CascadedShadowGenerator.IsSupported && caps.texture2DArrayMaxLayerCount >= 4 &&
    caps.maxVaryingVectors >= (gpu ? 20 : 15) ? new CascadedShadowGenerator(mapSize, sun, false, camera) : null;
  const shadows = cascades ?? (shadowSampler ? new ShadowGenerator(mapSize, sun, false, camera) : null);
  const planes = Frustum.GetPlanes(Matrix.Identity());
  const visibleCasters: AbstractMesh[] = [];
  let cast: AbstractMesh[] = [];
  function casters(meshes: AbstractMesh[]) {
    cast = meshes.filter(m => {
      if (m === sky || !m.isEnabled() || !m.getTotalVertices() || m.metadata?.noShadowCaster || m.metadata?.trackShadowCaster === false) return false;
      if (m.metadata?.shadowProxy) return true;
      for (let parent = m.parent; parent; parent = parent.parent) if (parent.metadata?.chassis) return false;
      return !m.material?.needAlphaBlendingForMesh(m);
    });
    if (shadows) shadows.getShadowMap()!.renderList = cast;
  }
  if (cascades) {
    cascades.numCascades = 2;
    cascades.lambda = 0.72;
    cascades.stabilizeCascades = true;
    cascades.shadowMaxZ = 115;
  } else if (shadows) {
    // A single filtered sun shadow fits low-varying receivers. Keep the map
    // near the player; fitting the bounds of the whole circuit wastes its texels.
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
    shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    shadows.bias = 0.0004;
    shadows.normalBias = 0.028;
    shadows.darkness = 0.13;
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
        m.computeWorldMatrix(); // Layer-zero shadow proxies aren't in the camera's active meshes.
        const { minimumWorld: lo, maximumWorld: hi } = m.getBoundingInfo().boundingBox;
        // Only the four side planes: an off-camera, depth-clamped caster can
        // still cast into view. Support points give long, low guardrail and
        // forest cells a much tighter test than their bounding spheres.
        let p = 2;
        for (; p < 6; p++) {
          const { normal: n, d } = planes[p];
          if (d + n.x * (n.x < 0 ? lo.x : hi.x) + n.y * (n.y < 0 ? lo.y : hi.y) + n.z * (n.z < 0 ? lo.z : hi.z) < 0) break;
        }
        if (p === 6) visibleCasters.push(m);
      }
      return visibleCasters;
    };
  }
  let lamps: ReturnType<typeof raceLights> | undefined;
  let installedQuality: Settings['graphics'] | undefined, garage = true, density = 1, samples = 0, totalMs = 0;
  function resize() {
    const canvas = engine.getRenderingCanvas()!;
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    const budget = installedQuality === 'ultra' ? 2560 * 1440 : 1920 * 1080;
    const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(budget / (w * h)), maxMap / Math.max(w, h));
    const scale = 1 / (ratio * (garage ? 1 : density));
    if (Math.abs(scale - engine.getHardwareScalingLevel()) > 0.001) engine.setHardwareScalingLevel(scale);
    else engine.resize();
  }
  function stage(inGarage: boolean) {
    if (!inGarage) lamps ??= raceLights(scene, sky, samplers - materialSamplers - Number(!!shadows));
    if (garage === inGarage) return;
    garage = inGarage;
    totalMs = samples = 0;
    resize();
  }
  function quality(q: Settings['graphics']) {
    if (installedQuality === q) return;
    installedQuality = q;
    if (shadows) {
      const size = Math.min(maxMap, q === 'ultra' ? 2048 : q === 'high' ? 1024 : 768);
      // Even assigning the current size disposes and recreates the entire atlas.
      if (shadows.mapSize !== size) shadows.mapSize = size;
      bindShadowVolumes();
    }
    density = 1;
    totalMs = samples = 0;
    resize();
  }
  function update(s: RaceState, rigs: VehicleRig[], frameMs: number) {
    if (installedQuality === 'balanced' && !garage && (s.phase === 'race' || s.phase === 'lights') && !document.hidden && frameMs > 0) {
      totalMs += Math.min(120, frameMs);
      // Let transient shader compilation and GC settle. Lower the drawing
      // resolution quickly under sustained pressure; recover detail more slowly.
      if (++samples >= 12 && totalMs >= 420) {
        const mean = totalMs / samples;
        const next = mean > 24 ? Math.max(0.58, density * Math.max(0.78, Math.sqrt(20 / mean))) :
          mean < 18 ? Math.min(1, density + 0.045) : density;
        totalMs = samples = 0;
        if (next !== density) { density = next; resize(); }
      }
    }
    lamps?.update(s, rigs);
  }
  return { quality, setWeather, casters, stage, resize, update };
}

function raceLights(scene: Scene, sky: AbstractMesh, freeSamplers: number) {
  const engine = scene.getEngine(), caps = engine.getCaps();
  const gl = engine instanceof Engine ? engine._gl : undefined;
  const gpu = engine instanceof WebGPUEngine ? engine.currentLimits : undefined;
  // Bound WebGL wet-road program: Material + Scene + sun + fill in fragment;
  // binding #2 is reserved for Mesh. WebGPU also has a leftover-uniform buffer.
  // When Babylon uses plain GL uniforms (e.g. macOS Chrome), the same cluster
  // is supported without occupying any uniform blocks.
  const lightSlots = gpu ? gpu.maxUniformBuffersPerShaderStage - 6 : gl && engine.supportsUniformBuffers ?
    Math.min(gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_BLOCKS) - 4, gl.getParameter(gl.MAX_UNIFORM_BUFFER_BINDINGS) - 5) : 2;
  if (lightSlots < 1) return { update() {} }; // Emissive lamps and sun/sky need no additional light block.
  const lamps: { spot: SpotLight[]; tail?: PointLight }[] = [];
  let cluster: ClusteredLightContainer | undefined;
  function projector(i: number, k: number) {
    const light = new SpotLight(`projector ${i}.${k}`, Vector3.Zero(), Vector3.Forward(), 0.48, 4, scene);
    light.range = 58;
    light.diffuse = new Color3(0.86, 0.94, 1);
    return light;
  }
  const first = projector(0, 0);
  // IsLightSupported checks type, falloff, texel fetch and (GL) float blending,
  // not the binding budget of the receiver. GL reads two textures; WebGPU
  // reads one texture and the 64x64 x two 32-light batches of storage masks.
  const fragmentStorage = gpu && 'maxStorageBuffersInFragmentStage' in gpu
    ? Number(gpu.maxStorageBuffersInFragmentStage) : gpu?.maxStorageBuffersPerShaderStage;
  const clustered = ClusteredLightContainer.IsLightSupported(first) && caps.textureFloat &&
    caps.maxVertexTextureImageUnits >= 1 && freeSamplers >= (gpu ? 1 : 2) &&
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
    // The HDR dome is infinitely distant. Feeding it the finite race lights
    // also selects a cluster UBO on Babylon 9's non-cluster-aware BackgroundMaterial.
    cluster.excludedMeshes.push(sky);
    cluster.renderPriority = 7;
  }
  scene.onDisposeObservable.addOnce(() => cluster?.dispose(false, true));
  function update(s: RaceState, rigs: VehicleRig[]) {
    const on = s.phase !== 'garage';
    if (cluster && cluster.isEnabled() !== on) cluster.setEnabled(on);
    for (let i = 0; i < lamps.length; i++) {
      const d = s.drivers[i],
        l = lamps[i];
      const active = !!d && s.phase !== 'garage' && !!rigs[i];
      const sn = Math.sin(d?.yaw || 0),
        cs = Math.cos(d?.yaw || 0);
      l.spot.forEach((p, k) => {
        p.intensity = active ? (s.settings.weather === 'damp' ? 24 : 8) * (clustered ? 1 : 2) : 0;
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
