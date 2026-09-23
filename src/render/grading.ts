// Regional look presets (PRD §5.8): desert warm haze, mountain clarity, humid East softness, coastal cool.
import type { Recipe } from '../core/types';

export interface LookPreset {
  name: string;
  /** Mie (aerosol) density multiplier for the atmosphere model: haze, sun glow, horizon whiteness. */
  mie: number;
  /** Mie anisotropy. */
  mieG: number;
  /** Aerial haze extinction per meter (visibility ≈ 3.9 / haze). */
  haze: number;
  /** Ground height fog: density at base, falloff per meter. */
  heightFog: number;
  heightFalloff: number;
  /** White balance multipliers (applied in linear before tone mapping). */
  wb: [number, number, number];
  saturation: number;
  contrast: number;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  /** Cloud coverage baseline (0..1). */
  clouds: number;
  /** City light-pollution strength multiplier. */
  cityGlow: number;
  /** Chance of starting in rain. */
  rainChance: number;
}

const base: LookPreset = {
  name: 'temperate',
  mie: 1.2, mieG: 0.8, haze: 1 / 16000, heightFog: 1 / 9000, heightFalloff: 1 / 90,
  wb: [1.02, 1, 0.96], saturation: 1.06, contrast: 1.06,
  shadowTint: [0.985, 1.0, 1.02], highlightTint: [1.03, 1.0, 0.96],
  clouds: 0.35, cityGlow: 1, rainChance: 0.15,
};

export const LOOKS: Record<string, LookPreset> = {
  desert: {
    ...base, name: 'desert', mie: 2.2, mieG: 0.76, haze: 1 / 11000, heightFog: 1 / 16000, heightFalloff: 1 / 160,
    wb: [1.05, 1.0, 0.92], saturation: 0.97, contrast: 1.07,
    shadowTint: [1.0, 0.98, 0.99], highlightTint: [1.05, 1.0, 0.92], clouds: 0.12, cityGlow: 1.1, rainChance: 0.03,
  },
  mountain: {
    ...base, name: 'mountain', mie: 0.85, mieG: 0.82, haze: 1 / 17000, heightFog: 1 / 14000, heightFalloff: 1 / 70,
    wb: [1.02, 1.0, 0.97], saturation: 1.1, contrast: 1.08,
    shadowTint: [0.975, 0.995, 1.03], highlightTint: [1.04, 1.0, 0.95], clouds: 0.3, cityGlow: 0.9, rainChance: 0.1,
  },
  humid: {
    ...base, name: 'humid', mie: 2.0, mieG: 0.74, haze: 1 / 8500, heightFog: 1 / 5000, heightFalloff: 1 / 110,
    wb: [1.01, 1.0, 0.98], saturation: 1.0, contrast: 0.98,
    shadowTint: [0.98, 1.01, 1.0], highlightTint: [1.03, 1.01, 0.95], clouds: 0.5, cityGlow: 1.2, rainChance: 0.15,
  },
  coastal: {
    ...base, name: 'coastal', mie: 1.7, mieG: 0.78, haze: 1 / 10000, heightFog: 1 / 3500, heightFalloff: 1 / 60,
    wb: [0.99, 1.0, 1.01], saturation: 1.02, contrast: 1.04,
    shadowTint: [0.95, 0.99, 1.05], highlightTint: [1.01, 1.0, 0.98], clouds: 0.4, cityGlow: 1.0, rainChance: 0.12,
  },
  temperate: base,
};

export function lookForRecipe(r: Pick<Recipe, 'climate' | 'region'>): LookPreset {
  const q = new URLSearchParams(location.search).get('look');
  if (q && LOOKS[q]) return LOOKS[q];
  if (r.climate === 'coastal' || r.region === 'pacific') return LOOKS.coastal;
  if (r.region === 'mountain-west') return LOOKS.mountain;
  if (r.climate === 'arid' || r.region === 'southwest') return LOOKS.desert;
  if (r.climate === 'humid' || r.region === 'southeast' || r.region === 'northeast') return LOOKS.humid;
  if (r.climate === 'cold') return LOOKS.mountain;
  return LOOKS.temperate;
}
