export type MobileLayoutType = 'default' | 'shooting-games' | 'battlefield' | 'console' | 'custom';

/** Position of a single mobile UI element in percentage (0-100) of viewport */
export interface MobileLayoutPosition {
  x: number; // percentage, 0-100
  y: number; // percentage, 0-100
}

/** A mobile control button definition */
export interface MobileControlConfig {
  id: string;
  label: string;
  size: number; // in px
  icon: string;
  action: string;
  color: string;
  /** If true, the button fires the action on press and a `:release`
   *  action on release (e.g. for auto-fire while held). Otherwise the
   *  action fires on release (tap-style — jump, reload, switch, pause). */
  hold?: boolean;
}

/** Default controls that are always present */
export const DEFAULT_CONTROLS: MobileControlConfig[] = [
  { id: 'fire', label: 'Fire', size: 80, icon: '🔫', action: 'fire', color: '#ff6b35', hold: true },
  { id: 'jump', label: 'Jump', size: 68, icon: '⬆️', action: 'jump', color: '#c084fc' },
  { id: 'weapon', label: 'Switch', size: 48, icon: '⇄', action: 'switch("weapon")', color: '#38bdf8' },
  { id: 'reload', label: 'Reload', size: 48, icon: '↻', action: 'reload', color: '#22c55e' },
  { id: 'crouch', label: 'Crouch', size: 48, icon: '⬇️', action: 'crouch', color: '#fbbf24' },
  { id: 'sprint', label: 'Sprint', size: 48, icon: '⚡', action: 'sprint', color: '#f59e0b' },
  { id: 'pause', label: 'Pause', size: 44, icon: '⏸', action: 'pause', color: '#6b7280' },
];

/** Preset layouts */
export interface MobileLayoutPreset {
  name: string;
  description: string;
  positions: Record<string, MobileLayoutPosition>;
}

export const MOBILE_LAYOUT_PRESETS: Record<MobileLayoutType, MobileLayoutPreset> = {
  default: {
    name: 'Default',
    description: 'Standard shooter layout',
    positions: {
      fire: { x: 85, y: 70 },
      jump: { x: 15, y: 70 },
      weapon: { x: 80, y: 50 },
      reload: { x: 90, y: 40 },
      crouch: { x: 15, y: 55 },
      sprint: { x: 25, y: 70 },
      pause: { x: 95, y: 10 },
    },
  },
  'shooting-games': {
    name: 'Shooting Games',
    description: 'Pubg / CoD Mobile style',
    positions: {
      fire: { x: 88, y: 72 },
      jump: { x: 18, y: 75 },
      weapon: { x: 82, y: 82 },
      reload: { x: 75, y: 82 },
      crouch: { x: 12, y: 82 },
      sprint: { x: 30, y: 82 },
      pause: { x: 95, y: 8 },
    },
  },
  battlefield: {
    name: 'Battlefield / MW',
    description: 'Battlefield style layout',
    positions: {
      fire: { x: 87, y: 68 },
      jump: { x: 13, y: 68 },
      weapon: { x: 80, y: 45 },
      reload: { x: 90, y: 45 },
      crouch: { x: 10, y: 45 },
      sprint: { x: 25, y: 85 },
      pause: { x: 94, y: 12 },
    },
  },
  console: {
    name: 'Console Style',
    description: 'Controller-like button placement',
    positions: {
      fire: { x: 86, y: 65 },
      jump: { x: 15, y: 82 },
      weapon: { x: 75, y: 50 },
      reload: { x: 95, y: 50 },
      crouch: { x: 10, y: 50 },
      sprint: { x: 35, y: 78 },
      pause: { x: 94, y: 10 },
    },
  },
  custom: {
    name: 'Custom',
    description: 'Your own layout',
    positions: {
      fire: { x: 88, y: 72 },
      jump: { x: 18, y: 75 },
      weapon: { x: 82, y: 82 },
      reload: { x: 75, y: 82 },
      crouch: { x: 12, y: 82 },
      sprint: { x: 30, y: 82 },
      pause: { x: 95, y: 8 },
    },
  },
};

/** Storage key for custom layout */
const CUSTOM_LAYOUT_STORAGE_KEY = 'bounceroyale.mobileLayout.custom';
const SELECTED_LAYOUT_STORAGE_KEY = 'bounceroyale.mobileLayout.selected';

/** Load custom layout from localStorage */
export function loadCustomLayout(): Record<string, MobileLayoutPosition> {
  try {
    const raw = localStorage.getItem(CUSTOM_LAYOUT_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { ...MOBILE_LAYOUT_PRESETS.custom.positions };
}

/** Save custom layout to localStorage */
export function saveCustomLayout(positions: Record<string, MobileLayoutPosition>) {
  try {
    localStorage.setItem(CUSTOM_LAYOUT_STORAGE_KEY, JSON.stringify(positions));
  } catch {
    /* ignore */
  }
}

/** Load selected layout type */
export function loadSelectedLayout(): MobileLayoutType {
  try {
    const raw = localStorage.getItem(SELECTED_LAYOUT_STORAGE_KEY);
    if (raw && raw in MOBILE_LAYOUT_PRESETS) return raw as MobileLayoutType;
  } catch {
    /* ignore */
  }
  return 'default';
}

/** Save selected layout type */
export function saveSelectedLayout(type: MobileLayoutType) {
  try {
    localStorage.setItem(SELECTED_LAYOUT_STORAGE_KEY, type);
  } catch {
    /* ignore */
  }
}
