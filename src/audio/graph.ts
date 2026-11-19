import type { Settings } from '../types';

export type Chassis = Settings['chassis'];

export function clamp(n: number, lo = 0, hi = 1): number {
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

// Audio-rate interpolation between physics samples. Don't enqueue the same
// automation event every frame for a parked car or an inaudible opponent.
const lastTarget = new WeakMap<AudioParam, number>();
export function smooth(param: AudioParam, value: number, now: number, tau = 0.028): void {
  const last = lastTarget.get(param);
  if (
    !Number.isFinite(value) ||
    value === last ||
    (last !== undefined && value !== 0 && Math.abs(last - value) < Math.abs(value) * 0.0006)
  )
    return;
  lastTarget.set(param, value);
  param.setTargetAtTime(value, now, tau);
}

// One oscillator turn = one complete four-stroke cycle (RPM / 120 Hz).
// Sum individual cylinder impulses in the frequency domain, as heard at a
// collector. The far bank is slightly delayed and attenuated. A flat-six
// alternates banks; a crossplane V8 has 90°, 180°, 270°, 180° bank intervals.
function exhaustWave(ctx: AudioContext, cylinders: 6 | 8): PeriodicWave {
  const re = new Float32Array(65),
    im = new Float32Array(65);
  const nearBank = cylinders === 8 ? [0, 1, 3, 6] : [0, 2, 4];
  for (let k = 1; k < re.length; k++) {
    const envelope = Math.exp(-k / (cylinders * 3.8)) / Math.sqrt(1 + (k / cylinders) ** 2);
    for (let j = 0; j < cylinders; j++) {
      const near = nearBank.includes(j);
      const phase = (2 * Math.PI * k * (j + (near ? 0 : 0.14))) / cylinders;
      const amplitude = envelope * (near ? 1 : 0.64) * (1 + 0.07 * Math.sin(j * 2.31));
      re[k] += amplitude * Math.cos(phase);
      im[k] += amplitude * Math.sin(phase);
    }
  }
  return ctx.createPeriodicWave(re, im);
}

export class Graph {
  readonly ctx: AudioContext;
  readonly waves: Record<Chassis, PeriodicWave>;
  private readonly noiseBuffer: AudioBuffer;
  private readonly sources: AudioScheduledSourceNode[] = [];

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.waves = { '458': exhaustWave(ctx, 8), concept: exhaustWave(ctx, 6) };
    this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const samples = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  }

  gain(to: AudioNode, value = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    g.connect(to);
    return g;
  }

  filter(to: AudioNode, type: BiquadFilterType, hz: number, q: number): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    f.connect(to);
    return f;
  }

  pan(to: AudioNode, value: number): StereoPannerNode {
    const p = this.ctx.createStereoPanner();
    p.pan.value = value;
    p.connect(to);
    return p;
  }

  tone(to: AudioNode, wave: OscillatorType | PeriodicWave, hz: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    if (wave instanceof PeriodicWave) o.setPeriodicWave(wave);
    else o.type = wave;
    o.frequency.value = hz;
    o.connect(to);
    o.start();
    this.sources.push(o);
    return o;
  }

  noise(to: AudioNode, offset: number): void {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noiseBuffer;
    n.loop = true;
    n.connect(to);
    n.start(0, offset % this.noiseBuffer.duration);
    this.sources.push(n);
  }

  stop(): void {
    for (const source of this.sources) {
      source.stop();
      source.disconnect();
    }
    this.sources.length = 0;
  }
}
