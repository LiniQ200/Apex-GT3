import { raceOrder, SPRINT_LAPS } from '../physics/race';
import { teams, type Circuit, type Driver, type RaceState } from '../types';
import { circuitGraphic, icon, insignia } from './graphics';

export function clock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–:––.–––';
  const ms = Math.floor(1000 * seconds);
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
const two = (n: number) => String(n).padStart(2, '0');
const clip = (n: number) => Math.max(0, Math.min(1, n));
const cameras = { chase: 'CHASE', cockpit: 'HELMET', hood: 'ONBOARD', tv: 'TRACKSIDE' };

// Timestamp a car actually crossed the following car's current distance. Before the
// first crossing (e.g. standing grid), report metres rather than invent a time gap.
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
      <div class="ax-sectors">${[1, 2, 3].map((i) => `<span data-sector>S${i}</span>`).join('')}<output data-v="delta">Δ —</output></div><div class="ax-delta"><i></i></div></section>
    <div class="ax-feed"><b>${insignia} APEX <i>RACECAST</i></b><span class="ax-camera-id"><i class="ax-live-dot"></i><span data-v="camera"></span></span></div>
    <div class="ax-lights"><div class="ax-lamps">${'<b></b>'.repeat(5)}</div><span class="ax-micro">START PROCEDURE</span></div>
    <div class="ax-radar ax-glass"><header class="ax-mini-head">${icon('map')}<b>TRACK MAP</b><span>VD'O</span></header>${outline.svg}<div class="ax-map-caption"><i></i> YOU <span>• &nbsp; FIELD</span></div></div>
    <section class="ax-dash ax-glass"><header class="ax-mini-head"><b>MoTeC <em>C127</em></b><span data-v="hardware"></span></header><div class="ax-shift">${Array.from({ length: 15 }, (_, i) => `<i style="--led:${i < 6 ? '#66e5a0' : i < 11 ? '#ffe063' : '#ff573c'}"></i>`).join('')}</div>
      <div class="ax-readout"><div class="ax-gear"><span>GEAR</span><b data-v="gear">N</b></div><div class="ax-speed"><strong data-v="speed">0</strong><button data-unit title="Switch speed unit" aria-label="Switch speed unit">KM/H</button></div><div class="ax-revs"><b data-v="rpm">0</b><span>RPM</span></div></div>
      <div class="ax-pedals"><label>THR<i><b data-pedal></b></i></label><label>BRK<i><b data-pedal></b></i></label></div>
      <div class="ax-thermal-head ax-micro"><span>WHEEL TELEMETRY</span><span>TYRE / DISC °C</span></div><div class="ax-thermals">${['FL', 'FR', 'RL', 'RR'].map((w) => `<div class="ax-wheel"><span>${w}</span><b></b><small></small><i><s></s></i></div>`).join('')}</div>
      <div class="ax-assists"><button data-action="cycleTc" title="Cycle traction control"></button><button data-action="cycleAbs" title="Cycle anti-lock braking"></button><span data-v="surface"></span></div></section>`;

  const readouts = Object.fromEntries(
    Array.from(el.querySelectorAll<HTMLElement>('[data-v]'), (n) => [n.dataset.v!, n]),
  );
  function write(k: string, v: string) {
    const n = readouts[k];
    if (n.textContent !== v) n.textContent = v;
  }
  const leds = Array.from(el.querySelectorAll<HTMLElement>('.ax-shift i'));
  const lamps = Array.from(el.querySelectorAll('.ax-lamps b'));
  const pedals = Array.from(el.querySelectorAll<HTMLElement>('[data-pedal]'));
  const wheels = Array.from(el.querySelectorAll('.ax-wheel'), (n) => ({
    tyre: n.querySelector('b')!,
    brake: n.querySelector('small')!,
    spring: n.querySelector('s')!,
  }));
  const sectorNodes = Array.from(el.querySelectorAll<HTMLElement>('[data-sector]'));
  const lightPlate = el.querySelector<HTMLElement>('.ax-lights')!;
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
    best = [Infinity, Infinity, Infinity],
    previous = best.slice(),
    activeLap = 0,
    lastSplitColors = ['', '', ''];
  function reset() {
    timing.clear();
    lastTime = -1;
    activeLap = 0;
    lastSplitColors = ['', '', ''];
    best = [Infinity, Infinity, Infinity];
    previous = best.slice();
  }
  const timedDistance = (d: Driver) => d.finishTime === null ? d.distance : d.completedLaps * circuit.length;
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
    if (!player) return;
    if (s.elapsed < lastTime) reset();
    lastTime = s.elapsed;
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
      int.textContent = i ? interval(order[i - 1], d, s.elapsed) : d.finishTime === null ? 'LEADER' : 'FLAG';
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
      lastSplitColors = s.lastSectors.map((v, i) => v < best[i] ? 'best' : v < previous[i] ? 'gain' : 'set');
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
    leds.forEach((n, i) => n.classList.toggle('on', player.rpm >= 3000 + (i + 1) * 350));
    pedals[0].style.transform = `scaleX(${clip(player.throttle)})`;
    pedals[1].style.transform = `scaleX(${clip(player.brake)})`;
    wheels.forEach((w, i) => {
      const t = player.tireTempC[i] || 0,
        b = player.brakeTempC[i] || 0;
      w.tyre.textContent = String(Math.round(t));
      w.brake.textContent = `/ ${Math.round(b)}`;
      w.tyre.style.color = t > 110 ? '#ff9668' : t > 65 ? '#92d8a8' : '#a4bacc';
      w.brake.style.color = b > 650 ? '#ff7556' : b > 350 ? '#e6bd7e' : '';
      w.spring.style.transform = `scaleX(${clip((player.wheelCompressionM[i] || 0) / 0.16)})`;
    });
    tc.textContent = `TC ${s.tc}`;
    abs.textContent = `ABS ${s.abs}`;
    tc.classList.toggle('intervening', player.tcActive);
    abs.classList.toggle('intervening', player.absActive);
    write('surface', player.surface.toUpperCase());
  }
  return { update, reset };
}
