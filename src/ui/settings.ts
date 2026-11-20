import { teams, type Settings } from '../types';

export const options = {
  chassis: [['458', '458 GT3 Evo'], ['concept', 'Concept GT3 Prototype']],
  weather: [['golden', 'Golden hour · Dry'], ['damp', 'Overcast · Damp']],
  mode: [['sprint', '3-lap grid sprint'], ['hotlap', 'Hotlap qualifying']],
  pace: [['clubman', 'Clubman'], ['pro', 'Pro'], ['platinum', 'FIA Platinum']],
  transmission: [['auto', 'Automatic'], ['manual', 'Manual']],
  graphics: [['balanced', 'Balanced'], ['high', 'High'], ['ultra', 'Ultra']],
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
  } catch { /* Storage may be unavailable in an embed or a local file. */ }
}

export function rememberSetup(patch: Partial<Settings>) {
  try {
    for (const [key, value] of Object.entries(patch)) localStorage.setItem(prefix + key, String(value));
  } catch { /* The session is playable without saving preferences. */ }
}
