/**
 * Settings store (zustand). Persisted to localStorage so user choices survive reloads.
 */
import { create } from 'zustand';
import type { IslandSize } from '../game/island';

export type Language = 'en' | 'fa';

export interface Settings {
  language: Language;
  masterVolume: number; // 0..1
  gameSpeed: number; // 0.25..2 — multiplier applied to the whole sim
  graphicsQuality: 'low' | 'medium' | 'high';
  pointerLock: boolean;
  showFps: boolean;
  cameraSensitivity: number; // 0.1..3
  islandDamageMultiplier: number; // 0.1..3 — scales how much each landing damages the island
  islandSize: IslandSize; // 'small' | 'medium' | 'large'
}

const STORAGE_KEY = 'bounceroyale.settings.v1';

const defaults: Settings = {
  language: 'en',
  masterVolume: 0.7,
  gameSpeed: 1.0,
  graphicsQuality: 'high',
  pointerLock: true,
  showFps: false,
  cameraSensitivity: 1.0,
  islandDamageMultiplier: 1.0,
  islandSize: 'medium',
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function save(s: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

interface SettingsStore extends Settings {
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  reset: () => void;
}

export const useSettings = create<SettingsStore>((set) => ({
  ...load(),
  set: (key, value) => {
    set({ [key]: value } as Pick<Settings, typeof key>);
    const next = { ...useSettings.getState() } as Settings;
    delete (next as unknown as { set?: unknown }).set;
    delete (next as unknown as { reset?: unknown }).reset;
    save(next);
  },
  reset: () => {
    set({ ...defaults });
    save(defaults);
  },
}));

/** Compose effective time scale used by the engine. */
export function getEffectiveTimeScale(s: Settings): number {
  return s.gameSpeed;
}
