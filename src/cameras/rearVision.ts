import type { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Frustum } from '@babylonjs/core/Maths/math.frustum';
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';

/** An auxiliary texture pass, not another scene or another main camera. The
 * main camera's active mesh list normally contains no cars astern. */
export function createRearVision(scene: Scene, mount: TransformNode) {
  const width = 320,
    height = 96;
  const camera = new FreeCamera('tail camera', new Vector3(0, 1.05, -2.27), scene, false);
  camera.inputs.clear();
  camera.parent = mount;
  // The lens is centred at the tail, not at the laterally offset column.
  camera.position.subtractInPlace(mount.position);
  camera.rotation.set(0.065, Math.PI, 0);
  camera.minZ = 0.18;
  camera.maxZ = 1800; // includes the HDR dome; traffic has a much shorter cut-off
  camera.fov = 0.56;
  const projection = Matrix.Identity(),
    engine = scene.getEngine();
  // The auxiliary lens has its own aspect even during scene readiness / resize.
  Matrix.PerspectiveFovLHToRef(
    camera.fov,
    width / height,
    camera.minZ,
    camera.maxZ,
    projection,
    true,
    engine.isNDCHalfZRange,
  );
  camera.freezeProjectionMatrix(projection);
  const target = new RenderTargetTexture('rear vision feed', { width, height }, scene, {
    generateMipMaps: false,
    samples: 1,
    samplingMode: Texture.BILINEAR_SAMPLINGMODE,
    // Babylon's normal clustered-light pass uses the main view's tile mask
    // and depth slices. Rebin the same lamps for the tail lens before this
    // pass; the main camera's own gather then restores its mask as usual.
    enableClusteredLights: true,
  });
  target.activeCamera = camera;
  target.noPrePassRenderer = true;
  target.useCameraPostProcesses =
    target.renderParticles =
    target.renderSprites =
    target.enableOutlineRendering =
      false;
  target.wrapU = target.wrapV = Texture.CLAMP_ADDRESSMODE;

  const sky = scene.getMeshByName('weather dome');
  const road = scene.meshes.filter((m) => /^circuit\.(asphalt|grass|paint$)|^terrain\./.test(m.name));
  const verge = scene.meshes.filter((m) =>
    /^circuit\.(wall|pitWall|gravel|painted kerb)|^venue\.box/.test(m.name),
  );
  const playerRoot = mount.parent?.parent;
  const roster = () =>
    scene.transformNodes
      .filter((n) => n.metadata?.chassis && n !== playerRoot)
      .map((root) => ({
        root,
        depth: Infinity,
        exterior: root
          .getChildMeshes()
          .filter((m) => m.metadata?.rigPart && m.metadata.rigPart.joint !== 'column'),
      }));
  const planes = Frustum.GetPlanes(Matrix.Identity()),
    clip = Matrix.Identity(),
    local = Vector3.Zero();
  const list: AbstractMesh[] = [];
  target.getCustomRenderList = () => list; // never includes the player, any screen, HUD, or shadow hull
  let traffic = roster(),
    population = scene.transformNodes.length;
  let nextTime = 0,
    nextFrame = 0,
    queued = false;
  function dequeue() {
    if (!queued) return;
    const i = scene.customRenderTargets.indexOf(target);
    if (i >= 0) scene.customRenderTargets.splice(i, 1);
    queued = false;
  }
  return {
    target,
    dequeue,
    refresh(now: number, live: boolean) {
      dequeue();
      const frame = scene.getFrameId();
      if (!live || now < nextTime || frame < nextFrame) return;
      nextTime = now + 100; // at most 10 Hz and one in three presented frames on slower devices
      nextFrame = frame + 3;
      const view = camera.getViewMatrix(true);
      view.multiplyToRef(projection, clip);
      Frustum.GetPlanesToRef(clip, planes);
      list.length = 0;
      if (sky) list.push(sky);
      for (const m of road) {
        if (list.length >= 16) break;
        if (m.isInFrustum(planes)) list.push(m);
      }
      for (const m of verge) {
        if (list.length >= 16) break;
        const sphere = m.getBoundingInfo().boundingSphere;
        if (
          Vector3.Distance(camera.globalPosition, sphere.centerWorld) < 140 + sphere.radiusWorld &&
          m.isInFrustum(planes)
        )
          list.push(m);
      }
      // On restart the player can finish loading before the other donor. Don't
      // retain a half-built grid, or rescan its hierarchy every mirror refresh.
      if (population !== scene.transformNodes.length) {
        traffic = roster();
        population = scene.transformNodes.length;
      }
      for (const t of traffic) {
        Vector3.TransformCoordinatesToRef(t.root.position, view, local);
        t.depth = local.z > -1 && local.z < 125 && Math.abs(local.x) < 2 + local.z ? local.z : Infinity;
      }
      traffic.sort((a, b) => a.depth - b.depth);
      // Budget *whole* visible rigs. A close GT3 has separate roof, glazing,
      // aero and four wheel assemblies, while the farther tiers batch them.
      // Never spend a last partial draw allowance on just the front wheels.
      let remaining = 64;
      for (let i = 0; i < Math.min(2, traffic.length) && Number.isFinite(traffic[i].depth); i++) {
        const start = list.length;
        for (const m of traffic[i].exterior) if (m.isEnabled()) list.push(m);
        const parts = list.length - start;
        if (parts > remaining) list.length = start;
        else remaining -= parts;
      }
      scene.customRenderTargets.push(target);
      queued = true;
    },
    dispose() {
      dequeue();
      target.dispose();
      // The mount owns the child camera and disposes it along with the screens.
    },
  };
}
