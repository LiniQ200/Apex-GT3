import { raceOrder, SPRINT_LAPS } from '../physics/race';
import { COMPOUNDS } from '../physics/tires';
import { teams, type Circuit, type Driver, type RaceState, type Weather } from '../types';
import { circuitGraphic, icon, insignia } from './graphics';
import { createPitwall } from './pitwall';
import './pitwall.css';

export function clock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–:––.–––';
  const ms = Math.floor(1000 * seconds);
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
const two = (n: number) => String(n).padStart(2, '0');
const clip = (n: number) => Math.max(0, Math.min(1, n));
const cameras = { chase: 'CHASE', cockpit: 'HELMET', hood: 'ONBOARD', tv: 'TRACKSIDE' };
const weatherLabels: [Weather, string][] = [
  ['clear', 'CLEAR'],
  ['golden', 'GOLDEN'],
  ['dusk', 'DUSK'],
  ['damp', 'DAMP'],
  ['rain', 'RAIN'],
];

class Transponder {
  private static readonly size = 512;
  private samples = new Float64Array(2 * Transponder.size);
  private count = 0;
  private index(i: number) {
    return (i % Transponder.size) * 2;
  }
  record(m: number, t: number) {
    if (this.count && m <= this.samples[this.index(this.count - 1)]) return;
    const i = this.index(this.count++);
    this.samples[i] = m;
    this.samples[i + 1] = t;
  }
  crossing(m: number) {
    let lo = Math.max(0, this.count - Transponder.size),
      hi = this.count - 1;
    if (hi <= lo || this.samples[this.index(lo)] > m || this.samples[this.index(hi)] < m) return null;
    while (hi - lo > 1) {
      const mid = (hi + lo) >>> 1;
      if (this.samples[this.index(mid)] < m) lo = mid;
      else hi = mid;
    }
    const a = this.index(lo),
      b = this.index(hi);
    return (
      this.samples[a + 1] +
      ((m - this.samples[a]) / (this.samples[b] - this.samples[a])) *
        (this.samples[b + 1] - this.samples[a + 1])
    );
  }
}

export function createHud(el: HTMLElement, circuit: Circuit, outline: ReturnType<typeof circuitGraphic>) {
  el.innerHTML = `<div class="ax-tower ax-glass"><header class="ax-tv-title">${insignia}<b>LIVE TIMING</b><span class="ax-live-dot"></span></header>
    <div class="ax-tower-cols ax-micro"><span>POS</span><span>DRIVER</span><span>INTERVAL</span></div><ol data-rows></ol></div>
    <section class="ax-laptime ax-glass"><div class="ax-lap-line"><div class="ax-lap-n"><small>LAP</small><b data-v="lap">01/03</b></div><strong data-v="clock">0:00.000</strong></div>
      <div class="ax-sectors">${[1, 2, 3].map((i) => `<span data-sector>S${i}</span>`).join('')}<output data-v="delta">Δ —</output></div><div class="ax-delta"><i></i></div>
      <div class="ax-pitwall" role="group" aria-label="Race engineer" hidden></div></section>
    <div class="ax-feed"><b>${insignia} APEX <i>RACECAST</i></b><span class="ax-camera-id"><i class="ax-live-dot"></i><span data-v="camera"></span></span>
      <div class="ax-weather-bar" role="group" aria-label="Live weather">${weatherLabels.map(([w, lbl]) => `<button type="button" data-weather="${w}" aria-pressed="false">${lbl}</button>`).join('')}</div>
      <div class="ax-track-meta"><span data-v="trackMeta">27°C · DRY</span><button type="button" data-action="togglePitMfd" title="Toggle Pit Strategy MFD (P)">PIT MFD</button></div></div>
    <div class="ax-pit-banner" data-pit-banner hidden><strong data-v="pitBannerTitle">PIT LIMITER 60 KM/H</strong><span data-v="pitBannerSub">PULL INTO BAY 01</span><div class="ax-pit-prog"><i data-pit-prog></i></div></div>
    <section class="ax-mfd ax-glass" data-mfd hidden aria-label="MoTeC Pit Strategy MFD">
      <header class="ax-mini-head"><b>MoTeC <em>PIT MFD</em></b><button type="button" data-action="togglePitMfd">ESC / P</button></header>
      <div class="ax-mfd-row"><span class="ax-micro">NEXT TYRE</span><div class="ax-mfd-btns"><button type="button" data-mfd-compound="soft">SOFT</button><button type="button" data-mfd-compound="medium">MED</button><button type="button" data-mfd-compound="wet">WET</button></div></div>
      <div class="ax-mfd-row"><span class="ax-micro">REFUEL</span><div class="ax-mfd-btns"><button type="button" data-mfd-fuel="0">+0L</button><button type="button" data-mfd-fuel="20">+20L</button><button type="button" data-mfd-fuel="40">+40L</button><button type="button" data-mfd-fuel="70">+70L</button></div></div>
      <div class="ax-mfd-row"><span class="ax-micro">SERVICE</span><div class="ax-mfd-btns"><button type="button" data-mfd-toggle="changeTires" aria-pressed="true">TYRES ON</button><button type="button" data-mfd-toggle="repair" aria-pressed="true">REPAIR ON</button></div></div>
    </section>
    <div class="ax-lights"><div class="ax-lamps">${'<b></b>'.repeat(5)}</div><span class="ax-micro">START PROCEDURE</span></div>
    <div class="ax-radar ax-glass"><header class="ax-mini-head">${icon('map')}<b>TRACK MAP</b><span>VD'O</span></header>${outline.svg}<div class="ax-map-caption"><i></i> YOU <span>• &nbsp; FIELD</span></div></div>
    <details class="ax-dash ax-glass" open><summary class="ax-mini-head" aria-label="Driving telemetry" title="Show or hide driving telemetry"><b>MoTeC <em>C127</em></b><span data-v="hardware"></span>${icon('down')}</summary><div class="ax-shift">${Array.from({ length: 15 }, (_, i) => `<i style="--led:${i < 6 ? '#66e5a0' : i < 11 ? '#ffe063' : '#ff573c'}"></i>`).join('')}</div>
      <div class="ax-readout"><div class="ax-gear"><span>GEAR</span><b data-v="gear">N</b></div><div class="ax-speed"><strong data-v="speed">0</strong><button data-unit title="Switch speed unit" aria-label="Switch speed unit">KM/H</button></div><div class="ax-gmeter" title="Live G-Force friction circle (2.0G ring)"><svg viewBox="-16 -16 32 32" aria-hidden="true"><circle cx="0" cy="0" r="14" class="ax-g-ring"/><circle cx="0" cy="0" r="7" class="ax-g-mid"/><line x1="-14" y1="0" x2="14" y2="0"/><line x1="0" y1="-14" x2="0" y2="14"/><circle data-g-dot cx="0" cy="0" r="2.6" class="ax-g-dot"/></svg><span data-v="gforce">0.0G</span></div><div class="ax-revs"><b data-v="rpm">0</b><span>RPM</span></div></div>
      <div class="ax-pedals"><label>THR<i><b data-pedal></b></i></label><label>BRK<i><b data-pedal></b></i></label></div>
      <div class="ax-thermal-head ax-micro"><span data-v="compoundMeta">SOFT · FUEL 36L</span><span>TYRE / DISC / SUSP</span></div><div class="ax-thermals">${['FL', 'FR', 'RL', 'RR'].map((w) => `<div class="ax-wheel"><span>${w}</span><b></b><small></small><em class="ax-rotor" title="Brake rotor temp"></em><i><s></s></i></div>`).join('')}</div>
      <div class="ax-assists"><button data-action="cycleTc" title="Cycle traction control"></button><button data-action="cycleAbs" title="Cycle anti-lock braking"></button><button data-action="togglePitLimiter" data-pit-lim title="Toggle 60 km/h pit limiter (L)">LIM</button><span data-v="surface"></span></div></details>`;

  const pitwall = createPitwall(el.querySelector<HTMLElement>('.ax-pitwall')!, circuit);
  const readouts = Object.fromEntries(
    Array.from(el.querySelectorAll<HTMLElement>('[data-v]'), (n) => [n.dataset.v!, n]),
  );
  function write(k: string, v: string) {
    const n = readouts[k];
    if (n && n.textContent !== v) n.textContent = v;
  }
  const leds = Array.from(el.querySelectorAll<HTMLElement>('.ax-shift i'));
  const lamps = Array.from(el.querySelectorAll('.ax-lamps b'));
  const pedals = Array.from(el.querySelectorAll<HTMLElement>('[data-pedal]'));
  const gDot = el.querySelector<SVGCircleElement>('[data-g-dot]')!;
  const wheels = Array.from(el.querySelectorAll('.ax-wheel'), (n) => ({
    tyre: n.querySelector('b')!,
    brake: n.querySelector('small')!,
    rotor: n.querySelector<HTMLElement>('.ax-rotor')!,
    spring: n.querySelector('s')!,
  }));
  const weatherBtns = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-weather]'));
  const mfdEl = el.querySelector<HTMLElement>('[data-mfd]')!;
  const mfdCompounds = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-mfd-compound]'));
  const mfdFuels = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-mfd-fuel]'));
  const mfdTiresBtn = el.querySelector<HTMLButtonElement>('[data-mfd-toggle="changeTires"]')!;
  const mfdRepairBtn = el.querySelector<HTMLButtonElement>('[data-mfd-toggle="repair"]')!;
  const pitBanner = el.querySelector<HTMLElement>('[data-pit-banner]')!;
  const pitProg = el.querySelector<HTMLElement>('[data-pit-prog]')!;
  const pitLimBtn = el.querySelector<HTMLButtonElement>('[data-pit-lim]')!;

  const sectorNodes = Array.from(el.querySelectorAll<HTMLElement>('[data-sector]'));
  const lightPlate = el.querySelector<HTMLElement>('.ax-lights')!;
  const dash = el.querySelector('details')!,
    expanded = { cockpit: false, external: true };
  let instruments: keyof typeof expanded = 'external';
  const tc = el.querySelector<HTMLButtonElement>('[data-action="cycleTc"]')!,
    abs = el.querySelector<HTMLButtonElement>('[data-action="cycleAbs"]')!;
  const rowsEl = el.querySelector('ol')!,
    markers = el.querySelector('[data-map-points]')!;
  const deltaBar = el.querySelector<HTMLElement>('.ax-delta i')!;
  const unit = el.querySelector<HTMLElement>('[data-unit]')!;
  let mph = false;
  unit.onclick = () => {
    mph = !mph;
    unit.textContent = mph ? 'MPH' : 'KM/H';
  };
  const rows: { li: HTMLLIElement; num: HTMLElement; name: HTMLElement; int: HTMLElement }[] = [];
  const dots = new Map<number, SVGCircleElement>();
  const timing = new Map<number, Transponder>();
  let lastTime = -1,
    lastSpeedG = 0,
    lastYawG = 0,
    gLatSmooth = 0,
    gLongSmooth = 0,
    best = [Infinity, Infinity, Infinity],
    previous = best.slice(),
    activeLap = 0,
    lastSplitColors = ['', '', ''];
  function reset() {
    pitwall.reset();
    timing.clear();
    lastTime = -1;
    lastSpeedG = 0;
    lastYawG = 0;
    gLatSmooth = 0;
    gLongSmooth = 0;
    activeLap = 0;
    lastSplitColors = ['', '', ''];
    best = [Infinity, Infinity, Infinity];
    previous = best.slice();
  }
  const timedDistance = (d: Driver) => (d.finishTime === null ? d.distance : d.completedLaps * circuit.length);
  function interval(lead: Driver, follow: Driver, elapsed: number) {
    if (follow.finishTime !== null) {
      const laps = lead.completedLaps - follow.completedLaps;
      if (laps > 0) return `+${laps}L`;
      return lead.finishTime === null ? 'FLAG' : `+${(follow.finishTime - lead.finishTime).toFixed(2)}`;
    }
    const m = Math.max(0, timedDistance(lead) - follow.distance);
    if (m >= circuit.length) return `+${Math.floor(m / circuit.length)}L`;
    const timestamp = timing.get(lead.id)?.crossing(follow.distance);
    return timestamp == null ? `+${Math.round(m)}m` : `+${Math.max(0, elapsed - timestamp).toFixed(2)}`;
  }

  function update(s: RaceState) {
    const player = s.drivers.find((d) => d.id === 0);
    if (!player) {
      pitwall.reset();
      return;
    }
    const layout = s.camera === 'cockpit' ? 'cockpit' : 'external';
    if (instruments !== layout) {
      expanded[instruments] = dash.open;
      dash.open = expanded[layout];
      instruments = layout;
    }
    if (s.elapsed < lastTime) reset();
    const dtG = lastTime >= 0 ? s.elapsed - lastTime : 0;
    if (dtG > 0.001 && dtG < 3.0) {
      const dYaw = Math.atan2(Math.sin(player.yaw - lastYawG), Math.cos(player.yaw - lastYawG));
      const rawLong = (player.speed - lastSpeedG) / (dtG * 9.81);
      const rawLat = (player.speed * dYaw) / (dtG * 9.81);
      const alphaG = 1 - Math.exp(-10 * Math.min(dtG, 0.25));
      gLongSmooth += (Math.max(-2.4, Math.min(2.4, rawLong)) - gLongSmooth) * alphaG;
      gLatSmooth += (Math.max(-2.4, Math.min(2.4, rawLat)) - gLatSmooth) * alphaG;
    } else if (lastTime < 0) {
      gLongSmooth = 0;
      gLatSmooth = 0;
    }
    lastSpeedG = player.speed;
    lastYawG = player.yaw;
    lastTime = s.elapsed;
    pitwall.update(s, player, mph);

    // Sync live 4-weather buttons & surface condition readout
    for (const b of weatherBtns) b.setAttribute('aria-pressed', String(b.dataset.weather === s.settings.weather));
    const wetPct = Math.round(s.trackWetness * 100);
    const wetLabel = wetPct >= 65 ? 'WET' : wetPct >= 15 ? 'DAMP' : 'DRY';
    write('trackMeta', `${Math.round(s.surfaceTempC)}°C · ${wetLabel}${wetPct >= 15 ? ` ${wetPct}%` : ''}`);

    // Sync MoTeC Pit Strategy MFD
    mfdEl.hidden = !s.pitMfdOpen;
    if (s.pitMfdOpen) {
      for (const b of mfdCompounds)
        b.setAttribute('aria-pressed', String(b.dataset.mfdCompound === s.pitStrategy.compound));
      for (const b of mfdFuels)
        b.setAttribute('aria-pressed', String(Number(b.dataset.mfdFuel) === s.pitStrategy.refuelL));
      mfdTiresBtn.setAttribute('aria-pressed', String(s.pitStrategy.changeTires));
      mfdTiresBtn.textContent = s.pitStrategy.changeTires ? 'TYRES ON' : 'TYRES OFF';
      mfdRepairBtn.setAttribute('aria-pressed', String(s.pitStrategy.repair));
      mfdRepairBtn.textContent = s.pitStrategy.repair ? 'REPAIR ON' : 'REPAIR OFF';
    }

    // Live Pit Lane / Air-Jack Service Banner
    const showPitBanner = player.pitState !== 'track' || player.pitLimiter;
    pitBanner.hidden = !showPitBanner;
    if (showPitBanner) {
      if (player.pitState === 'servicing') {
        write('pitBannerTitle', `AIR-JACKS ACTIVE · ${player.pitTimer.toFixed(1)} s`);
        write(
          'pitBannerSub',
          `${s.pitStrategy.changeTires ? COMPOUNDS[s.pitStrategy.compound].short : 'HOLD TYRES'} · +${s.pitStrategy.refuelL}L FUEL`,
        );
        const pct = player.pitDuration > 0 ? clip(1 - player.pitTimer / player.pitDuration) : 1;
        pitProg.style.transform = `scaleX(${pct})`;
      } else if (player.pitState === 'box') {
        write('pitBannerTitle', 'BAY 01 · STOP FOR AIR-JACKS');
        write('pitBannerSub', 'BRAKE TO ZERO TO BEGIN PIT STOP');
        pitProg.style.transform = 'scaleX(0)';
      } else if (player.pitState === 'exit') {
        write('pitBannerTitle', 'SERVICE COMPLETE · GO!');
        write('pitBannerSub', '60 KM/H UNTIL PIT EXIT LINE');
        pitProg.style.transform = 'scaleX(1)';
      } else {
        write('pitBannerTitle', 'PIT LIMITER 60 KM/H');
        write('pitBannerSub', player.pitState === 'track' ? 'MANUAL LIMITER ENGAGED (L)' : 'PULL INTO BAY 01 ON RIGHT');
        pitProg.style.transform = 'scaleX(0)';
      }
    }

    const order = raceOrder(s.drivers);
    for (const d of order) {
      let sensor = timing.get(d.id);
      if (!sensor) timing.set(d.id, (sensor = new Transponder()));
      sensor.record(timedDistance(d), d.finishTime ?? s.elapsed);
    }
    while (rows.length < order.length) {
      const li = document.createElement('li');
      li.innerHTML = '<i></i><b></b><span></span><small></small>';
      rowsEl.append(li);
      rows.push({
        li,
        num: li.children[1] as HTMLElement,
        name: li.children[2] as HTMLElement,
        int: li.children[3] as HTMLElement,
      });
    }
    for (let i = 0; i < rows.length; i++) {
      const { li, num, name, int } = rows[i],
        d = order[i];
      li.hidden = !d;
      if (!d) continue;
      const team = teams[d.livery] || teams[0];
      li.classList.toggle('is-player', d.id === 0);
      li.style.setProperty('--team', team[2]);
      li.children[0].textContent = String(i + 1);
      num.textContent = d.number;
      name.textContent = d.id === 0 ? 'YOU' : d.name;
      int.textContent =
        d.pitState !== 'track'
          ? 'PIT'
          : i
            ? interval(order[i - 1], d, s.elapsed)
            : d.finishTime === null
              ? 'LEADER'
              : 'FLAG';
      let dot = dots.get(d.id);
      if (!dot) {
        dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('r', d.id === 0 ? '4.3' : '2.8');
        dot.setAttribute('fill', d.id === 0 ? '#ff6139' : '#e2e8e6');
        dot.setAttribute('stroke', '#151b1c');
        dot.setAttribute('stroke-width', d.id === 0 ? '1.4' : '1');
        markers.prepend(dot);
        dots.set(d.id, dot);
      }
      dot.setAttribute('cx', outline.x(d.x).toFixed(2));
      dot.setAttribute('cy', outline.y(d.z).toFixed(2));
    }
    for (const [id, dot] of dots)
      if (!order.some((d) => d.id === id)) {
        dot.remove();
        dots.delete(id);
      }
    const playerDot = dots.get(0);
    if (playerDot && markers.lastChild !== playerDot) markers.append(playerDot);
    write('lap', s.settings.mode === 'sprint' ? `${two(s.lap)} / ${two(SPRINT_LAPS)}` : two(s.lap));
    write('clock', clock(s.lapTime));
    const hasBest = s.bestLap > 0 && Number.isFinite(s.bestLap);
    write('delta', hasBest ? `Δ ${s.delta >= 0 ? '+' : '−'}${Math.abs(s.delta).toFixed(3)}` : 'Δ —');
    deltaBar.style.width = `${hasBest ? Math.min(50, Math.abs(s.delta) * 14) : 0}%`;
    deltaBar.style.left = s.delta >= 0 ? '50%' : 'auto';
    deltaBar.style.right = s.delta < 0 ? '50%' : 'auto';
    deltaBar.style.background = s.delta >= 0 ? '#efb251' : '#66dda7';
    if (s.lap !== activeLap && s.lastSectors.length) {
      lastSplitColors = s.lastSectors.map((v, i) => (v < best[i] ? 'best' : v < previous[i] ? 'gain' : 'set'));
      previous = s.lastSectors;
      best = previous.map((v, i) => Math.min(best[i], v));
    }
    activeLap = s.lap;
    sectorNodes.forEach((n, i) => {
      const v = s.sectors[i] || 0;
      const hold = !v && activeLap > 1 && s.lapTime < 4 && !!lastSplitColors[i];
      n.dataset.split = hold
        ? lastSplitColors[i]
        : v > 0 && Number.isFinite(v)
          ? v < best[i]
            ? 'best'
            : v < previous[i]
              ? 'gain'
              : 'set'
          : '';
      n.title = hold
        ? `Last lap S${i + 1}: ${previous[i].toFixed(3)} s`
        : v > 0
          ? `Sector ${i + 1}: ${v.toFixed(3)} s`
          : `Sector ${i + 1}: awaiting split`;
    });
    write('camera', `${cameras[s.camera]}${s.autopilot ? ' · AUTO PILOT' : ''}`);
    lightPlate.hidden = s.phase !== 'lights';
    lamps.forEach((n, i) => n.classList.toggle('lit', i < s.lights));
    write('hardware', `${s.backend} · ${Math.round(s.fps)} FPS`);
    write('gear', player.gear < 0 ? 'R' : player.gear === 0 ? 'N' : String(player.gear));
    write('speed', String(Math.round(Math.abs(player.speed) * (mph ? 2.23694 : 3.6))));
    write('rpm', String(Math.round(player.rpm)));

    // Shift LEDs flash alternating pit-limiter blue/amber when 60 km/h limiter is active
    const limFlash = player.pitLimiter && Math.floor(performance.now() / 180) % 2 === 0;
    leds.forEach((n, i) => {
      n.classList.toggle('pit-led', player.pitLimiter);
      n.classList.toggle('on', player.pitLimiter ? (i % 2 === 0 ? limFlash : !limFlash) : player.rpm >= 3000 + (i + 1) * 350);
    });
    pedals[0].style.transform = `scaleX(${clip(player.throttle)})`;
    pedals[1].style.transform = `scaleX(${clip(player.brake)})`;

    const gMag = Math.hypot(gLatSmooth, gLongSmooth);
    const gx = Math.max(-13, Math.min(13, (-gLatSmooth / 2) * 13));
    const gy = Math.max(-13, Math.min(13, (gLongSmooth / 2) * 13));
    gDot.setAttribute('cx', gx.toFixed(1));
    gDot.setAttribute('cy', gy.toFixed(1));
    write('gforce', `${gMag.toFixed(1)}G`);

    write('compoundMeta', `${COMPOUNDS[player.compound].short} · FUEL ${player.fuelL.toFixed(1)}L`);
    wheels.forEach((w, i) => {
      const t = player.tireTempC[i] || 0,
        bt = player.brakeTempC[i] || 150,
        wearPct = Math.round((player.tireWear[i] ?? 1) * 100);
      w.tyre.textContent = `${Math.round(t)}°`;
      w.brake.textContent = `${wearPct}%`;
      w.tyre.style.color = t > 105 ? '#ff9668' : t > 62 ? '#92d8a8' : '#a4bacc';
      w.brake.style.color = wearPct < 35 ? '#ff7556' : wearPct < 65 ? '#e6bd7e' : '';
      w.rotor.style.background =
        bt > 560 ? '#ff4a28' : bt > 380 ? '#ff9b3d' : bt > 240 ? '#d8b468' : '#4a5753';
      w.rotor.title = `Rotor: ${Math.round(bt)}°C`;
      w.spring.style.transform = `scaleX(${clip((player.wheelCompressionM[i] || 0) / 0.16)})`;
    });
    tc.textContent = `TC ${s.tc}`;
    abs.textContent = `ABS ${s.abs}`;
    tc.classList.toggle('intervening', player.tcActive);
    abs.classList.toggle('intervening', player.absActive);
    pitLimBtn.classList.toggle('intervening', player.pitLimiter);
    // Live slipstream tow indicator when drafting a rival within 26 m ahead at racing speed
    let drafting = false;
    if (player.speed > 36 && s.drivers.length > 1) {
      for (const r of s.drivers) {
        if (r.id === 0) continue;
        let gap = r.s - player.s;
        if (gap < -circuit.length / 2) gap += circuit.length;
        else if (gap > circuit.length / 2) gap -= circuit.length;
        if (gap > 3.5 && gap < 26 && Math.abs(r.d - player.d) < 3.0) {
          drafting = true;
          break;
        }
      }
    }
    write('surface', drafting ? `TOW · ${player.surface.toUpperCase()}` : player.surface.toUpperCase());
  }
  return { update, reset };
}
