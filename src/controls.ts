import type { RaceState } from './types';
import { clamp, type Controls } from './physics/world';
import { createTouchControls } from './ui/touch';

export function controls(
  canvas: HTMLCanvasElement,
  state: RaceState,
  command: (key: string) => void,
  onInterrupt?: () => void,
) {
  const hud = canvas.ownerDocument.querySelector<HTMLElement>('[data-section="hud"]');
  const touch = hud && navigator.maxTouchPoints > 0 ? createTouchControls(hud, state, command) : undefined;
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
      'KeyL',
      'KeyP',
      'KeyV',
    ];
  let lastRumble = 0,
    previousYaw = 0,
    headingRate = 0,
    padsDenied = false,
    syncButtons = false;
  const lastButtons: boolean[] = [];
  const driving = () => state.phase === 'race' || state.phase === 'lights';
  function activePad() {
    if (padsDenied) return;
    try {
      for (const pad of navigator.getGamepads?.() ?? []) if (pad?.connected) return pad;
    } catch (e) {
      // Permissions Policy is fixed for this document. Don't throw (and emit a
      // browser policy violation) on every frame in a keyboard-only embed.
      if (e instanceof DOMException && e.name === 'SecurityError') padsDenied = true;
    }
  }
  function keydown(e: KeyboardEvent) {
    if (
      !mapped.includes(e.code) ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      e.defaultPrevented ||
      document.hidden ||
      (e.target instanceof HTMLElement &&
        (e.target.isContentEditable || e.target.matches('input,select,textarea'))) ||
      document.querySelector('dialog[open]')
    )
      return;
    if (!driving() && e.code !== (state.phase === 'paused' ? 'Escape' : 'KeyM')) return;
    if (e.code === 'Space' && e.target instanceof HTMLElement && e.target.closest('button,summary')) return;
    e.preventDefault();
    keys.add(e.code);
    if (!e.repeat) command(e.code);
  }
  function keyup(e: KeyboardEvent) {
    keys.delete(e.code);
  }
  function clear() {
    keys.clear();
    touch?.clear();
    previousYaw = state.drivers[0]?.yaw ?? 0;
    headingRate = 0;
    syncButtons = true;
  }
  function interrupt() {
    clear();
    onInterrupt?.();
  }
  const visibility = () => {
    if (document.hidden) interrupt();
  };
  const focusCanvas = () => canvas.focus();
  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);
  window.addEventListener('blur', interrupt);
  document.addEventListener('visibilitychange', visibility);
  canvas.addEventListener('pointerdown', focusCanvas);
  const button = (pad: Gamepad | undefined, i: number) => pad?.buttons[i]?.value ?? 0;
  function sample(dt: number): Controls {
    const fingers = touch?.sync();
    const focused = !document.hidden && document.hasFocus();
    const pad = focused && (driving() || state.phase === 'paused') ? activePad() : undefined;
    const blocked = !focused || (pad && !!document.querySelector('dialog[open]'));
    if (pad) {
      for (const [i, code] of [
        [9, 'Escape'],
        [3, 'KeyC'],
        [5, 'KeyE'],
        [4, 'KeyQ'],
        [8, 'KeyR'],
      ] as const) {
        const pressed = button(pad, i) > 0.5;
        if (!blocked && !syncButtons && pressed && !lastButtons[i] && (driving() || code === 'Escape'))
          command(code);
        lastButtons[i] = pressed;
      }
      syncButtons = false;
    } else lastButtons.length = 0;
    if (blocked || !driving()) return { throttle: 0, brake: 0, right: 0, handbrake: 0, draft: 0 };
    const d = state.drivers[0];
    const analog = pad?.axes[0] ?? 0,
      key =
        Number(keys.has('KeyD') || keys.has('ArrowRight')) -
        Number(keys.has('KeyA') || keys.has('ArrowLeft'));
    const rate =
      Math.atan2(Math.sin(d.yaw - previousYaw), Math.cos(d.yaw - previousYaw)) / Math.max(0.015, dt);
    previousYaw = d.yaw;
    headingRate += (clamp(rate, -3, 3) - headingRate) * Math.min(1, dt * 9);
    // A batch of physics ticks can turn the lights green between input samples.
    // A pre-green touch must not leak into the next phase, even for that first batch.
    const axes = state.phase === 'race' ? fingers : undefined;
    const demand = axes?.steer ?? (Math.abs(analog) > 0.09 ? analog : key),
      sens = 1 / (1 + d.speed * 0.036);
    const right = demand * sens - (demand === 0 ? headingRate * Math.min(0.16, d.speed * 0.0045) : 0);
    if (
      typeof pad?.vibrationActuator?.playEffect === 'function' &&
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
      throttle: Math.max(Number(keys.has('KeyW') || keys.has('ArrowUp')), button(pad, 7), axes?.throttle ?? 0),
      brake: Math.max(Number(keys.has('KeyS') || keys.has('ArrowDown')), button(pad, 6), axes?.brake ?? 0),
      right,
      handbrake: Math.max(Number(keys.has('Space')), button(pad, 0), axes?.handbrake ?? 0),
      draft: 0,
    };
  }
  return {
    sample,
    lookBack: () => keys.has('KeyB') || !!touch?.sync().rear,
    clear,
    interrupt,
    dispose() {
      clear();
      touch?.dispose();
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', interrupt);
      document.removeEventListener('visibilitychange', visibility);
      canvas.removeEventListener('pointerdown', focusCanvas);
    },
  };
}
