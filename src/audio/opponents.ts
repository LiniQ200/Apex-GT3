import type { Driver } from '../types';
import { clamp, Graph, smooth } from './graph';

export function opponents(g: Graph, mix: AudioNode) {
  // Slots follow driver IDs, not race-position ordering. Missing/culled cars
  // fade out, and no node or source is created for any pass, reset or restart.
  const slots = Array.from({ length: 9 }, () => {
    const pan = g.pan(mix, 0),
      level = g.gain(pan);
    const pipe = g.filter(level, 'lowpass', 1600, 0.4);
    const motor = g.tone(pipe, g.waves['458'], 15);
    return { pan, level, pipe, motor, id: -1 };
  });

  return (drivers: Driver[], p: Driver, cockpit: boolean, now: number) => {
    const sx = Math.sin(p.yaw),
      sz = Math.cos(p.yaw);
    for (const v of slots) {
      if (v.id !== -1 && !drivers.some((d) => d.id === v.id)) {
        smooth(v.level.gain, 0, now, 0.025);
        v.id = -1;
      }
    }
    for (const d of drivers) {
      if (d.id === p.id) continue;
      const dx = d.x - p.x,
        dz = d.z - p.z;
      const distance = Math.hypot(dx, d.y - p.y, dz);
      let v = slots.find((s) => s.id === d.id);
      if (!Number.isFinite(distance) || distance >= 165) {
        if (v) smooth(v.level.gain, 0, now, 0.04);
        continue;
      }
      if (!v) {
        v = slots.find((s) => s.id === -1);
        if (!v) continue;
        v.id = d.id;
        // The fixed driver contract has no opponent chassis field.
        v.motor.setPeriodicWave(g.waves[d.id % 2 ? 'concept' : '458']);
      }
      const inv = 1 / Math.max(distance, 1);
      const front = (dx * sx + dz * sz) * inv;
      const sourceRadial = d.speed * (dx * Math.sin(d.yaw) + dz * Math.cos(d.yaw)) * inv;
      // +n points listener -> source. Matched velocities cancel irrespective
      // of distance, unlike pitch-shifting from source speed alone.
      const doppler = clamp((343 + p.speed * front) / (343 + sourceRadial), 0.65, 1.55);
      smooth(v.motor.frequency, (clamp(d.rpm, 750, 9000) / 120) * doppler, now, 0.025);
      smooth(v.pan.pan, clamp((dx * sz - dz * sx) / Math.max(distance, 2.5), -0.97, 0.97), now, 0.035);
      const throttle = clamp(d.throttle);
      smooth(
        v.pipe.frequency,
        ((1050 + 3100 * throttle) * (0.84 + 0.13 * front)) / (1 + 0.012 * distance),
        now,
      );
      const attenuation = (1 - (distance / 165) ** 2) / (1 + (distance / 10) ** 1.38);
      smooth(v.level.gain, attenuation * (0.145 + 0.18 * throttle) * (cockpit ? 0.72 : 1), now);
    }
  };
}
