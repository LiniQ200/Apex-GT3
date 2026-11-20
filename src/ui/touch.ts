import type { RaceState } from '../types';
import './touch.css';

const commands = { camera: 'KeyC', recover: 'KeyR', pause: 'Escape', down: 'KeyQ', up: 'KeyE' } as const;
type Key = keyof typeof commands | 'rear' | 'handbrake';
type Axis = 'steer' | 'throttle' | 'brake';
const glyphs = {
  camera: '<path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="3.5"/>',
  rear: '<path d="M3 6h18l-2 8H5zM12 14v4m-3 2 3-2 3 2"/>',
  recover: '<path d="M4 12a8 8 0 1 1 3 6M4 5v7h7"/>',
  pause: '<path d="M8 5v14m8-14v14" stroke-width="4"/>',
  down: '<path d="M5 12h14" stroke-width="2.6"/>',
  up: '<path d="M5 12h14M12 5v14" stroke-width="2.6"/>',
  handbrake: '<circle cx="12" cy="12" r="6.8"/><path d="M4 5a11 11 0 0 0 0 14m16-14a11 11 0 0 1 0 14M10 16V8h3a2.2 2.2 0 0 1 0 4.4h-3"/>',
  wheel: '<circle cx="12" cy="12" r="9.2"/><circle cx="12" cy="12" r="2.2"/><path d="m3.5 9 6.5 2.5m10.5-2.5L14 11.5M12 14.5v6M12 3v3"/>',
};
const icon = (name: keyof typeof glyphs) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name]}</svg>`;
const key = (name: Key, text: string, label: string) =>
  `<button type="button" class="ax-touch-key" data-touch="${name}" aria-label="${label}" title="${label}"${name === 'rear' || name === 'handbrake' ? ' aria-pressed="false"' : ''}>${icon(name)}<span>${text}</span></button>`;
const axis = (name: Axis, label: string, face: string) =>
  `<div class="ax-touch-axis ax-touch-${name}" data-touch="${name}">${face}<input type="range" aria-label="${label}" aria-orientation="${name === 'steer' ? 'horizontal' : 'vertical'}" min="${name === 'steer' ? -100 : 0}" max="100" value="0"></div>`;
const pedal = (name: 'throttle' | 'brake', label: string) =>
  axis(name, `${name === 'throttle' ? 'Gas (throttle)' : 'Brake'} pedal, slide up for more`, `<i class="ax-touch-tread" aria-hidden="true"></i><b>${label}</b>`);
const limit = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export function createTouchControls(hud: HTMLElement, state: RaceState, command: (code: string) => void) {
  const view = document.createElement('div');
  view.className = 'ax-touch';
  view.setAttribute('role', 'group');
  view.setAttribute('aria-label', 'Touch driving controls');
  view.innerHTML = `<div class="ax-touch-bank ax-touch-left"><div class="ax-touch-keys">
    ${key('camera', 'Cam', 'Change camera')}${key('rear', 'Rear', 'Hold to look back')}${key('down', 'Shift', 'Shift down')}</div>
    ${axis('steer', 'Steering, slide left or right', `<span class="ax-touch-legend"><b>Steer</b><i>◂ &nbsp; ▸</i></span><span class="ax-touch-rail"><i>${icon('wheel')}</i></span>`)}
  </div><div class="ax-touch-bank ax-touch-right"><div class="ax-touch-keys">
    ${key('up', 'Shift', 'Shift up')}${key('recover', 'Reset', 'Recover to track')}${key('pause', 'Pause', 'Pause session')}</div>
    <div class="ax-touch-feet">${key('handbrake', 'H-Brake', 'Hold handbrake')}${pedal('brake', 'Brake')}${pedal('throttle', 'Gas')}</div></div>`;
  hud.append(view);
  hud.classList.add('ax-touch-hud');

  const values = { steer: null as number | null, throttle: 0, brake: 0, handbrake: 0, rear: false };
  // The plate owns touch; the native range is for keyboard/assistive adjustment.
  // A native range drag otherwise survives explicit pointer-capture loss in Chromium.
  const axes = new Map(Array.from(view.querySelectorAll('input'), input => [input.parentElement!, input] as const));
  const contacts = new Map<number, { el: HTMLElement; rect: DOMRect }>();
  let phase = state.phase;
  let transmission: RaceState['settings']['transmission'] | undefined;
  const shifters = view.querySelectorAll<HTMLElement>('[data-touch="up"], [data-touch="down"]');
  const available = () => (state.phase === 'race' || state.phase === 'lights') &&
    !hud.hidden && !hud.closest('[inert]') && !document.hidden && document.hasFocus();

  function setAxis(el: HTMLInputElement, value: number, active: boolean) {
    const plate = el.parentElement!;
    const name = plate.dataset.touch as Axis;
    if (name === 'steer') values.steer = active ? value : null;
    else values[name] = value;
    el.value = String(Math.round(value * 100));
    plate.toggleAttribute('data-held', active);
    plate.style.setProperty('--travel', String(value));
  }
  function hold(el: HTMLElement, on: boolean) {
    const name = el.dataset.touch;
    el.toggleAttribute('data-held', on);
    if (name === 'rear') values.rear = on;
    if (name === 'handbrake') values.handbrake = Number(on);
    if (name === 'rear' || name === 'handbrake') el.setAttribute('aria-pressed', String(on));
  }
  function release(id: number) {
    const contact = contacts.get(id);
    if (!contact) return;
    contacts.delete(id);
    const { el } = contact;
    const input = axes.get(el);
    if (input) setAxis(input, 0, false);
    else hold(el, false);
    if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
  }
  function clear() {
    for (const id of contacts.keys()) release(id);
    // A focused range can also be adjusted without a pointer (keyboard or assistive technology).
    for (const el of view.querySelectorAll<HTMLInputElement>('[data-held] > input')) setAxis(el, 0, false);
    for (const el of view.querySelectorAll<HTMLElement>('button[data-held]')) hold(el, false);
  }
  function sync() {
    if (phase !== state.phase) {
      clear();
      phase = state.phase;
    }
    if (transmission !== state.settings.transmission) {
      transmission = state.settings.transmission;
      for (const el of shifters) el.hidden = transmission !== 'manual';
    }
    return values;
  }
  function position(e: PointerEvent, el: HTMLElement, rect: DOMRect) {
    const input = axes.get(el);
    if (!input) return;
    // Leave a thumb-width margin: full lock / full pedal is reachable without touching the bezel.
    const steer = el.dataset.touch === 'steer';
    const dx = e.clientX - rect.left - rect.width / 2;
    const value = steer
      ? Math.sign(dx) * limit((Math.abs(dx) - 3) / (rect.width / 2 - 17), 0, 1)
      : limit((rect.bottom - e.clientY - 8) / (rect.height - 16), 0, 1);
    setAxis(input, value, true);
  }
  function fire(el: HTMLElement) {
    const name = el.dataset.touch as keyof typeof commands;
    if (Object.hasOwn(commands, name) && available() && !el.hidden) command(commands[name]);
  }

  view.addEventListener('pointerdown', e => {
    sync();
    const el = (e.target as Element).closest<HTMLElement>('[data-touch]');
    if (!el || e.button !== 0 || !available()) return;
    e.preventDefault();
    for (const c of contacts.values()) if (c.el === el) return; // Never let a second finger steal an axis.
    const rect = el.getBoundingClientRect();
    contacts.set(e.pointerId, { el, rect });
    el.setPointerCapture(e.pointerId);
    if (axes.has(el)) position(e, el, rect);
    else hold(el, true);
  });
  view.addEventListener('pointermove', e => {
    sync();
    const c = contacts.get(e.pointerId);
    if (c) position(e, c.el, c.rect);
  });
  view.addEventListener('pointerup', e => {
    sync();
    const c = contacts.get(e.pointerId);
    if (!c) return;
    release(e.pointerId);
    // Commit discrete commands on an intentional release, even for a non-primary finger.
    const r = c.rect;
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) fire(c.el);
  });
  view.addEventListener('pointercancel', e => release(e.pointerId));
  view.addEventListener('lostpointercapture', e => {
    if (contacts.get(e.pointerId)?.el === e.target) release(e.pointerId);
  });
  view.addEventListener('contextmenu', e => e.preventDefault());
  view.addEventListener('click', e => {
    // Keyboard/assistive activation. Touch compatibility clicks must not shift or cycle twice.
    const el = (e.target as Element).closest('button');
    if (el && e.detail === 0) fire(el);
  });
  view.addEventListener('input', e => {
    const el = e.target;
    if (el instanceof HTMLInputElement && available()) setAxis(el, el.valueAsNumber / 100, true);
  });
  view.addEventListener('keydown', e => {
    const el = e.target;
    if (el instanceof HTMLButtonElement && el.hasAttribute('aria-pressed') &&
      (e.key === ' ' || e.key === 'Enter') && available()) {
      e.preventDefault();
      hold(el, true);
    }
  });
  function releaseFocus(e: Event) {
    const el = e.target;
    if (el instanceof HTMLInputElement) setAxis(el, 0, false);
    if (el instanceof HTMLButtonElement) hold(el, false);
  }
  view.addEventListener('keyup', releaseFocus);
  view.addEventListener('focusout', releaseFocus);
  window.addEventListener('resize', clear);
  sync();
  return {
    sync, clear,
    dispose() {
      clear();
      window.removeEventListener('resize', clear);
      hud.classList.remove('ax-touch-hud');
      view.remove();
    },
  };
}
