import type { Driver, Weather } from '../types';
import { clamp, Graph, smooth } from './graph';

export function road(g: Graph, mix: AudioNode) {
  const tires = [-0.83, 0.83, -0.62, 0.62].map((side, i) => {
    const patch = g.gain(g.pan(mix, side));
    const tread = g.filter(patch, 'bandpass', 840, 1.4);
    g.noise(tread, 0.29 * i);
    const ring = g.gain(patch);
    const squeal = g.tone(ring, 'triangle', 920 + 28 * i);
    // Stick-slip pitch flutters irregularly instead of sounding like a siren.
    const jitter = g.ctx.createGain();
    jitter.gain.value = 1300;
    jitter.connect(squeal.detune);
    g.noise(g.filter(jitter, 'lowpass', 26 + 2 * i, 0.3), 0.37 + 0.31 * i);
    return { patch, tread, ring, squeal };
  });
  const kerbPan = g.pan(mix, 0),
    kerbLevel = g.gain(kerbPan);
  const kerb = g.tone(g.filter(kerbLevel, 'lowpass', 390, 0.3), 'sawtooth', 36);
  const wind = g.gain(mix);
  for (const side of [-1, 1]) {
    const buffeting = g.filter(g.pan(wind, side * 0.75), 'bandpass', 640, 0.38);
    g.noise(buffeting, side > 0 ? 1.27 : 0.71);
  }
  // Wet-road hydro-hiss (spray/evacuation hiss scaled by speed and local track wetness)
  const hydro = g.gain(mix, 0);
  const hydroFilter = g.filter(hydro, 'bandpass', 2400, 0.65);
  g.noise(hydroFilter, 0.53);
  // Subtle rain patter on carbon roof in cockpit view during heavy rain
  const roofRain = g.gain(mix, 0);
  const roofFilter = g.filter(roofRain, 'highpass', 3200, 0.7);
  g.noise(roofFilter, 1.11);
  // Carbon-ceramic GT3 brake harmonic chirp when rotors are hot under medium/low-speed braking
  const brakeSqueal = g.gain(mix, 0);
  const brakeChirp = g.tone(g.filter(brakeSqueal, 'bandpass', 3150, 4.5), 'sine', 3120);
  // Subtle cockpit windshield wiper rubber swoosh synced to wet wiper sweep
  const wiperSwoosh = g.gain(mix, 0);
  const wiperFilter = g.filter(wiperSwoosh, 'bandpass', 520, 1.6);
  g.noise(wiperFilter, 0.21);
  // Distant low-frequency storm thunder rumble in Heavy Rain synced to sheet-lightning
  const thunder = g.gain(mix, 0);
  g.noise(g.filter(thunder, 'lowpass', 95, 0.8), 1.43);

  return (p: Driver, cockpit: boolean, wetness: number, weather: Weather, now: number) => {
    const damp = wetness > 0.15;
    const speed = clamp(Math.abs(p.speed), 0, 125);
    const airspeed = clamp(speed / 82),
      rolling = clamp(speed / 6);
    const slip = clamp(Math.abs(p.slip)),
      load = clamp(p.throttle),
      brake = clamp(p.brake);
    const loose = p.surface === 'gravel' || p.surface === 'grass';
    for (let i = 0; i < tires.length; i++) {
      const t = tires[i];
      const compression = clamp(p.wheelCompressionM[i] ?? 0.055, 0, 0.22);
      const contact = clamp(compression / 0.055, 0.25, 1.45);
      const axle = i < 2 ? 0.87 + 0.37 * brake : 0.87 + 0.33 * load;
      const scrub = clamp((slip * axle - 0.045) / 0.52) * Math.max(rolling, slip * load * 0.6);
      const tone = loose ? 0 : clamp((scrub - 0.22) * 1.7);
      const hz = (790 + i * 43 + airspeed * 155 + scrub * 330) * (damp ? 0.9 : 1);
      smooth(t.patch.gain, (scrub * 0.21 + (loose ? 0.14 * rolling : 0)) * contact, now, 0.047);
      smooth(t.ring.gain, tone * (damp ? 0.18 : 0.26), now, 0.045);
      smooth(t.tread.frequency, loose ? 410 + 520 * airspeed : hz * 0.78, now);
      smooth(t.squeal.frequency, hz, now);
    }
    smooth(kerb.frequency, clamp(speed / 0.72, 12, 170), now, 0.017);
    smooth(kerbLevel.gain, p.surface === 'kerb' ? rolling * (0.105 + 0.11 * airspeed) : 0, now, 0.012);
    smooth(kerbPan.pan, clamp(p.d / 7, -0.72, 0.72), now);
    smooth(wind.gain, (cockpit ? 0.29 : 0.55) * airspeed ** 1.8, now, 0.11);
    smooth(hydroFilter.frequency, 1500 + 2100 * airspeed, now, 0.08);
    smooth(hydro.gain, clamp(wetness) * (cockpit ? 0.24 : 0.38) * clamp(speed / 45) ** 1.35, now, 0.07);
    smooth(roofRain.gain, cockpit && wetness > 0.55 ? (wetness - 0.55) * 0.14 : 0, now, 0.12);

    // Carbon-ceramic brake chirp: audible during medium braking at 12..140 km/h when front rotors are hot
    const frontTemp = ((p.brakeTempC[0] ?? 170) + (p.brakeTempC[1] ?? 170)) * 0.5;
    const hotRotor = clamp((frontTemp - 240) / 300);
    const speedBand = clamp((speed - 3.5) / 6) * clamp((40 - speed) / 14);
    const brakeBand = brake > 0.12 && brake < 0.82 ? Math.sin(clamp((brake - 0.12) / 0.7) * Math.PI) : 0;
    smooth(brakeChirp.frequency, 2980 + 340 * clamp(speed / 35), now, 0.04);
    smooth(brakeSqueal.gain, hotRotor * speedBand * brakeBand * (cockpit ? 0.022 : 0.016), now, 0.035);

    // Cockpit wiper blade rhythmic swoosh in Rain / Damp
    const wiperActive = cockpit && (weather === 'rain' || weather === 'damp');
    const wiperPulse =
      weather === 'rain'
        ? Math.abs(Math.cos(now * 2.15)) ** 2.4
        : (now % 3.4) < 1.25
          ? Math.abs(Math.sin(((now % 3.4) / 1.25) * Math.PI * 2)) ** 2.0
          : 0;
    smooth(wiperFilter.frequency, 440 + 280 * wiperPulse, now, 0.04);
    smooth(wiperSwoosh.gain, wiperActive ? wiperPulse * 0.032 : 0, now, 0.045);

    // Distant storm thunder rumble in Heavy Rain (~11.4s lightning period, delayed ~0.5s after flash)
    const thunderCycle = now % 11.4;
    const rumble =
      weather === 'rain' && thunderCycle > 0.25 && thunderCycle < 2.6
        ? Math.sin(((thunderCycle - 0.25) / 2.35) * Math.PI) * 0.11 * (cockpit ? 0.7 : 1.0)
        : 0;
    smooth(thunder.gain, rumble, now, 0.14);
  };
}
