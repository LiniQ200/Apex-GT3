import type { PitAudioEvent } from '../types';
import { Graph } from './graph';

/**
 * Procedural motorsport pit-stop pneumatics:
 *  - Internal GT3 air-jack hiss (lift & drop pressurized nitrogen release)
 *  - High-RPM pneumatic impact wheel-gun zip bursts during tire changes
 */
export function pitPneumatics(g: Graph, mix: AudioNode) {
  const hissGain = g.gain(mix, 0);
  const hissFilter = g.filter(hissGain, 'bandpass', 3200, 0.9);
  g.noise(hissFilter, 0.13);

  const gunGain = g.gain(mix, 0);
  const gunFilter = g.filter(gunGain, 'bandpass', 1450, 2.6);
  const gunOsc = g.tone(gunFilter, 'sawtooth', 390);
  g.noise(gunFilter, 0.77);

  let lastSeq = 0;

  return (ev: PitAudioEvent, now: number) => {
    if (ev.seq === lastSeq || ev.type === 'none') return;
    lastSeq = ev.seq;

    if (ev.type === 'jack_up' || ev.type === 'jack_down') {
      const up = ev.type === 'jack_up';
      hissFilter.frequency.cancelScheduledValues(now);
      hissFilter.frequency.setValueAtTime(up ? 4200 : 2800, now);
      hissFilter.frequency.exponentialRampToValueAtTime(up ? 1900 : 1200, now + 0.36);
      hissGain.gain.cancelScheduledValues(now);
      hissGain.gain.setValueAtTime(0, now);
      hissGain.gain.linearRampToValueAtTime(0.32, now + 0.02);
      hissGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
      hissGain.gain.setValueAtTime(0, now + 0.4);
    } else if (ev.type === 'gun') {
      // Twin-burst pneumatic wheel-gun (nut off + nut on)
      gunOsc.frequency.cancelScheduledValues(now);
      gunOsc.frequency.setValueAtTime(420, now);
      gunOsc.frequency.linearRampToValueAtTime(590, now + 0.11);
      gunOsc.frequency.setValueAtTime(360, now + 0.16);
      gunOsc.frequency.linearRampToValueAtTime(640, now + 0.28);

      gunGain.gain.cancelScheduledValues(now);
      gunGain.gain.setValueAtTime(0, now);
      gunGain.gain.linearRampToValueAtTime(0.26, now + 0.015);
      gunGain.gain.setValueAtTime(0.24, now + 0.11);
      gunGain.gain.linearRampToValueAtTime(0.02, now + 0.14);
      gunGain.gain.linearRampToValueAtTime(0.28, now + 0.17);
      gunGain.gain.setValueAtTime(0.25, now + 0.28);
      gunGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
      gunGain.gain.setValueAtTime(0, now + 0.36);
    }
  };
}
