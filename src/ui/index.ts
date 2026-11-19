import { defaults, teams, type Circuit, type RaceState, type Settings, type UiActions } from '../types';
import { circuitGraphic, icon, insignia } from './graphics';
import { clock, createHud } from './hud';
import './style.css';

const options = {
  chassis: [
    ['458', '458 GT3 Evo'],
    ['concept', 'Concept GT3 Prototype'],
  ],
  weather: [
    ['golden', 'Golden hour · Dry'],
    ['damp', 'Overcast · Damp'],
  ],
  mode: [
    ['sprint', '3-lap grid sprint'],
    ['hotlap', 'Hotlap qualifying'],
  ],
  pace: [
    ['clubman', 'Clubman'],
    ['pro', 'Pro'],
    ['platinum', 'FIA Platinum'],
  ],
  transmission: [
    ['auto', 'Automatic'],
    ['manual', 'Manual'],
  ],
  graphics: [
    ['balanced', 'Balanced'],
    ['high', 'High'],
    ['ultra', 'Ultra'],
  ],
} as const;

function select(key: keyof typeof options, label: string, wide = false) {
  return `<label class="ax-field${wide ? ' ax-wide' : ''}"><span class="ax-micro">${label}</span><span class="ax-select"><select data-setting="${key}" aria-label="${label}">${options[key].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>${icon('down')}</span></label>`;
}
const controls = [
  ['W / ↑', 'Accelerate'],
  ['S / ↓', 'Brake'],
  ['A D / ← →', 'Steer'],
  ['SPACE', 'Launch / handbrake'],
  ['E / Q', 'Shift up / down'],
  ['C / B', 'Camera / look back'],
  ['R', 'Reset to track'],
  ['T / Y', 'Cycle TC / ABS'],
  ['M', 'Mute audio'],
  ['ESC', 'Pause / resume'],
];

export function createUI(
  element: HTMLElement,
  circuit: Circuit,
  actions: UiActions,
): { update(state: RaceState): void } {
  const graphic = circuitGraphic(circuit);
  // Use an owned child so the host's canvas or loading indicator is never replaced.
  const root = document.createElement('div');
  root.className = 'ax-ui';
  element.append(root);
  root.innerHTML = `<div class="ax-garage" data-section="garage">
    <header class="ax-mast"><div class="ax-wordmark">${insignia}<b>APEX <i>GT3</i></b></div><span class="ax-mast-slash">/</span><div class="ax-series">WEBGPU<span>SIM</span></div>
      <div class="ax-mast-status"><i class="ax-live-dot"></i> PADDOCK ONLINE</div><div class="ax-utility"><button data-help title="Driving controls">${icon('keys')}<span>Controls</span></button><button data-action="toggleMute" data-sound aria-label="Mute audio"></button></div></header>
    <div class="ax-identity"><div class="ax-strap"><i></i> COMPETITION GARAGE <span>/</span> BAY 01</div><h1 data-chassis>458 GT3 EVO</h1><div class="ax-teamline"><b data-team-no>88</b><span data-team-name>Scuderia Rosso Corsa</span><em>FACTORY ENTRY</em></div></div>
    <section class="ax-config" aria-label="Garage setup"><div class="ax-config-scroll"><div class="ax-config-title"><div class="ax-strap"><i></i> RACE OPERATIONS</div><div><h2>Session setup</h2>${icon('tune')}</div></div>
      <div class="ax-form-section"><div class="ax-section-head"><span>01</span> VEHICLE ENTRY <i></i></div><div class="ax-fields">${select('chassis', 'Chassis', true)}
      <div class="ax-livery ax-wide"><div class="ax-livery-label"><span class="ax-micro">Factory livery</span><b data-livery-code>01 / 05</b></div><div class="ax-swatches" role="group" aria-label="Factory livery">${teams.map(([num, name, base, accent], i) => `<button type="button" data-livery="${i}" title="#${num} ${name}" aria-label="${name} livery" aria-pressed="false" style="--paint:${base};--stripe:${accent}"><i></i><b>${num}</b></button>`).join('')}</div></div></div></div>
      <div class="ax-form-section"><div class="ax-section-head"><span>02</span> SESSION PARAMETERS <i></i></div><div class="ax-fields">${select('mode', 'Race format', true)}${select('weather', 'Conditions', true)}${select('pace', 'AI pace')}${select('transmission', 'Gearbox')}
      <div class="ax-quality ax-wide"><span class="ax-micro">Graphics</span><div role="group" aria-label="Graphics quality">${options.graphics.map(([v, name]) => `<button data-quality="${v}" aria-pressed="false">${name}</button>`).join('')}</div></div></div></div></div>
      <button class="ax-drive" data-action="start" aria-label="Drive — Start session"><b>DRIVE</b><small>START SESSION</small>${icon('arrow')}</button></section>
    <section class="ax-dossier"><div class="ax-dossier-map">${graphic.svg}</div><div class="ax-dossier-text"><div class="ax-location"><i></i> CIRCUIT DOSSIER <span>/ ITA</span></div><h2>Autodromo Valle d’Oro</h2><p>${(circuit.length / 1000).toFixed(2)} KM <b>·</b> 10 CORNERS <b>·</b> <span data-race-distance>03 LAPS</span></p></div></section>
    <footer class="ax-footer"><div><i></i> APEX MOTORSPORT <span>/</span> SIMULATION DIVISION</div><a class="ax-credit" style="pointer-events:auto;color:inherit" href="./credits.txt" target="_blank" rel="noopener">HDRIs &amp; PBR Textures: Powered by Poly Haven (CC0) · Credits</a><b data-backend></b></footer>
  </div><div class="ax-hud" data-section="hud" hidden></div>
  <div class="ax-overlay" data-section="paused" hidden><section class="ax-modal ax-pause"><div class="ax-strap"><i></i> RACE CONTROL / PIT WALL</div><h2>Session paused</h2><div class="ax-rule"></div><div class="ax-fields">${select('transmission', 'Gearbox')}${select('graphics', 'Graphics')}</div>
    <div class="ax-tune-rows"><button data-action="cycleTc">Traction control <b data-tc></b>${icon('angle')}</button><button data-action="cycleAbs">Anti-lock braking <b data-abs></b>${icon('angle')}</button><button data-action="toggleMute">Race audio <b data-audio></b>${icon('angle')}</button></div>
    <button class="ax-primary" data-action="resume">RESUME SESSION ${icon('arrow')}</button><div class="ax-modal-foot"><button data-action="restart">Restart race</button><button data-action="garage">Return to garage</button><button data-help>Controls</button></div></section></div>
  <div class="ax-overlay" data-section="finished" hidden><section class="ax-modal ax-finish"><div class="ax-strap"><i></i> CHEQUERED FLAG / OFFICIAL RESULT</div><h2>Final classification</h2><div class="ax-finish-summary"><span>YOUR FINISH <b data-finish-place></b></span><span>BEST LAP <b data-finish-lap></b></span></div><div class="ax-result-scroll"><table><thead><tr><th>POS</th><th>DRIVER</th><th>NO.</th><th>DISTANCE</th></tr></thead><tbody></tbody></table></div><button class="ax-primary" data-action="restart">RACE AGAIN ${icon('arrow')}</button><div class="ax-modal-foot"><button data-action="garage">Return to garage</button></div></section></div>
  <dialog class="ax-modal ax-help"><div class="ax-help-head"><div class="ax-strap"><i></i> DRIVING MANUAL</div><button data-close aria-label="Close controls">${icon('close')}</button></div><h2>Driver controls</h2><dl>${controls.map(([k, v]) => `<div><dt><kbd>${k}</kbd></dt><dd>${v}</dd></div>`).join('')}</dl><p>Keyboard or connected gamepad.</p><button data-close class="ax-primary">BACK ${icon('arrow')}</button></dialog>`;

  const sections = Object.fromEntries(
    Array.from(root.querySelectorAll<HTMLElement>('[data-section]'), (e) => [e.dataset.section!, e]),
  );
  const hud = createHud(sections.hud, circuit, graphic),
    dialog = root.querySelector('dialog')!;
  const query = (selector: string) => root.querySelector<HTMLElement>(selector)!;
  const swatches = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-livery]'));
  const qualities = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-quality]'));
  const selects = Array.from(root.querySelectorAll<HTMLSelectElement>('select[data-setting]'));
  const sounds = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-sound]'));
  let settingsKey = '',
    soundState: boolean | undefined,
    lastPhase: RaceState['phase'] | undefined,
    hudDue = 0;
  const simpleActions = [
    'start',
    'resume',
    'garage',
    'restart',
    'cycleTc',
    'cycleAbs',
    'toggleMute',
  ] as const;
  root.addEventListener('click', (e) => {
    const button = (e.target as Element).closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if ('help' in button.dataset) {
      if (!dialog.open) dialog.showModal();
      return;
    }
    if ('close' in button.dataset) {
      dialog.close();
      return;
    }
    const action = simpleActions.find((a) => a === button.dataset.action);
    if (action) {
      actions[action]();
      if (sections.hud.contains(button)) button.blur();
      return;
    }
    if (button.dataset.livery !== undefined) actions.configure({ livery: Number(button.dataset.livery) });
    else if (button.dataset.quality !== undefined)
      actions.configure({ graphics: button.dataset.quality as Settings['graphics'] });
  });
  root.addEventListener('change', (e) => {
    const select = e.target as HTMLSelectElement,
      key = select.dataset.setting as keyof typeof options;
    if (!Object.hasOwn(options, key) || !options[key].some(([value]) => value === select.value)) return;
    actions.configure({ [key]: select.value });
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      dialog.close();
    }
  });
  function syncSettings(settings: Settings) {
    const key = Object.values(settings).join('|');
    if (key === settingsKey) return;
    settingsKey = key;
    for (const input of selects) {
      const k = input.dataset.setting as keyof typeof options;
      input.value = settings[k];
      input.disabled = k === 'pace' && settings.mode === 'hotlap';
    }
    for (const b of swatches)
      b.setAttribute('aria-pressed', String(Number(b.dataset.livery) === settings.livery));
    for (const b of qualities)
      b.setAttribute('aria-pressed', String(b.dataset.quality === settings.graphics));
    const team = teams[settings.livery] || teams[0];
    query('[data-team-no]').textContent = team[0];
    query('[data-team-name]').textContent = team[1];
    query('[data-chassis]').textContent = settings.chassis === '458' ? '458 GT3 Evo' : 'Concept GT3';
    query('[data-livery-code]').textContent = `0${settings.livery + 1} / 05`;
    query('[data-race-distance]').textContent = settings.mode === 'sprint' ? '03 LAPS' : 'HOTLAP';
  }
  function classification(s: RaceState) {
    const drivers = [...s.drivers].sort((a, b) => b.distance - a.distance || a.id - b.id);
    const body = root.querySelector('tbody')!;
    body.replaceChildren();
    drivers.forEach((d, i) => {
      const row = body.insertRow();
      if (d.id === 0) row.className = 'is-player';
      for (const v of [
        String(i + 1).padStart(2, '0'),
        d.id === 0 ? 'YOU' : d.name,
        d.number,
        `${(Math.max(0, d.distance) / 1000).toFixed(2)} km`,
      ])
        row.insertCell().textContent = v;
    });
    query('[data-finish-place]').textContent = `P${drivers.findIndex((d) => d.id === 0) + 1}`;
    query('[data-finish-lap]').textContent = s.bestLap > 0 ? clock(s.bestLap) : '–:––.–––';
  }
  syncSettings(defaults);
  return {
    update(s) {
      const change = s.phase !== lastPhase;
      if (change) {
        if (dialog.open) dialog.close();
        Object.entries(sections).forEach(
          ([key, el]) => (el.hidden = key !== (s.phase === 'lights' || s.phase === 'race' ? 'hud' : s.phase)),
        );
        if (s.phase === 'garage' || s.phase === 'lights') hud.reset();
        if (s.phase === 'finished') classification(s);
        lastPhase = s.phase;
      }
      if (s.phase === 'garage' || s.phase === 'paused') {
        syncSettings(s.settings);
        if (soundState !== s.muted) {
          for (const b of sounds) {
            b.innerHTML = icon(s.muted ? 'silent' : 'sound');
            b.setAttribute('aria-label', s.muted ? 'Unmute audio' : 'Mute audio');
            b.title = s.muted ? 'Unmute audio' : 'Mute audio';
          }
          soundState = s.muted;
        }
        if (s.phase === 'paused') {
          query('[data-tc]').textContent = `${s.tc} / 5`;
          query('[data-abs]').textContent = `${s.abs} / 3`;
          query('[data-audio]').textContent = s.muted ? 'MUTED' : 'LIVE';
        } else {
          const b = query('[data-backend]');
          if (b.textContent !== s.backend) b.textContent = s.backend;
        }
      } else if (s.phase === 'lights' || s.phase === 'race') {
        const now = performance.now();
        if (change || now >= hudDue) {
          hudDue = now + 65;
          hud.update(s);
        }
      }
    },
  };
}
