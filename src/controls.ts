import type { RaceState } from './types';
import { clamp, type Controls } from './physics/world';

export function controls(canvas: HTMLCanvasElement, state: RaceState, command: (key: string) => void) {
  const keys = new Set<string>(),
    mapped = [
      'KeyW',
      'KeyA',
      'KeyS',
      'KeyD',
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'Space',
      'KeyB',
      'KeyC',
      'Escape',
      'KeyE',
      'KeyQ',
      'KeyR',
      'KeyT',
      'KeyY',
      'KeyM',
    ];
  let lastRumble = 0,
    previousYaw = 0,
    headingRate = 0,
    lastButtons: boolean[] = [];
  function keydown(e: KeyboardEvent) {
    if (
      !mapped.includes(e.code) ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      document.querySelector('dialog[open]')
    )
      return;
    if (state.phase === 'garage' && e.code !== 'KeyM') return;
    if (state.phase === 'paused' && e.code !== 'Escape') return;
    e.preventDefault();
    keys.add(e.code);
    if (!e.repeat) command(e.code);
  }
  function keyup(e: KeyboardEvent) {
    keys.delete(e.code);
  }
  function clear() {
    keys.clear();
  }
  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);
  window.addEventListener('blur', clear);
  canvas.addEventListener('pointerdown', () => canvas.focus());
  const button = (pad: Gamepad | undefined, i: number) => pad?.buttons[i]?.value ?? 0;
  function sample(dt: number): Controls {
    const pad = Array.from(navigator.getGamepads?.() ?? []).find((p): p is Gamepad => !!p),
      d = state.drivers[0];
    if (pad) {
      for (const [i, code] of [
        [9, 'Escape'],
        [3, 'KeyC'],
        [5, 'KeyE'],
        [4, 'KeyQ'],
        [8, 'KeyR'],
      ] as const) {
        const pressed = button(pad, i) > 0.5;
        if (pressed && !lastButtons[i]) command(code);
        lastButtons[i] = pressed;
      }
    }
    const analog = pad?.axes[0] ?? 0,
      key =
        Number(keys.has('KeyD') || keys.has('ArrowRight')) -
        Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    const rate =
      Math.atan2(Math.sin(d.yaw - previousYaw), Math.cos(d.yaw - previousYaw)) / Math.max(0.015, dt);
    previousYaw = d.yaw;
    headingRate += (clamp(rate, -3, 3) - headingRate) * Math.min(1, dt * 9);
    const demand = Math.abs(analog) > 0.09 ? analog : key,
      sens = 1 / (1 + d.speed * 0.043);
    const right = demand * sens - (demand === 0 ? headingRate * Math.min(0.14, d.speed * 0.004) : 0);
    if (
      pad?.vibrationActuator &&
      state.phase === 'race' &&
      performance.now() - lastRumble > 120 &&
      (d.surface === 'kerb' || d.absActive)
    ) {
      lastRumble = performance.now();
      void pad.vibrationActuator
        .playEffect('dual-rumble', {
          duration: 95,
          weakMagnitude: 0.25,
          strongMagnitude: d.surface === 'kerb' ? 0.3 : 0.1,
        })
        .catch(() => {});
    }
    return {
      throttle: Math.max(Number(keys.has('KeyW') || keys.has('ArrowUp')), button(pad, 7)),
      brake: Math.max(Number(keys.has('KeyS') || keys.has('ArrowDown')), button(pad, 6)),
      right,
      handbrake: Math.max(Number(keys.has('Space')), button(pad, 0)),
      draft: 0,
    };
  }
  return {
    sample,
    lookBack: () => keys.has('KeyB'),
    clear,
    dispose() {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', clear);
    },
  };
}
