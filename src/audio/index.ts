import type { AudioRig, RaceState } from '../types';
import { Graph } from './graph';
import { opponents } from './opponents';
import { pitPneumatics } from './pit';
import { powertrain } from './powertrain';
import { road } from './road';

function mixer(g: Graph) {
  const master = g.gain(g.ctx.destination);
  const limiter = g.ctx.createDynamicsCompressor();
  limiter.threshold.value = -12;
  limiter.knee.value = 5;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.14;
  limiter.connect(master);
  const mix = g.filter(limiter, 'highpass', 28, 0.5);
  const motor = powertrain(g, mix),
    tires = road(g, mix),
    rivals = opponents(g, mix),
    pit = pitPneumatics(g, mix);
  let playing = false;
  return (s: RaceState) => {
    const now = g.ctx.currentTime;
    const p = s.drivers.find((d) => d.id === 0);
    const active = !!p && !s.muted && (s.phase === 'race' || s.phase === 'lights');
    const fresh = active && !playing;
    if (active !== playing) {
      master.gain.cancelScheduledValues(now);
      master.gain.setTargetAtTime(active ? 0.72 : 0, now, active ? 0.026 : 0.009);
      if (!active) master.gain.setValueAtTime(0, now + 0.08);
      playing = active;
    }
    if (!active || !p) return;
    const cockpit = s.camera === 'cockpit';
    motor(p, s.settings.chassis, cockpit, now, fresh);
    tires(p, cockpit, s.trackWetness, now);
    rivals(s.drivers, p, cockpit, now);
    pit(s.pitEvent, now);
  };
}

export function createAudio(): AudioRig {
  let ctx: AudioContext | undefined, graph: Graph | undefined;
  let update: ReturnType<typeof mixer> | undefined,
    disposed = false;
  function release() {
    update = undefined;
    try {
      graph?.stop();
    } finally {
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
      ctx = undefined;
      graph = undefined;
    }
  }
  return {
    unlock() {
      if (disposed || typeof window === 'undefined') return;
      const Context =
        window.AudioContext ??
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;
      try {
        // Must run directly inside the trusted input handler, before any await.
        ctx ??= new Context({ latencyHint: 'interactive' });
        if (ctx.state !== 'running') void ctx.resume().catch(() => {});
        if (!graph) {
          graph = new Graph(ctx);
          update = mixer(graph);
        }
      } catch {
        // Unsupported/busy audio devices must not prevent a race from starting.
        release();
      }
    },
    update(state) {
      update?.(state);
    },
    dispose() {
      disposed = true;
      release();
    },
  };
}
