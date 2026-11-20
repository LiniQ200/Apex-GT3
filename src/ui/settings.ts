import { teams, type Settings } from '../types';

export const options = {
  chassis: [
    ['458', '458 GT3 Evo'],
    ['concept', 'Concept GT3 Prototype'],
  ],
  weather: [
    ['clear', 'Clear Midday · Dry'],
    ['golden', 'Golden Hour · Dry'],
    ['damp', 'Overcast · Damp'],
    ['rain', 'Heavy Rain · Wet'],
  ],
  compound: [
    ['soft', 'Dry Slick — Soft'],
    ['medium', 'Dry Slick — Medium'],
    ['wet', 'Rain Treaded — Wet'],
  ],
  mode: [
    ['sprint', '3-lap grid sprint'],
    ['hotlap', 'Hotlap qualifying'],
  ],
  pace: [
    ['clubman', 'Clubman'],
    ['pro', 'Pro'],
    ['platinum', 'FIA Platinum'],
  ],
  transmission: [
    ['auto', 'Automatic'],
    ['manual', 'Manual'],
  ],
} as const;

const prefix = 'apex-gt3.setup.';
export function restoreSetup(settings: Settings) {
  try {
    for (const [key, choices] of Object.entries(options)) {
      const value = localStorage.getItem(prefix + key);
      if (choices.some(([v]) => v === value)) Object.assign(settings, { [key]: value });
    }
    const livery = localStorage.getItem(prefix + 'livery');
    if (teams.some((_, i) => String(i) === livery)) settings.livery = Number(livery);
  } catch {
    /* Storage may be unavailable in an embed or a local file. */
  }
  // Always lock to the single Native 1080p direct forward preset
  settings.graphics = 'high';
}

export function rememberSetup(patch: Partial<Settings>) {
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'graphics') continue;
      localStorage.setItem(prefix + key, String(value));
    }
  } catch {
    /* The session is playable without saving preferences. */
  }
}
