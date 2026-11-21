import type { Circuit, Driver, RaceState, Weather } from '../types';

type Side = 'left' | 'right';
type Cue = 'next' | 'brake' | 'lift' | 'turn';
type Note =
  | { kind: 'corner'; number: number; side: Side; metres: number; entrySpeed: number; cue: Cue }
  | { kind: 'traffic'; side: Side | 'both' };
type Turn = { entry: number; handoff: number; curvature: number };
const wrap = (s: number, length: number) => ((s % length) + length) % length;

// Write the pace notes once, from the survey rather than corner names or script times.
// Filter ~20 m of curvature so spline ripples and small corrections aren't called turns.
function surveyTurns(circuit: Circuit): Turn[] {
  const count = Math.ceil(circuit.length / 4), step = circuit.length / count;
  const raw = Array.from({ length: count }, (_, i) => circuit.at(i * step).kappa);
  const bends = raw.map((_, i) => {
    let sum = 0;
    for (let j = -2; j <= 2; j++) sum += raw[wrap(i + j, count)];
    return sum / 5;
  });
  const turns: Turn[] = [];
  // Start on a straight so a corner crossing the timing line remains a single note.
  const start = Math.max(0, bends.findIndex(k => Math.abs(k) < 0.001));
  let run: { first: number; last: number; peak: number; angle: number } | undefined;
  function finish() {
    if (!run || run.angle < 0.33) return; // less than ~19° of heading change
    const curvature = bends[run.peak % count];
    let entry = run.first;
    while (Math.abs(bends[entry % count]) < 0.45 * Math.abs(curvature)) entry++;
    // Once committed, preview the following turn (especially the second leg of a chicane).
    const hold = Math.max(8, Math.min(55, (run.peak - entry) * step));
    turns.push({ entry: (entry % count) * step, handoff: (entry % count) * step + hold, curvature });
  }
  for (let i = start; i < start + count; i++) {
    const k = bends[i % count];
    if (Math.abs(k) < 0.003) continue;
    if (!run || k * bends[run.peak % count] < 0 || (i - run.last) * step > 38) {
      finish();
      run = { first: i, last: i, peak: i, angle: 0 };
    }
    run.last = i;
    run.angle += Math.abs(k) * step;
    if (Math.abs(k) > Math.abs(bends[run.peak % count])) run.peak = i;
  }
  finish();
  return turns.sort((a, b) => a.entry - b.entry);
}

// Real world poses, not the timing order or a difference in track-lane offsets. A
// lapped car can be alongside; a car directly in front or on the opposite verge isn't.
function occupiedSides(p: Driver, field: readonly Driver[], lastOverlap: number[], scan: number) {
  const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw);
  let occupied = 0;
  for (const r of field) {
    if (r.id === p.id) continue;
    const dx = r.x - p.x, dz = r.z - p.z;
    if (!(dx * dx + dz * dz <= 9 * 9 && Math.abs(r.y - p.y) <= 1.6)) continue;
    const lateral = dx * cos - dz * sin, along = dx * sin + dz * cos;
    const side = lateral < 0 ? 1 : 2, slot = 2 * r.id + side - 1;
    const held = lastOverlap[slot] === scan - 1; // same rival, same side, last update
    const heading = r.yaw - p.yaw, parallel = Math.cos(heading);
    // Project the rival's 4.22 × 1.82 m body onto our fore/aft axis. The release
    // band tolerates bumper jitter without holding a call after the car has left.
    const overlap = 2.11 + 2.11 * parallel + 0.91 * Math.abs(Math.sin(heading));
    if (parallel > (held ? 0.50 : 0.60) && Math.abs(along) <= overlap + (held ? 0.55 : 0) &&
        Math.abs(lateral) >= (held ? 1 : 1.25) && Math.abs(lateral) <= (held ? 6.2 : 5.8)) {
      occupied |= side;
      lastOverlap[slot] = scan;
    }
  }
  return occupied;
}

export function createEngineer(circuit: Circuit) {
  const turns = surveyTurns(circuit), lastOverlap: number[] = [];
  let previous = -1, cue: Cue = 'next', scan = 0;
  function reset() { previous = -1; cue = 'next'; lastOverlap.length = 0; scan = 0; }
  function read(p: Driver, field: readonly Driver[], weather: Weather): Note | null {
    const occupied = occupiedSides(p, field, lastOverlap, ++scan);
    if (occupied) return { kind: 'traffic', side: occupied === 3 ? 'both' : occupied === 1 ? 'left' : 'right' };
    if (!turns.length || !Number.isFinite(p.s) || !Number.isFinite(p.speed) || p.speed < 0 || p.gear < 0 ||
        p.surface === 'grass' || p.surface === 'gravel' || !(Math.cos(p.yaw - circuit.at(p.s).yaw) > 0.45)) {
      reset();
      return null;
    }
    let index = 0, untilHandoff = Infinity;
    for (let i = 0; i < turns.length; i++) {
      const gap = wrap(turns[i].handoff - p.s, circuit.length);
      // Once we handed off, don't take the old corner back for a metre of jitter.
      if (turns.length > 1 && gap < 3 && previous === (i + 1) % turns.length) continue;
      if (gap < untilHandoff) { index = i; untilHandoff = gap; }
    }
    const turn = turns[index], metres = untilHandoff - (turn.handoff - turn.entry);
    // Conservative centreline guide, not a prediction of optimal racing-line pace.
    const grip = weather === 'rain' ? 0.81 : weather === 'damp' ? 0.91 : 1, decel = 8.5 * grip * grip;
    const entrySpeed = grip * Math.sqrt(11 / Math.abs(turn.curvature));
    const v = p.speed, excess = v - entrySpeed;
    const brakeAt = Math.max(0, (v * v - entrySpeed * entrySpeed) / (2 * decel)) + 0.55 * v;
    const braking = index === previous && cue === 'brake';
    const easing = index === previous && (braking || cue === 'lift');
    const inTurn = metres <= 0 || (index === previous && cue === 'turn' && metres < 3);
    cue = inTurn ? 'turn'
      : excess > (braking ? 2 : 3.5) && metres <= brakeAt + (braking ? 8 : 0) ? 'brake'
      : excess > (easing ? 0.65 : 1.5) && metres <= brakeAt + 0.9 * v + (easing ? 8 : 0) ? 'lift' : 'next';
    previous = index;
    return { kind: 'corner', number: index + 1, side: turn.curvature < 0 ? 'left' : 'right', metres: Math.max(0, metres), entrySpeed, cue };
  }
  return { read, reset };
}

export function createPitwall(el: HTMLElement, circuit: Circuit) {
  const engineer = createEngineer(circuit);
  el.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24"><path class="ax-pw-bend" d="M5 21v-8a6 6 0 0 1 6-6h8m-5-5 5 5-5 5"/>
    <g class="ax-pw-cars"><rect x="9" y="6" width="6" height="13" rx="1.4"/><rect class="ax-pw-left" x="1" y="4" width="5" height="11" rx="1.4"/><rect class="ax-pw-right" x="18" y="4" width="5" height="11" rx="1.4"/></g></svg>
    <div class="ax-pw-body"><div class="ax-pw-meta"><span>PIT WALL / <b></b></span><span data-pw-target></span></div>
    <div class="ax-pw-line"><strong role="status"></strong><span data-pw-gap></span></div></div>`;
  const channel = el.querySelector('b')!, target = el.querySelector('[data-pw-target]')!;
  const call = el.querySelector('strong')!, gap = el.querySelector('[data-pw-gap]')!;
  function write(node: Element, value: string) { if (node.textContent !== value) node.textContent = value; }
  function reset() { engineer.reset(); el.hidden = true; }
  function update(s: RaceState, player: Driver, mph: boolean) {
    if (s.phase !== 'race') { reset(); return; }
    const note = engineer.read(player, s.drivers, s.settings.weather);
    el.hidden = !note;
    if (!note) return;
    const mode = note.kind === 'traffic' ? 'spotter' : note.cue;
    if (el.dataset.cue !== mode) el.dataset.cue = mode;
    if (el.dataset.side !== note.side) el.dataset.side = note.side;
    if (note.kind === 'traffic') {
      write(channel, 'SPOTTER'); write(target, '');
      write(call, note.side === 'both' ? 'Cars both sides' : `Car ${note.side}`);
      write(gap, 'ALONGSIDE');
    } else {
      const unit = mph ? 'MPH' : 'KM/H', speed = 5 * Math.round(note.entrySpeed * (mph ? 2.23694 : 3.6) / 5);
      write(channel, `T${String(note.number).padStart(2, '0')}`);
      write(target, `ENTRY ≈${speed} ${unit}`);
      write(call, note.cue === 'turn' ? (note.side === 'left' ? 'Left turn' : 'Right turn')
        : `${note.cue === 'brake' ? 'Brake for' : note.cue === 'lift' ? 'Lift for' : 'Next'} ${note.side}`);
      const step = note.metres > 100 ? 10 : 5;
      write(gap, note.cue === 'turn' ? 'IN TURN' : note.metres < 5 ? '<5 m' : `${Math.round(note.metres / step) * step} m`);
    }
  }
  return { update, reset };
}
