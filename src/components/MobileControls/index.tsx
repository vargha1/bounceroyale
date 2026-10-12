export type MobileLayoutType = 'default' | 'shooting-games' | 'battlefield' | 'console' | 'custom';

/** Position of a single mobile UI element in percentage (0-100) of the
 *  safe-area box that contains the touch controls. */
export interface MobileLayoutPosition {
  x: number; // percentage, 0-100
  y: number; // percentage, 0-100
}

/** A mobile control button definition */
export interface MobileControlConfig {
  id: string;
  label: string;
  /** Diameter in px at the reference viewport (390px short side). Scaled at
   *  runtime by getControlScale(). */
  size: number;
  action: string;
  color: string;
  /** If true, the button fires the action on press and a `:release`
   *  action on release (e.g. for auto-fire while held). Otherwise the
   *  action fires on press (jump, reload, switch) — except `fireOnRelease`. */
  hold?: boolean;
  /** Fire the action when the finger lifts instead of on press (pause, so a
   *  stray brush while looking around can't pause the match). */
  fireOnRelease?: boolean;
}

/** Every control the engine actually supports. Crouch / sprint were removed:
 *  the engine has no such mechanics, so those buttons did nothing. */
export const DEFAULT_CONTROLS: MobileControlConfig[] = [
  { id: 'fire', label: 'Fire', size: 84, action: 'fire', color: '#ff6b35', hold: true },
  { id: 'jump', label: 'Jump', size: 66, action: 'jump', color: '#c084fc' },
  { id: 'weapon', label: 'Switch', size: 50, action: 'switch', color: '#38bdf8' },
  { id: 'reload', label: 'Reload', size: 50, action: 'reload', color: '#22c55e' },
  { id: 'pause', label: 'Pause', size: 40, action: 'pause', color: '#6b7280', fireOnRelease: true },
];

/** Scale factor applied to button sizes so they stay thumb-friendly on small
 *  phones without swallowing the screen, and grow slightly on tablets. */
export function getControlScale(): number {
  if (typeof window === 'undefined') return 1;
  const short = Math.min(window.innerWidth, window.innerHeight);
  return Math.max(0.8, Math.min(1.25, short / 390));
}

/** True when the primary input is a touchscreen (phones / tablets). */
export function isTouchPrimary(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/** Preset layouts */
export interface MobileLayoutPreset {
  name: string;
  description: string;
  positions: Record<string, MobileLayoutPosition>;
}

// All presets keep the whole left 40% of the screen free: that's where the
// floating move-joystick appears, and the free right-hand area above the
// buttons is the camera-look zone.
export const MOBILE_LAYOUT_PRESETS: Record<MobileLayoutType, MobileLayoutPreset> = {
  default: {
    name: 'Default',
    description: 'Right-thumb arc around the fire button',
    positions: {
      fire: { x: 89, y: 72 },
      jump: { x: 76, y: 82 },
      weapon: { x: 91, y: 42 },
      reload: { x: 80, y: 46 },
      pause: { x: 79, y: 9 },
    },
  },
  'shooting-games': {
    name: 'Shooter',
    description: 'PUBG / CoD Mobile style column',
    positions: {
      fire: { x: 88, y: 60 },
      jump: { x: 88, y: 86 },
      weapon: { x: 74, y: 46 },
      reload: { x: 74, y: 72 },
      pause: { x: 79, y: 9 },
    },
  },
  battlefield: {
    name: 'Compact',
    description: 'Tight cluster in the bottom-right corner',
    positions: {
      fire: { x: 90, y: 76 },
      jump: { x: 78, y: 86 },
      weapon: { x: 90, y: 48 },
      reload: { x: 77, y: 63 },
      pause: { x: 79, y: 9 },
    },
  },
  console: {
    name: 'Controller',
    description: 'Diamond of face buttons',
    positions: {
      fire: { x: 90, y: 68 },
      jump: { x: 80, y: 85 },
      weapon: { x: 70, y: 68 },
      reload: { x: 80, y: 51 },
      pause: { x: 79, y: 9 },
    },
  },
  custom: {
    name: 'Custom',
    description: 'Your own layout',
    positions: {
      fire: { x: 89, y: 72 },
      jump: { x: 76, y: 82 },
      weapon: { x: 91, y: 42 },
      reload: { x: 80, y: 46 },
      pause: { x: 79, y: 9 },
    },
  },
};

/** Storage keys */
const CUSTOM_LAYOUT_STORAGE_KEY = 'bounceroyale.mobileLayout.custom';
const SELECTED_LAYOUT_STORAGE_KEY = 'bounceroyale.mobileLayout.selected';
const LAYOUT_VERSION_KEY = 'bounceroyale.mobileLayout.version';
const LAYOUT_VERSION = '2';

/** One-time migration: layout v2 changed the button set and sizes, so a
 *  saved v1 layout (with now-removed crouch / sprint buttons and left-side
 *  jump) would overlap the new controls. Reset it once. */
function migrateLayoutStorage() {
  try {
    if (localStorage.getItem(LAYOUT_VERSION_KEY) === LAYOUT_VERSION) return;
    localStorage.removeItem(CUSTOM_LAYOUT_STORAGE_KEY);
    localStorage.removeItem(SELECTED_LAYOUT_STORAGE_KEY);
    localStorage.setItem(LAYOUT_VERSION_KEY, LAYOUT_VERSION);
  } catch {
    /* ignore */
  }
}
migrateLayoutStorage();

function isValidPosition(p: unknown): p is MobileLayoutPosition {
  const v = p as MobileLayoutPosition | null;
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && v.x >= 0 && v.x <= 100 && v.y >= 0 && v.y <= 100;
}

/** Load custom layout from localStorage (always returns every control). */
export function loadCustomLayout(): Record<string, MobileLayoutPosition> {
  const fallback = MOBILE_LAYOUT_PRESETS.custom.positions;
  try {
    const raw = localStorage.getItem(CUSTOM_LAYOUT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, MobileLayoutPosition> = {};
      for (const id of Object.keys(fallback)) {
        out[id] = isValidPosition(parsed[id]) ? (parsed[id] as MobileLayoutPosition) : { ...fallback[id] };
      }
      return out;
    }
  } catch {
    /* ignore */
  }
  const out: Record<string, MobileLayoutPosition> = {};
  for (const id of Object.keys(fallback)) out[id] = { ...fallback[id] };
  return out;
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

/** Resolve the positions for a layout type. */
export function getLayoutPositions(type: MobileLayoutType): Record<string, MobileLayoutPosition> {
  if (type === 'custom') return loadCustomLayout();
  return { ...MOBILE_LAYOUT_PRESETS[type].positions };
}

/** Style shared by the in-game controls layer and the layout editor so that a
 *  percentage position means the same physical spot in both. Insets keep the
 *  buttons clear of notches / rounded corners / the gesture bar. */
export const CONTROLS_LAYER_STYLE = {
  position: 'fixed',
  top: 'env(safe-area-inset-top, 0px)',
  right: 'env(safe-area-inset-right, 0px)',
  bottom: 'env(safe-area-inset-bottom, 0px)',
  left: 'env(safe-area-inset-left, 0px)',
} as const;

/** Simple inline SVG glyphs — consistent on every device (emoji fonts vary a
 *  lot between low-end Android builds) and tiny to render. */
export function ControlIcon({ id, size }: { id: string; size: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  switch (id) {
    case 'fire':
      // crosshair
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="6.5" />
          <circle cx="12" cy="12" r="1.2" fill="currentColor" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>
      );
    case 'jump':
      return (
        <svg {...common}>
          <path d="M6 14l6-6 6 6" />
          <path d="M6 19l6-6 6 6" />
        </svg>
      );
    case 'weapon':
      return (
        <svg {...common}>
          <path d="M4 8h14M14 4l4 4-4 4" />
          <path d="M20 16H6M10 12l-4 4 4 4" />
        </svg>
      );
    case 'reload':
      return (
        <svg {...common}>
          <path d="M20 12a8 8 0 1 1-2.6-5.9" />
          <path d="M20 4v5h-5" />
        </svg>
      );
    case 'pause':
      return (
        <svg {...common}>
          <path d="M9 5v14M15 5v14" strokeWidth={3} />
        </svg>
      );
    default:
      return null;
  }
}
