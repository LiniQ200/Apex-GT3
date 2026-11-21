import type { Driver } from '../types';
import { clamp, Graph, smooth, type Chassis } from './graph';

function pulse(gain: AudioParam, now: number, peak: number, length: number): void {
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(0, now);
  gain.linearRampToValueAtTime(peak, now + 0.003);
  gain.exponentialRampToValueAtTime(0.0001, now + length);
  gain.setValueAtTime(0, now + length + 0.002);
}

export function powertrain(g: Graph, mix: AudioNode) {
  // Drive the soft clipper *before* the collector filter: opening the throttle
  // changes the exhaust harmonics, not just the volume of a fixed sample.
  const ignition = g.gain(mix, 1);
  const level = g.gain(ignition, 0.34);
  const collector = g.filter(level, 'lowpass', 750, 0.5);
  const intakeLevel = g.gain(ignition);
  const intake = g.filter(intakeLevel, 'bandpass', 900, 1.3);
  const shaper = g.ctx.createWaveShaper();
  const curve = new Float32Array(1025);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(2.3 * ((2 * i) / (curve.length - 1) - 1));
  shaper.curve = curve;
  shaper.oversample = '2x';
  shaper.connect(collector);
  shaper.connect(intake);
  const drive = g.gain(shaper, 0.3);
  let chassis: Chassis = '458';
  const crank = g.tone(drive, g.waves[chassis], 10);

  const transmission = g.gain(mix);
  const meshWave = g.ctx.createPeriodicWave(new Float32Array(4), new Float32Array([0, 1, 0.19, 0.06]));
  const pinion = g.tone(transmission, meshWave, 350);

  // Persistent transient voices: an ignition cut, exhaust afterfire, and Concept GT3 turbo flutter
  // need no allocations or timers on the physics/render thread.
  const thud = g.gain(mix);
  const body = g.tone(thud, 'sine', 80);
  const snap = g.gain(mix);
  g.noise(g.filter(snap, 'bandpass', 1200, 0.65), 0.32);
  const flutter = g.gain(mix);
  const flutterFilter = g.filter(flutter, 'bandpass', 2350, 4.2);
  g.noise(flutterFilter, 0.89);
  let prevGear = 0,
    prevThrottle = 0,
    lastFueled = -10,
    nextPop = 0,
    blipEnd = 0,
    nextFlutter = 0;

  return (p: Driver, model: Chassis, cockpit: boolean, now: number, fresh: boolean) => {
    if (model !== chassis) {
      chassis = model;
      crank.setPeriodicWave(g.waves[chassis]);
    }
    const rpm = clamp(p.rpm, 750, 9000),
      load = clamp(p.throttle);
    const speed = clamp(Math.abs(p.speed), 0, 125),
      rev = rpm / 8500;
    if (fresh) {
      prevGear = p.gear;
      prevThrottle = load;
      lastFueled = -10;
      nextPop = now;
      blipEnd = 0;
      nextFlutter = now;
      ignition.gain.cancelScheduledValues(now);
      ignition.gain.setValueAtTime(1, now);
      for (const a of [thud.gain, snap.gain, flutter.gain]) {
        a.cancelScheduledValues(now);
        a.setValueAtTime(0, now);
      }
    }
    if (p.gear > 0 && prevGear > 0 && p.gear !== prevGear) {
      const up = p.gear > prevGear;
      if (up) {
        // Sample-clocked so the 45 ms flat-shift ignition cut completes cleanly.
        ignition.gain.cancelScheduledValues(now);
        ignition.gain.setTargetAtTime(0.06, now, 0.003);
        ignition.gain.setTargetAtTime(1, now + 0.045, 0.008);
      } else {
        blipEnd = now + 0.11;
      }
      body.frequency.cancelScheduledValues(now);
      body.frequency.setValueAtTime(up ? 108 : 84, now);
      body.frequency.exponentialRampToValueAtTime(42, now + 0.085);
      pulse(thud.gain, now, up ? 0.2 : 0.1, 0.095);
      pulse(snap.gain, now, 0.2 + load * 0.16, 0.045);
      nextPop = now + 0.15;
    }
    // Endurance Concept twin-turbo wastegate chirp/flutter on rapid high-RPM throttle lift
    if (chassis === 'concept' && prevThrottle > 0.55 && load < 0.16 && rpm > 4800 && now >= nextFlutter) {
      const baseHz = 1950 + rev * 950;
      flutterFilter.frequency.cancelScheduledValues(now);
      flutterFilter.frequency.setValueAtTime(baseHz, now);
      flutterFilter.frequency.exponentialRampToValueAtTime(baseHz * 0.62, now + 0.24);
      flutter.gain.cancelScheduledValues(now);
      flutter.gain.setValueAtTime(0, now);
      for (let k = 0; k < 3; k++) {
        const t0 = now + k * 0.068;
        const amp = (cockpit ? 0.09 : 0.13) * (1 - k * 0.26);
        flutter.gain.linearRampToValueAtTime(amp, t0 + 0.012);
        flutter.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.062);
      }
      flutter.gain.setValueAtTime(0, now + 0.24);
      nextFlutter = now + 0.36;
    }
    prevGear = p.gear;
    prevThrottle = load;
    if (load > 0.44) lastFueled = now;
    if (load < 0.2 && rpm > 3400 && now - lastFueled < 1.05 && now >= nextPop) {
      pulse(snap.gain, now, 0.18 + Math.random() * 0.32, 0.028 + Math.random() * 0.04);
      pulse(thud.gain, now, 0.045 + Math.random() * 0.055, 0.055);
      nextPop = now + 0.105 + Math.random() ** 2 * 0.46;
    }

    // 60 km/h FIA pit-limiter rhythmic fuel-cut ignition stutter
    if (p.pitLimiter && speed > 14.8 && p.pitState !== 'servicing') {
      const stutter = Math.sin(now * 86) > 0 ? 1.0 : 0.24;
      ignition.gain.setTargetAtTime(stutter, now, 0.004);
    } else if (now > nextPop - 0.05) {
      ignition.gain.setTargetAtTime(1, now, 0.012);
    }

    const blip = clamp((blipEnd - now) / 0.11),
      demand = Math.max(load, 0.84 * blip);
    const idleLump = clamp((2100 - rpm) / 1300) * (18 * Math.sin(now * 19) + 10 * Math.sin(now * 7.7));
    smooth(crank.frequency, ((rpm + idleLump) * (1 + 0.036 * blip)) / 120, now, 0.018);
    smooth(drive.gain, 0.29 + 0.24 * rev + 1.08 * demand, now, 0.023);
    smooth(level.gain, 0.23 + 0.12 * rev + 0.16 * demand, now);
    smooth(collector.frequency, (540 + 850 * rev + demand * (850 + 1400 * rev)) * (cockpit ? 0.7 : 1), now);
    smooth(intake.frequency, (chassis === '458' ? 420 : 610) + 1300 * rev, now);
    smooth(intakeLevel.gain, (cockpit ? 0.16 : 0.11) * demand, now);

    // Gear-tooth mesh follows the engaged input shaft; retain the coast whine
    // under engine braking, and never whine when revving stationary in neutral.
    smooth(pinion.frequency, (rpm / 60) * (13 + 0.8 * clamp(p.gear, 1, 6)), now);
    smooth(
      transmission.gain,
      (p.gear > 0 ? clamp(speed / 16) : 0) *
        (cockpit ? 0.065 : 0.039) *
        (0.52 + 0.33 * demand + 0.35 * clamp(p.brake)),
      now,
    );
  };
}
