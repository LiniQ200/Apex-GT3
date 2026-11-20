import type { SurfaceId, TireCompound } from '../types';
import type { SurfaceSample } from '../track/surfaceState';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface CompoundSpec {
  label: string;
  short: string;
  peakDryMu: number;
  optTempLo: number;
  optTempHi: number;
  overheatSlope: number;
  wearRate: number;
  wetGripBase: number;
  hydroplaneStart: number;
  hydroplaneSlope: number;
  blanketTempC: number;
  /** Pacejka Magic Formula shape coefficients (B=stiffness, C=shape, E=curvature) */
  B: number;
  C: number;
  E: number;
}

export const COMPOUNDS: Record<TireCompound, CompoundSpec> = {
  soft: {
    label: 'Dry Slick — Soft',
    short: 'SOFT',
    peakDryMu: 1.72,
    optTempLo: 85,
    optTempHi: 96,
    overheatSlope: 0.0045,
    wearRate: 1.0,
    wetGripBase: 0.92,
    hydroplaneStart: 0.35,
    hydroplaneSlope: 1.15,
    blanketTempC: 76,
    B: 11.4,
    C: 1.62,
    E: 0.35,
  },
  medium: {
    label: 'Dry Slick — Medium',
    short: 'MED',
    peakDryMu: 1.63,
    optTempLo: 80,
    optTempHi: 95,
    overheatSlope: 0.0032,
    wearRate: 0.56,
    wetGripBase: 0.95,
    hydroplaneStart: 0.38,
    hydroplaneSlope: 1.05,
    blanketTempC: 72,
    B: 10.6,
    C: 1.58,
    E: 0.42,
  },
  wet: {
    label: 'Rain Treaded — Wet',
    short: 'WET',
    peakDryMu: 1.34,
    optTempLo: 42,
    optTempHi: 68,
    overheatSlope: 0.0095, // Overheats & loses precision above 75°C on dry asphalt
    wearRate: 0.85,
    wetGripBase: 1.38,
    hydroplaneStart: 0.92,
    hydroplaneSlope: 0.28,
    blanketTempC: 46,
    B: 9.2,
    C: 1.48,
    E: 0.52,
  },
};

/**
 * Normalized Pacejka Magic Formula curve evaluated at combined slip magnitude.
 * Returns a grip efficiency multiplier around 1.0 at peak slip (~0.09..0.14).
 */
export function pacejkaFactor(slipMag: number, spec: CompoundSpec): number {
  const s = clamp(Math.abs(slipMag), 0, 1.5);
  // Keep standing/low-slip authority crisp while preserving progressive drop-off past peak
  const x = Math.max(0.085, s);
  const bx = spec.B * x;
  const val = Math.sin(spec.C * Math.atan(bx - spec.E * (bx - Math.atan(bx))));
  return clamp(0.92 + 0.11 * val, 0.80, 1.03);
}

/**
 * Compute effective physical tire-road friction mu for one wheel at 120 Hz.
 * Combines:
 *  - 3-compound dry/wet base grip & hydroplaning evacuation curve
 *  - Live TrackSurfaceGrid wetness, rubbered groove buildup, drying line, and off-line marbles
 *  - Surface type (asphalt, rubbered groove, painted wet FIA kerb, pit concrete, gravel, grass)
 *  - Core tread temperature window & wear degradation
 *  - Double-wishbone camber-gain factor under suspension compression
 */
export function computeWheelGrip(
  compound: TireCompound,
  surface: SurfaceId,
  state: SurfaceSample,
  tempC: number,
  wear: number,
  speedMs: number,
  compressionM: number,
  slipMag: number,
): number {
  const spec = COMPOUNDS[compound];
  // Effective local water depth reduced by active drying racing groove
  const effectiveWet = clamp(state.wetness * (1 - 0.58 * state.dryingGroove), 0, 1);

  // 1. Compound grip across dry -> damp -> standing water
  let mu: number;
  if (compound === 'wet') {
    // Rain tire shines in damp/wet (mu ~ 1.38) and stays predictable on wet kerbs
    const wetGain = clamp(effectiveWet / 0.25, 0, 1);
    mu = spec.peakDryMu * (1 - wetGain) + spec.wetGripBase * wetGain;
    if (effectiveWet > spec.hydroplaneStart) {
      mu -= (effectiveWet - spec.hydroplaneStart) * spec.hydroplaneSlope;
    }
  } else {
    // Dry slick loses grip steadily as pore water rises, then hydroplanes sharply above 0.35
    const dampDrop = clamp(effectiveWet / spec.hydroplaneStart, 0, 1);
    mu = spec.peakDryMu * (1 - 0.14 * dampDrop);
    if (effectiveWet > spec.hydroplaneStart) {
      const hydro = (effectiveWet - spec.hydroplaneStart) * spec.hydroplaneSlope * (0.45 + 0.55 * clamp(speedMs / 55, 0, 1));
      mu = Math.max(0.68, mu - hydro);
    }
  }

  // 2. Surface modifier & live track evolution
  if (surface === 'groove' || surface === 'asphalt' || surface === 'marbles') {
    // Dry rubbered groove adds grip; wet rubbered groove gets slightly slicker off the drying line
    const rubberDelta = effectiveWet < 0.28
      ? 0.07 * state.rubberGrip
      : -0.05 * state.rubberGrip * (1 - state.dryingGroove);
    const marblePenalty = -0.14 * state.marbles * (1 - 0.5 * effectiveWet);
    mu += rubberDelta + marblePenalty;
  } else if (surface === 'kerb') {
    // Painted FIA kerbs are crisp when dry (0.88x) and genuinely treacherous when wet (0.54x slicks, 0.76x wets)
    const kerbFactor = effectiveWet > 0.18
      ? (compound === 'wet' ? 0.78 : 0.56)
      : 0.88;
    mu *= kerbFactor;
  } else if (surface === 'pit') {
    mu *= effectiveWet > 0.2 ? 0.82 : 0.94;
  } else if (surface === 'grass') {
    mu = 0.76 * (1 - 0.22 * effectiveWet);
  } else if (surface === 'gravel') {
    mu = 0.58;
  }

  // 3. Thermal operating window (pre-heated tire blankets at 72°C+ are immediately raceable)
  let tempMul = 1.0;
  if (tempC < spec.optTempLo - 12) {
    tempMul = 1.0 - clamp((spec.optTempLo - 12 - tempC) / 110, 0, 0.14);
  } else if (tempC > spec.optTempHi) {
    tempMul = 1.0 - clamp((tempC - spec.optTempHi) * spec.overheatSlope, 0, 0.28);
  }
  mu *= tempMul;

  // 4. Tire wear curve (1.0 fresh -> 0.0 worn; cliff below 25%)
  const w = clamp(wear, 0, 1);
  const wearMul = w > 0.25 ? 0.90 + 0.10 * ((w - 0.25) / 0.75) : 0.68 + 0.22 * (w / 0.25);
  mu *= wearMul;

  // 5. Double-wishbone camber gain (slight positive grip gain as outer wheel compresses in roll)
  const camberGain = 1.0 + clamp((compressionM - 0.03) * 0.35, -0.02, 0.035);
  mu *= camberGain;

  // 6. Combined-slip Pacejka curve modulation
  mu *= pacejkaFactor(slipMag, spec);

  return clamp(mu, 0.42, 1.88);
}
