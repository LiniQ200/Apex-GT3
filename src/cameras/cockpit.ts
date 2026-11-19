import type { Scene } from '@babylonjs/core/scene';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Quaternion } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { Driver } from '../types';

/** Removable wheel-boss display. Copying the rigged column's pose (rather than
 * parenting to it) lets the vehicle builder dispose and replace rigs freely. */
export function createWheelDisplay(scene: Scene) {
  const mount = new TransformNode('wheel logger mount', scene);
  mount.rotationQuaternion = Quaternion.Identity();
  const housing = CreateBox('wheel logger enclosure', { width: 0.191, height: 0.085, depth: 0.026 }, scene);
  housing.parent = mount;
  housing.position.set(0, 0.012, -0.096);
  housing.rotation.x = 0.16;
  const shell = new StandardMaterial('wheel logger anodised case', scene);
  shell.diffuseColor = new Color3(0.032, 0.042, 0.038);
  shell.specularColor = new Color3(0.19, 0.22, 0.18);
  housing.material = shell;
  const face = CreatePlane('wheel logger LCD', { width: 0.177, height: 0.071 }, scene);
  face.parent = housing;
  face.position.z = -0.014;
  housing.isPickable = face.isPickable = false;
  const texture = new DynamicTexture('wheel logger pixels', { width: 256, height: 96 }, scene, false);
  const c = texture.getContext() as unknown as CanvasRenderingContext2D;
  // Scene readiness includes unbound dynamic textures, even in the garage.
  c.fillStyle = '#141c1b';
  c.fillRect(0, 0, 256, 96);
  texture.update(true);
  const lcd = new StandardMaterial('wheel logger backlight', scene);
  lcd.disableLighting = true;
  lcd.diffuseTexture = texture;
  lcd.emissiveColor = new Color3(0.95, 0.95, 0.95);
  lcd.specularColor = Color3.Black();
  face.material = lcd;
  mount.setEnabled(false);
  let column: TransformNode | undefined,
    nextLookup = 0,
    lastReadout = '';

  return {
    update(driver: Driver | undefined, active: boolean) {
      const now = performance.now();
      if (!active || !driver) {
        if (mount.isEnabled()) mount.setEnabled(false);
        return;
      }
      if (
        (column?.isDisposed() || !column || column.parent?.parent?.metadata?.number !== driver.number) &&
        now >= nextLookup
      ) {
        column = scene.transformNodes.find(
          (n) => n.name === 'driver steering column' && n.parent?.parent?.metadata?.number === driver.number,
        );
        nextLookup = now + 250;
      }
      const available = !!column && !column.isDisposed() && column.isEnabled();
      if (mount.isEnabled() !== available) mount.setEnabled(available);
      if (!available || !column) return;
      column.computeWorldMatrix().decompose(undefined, mount.rotationQuaternion!, mount.position);
      const rpm = Math.max(0, Math.round(driver.rpm / 100) * 100),
        gear = driver.gear > 0 ? String(driver.gear) : driver.gear === 0 ? 'N' : 'R';
      const text = `${gear}/${rpm}`;
      if (text !== lastReadout) {
        lastReadout = text;
        c.fillStyle = '#141c1b';
        c.fillRect(0, 0, 256, 96);
        for (let i = 0; i < 15; i++) {
          c.fillStyle =
            rpm >= 3000 + (i + 1) * 350 ? (i < 6 ? '#8be892' : i < 11 ? '#ffe05b' : '#ff6247') : '#37433d';
          c.fillRect(6 + i * 16.5, 7, 13, 9);
        }
        c.fillStyle = '#ccd6ba';
        c.fillRect(7, 23, 52, 64);
        c.fillStyle = '#19251e';
        c.font = 'bold 54px sans-serif';
        c.textAlign = 'center';
        c.fillText(gear, 33, 77);
        c.textAlign = 'left';
        c.fillStyle = '#a9b7a3';
        c.font = 'bold 13px monospace';
        c.fillText('ENGINE   /   RPM', 70, 41);
        c.fillStyle = '#ebefcf';
        c.font = 'bold 41px monospace';
        c.fillText(String(rpm), 70, 79);
        texture.update(true);
      }
      return column.position;
    },
  };
}
