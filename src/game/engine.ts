/**
 * Core game engine — Three.js + Rapier, with a fixed-timestep physics loop
 * that is fully independent of the display refresh rate, plus a game-speed
 * time scale that affects the entire simulation without breaking determinism.
 *
 * Key design points (these are the bugs the original code had):
 *
 *  1. Physics runs at a FIXED 60 Hz via an accumulator. If the display runs at
 *     30 Hz we step twice per frame; if it runs at 144 Hz we step every other
 *     frame. The physics never speeds up or slows down with FPS.
 *
 *  2. The render loop is driven by requestAnimationFrame and reads back the
 *     latest interpolated physics state. Movement input is applied per render
 *     frame using the actual frame delta — so movement is FPS-independent too.
 *
 *  3. `gameSpeed` is implemented as a multiplier on the simulated time we feed
 *     into the accumulator. A 2x game speed doubles the number of physics steps
 *     per real second without changing the per-step dt, so physics stays
 *     numerically stable. (We also clamp the max steps-per-frame to avoid the
 *     "spiral of death".)
 *
 *  4. Animations (tweens, particles, score-per-second) use the real frame delta
 *     scaled by gameSpeed, so they look smooth at any FPS.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { Tween, Group, Easing } from '@tweenjs/tween.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

import type { NetClient, NetMessage, NetEvent } from '../networking/types';
import type { Settings } from '../store/settings';
import { generateIsland, getIslandSpawn, type IslandTile, type IslandSize } from './island';

// ---------- Constants ----------
const DEATH_Y_LEVEL = -10;
const PHYSICS_HZ = 60;
const PHYSICS_DT = 1 / PHYSICS_HZ;
const MAX_STEPS_PER_FRAME = 5; // safety cap to prevent spiral-of-death
const PLAYER_RADIUS = 0.5;
const PLAYER_HEIGHT = 1.8; // First-person eye height

// ---------- Weapon Definitions ----------
type WeaponType = 'ak47' | 'desert_eagle';
interface WeaponDef {
  name: string;
  damage: number;
  fireRate: number; // shots per second
  maxAmmo: number; // magazine size
  reserveAmmo: number; // extra rounds beyond the magazine
  reloadTime: number; // seconds
  spread: number; // radians
  range: number;
  knockback: number;
}
const WEAPONS: Record<WeaponType, WeaponDef> = {
  ak47: {
    name: 'AK-47',
    damage: 15,
    fireRate: 10,
    maxAmmo: 30,
    reserveAmmo: 60, // 2 extra mags
    reloadTime: 2.5,
    spread: 0.04,
    range: 50,
    knockback: 3,
  },
  desert_eagle: {
    name: 'Desert Eagle',
    damage: 45,
    fireRate: 2.5,
    maxAmmo: 7,
    reserveAmmo: 21, // 3 extra mags
    reloadTime: 1.8,
    spread: 0.015,
    range: 70,
    knockback: 8,
  },
};
const WEAPON_SWITCH_TIME = 0.4; // seconds to switch weapon

// Island tile geometry — smaller than the old hexagons so destruction feels granular.
const TILE_RADIUS = 0.6;
const TILE_HEIGHT = 0.5;
const TILE_MAX_HEALTH = 100;

// Powerup pickup tuning.
const POWERUP_PICKUP_COUNT = 6;        // how many pickups spawn on the map
const POWERUP_PICKUP_RADIUS = 0.45;    // visual size of the pickup
const POWERUP_COLLECT_DISTANCE = 1.1;  // player-to-pickup distance to collect
const POWERUP_RESPAWN_MS = 12000;      // a collected pickup reappears after this long
const POWERUP_DURATION_MS = 12000;     // how long the collected effect lasts on the player
const POWERUP_TYPES = ['speed_boost', 'high_jump', 'invincibility', 'health_regen'] as const;
const POWERUP_COLORS: Record<string, number> = {
  speed_boost: 0xffd700,    // gold
  high_jump: 0x00e676,      // green
  invincibility: 0x40c4ff,  // blue
  health_regen: 0xff5252,   // red
};

// Impact damage tuning. The "base" damage is applied at a reference fall speed
// of 10 m/s with a 1× multiplier. Harder landings scale linearly up to 3×.
const BASE_TILE_DAMAGE = 22;
const IMPACT_SPEED_REFERENCE = 10; // m/s — a "normal" landing
const IMPACT_SPEED_MAX_FACTOR = 3; // clamp the speed multiplier
const IMPACT_RADIUS_BASE = 0.9; // minimum blast radius
const IMPACT_RADIUS_SCALE = 0.5; // added per speed-factor
const MIN_IMPACT_SPEED = 3; // below this, no damage (prevents jitter)
const IMPACT_DEBOUNCE_MS = 150; // prevent double-triggering on the same landing

const ALL_INTERACTION = 0x00010001;
const PLAYER_COLLISION_GROUP = 0x00020002;

const PLAYER_COLORS = [
  0xff5252, 0x5b8cff, 0xffc400, 0x00e676, 0xff4081, 0x18ffff, 0xb388ff, 0xffab40,
];

export type EngineHandle = ReturnType<typeof createGameEngine>;

export interface EngineCallbacks {
  onState: (s: EngineHudState) => void;
  onCountdown: (remainingSeconds: number | null) => void;
  onSpectatingChange: (spectating: boolean) => void;
  onEndGame: (rankings: { id: string; rank: number | null }[], winner: string | null) => void;
  onError: (message: string) => void;
  onConnectionLost: () => void;
  /** Fired when the local player takes damage (delta < 0). Used for damage indicator UI. */
  onDamageTaken?: (damage: number) => void;
  /** Fired when the engine's match state has been reset for a restart (either
   *  locally-initiated via restart() or remotely via a re-init from the host).
   *  The UI layer uses this to clear its end-game modal, spectating banner,
   *  and pause state so the new match starts fresh. */
  onReset?: () => void;
}

export interface EngineHudState {
  score: number;
  health: number;
  powerUps: { type: string; remaining: number }[];
  aliveCount: number;
  totalPlayers: number;
  isHost: boolean;
  weapon: WeaponType;
  ammo: number;
  maxAmmo: number;
  reserveAmmo: number;
  isReloading: boolean;
  reloadProgress: number; // 0..1
}

export interface EngineOptions {
  mode: 'single' | 'lan' | 'server';
  netClient?: NetClient | null;
  isHost: boolean;
  settings: Settings;
  startTimer: number;
  serverStartTime?: number;
  callbacks: EngineCallbacks;
}

// ---------- Engine ----------
export function createGameEngine(opts: EngineOptions) {
  const { mode, netClient, isHost, callbacks } = opts;
  let settings = opts.settings;

  // Three.js core
  const scene = new THREE.Scene();
  const texture = new THREE.TextureLoader().load(
    '/images/eso0932a.jpg'
  );
  texture.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = texture;
  scene.fog = new THREE.Fog(0x0a0a14, 25, 60);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 8, 14);

  const renderer = new THREE.WebGLRenderer({
    antialias: settings.graphicsQuality !== 'low',
    powerPreference: 'high-performance',
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Critical for mobile: prevent the canvas from triggering browser gestures
  // (pan, zoom, pull-to-refresh) that would otherwise eat our touch events.
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.style.display = 'block';
  renderer.shadowMap.enabled = false; // Shadows disabled for FPS — re-enable only on high-end
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  // CSS2D renderer for player name labels
  const css2dRenderer = new CSS2DRenderer();
  css2dRenderer.setSize(window.innerWidth, window.innerHeight);
  css2dRenderer.domElement.style.position = 'absolute';
  css2dRenderer.domElement.style.top = '0';
  css2dRenderer.domElement.style.left = '0';
  css2dRenderer.domElement.style.pointerEvents = 'none';
  renderer.domElement.style.position = 'relative';

  // Lighting
  // Use hemisphere light for cheaper ambient + directional in one pass
  const hemiLight = new THREE.HemisphereLight(0x8899bb, 0x444422, 0.8);
  scene.add(hemiLight);

  const sun = new THREE.DirectionalLight(0xffe4b5, 1.2);
  sun.position.set(10, 20, 8);
  scene.add(sun);

  // Audio
  const audioListener = new THREE.AudioListener();
  camera.add(audioListener);
  const audioLoader = new THREE.AudioLoader();
  const jumpSound = new THREE.Audio(audioListener);
  const collisionSound = new THREE.Audio(audioListener);
  const breakSound = new THREE.Audio(audioListener);
  let audioReady = false;
  audioLoader.load('/sounds/jump.mp3', (buf) => { jumpSound.setBuffer(buf); audioReady = true; });
  audioLoader.load('/sounds/collision.mp3', (buf) => collisionSound.setBuffer(buf));
  audioLoader.load('/sounds/break.mp3', (buf) => breakSound.setBuffer(buf));

  function ensureAudio() {
    // Always try to resume the AudioContext. On mobile browsers, the context
    // starts suspended and can only be resumed from within a user gesture
    // (touch/click). We call this from every touch handler so the first
    // interaction unlocks audio.
    try {
      if (audioListener.context.state === 'suspended') audioListener.context.resume();
    } catch { /* ignore */ }
  }

  function playSound(s: THREE.Audio, vol: number) {
    // Resume the AudioContext on every sound attempt — this is safe and
    // ensures audio unlocks on mobile even if the first call happens before
    // sounds finish loading.
    ensureAudio();
    if (!audioReady || !s.buffer) return;
    try {
      s.setVolume(vol * settings.masterVolume);
      if (!s.isPlaying) s.play();
    } catch {
      /* ignore */
    }
  }

  /** Play a synthesized weapon fire sound using Web Audio API.
   *  Closely mimics Counter-Strike: Source weapon characteristics:
   *    - AK-47: metallic crack with sharp attack, resonant ring-off,
   *      and a pronounced low-frequency thump. Two distinct noise layers
   *      (sharp transient + fizz tail) emulate the gas-system report.
   *    - Desert Eagle: enormous bass boom, long decay, window-rattling
   *      low-end. Multi-layered noise + sub-bass + rolled-off midrange
   *      gives that signature hand-cannon weight.
   *  No external audio files needed — works fully offline. */
  function playFireSound() {
    ensureAudio();
    try {
      const ctx = audioListener.context;
      if (ctx.state === 'suspended') return;
      const isAk = currentWeapon === 'ak47';
      const now = ctx.currentTime;

      // ---- Master gain for this shot ----
      const masterGain = ctx.createGain();
      masterGain.gain.value = settings.masterVolume * (isAk ? 0.45 : 0.6);
      masterGain.connect(ctx.destination);

      if (isAk) {
        // === AK-47: Three layers ===

        // Layer 1: Sharp transient crack (noise burst, very fast attack/decay)
        const crackDur = 0.045;
        const crackLen = Math.floor(ctx.sampleRate * crackDur);
        const crackBuf = ctx.createBuffer(1, crackLen, ctx.sampleRate);
        const crackData = crackBuf.getChannelData(0);
        for (let i = 0; i < crackLen; i++) {
          const t = i / ctx.sampleRate;
          // Ultra-fast exponential decay for the initial snap
          const env = Math.exp(-t * 120) * 0.7;
          crackData[i] = (Math.random() * 2 - 1) * env;
        }
        const crackSrc = ctx.createBufferSource();
        crackSrc.buffer = crackBuf;
        const crackGain = ctx.createGain();
        crackGain.gain.value = 0.7;
        crackSrc.connect(crackGain);
        crackGain.connect(masterGain);
        crackSrc.start(now);

        // Layer 2: Low-frequency thump (body of the shot)
        const thumpOsc = ctx.createOscillator();
        thumpOsc.type = 'sine';
        thumpOsc.frequency.setValueAtTime(120, now);
        thumpOsc.frequency.exponentialRampToValueAtTime(55, now + 0.08);
        const thumpGain = ctx.createGain();
        thumpGain.gain.setValueAtTime(0.55, now);
        thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        thumpOsc.connect(thumpGain);
        thumpGain.connect(masterGain);
        thumpOsc.start(now);
        thumpOsc.stop(now + 0.12);

        // Layer 3: Metallic ring-off (resonant filter on noise — mimics barrel resonance)
        const ringDur = 0.12;
        const ringLen = Math.floor(ctx.sampleRate * ringDur);
        const ringBuf = ctx.createBuffer(1, ringLen, ctx.sampleRate);
        const ringData = ringBuf.getChannelData(0);
        for (let i = 0; i < ringLen; i++) {
          const t = i / ctx.sampleRate;
          // Slower decay for the ring-off tail
          const env = Math.exp(-t * 35) * 0.25;
          ringData[i] = (Math.random() * 2 - 1) * env;
          // Add a pitched metallic resonance component
          ringData[i] += Math.sin(t * 2400) * Math.exp(-t * 50) * 0.08;
          ringData[i] += Math.sin(t * 3800) * Math.exp(-t * 60) * 0.04;
        }
        const ringSrc = ctx.createBufferSource();
        ringSrc.buffer = ringBuf;
        const ringFilter = ctx.createBiquadFilter();
        ringFilter.type = 'bandpass';
        ringFilter.frequency.value = 2500;
        ringFilter.Q.value = 2.5;
        const ringGain = ctx.createGain();
        ringGain.gain.value = 0.5;
        ringSrc.connect(ringFilter);
        ringFilter.connect(ringGain);
        ringGain.connect(masterGain);
        ringSrc.start(now + 0.01); // slight delay after crack

      } else {
        // === Desert Eagle: Four layers for maximum impact ===

        // Layer 1: Massive sub-bass hit
        const subOsc = ctx.createOscillator();
        subOsc.type = 'sine';
        subOsc.frequency.setValueAtTime(65, now);
        subOsc.frequency.exponentialRampToValueAtTime(35, now + 0.2);
        const subGain = ctx.createGain();
        subGain.gain.setValueAtTime(0.65, now);
        subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        subOsc.connect(subGain);
        subGain.connect(masterGain);
        subOsc.start(now);
        subOsc.stop(now + 0.3);

        // Layer 2: Mid-bass boom (the signature DE report)
        const boomOsc = ctx.createOscillator();
        boomOsc.type = 'sine';
        boomOsc.frequency.setValueAtTime(100, now);
        boomOsc.frequency.exponentialRampToValueAtTime(60, now + 0.15);
        const boomGain = ctx.createGain();
        boomGain.gain.setValueAtTime(0.5, now);
        boomGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        boomOsc.connect(boomGain);
        boomGain.connect(masterGain);
        boomOsc.start(now);
        boomOsc.stop(now + 0.25);

        // Layer 3: Noise burst with slow decay (concussive blast)
        const blastDur = 0.2;
        const blastLen = Math.floor(ctx.sampleRate * blastDur);
        const blastBuf = ctx.createBuffer(1, blastLen, ctx.sampleRate);
        const blastData = blastBuf.getChannelData(0);
        for (let i = 0; i < blastLen; i++) {
          const t = i / ctx.sampleRate;
          const env = Math.exp(-t * 14) * 0.45;
          blastData[i] = (Math.random() * 2 - 1) * env;
        }
        const blastSrc = ctx.createBufferSource();
        blastSrc.buffer = blastBuf;
        const blastFilter = ctx.createBiquadFilter();
        blastFilter.type = 'lowpass';
        blastFilter.frequency.value = 1800;
        blastFilter.Q.value = 0.7;
        const blastGain = ctx.createGain();
        blastGain.gain.value = 0.6;
        blastSrc.connect(blastFilter);
        blastFilter.connect(blastGain);
        blastGain.connect(masterGain);
        blastSrc.start(now);

        // Layer 4: High-frequency crack (the snap of the large caliber)
        const snapDur = 0.06;
        const snapLen = Math.floor(ctx.sampleRate * snapDur);
        const snapBuf = ctx.createBuffer(1, snapLen, ctx.sampleRate);
        const snapData = snapBuf.getChannelData(0);
        for (let i = 0; i < snapLen; i++) {
          const t = i / ctx.sampleRate;
          const env = Math.exp(-t * 80) * 0.35;
          snapData[i] = (Math.random() * 2 - 1) * env;
        }
        const snapSrc = ctx.createBufferSource();
        snapSrc.buffer = snapBuf;
        const snapFilter = ctx.createBiquadFilter();
        snapFilter.type = 'highpass';
        snapFilter.frequency.value = 3000;
        const snapGain = ctx.createGain();
        snapGain.gain.value = 0.3;
        snapSrc.connect(snapFilter);
        snapFilter.connect(snapGain);
        snapGain.connect(masterGain);
        snapSrc.start(now);
      }
    } catch {
      /* ignore — audio context may not be ready */
    }
  }

  /** Play a synthesized reload sound using Web Audio API.
   *  Two phases: magazine removal click + insertion thunk, then slide/bolt rack.
   *  Timed to match the reload animation progress:
   *    Phase 1 (0-30%): magazine ejection (metallic click-clack)
   *    Phase 2 (50-70%): magazine insertion (hollow thud)
   *    Phase 3 (70-100%): slide/bolt rack (sharp metallic pull & snap)
   *  Called once at the start of reload; sounds are scheduled at future times. */
  function playReloadSound() {
    ensureAudio();
    try {
      const ctx = audioListener.context;
      if (ctx.state === 'suspended') return;
      const wdef = WEAPONS[currentWeapon];
      const now = ctx.currentTime;
      const reloadSec = wdef.reloadTime;

      const masterGain = ctx.createGain();
      masterGain.gain.value = settings.masterVolume;
      masterGain.connect(ctx.destination);

      // Phase 1: Magazine ejection — metallic click + clack (at 15% of reload)
      const ejectTime = now + reloadSec * 0.15;
      const ejectDur = 0.08;
      const ejectLen = Math.floor(ctx.sampleRate * ejectDur);
      const ejectBuf = ctx.createBuffer(1, ejectLen, ctx.sampleRate);
      const ejectData = ejectBuf.getChannelData(0);
      for (let i = 0; i < ejectLen; i++) {
        const t = i / ctx.sampleRate;
        const env = Math.exp(-t * 80);
        ejectData[i] = (Math.random() * 2 - 1) * env * 0.3;
        // Metallic click component
        ejectData[i] += Math.sin(t * 5000) * Math.exp(-t * 120) * 0.15;
        // Clack (slightly delayed)
        const t2 = Math.max(0, t - 0.025);
        ejectData[i] += (Math.random() * 2 - 1) * Math.exp(-t2 * 100) * 0.2;
      }
      const ejectSrc = ctx.createBufferSource();
      ejectSrc.buffer = ejectBuf;
      ejectSrc.connect(masterGain);
      ejectSrc.start(ejectTime);

      // Phase 2: Magazine insertion — hollow thud (at 55% of reload)
      const insertTime = now + reloadSec * 0.55;
      const insertDur = 0.06;
      const insertLen = Math.floor(ctx.sampleRate * insertDur);
      const insertBuf = ctx.createBuffer(1, insertLen, ctx.sampleRate);
      const insertData = insertBuf.getChannelData(0);
      for (let i = 0; i < insertLen; i++) {
        const t = i / ctx.sampleRate;
        const env = Math.exp(-t * 60);
        insertData[i] = (Math.random() * 2 - 1) * env * 0.35;
        // Resonant body of the insertion
        insertData[i] += Math.sin(t * 300) * Math.exp(-t * 50) * 0.25;
        insertData[i] += Math.sin(t * 600) * Math.exp(-t * 70) * 0.1;
      }
      const insertSrc = ctx.createBufferSource();
      insertSrc.buffer = insertBuf;
      const insertFilter = ctx.createBiquadFilter();
      insertFilter.type = 'lowpass';
      insertFilter.frequency.value = 1200;
      insertSrc.connect(insertFilter);
      insertFilter.connect(masterGain);
      insertSrc.start(insertTime);

      // Phase 3: Slide rack / bolt pull — sharp metallic pull + snap (at 78% of reload)
      const rackTime = now + reloadSec * 0.78;
      // 3a: Pull sound (grinding/scraping)
      const pullDur = 0.07;
      const pullLen = Math.floor(ctx.sampleRate * pullDur);
      const pullBuf = ctx.createBuffer(1, pullLen, ctx.sampleRate);
      const pullData = pullBuf.getChannelData(0);
      for (let i = 0; i < pullLen; i++) {
        const t = i / ctx.sampleRate;
        // Scraping texture
        pullData[i] = (Math.random() * 2 - 1) * 0.15 * (1 - t / pullDur);
        // Rising pitch slider
        pullData[i] += Math.sin(t * 2500) * 0.06 * (1 - t / pullDur);
      }
      const pullSrc = ctx.createBufferSource();
      pullSrc.buffer = pullBuf;
      const pullFilter = ctx.createBiquadFilter();
      pullFilter.type = 'bandpass';
      pullFilter.frequency.value = 3000;
      pullFilter.Q.value = 1.5;
      pullSrc.connect(pullFilter);
      pullFilter.connect(masterGain);
      pullSrc.start(rackTime);

      // 3b: Snap/slam at end of rack (sharp metallic impact)
      const snapDur = 0.04;
      const snapLen = Math.floor(ctx.sampleRate * snapDur);
      const snapBuf2 = ctx.createBuffer(1, snapLen, ctx.sampleRate);
      const snapData2 = snapBuf2.getChannelData(0);
      for (let i = 0; i < snapLen; i++) {
        const t = i / ctx.sampleRate;
        const env = Math.exp(-t * 150);
        snapData2[i] = (Math.random() * 2 - 1) * env * 0.4;
        snapData2[i] += Math.sin(t * 7000) * Math.exp(-t * 200) * 0.2;
      }
      const snapSrc2 = ctx.createBufferSource();
      snapSrc2.buffer = snapBuf2;
      snapSrc2.connect(masterGain);
      snapSrc2.start(rackTime + 0.07);
    } catch {
      /* ignore — audio context may not be ready */
    }
  }

  // Physics — mutable so we can recreate on restart (Rapier's WASM can't
  // safely reuse a World after bodies have been removed — it causes
  // "recursive use of an object" aliasing errors).
  let world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  let eventQueue = new RAPIER.EventQueue(true);

  // World geometry (death floor for visualization only — actual death by Y check)
  // const floorGeo = new THREE.CircleGeometry(80, 64);
  // const floorMat = new THREE.MeshBasicMaterial({ color: 0x12122a, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  // const floorMesh = new THREE.Mesh(floorGeo, floorMat);
  // floorMesh.rotation.x = -Math.PI / 2;
  // floorMesh.position.y = DEATH_Y_LEVEL;
  // scene.add(floorMesh);

  // State
  type TileClient = {
    id: string;
    mesh: THREE.Mesh;
    rigidBody?: RAPIER.RigidBody;
    collider?: RAPIER.Collider;
    health: number;
    maxHealth: number;
    isBreaking: boolean;
    baseColor: THREE.Color;
  };
  type PlayerClient = {
    id: string;
    mesh: THREE.Mesh;
    rigidBody?: RAPIER.RigidBody;
    collider?: RAPIER.Collider;
    eliminated: boolean;
    rank?: number;
    color: number;
    targetPosition: { x: number; y: number; z: number };
    targetRotation: { x: number; y: number; z: number; w: number };
    /** Remote player's camera azimuth (facing direction), sent via 'move' messages.
     *  Used to orient their weapon model so other players can see where they aim. */
    targetAzimuth: number;
    nameLabel?: CSS2DObject;
    weaponGroup?: THREE.Group;
    muzzleFlash?: THREE.PointLight;
    health?: number;
    maxHealth?: number;
  };
  /**
   * A powerup pickup scattered on the map. Players collect these by moving
   * close to them; the effect then activates on the collector for a fixed
   * duration. Pickups respawn after POWERUP_RESPAWN_MS.
   *
   * Pickup IDs and positions are DETERMINISTIC across peers — they are
   * derived from the island seed (which the host generates and sends to
   * guests in the init message). So everyone sees the same set of pickups
   * in the same places. Collection events are broadcast so peers hide the
   * pickup on their side; respawn is similarly broadcast (host-driven).
   */
  type PowerupPickup = {
    id: string;
    type: string;
    tileId: string;          // which tile this pickup currently sits above
    basePosition: THREE.Vector3; // current anchor position (used for hover offset)
    mesh: THREE.Mesh;
    haloMesh: THREE.Mesh;
    collected: boolean;
    respawnAt: number;       // timestamp (ms) when the pickup reappears; 0 = available
    /** How many times this pickup has respawned. Used to seed the
     *  respawn-position PRNG so each respawn lands on a different tile. */
    respawnCount: number;
  };

  const tiles: TileClient[] = [];
  const tilesById = new Map<string, TileClient>();
  const players: Record<string, PlayerClient> = {};
  const powerupPickups: PowerupPickup[] = [];
  const powerupPickupsById = new Map<string, PowerupPickup>();
  let colliderHandleToPlayerId: Record<number, string> = {};
  const particles: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; maxLife: number }[] = [];
  const tweenGroup = new Group();

  let ballRigidBody: RAPIER.RigidBody | null = null;
  let ballCollider: RAPIER.Collider | null = null;
  let localPlayerId: string = isHost ? 'local-host' : (netClient?.id ?? 'local');
  if (mode === 'single') localPlayerId = 'local';

  let playerScore = 0;
  let playerHealth = 100;
  const powerUps: Record<string, { type: string; duration: number; startTime: number; active: boolean }> = {};

  let physicsEnabled = false;
  let isPaused = false;
  let isSpectating = false;
  /** Which player the camera follows while spectating. null = auto-pick the
   *  first alive player. Set by switchSpectator() and reset when the spectated
   *  player dies or disconnects. */
  let spectateTargetId: string | null = null;
  let cameraAzimuth = 0;
  let lastGroundedTileId: string | null = null;
  let canJump = false;
  let canJumpUntil = 0;
  let jumpBufferedUntil = 0;
  let lastSendTime = 0;
  /** Fallback timer for guests: if `game-started` isn't received within 3s of
   *  the guest's own countdown reaching 0, enable physics anyway (the message
   *  may have been lost on the unreliable WebRTC data channel). */
  let gameStartedFallbackTimer: number | null = null;
  const SEND_INTERVAL = 50; // ~20 updates/s — reduces network overhead for smoother gameplay

  // Fall-speed tracking for impact damage. While the ball is airborne we
  // record the peak downward velocity; on landing we convert that into
  // damage to nearby tiles.
  let wasAirborne = false;
  let maxFallSpeed = 0;
  let lastImpactTime = 0;

  // Input
  const keys = { w: false, a: false, s: false, d: false, space: false };
  let joystickX = 0;
  let joystickY = 0;
  let lookDelta = 0; // accumulated mouse/touch delta for camera
  let lookDeltaY = 0; // vertical look delta for FPS camera

  // Weapon state
  let currentWeapon: WeaponType = 'ak47';
  let ammo: number = WEAPONS.ak47.maxAmmo;
  let reserveAmmo: number = WEAPONS.ak47.reserveAmmo;
  // Per-weapon ammo state — saved when switching away, restored when switching back.
  // Without this, switching weapons resets ammo to full every time.
  const weaponAmmoState: Record<WeaponType, { ammo: number; reserveAmmo: number }> = {
    ak47: { ammo: WEAPONS.ak47.maxAmmo, reserveAmmo: WEAPONS.ak47.reserveAmmo },
    desert_eagle: { ammo: WEAPONS.desert_eagle.maxAmmo, reserveAmmo: WEAPONS.desert_eagle.reserveAmmo },
  };
  let isReloading = false;
  let reloadStartTime = 0;
  let lastFireTime = 0;
  let isSwitchingWeapon = false;
  let weaponSwitchStartTime = 0;
  let pendingWeapon: WeaponType | null = null;
  let isFiring = false; // mouse held down
  let weaponRecoilOffset = 0;
  let weaponBobTime = 0;
  let muzzleFlashTimer = 0;

  // FPS camera pitch
  let cameraPitch = -0.3; // slight downward look

  // Game start
  let serverStartTime: number | null = opts.serverStartTime ?? null;
  let startTimerValue = opts.startTimer;

  // Island seed + size — the host generates these and sends them to guests
  // in the init message so everyone has the exact same island.
  let islandSeed: number = Math.floor(Math.random() * 1e9);
  let islandSize: IslandSize = (opts.settings.islandSize as IslandSize) || 'medium';

  // Fixed timestep accumulator
  let physicsAccumulator = 0;
  let lastFrameTime = performance.now() / 1000;
  let realFps = 60;
  let fpsSmoothed = 60;
  let fpsAccum = 0;
  let fpsFrames = 0;

  let animationFrameId: number | null = null;
  let disconnected = false;

  // ---------- Helpers ----------
  function pushHud() {
    const wdef = WEAPONS[currentWeapon];
    callbacks.onState({
      score: playerScore,
      health: Math.round(playerHealth),
      powerUps: Object.values(powerUps)
        .filter((p) => p.active)
        .map((p) => ({ type: p.type, remaining: Math.max(0, p.duration - (performance.now() - p.startTime)) })),
      aliveCount: Object.values(players).filter((p) => !p.eliminated).length,
      totalPlayers: Object.keys(players).length,
      isHost,
      weapon: currentWeapon,
      ammo,
      maxAmmo: wdef.maxAmmo,
      reserveAmmo,
      isReloading,
      reloadProgress: isReloading ? Math.min(1, (performance.now() - reloadStartTime) / (wdef.reloadTime * 1000)) : 0,
    });
  }

  function pushCountdown() {
    if (!serverStartTime) {
      callbacks.onCountdown(null);
      return;
    }
    const remaining = Math.max(0, Math.ceil((serverStartTime - Date.now()) / 1000));
    if (remaining <= 0) {
      // Timer has expired. BEHAVIOR DIFFERS BY ROLE:
      //
      // HOST (and single-player): the host is the authority for when the
      // match begins. When the host's own countdown hits 0, it enables
      // physics locally AND broadcasts `game-started` to all guests (via
      // enablePhysics() → netClient.send). Guests then enable physics in
      // response to that broadcast.
      //
      // GUEST: guests must NOT enable physics based on their own countdown
      // expiring. The guest's `serverStartTime` is copied from the host's
      // `init` message, and due to network latency + clock skew the guest's
      // countdown can expire BEFORE the host's. If the guest enabled physics
      // on its own countdown, it could move/jump before the host's timer hit
      // 0 — the "one player can move before the timer finishes" bug.
      //
      // Instead, the guest shows "0" and WAITS for the host's `game-started`
      // broadcast (handled in the `case 'game-started'` branch of
      // setupNetworking, which calls enablePhysics()).
      //
      // FALLBACK: the WebRTC data channel is unreliable (maxRetransmits: 0),
      // so `game-started` could be lost. To prevent the guest from being
      // stuck forever, we enable physics after a 3-second grace period past
      // the guest's own countdown reaching 0. This is safe because:
      //   - The host's `serverStartTime` was set to `Date.now() + timer*1000`
      //     when the host's engine started.
      //   - The guest's `serverStartTime` is the SAME value (copied from init).
      //   - By the time the guest's countdown hits 0, the host's countdown
      //     has ALSO hit 0 (or is about to, within clock skew).
      //   - The 3-second grace accounts for clock skew + the network round
      //     trip of the `game-started` message. If it still hasn't arrived
      //     after 3 seconds, it was almost certainly lost.
      if (isHost || mode === 'single') {
        if (!physicsEnabled) {
          enablePhysics();
        }
        callbacks.onCountdown(null);
        serverStartTime = null;
      } else {
        // Guest: show "0" and wait for game-started (with 3s fallback).
        callbacks.onCountdown(0);
        if (!physicsEnabled && !gameStartedFallbackTimer) {
          gameStartedFallbackTimer = window.setTimeout(() => {
            if (!physicsEnabled && serverStartTime) {
              console.warn('[ENGINE] game-started not received within 3s of countdown expiry — enabling physics as fallback (message may have been lost on the unreliable data channel).');
              enablePhysics();
              serverStartTime = null;
              callbacks.onCountdown(null);
            }
            gameStartedFallbackTimer = null;
          }, 3000);
        }
      }
      return;
    }
    callbacks.onCountdown(remaining);
  }

  function enablePhysics() {
    physicsEnabled = true;
    if (ballRigidBody) {
      // Sync rigid body position from the mesh (mesh was set during createSphere)
      const lp = players[localPlayerId];
      if (lp) {
        const mp = lp.mesh.position;
        try {
          ballRigidBody.setTranslation({ x: mp.x, y: mp.y, z: mp.z }, true);
        } catch { /* ignore */ }
      }
      ballRigidBody.setEnabled(true);
      ballRigidBody.wakeUp();
      // Reset velocity so the ball doesn't carry stale momentum from a previous round
      try {
        ballRigidBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        ballRigidBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
      } catch { /* ignore */ }
    }
    // Reset camera to follow the ball immediately (avoid smooth glide from old position)
    const lp2 = players[localPlayerId];
    if (lp2) {
      const pos = lp2.mesh.position;
      const eyeOffset = PLAYER_HEIGHT * 0.4;
      camera.position.set(pos.x, pos.y + eyeOffset, pos.z);
    }
    if (netClient && mode !== 'single' && isHost) {
      netClient.send({ kind: 'game-started' });
    }
  }

  function addScore(n: number) {
    playerScore += n;
    pushHud();
  }

  function updateHealth(delta: number) {
    playerHealth = Math.max(0, Math.min(100, playerHealth + delta));
    pushHud();
    // Trigger damage indicator for UI when taking damage
    if (delta < 0) {
      callbacks.onDamageTaken?.(-delta);
    }
    if (playerHealth <= 0) {
      const id = localPlayerId;
      if (id && !players[id]?.eliminated) eliminatePlayer(id);
    }
  }

  /** Apply damage to a remote player (not the local player).
   *  Tracks per-player health and eliminates them when health reaches 0. */
  function applyDamageToRemotePlayer(playerId: string, damage: number) {
    const p = players[playerId];
    if (!p || p.eliminated) return;
    // Initialize health tracking for remote players if not present
    if (p.health === undefined) p.health = 100;
    if (p.health === undefined) p.maxHealth = 100;
    p.health = Math.max(0, p.health - damage);
    // Show hit effect
    createParticleEffect(p.mesh.position.clone().add(new THREE.Vector3(0, 0.5, 0)), 0xff4444, 4);
    // If health depleted, eliminate the player
    if (p.health <= 0 && !p.eliminated) {
      if (isHost || mode === 'single') {
        eliminatePlayer(playerId);
      }
    }
  }

  function addPowerUp(type: string, duration = POWERUP_DURATION_MS) {
    // Replace any existing powerup of the same type (refresh duration) so a
    // player can't stack 5 speed_boosts by collecting 5 gold pickups.
    for (const [id, p] of Object.entries(powerUps)) {
      if (p.type === type) {
        p.startTime = performance.now();
        p.duration = duration;
        p.active = true;
        pushHud();
        return;
      }
    }
    powerUps[`${type}_${Date.now()}`] = { type, duration, startTime: performance.now(), active: true };
    pushHud();
  }

  function hasPowerUp(type: string) {
    return Object.values(powerUps).some((p) => p.type === type && p.active);
  }

  // -----------------------------------------------------------------------
  // Scattered powerup pickups
  // -----------------------------------------------------------------------
  //
  // Pickups are placed DETERMINISTICALLY across all peers using a seeded PRNG
  // derived from the island seed. So host and guests see the same pickups in
  // the same positions. The collection / respawn events are broadcast so
  // everyone hides / shows the pickup at the same moment.
  //
  // We deliberately AVOID giving players powerups directly (the old code did
  // `spawnRandomPowerUp()` which directly granted a random effect every
  // second). Players now have to move their ball to a pickup to collect it.

  /** Mulberry32 — tiny, fast, deterministic PRNG for pickup placement. */
  function mulberry32(seed: number) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Pick N widely-spaced tiles for powerup pickup placement. Uses a seeded
   * PRNG so host and guests pick the same tiles. Returns the chosen tiles.
   */
  function pickPowerupTiles(count: number, seed: number): TileClient[] {
    const available = tiles.filter((t) => !t.isBreaking);
    if (available.length === 0) return [];
    const rand = mulberry32(seed ^ 0x5eed);
    const chosen: TileClient[] = [];
    const minDist = 4.0; // pickups should be at least this far apart
    let attempts = 0;
    while (chosen.length < count && attempts < count * 30) {
      attempts++;
      const candidate = available[Math.floor(rand() * available.length)];
      if (!candidate) continue;
      const tooClose = chosen.some((c) => {
        const dx = c.mesh.position.x - candidate.mesh.position.x;
        const dz = c.mesh.position.z - candidate.mesh.position.z;
        return Math.sqrt(dx * dx + dz * dz) < minDist;
      });
      if (!tooClose) chosen.push(candidate);
    }
    // If we couldn't get enough spaced-out tiles, fill the rest randomly.
    while (chosen.length < count && available.length > chosen.length) {
      const candidate = available[Math.floor(rand() * available.length)];
      if (candidate && !chosen.includes(candidate)) chosen.push(candidate);
    }
    return chosen;
  }

  /**
   * Spawn the initial set of powerup pickups. Call AFTER the island is
   * generated. Idempotent — if a pickup with the same id already exists,
   * skip it (so re-running on a guest receiving init twice is safe).
   */
  function spawnPowerupPickups() {
    if (powerupPickups.length > 0) return; // already spawned
    const seedForPickups = (islandSeed ^ 0x7077) >>> 0;
    const chosenTiles = pickPowerupTiles(POWERUP_PICKUP_COUNT, seedForPickups);
    const rand = mulberry32(seedForPickups + 1);
    chosenTiles.forEach((tile, i) => {
      const type = POWERUP_TYPES[Math.floor(rand() * POWERUP_TYPES.length)];
      const id = `pu-${i}-${tile.id}`;
      createPowerupPickup(id, type, tile);
    });
    console.log('[ENGINE] Spawned', powerupPickups.length, 'powerup pickups');
  }

  function createPowerupPickup(id: string, type: string, tile: TileClient) {
    if (powerupPickupsById.has(id)) return;
    const color = POWERUP_COLORS[type] ?? 0xffffff;
    const pos = tile.mesh.position;
    const hover = pos.y + 1.2; // float above the tile

    // Inner icon — a spinning octahedron. Cheap and clearly visible.
    const geo = new THREE.OctahedronGeometry(POWERUP_PICKUP_RADIUS, 0);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color),
      emissiveIntensity: 1.0,
      roughness: 0.3,
      metalness: 0.4,
      transparent: true,
      opacity: 0.95,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, hover, pos.z);
    mesh.castShadow = settings.graphicsQuality === 'high';
    scene.add(mesh);

    // Halo — a flat translucent ring on the tile surface so the pickup is
    // visible from above even when the player is right on top of it.
    const haloGeo = new THREE.RingGeometry(POWERUP_PICKUP_RADIUS * 0.9, POWERUP_PICKUP_RADIUS * 1.6, 24);
    const haloMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    });
    const haloMesh = new THREE.Mesh(haloGeo, haloMat);
    haloMesh.rotation.x = -Math.PI / 2;
    haloMesh.position.set(pos.x, pos.y + TILE_HEIGHT / 2 + 0.05, pos.z);
    scene.add(haloMesh);

    const pickup: PowerupPickup = {
      id,
      type,
      tileId: tile.id,
      basePosition: new THREE.Vector3(pos.x, hover, pos.z),
      mesh,
      haloMesh,
      collected: false,
      respawnAt: 0,
      respawnCount: 0,
    };
    powerupPickups.push(pickup);
    powerupPickupsById.set(id, pickup);
  }

  /**
   * Per-frame update for pickups: spin, hover, check local-player collection,
   * and check timer-based respawns.
   *
   * Collection is detected ONLY for the local player on each peer — that peer
   * then broadcasts `powerup-collected` so everyone else hides the pickup.
   * Respawn is host-driven: when the host's respawn timer fires, the host
   * picks a NEW random tile for the pickup (not the original tile — so
   * players have to keep moving to collect), moves the pickup there, and
   * broadcasts `powerup-respawned` with the new tileId + position. Guests
   * just apply the host's choice. (Single-player mode acts as host.)
   */
  function updatePowerupPickups(dt: number, now: number) {
    // First: handle respawns (host drives the timer + new-tile selection for everyone).
    if (isHost || mode === 'single') {
      for (const p of powerupPickups) {
        if (p.collected && p.respawnAt > 0 && now >= p.respawnAt) {
          // Pick a NEW random available tile. We exclude the pickup's
          // current tileId so the pickup never respawns on the same spot —
          // players have to keep moving to collect, which keeps the game
          // dynamic. We also exclude tiles that are currently breaking or
          // already occupied by another visible pickup.
          const newTile = pickRandomAvailableTile(p.tileId, p.id, p.respawnCount + 1);
          if (!newTile) {
            // No available tile (island mostly destroyed) — try again later.
            p.respawnAt = now + 2000;
            continue;
          }
          movePickupToTile(p, newTile);
          p.collected = false;
          p.respawnAt = 0;
          p.respawnCount++;
          p.mesh.visible = true;
          p.haloMesh.visible = true;
          // Broadcast respawn (with the new tileId + position) to peers.
          if (netClient && mode !== 'single') {
            netClient.send({
              kind: 'powerup-respawned',
              powerupId: p.id,
              newTileId: newTile.id,
              position: { x: newTile.mesh.position.x, y: newTile.mesh.position.y + 1.2, z: newTile.mesh.position.z },
            });
          }
        }
      }
    }

    // Spin + hover all visible pickups, and check local-player collection.
    const localPlayer = players[localPlayerId];
    const localPos = ballRigidBody && !isSpectating
      ? ballRigidBody.translation()
      : null;
    for (const p of powerupPickups) {
      if (p.collected) continue;
      // Spin
      p.mesh.rotation.y += dt * 2.0;
      p.mesh.rotation.x += dt * 0.7;
      // Hover bob
      const bob = Math.sin(now * 0.003 + p.basePosition.x) * 0.15;
      p.mesh.position.y = p.basePosition.y + bob;
      // Pulse halo
      const pulse = 0.4 + 0.2 * (0.5 + 0.5 * Math.sin(now * 0.005));
      (p.haloMesh.material as THREE.MeshBasicMaterial).opacity = pulse;

      // Collision check with local player
      if (localPos && localPlayer && !localPlayer.eliminated && physicsEnabled) {
        const dx = localPos.x - p.basePosition.x;
        const dy = localPos.y - p.mesh.position.y;
        const dz = localPos.z - p.basePosition.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq < POWERUP_COLLECT_DISTANCE * POWERUP_COLLECT_DISTANCE) {
          collectPowerup(p);
        }
      }
    }
  }

  /**
   * Pick a random available tile for a respawn. Excludes the given tileId
   * (so the pickup doesn't respawn on its previous spot), tiles that are
   * currently breaking, and tiles already occupied by other VISIBLE pickups.
   *
   * The seed combines the island seed + the pickup's id hash + the respawn
   * count, so each respawn lands on a different tile (different seed each
   * time) and different pickups land on different tiles (different id hash).
   */
  function pickRandomAvailableTile(excludeTileId: string, pickupId: string, respawnCount: number): TileClient | null {
    const available = tiles.filter((t) => {
      if (t.isBreaking) return false;
      if (t.id === excludeTileId) return false;
      // Exclude tiles that currently host a visible (non-collected) pickup.
      for (const other of powerupPickups) {
        if (other.id === pickupId) continue;
        if (!other.collected && other.tileId === t.id) return false;
      }
      return true;
    });
    if (available.length === 0) return null;
    // Hash the pickup id into a number for the seed.
    let idHash = 0;
    for (let i = 0; i < pickupId.length; i++) {
      idHash = ((idHash << 5) - idHash + pickupId.charCodeAt(i)) | 0;
    }
    const seed = ((islandSeed ^ 0xfeedface) ^ (idHash >>> 0) ^ (respawnCount * 2654435761)) >>> 0;
    const rand = mulberry32(seed);
    // Try a few times to find a tile that's at least minDist away from other
    // visible pickups (so respawns spread out instead of clustering).
    const minDist = 3.0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = available[Math.floor(rand() * available.length)];
      if (!candidate) continue;
      const tooClose = powerupPickups.some((other) => {
        if (other.id === pickupId) return false;
        if (other.collected) return false;
        const dx = other.basePosition.x - candidate.mesh.position.x;
        const dz = other.basePosition.z - candidate.mesh.position.z;
        return Math.sqrt(dx * dx + dz * dz) < minDist;
      });
      if (!tooClose) return candidate;
    }
    // Fallback: just take the first available.
    return available[0] ?? null;
  }

  /**
   * Move a pickup's meshes + state to a new tile. Called by the host on
   * respawn, and by guests in response to a `powerup-respawned` message.
   */
  function movePickupToTile(p: PowerupPickup, tile: TileClient) {
    const pos = tile.mesh.position;
    const hover = pos.y + 1.2;
    p.tileId = tile.id;
    p.basePosition.set(pos.x, hover, pos.z);
    p.mesh.position.set(pos.x, hover, pos.z);
    p.haloMesh.position.set(pos.x, pos.y + TILE_HEIGHT / 2 + 0.05, pos.z);
  }

  /**
   * Collect a pickup: hide its meshes, activate the effect on the local
   * player, set the respawn timer, and broadcast the collection so peers
   * hide the pickup on their side too.
   */
  function collectPowerup(p: PowerupPickup) {
    if (p.collected) return;
    p.collected = true;
    p.respawnAt = performance.now() + POWERUP_RESPAWN_MS;
    p.mesh.visible = false;
    p.haloMesh.visible = false;
    // Apply the effect to the local collector.
    addPowerUp(p.type, POWERUP_DURATION_MS);
    createParticleEffect(p.basePosition, POWERUP_COLORS[p.type] ?? 0xffffff, 14);
    addScore(10);
    // Broadcast collection.
    if (netClient && mode !== 'single') {
      netClient.send({
        kind: 'powerup-collected',
        powerupId: p.id,
        playerId: localPlayerId,
        powerupType: p.type,
      });
    }
  }

  /** Remote peer collected a pickup — hide it on our side. */
  function handleRemotePowerupCollected(powerupId: string, playerId: string, powerupType: string) {
    const p = powerupPickupsById.get(powerupId);
    if (!p) return;
    // Only apply the effect locally if WE are the collector — otherwise just
    // hide the pickup. (The collector's own client already applied the effect
    // in collectPowerup above.)
    if (playerId !== localPlayerId) {
      // The remote player gets the effect on their own screen; we just hide
      // the pickup. (Remote players don't have visible powerup UI on our
      // screen anyway — the HUD only shows the local player's powerups.)
      p.collected = true;
      p.respawnAt = performance.now() + POWERUP_RESPAWN_MS;
      p.mesh.visible = false;
      p.haloMesh.visible = false;
    }
    void powerupType;
  }

  /**
   * Host broadcast a respawn — move the pickup to the new tile and show it.
   * The host already picked the new tile and sent us its id + position; we
   * just apply the move. (We don't re-pick — that would desync from the
   * host.)
   */
  function handleRemotePowerupRespawned(powerupId: string, newTileId: string, position: { x: number; y: number; z: number }) {
    const p = powerupPickupsById.get(powerupId);
    if (!p) return;
    // Look up the tile locally — if it's missing (guest hasn't generated it
    // yet, or it was destroyed), use the position the host sent us directly.
    const tile = tilesById.get(newTileId);
    if (tile && !tile.isBreaking) {
      movePickupToTile(p, tile);
    } else {
      // Tile not found locally — just move the meshes to the host-provided
      // position. We won't have a tileId we can use for the respawn-after-
      // tile-break check, but that's a corner case (the host already
      // validated the tile exists).
      p.tileId = newTileId;
      p.basePosition.set(position.x, position.y, position.z);
      p.mesh.position.set(position.x, position.y, position.z);
      // Best-effort halo position (we don't know the tile's surface Y, so
      // estimate from the pickup's hover offset).
      p.haloMesh.position.set(position.x, position.y - 1.2 + TILE_HEIGHT / 2 + 0.05, position.z);
    }
    p.collected = false;
    p.respawnAt = 0;
    p.mesh.visible = true;
    p.haloMesh.visible = true;
  }

  function spawnRandomPowerUp() {
    // Deprecated — kept as a no-op so the per-second survival tick (which
    // used to call this) still compiles. Powerups are now scattered on the
    // map as pickups — see spawnPowerupPickups / updatePowerupPickups.
    void 0;
  }

  function updatePowerUps(dt: number) {
    const now = performance.now();
    let changed = false;
    for (const [id, p] of Object.entries(powerUps)) {
      if (now - p.startTime > p.duration) {
        p.active = false;
        delete powerUps[id];
        changed = true;
      }
    }
    if (hasPowerUp('health_regen')) {
      playerHealth = Math.min(100, playerHealth + 4 * dt); // 4 hp/s
      changed = true;
    }
    if (changed) pushHud();
  }

  // Shared geometry for particles — one SphereGeometry reused by all particles
  // instead of creating a new one per particle (saves GPU memory and draw calls).
  const particleGeo = new THREE.SphereGeometry(0.1, 4, 4);
  const MAX_PARTICLES = 60;

  function createParticleEffect(pos: THREE.Vector3, color: number, count: number) {
    // Cap count to avoid particle explosion lag
    const clampedCount = Math.min(count, 8);
    for (let i = 0; i < clampedCount; i++) {
      // If we're at the particle limit, remove the oldest one
      if (particles.length >= MAX_PARTICLES) {
        const oldest = particles.shift();
        if (oldest) {
          scene.remove(oldest.mesh);
          (oldest.mesh.material as THREE.Material).dispose();
        }
      }
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
      const m = new THREE.Mesh(particleGeo, mat);
      m.position.copy(pos);
      m.position.add(new THREE.Vector3((Math.random() - 0.5) * 1.5, Math.random() * 1.5, (Math.random() - 0.5) * 1.5));
      const vel = new THREE.Vector3((Math.random() - 0.5) * 8, Math.random() * 8 + 4, (Math.random() - 0.5) * 8);
      const life = 0.6 + Math.random() * 0.3;
      particles.push({ mesh: m, vel, life, maxLife: life });
      scene.add(m);
    }
  }

  function updateParticles(dt: number) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        scene.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        // Don't dispose geometry — it's shared (particleGeo)
        particles.splice(i, 1);
        continue;
      }
      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.y -= 9.81 * dt;
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = p.life / p.maxLife;
    }
  }

  // ---------- Geometry creation ----------
  function createHexagonGeometry(radius = TILE_RADIUS, height = TILE_HEIGHT): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    const vertices: number[] = [];
    const indices: number[] = [];
    const angle = Math.PI / 3;
    for (let i = 0; i < 6; i++) {
      const x = radius * Math.cos(i * angle);
      const z = radius * Math.sin(i * angle);
      vertices.push(x, height / 2, z);
    }
    for (let i = 0; i < 6; i++) {
      const x = radius * Math.cos(i * angle);
      const z = radius * Math.sin(i * angle);
      vertices.push(x, -height / 2, z);
    }
    vertices.push(0, height / 2, 0);
    vertices.push(0, -height / 2, 0);
    for (let i = 0; i < 6; i++) indices.push(12, i, (i + 1) % 6);
    for (let i = 0; i < 6; i++) indices.push(13, 6 + ((i + 1) % 6), 6 + i);
    for (let i = 0; i < 6; i++) {
      const next = (i + 1) % 6;
      indices.push(i, next, 6 + i);
      indices.push(next, 6 + next, 6 + i);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  // Shared tile geometries — one per tile type (ground vs wall), reused by
  // ALL tiles of that type instead of creating a new geometry per tile.
  // This is a major memory + draw-call optimization with hundreds of tiles.
  const groundTileGeo = createHexagonGeometry(TILE_RADIUS, TILE_HEIGHT);
  const wallTileGeo = createHexagonGeometry(TILE_RADIUS, 3.0);

  function createTile(pos: { x: number; y: number; z: number }, id: string) {
    if (tilesById.has(id)) return; // dedupe — stable IDs mean this can be called twice in multiplayer

    // Wall tiles (IDs start with "w-") are taller, have a stone color,
    // and are much harder to break than regular ground tiles.
    const isWall = id.startsWith('w-');
    const tileHeight = isWall ? 3.0 : TILE_HEIGHT;
    const tileHealth = isWall ? 500 : TILE_MAX_HEALTH;

    // Reuse shared geometry for all tiles of the same type
    const geo = isWall ? wallTileGeo : groundTileGeo;
    // Colour by type and height.
    const baseColor = new THREE.Color();
    if (isWall) {
      baseColor.setHSL(0.06, 0.12, 0.38); // dark stone grey for walls
    } else {
      const heightFactor = Math.min(1, pos.y / 3.5);
      if (heightFactor < 0.25) {
        baseColor.setHSL(0.12, 0.55, 0.62); // warm sand
      } else if (heightFactor < 0.55) {
        baseColor.setHSL(0.33, 0.65, 0.42); // grass green
      } else {
        baseColor.setHSL(0.08, 0.15, 0.45); // rock grey-brown
      }
    }
    // Use MeshLambertMaterial instead of MeshStandardMaterial for tiles —
    // much cheaper per-pixel shading, big FPS win with hundreds of tiles.
    const mat = new THREE.MeshLambertMaterial({
      color: baseColor.clone(),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1,
      emissive: baseColor.clone(),
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    scene.add(mesh);

    let rigidBody: RAPIER.RigidBody | undefined;
    let collider: RAPIER.Collider | undefined;
    try {
      // Use a cuboid collider for the tile — much faster than a convex hull
      // and close enough for a small hex. Wall tiles use a taller collider.
      const desc = RAPIER.ColliderDesc.cuboid(TILE_RADIUS * 0.9, tileHeight / 2, TILE_RADIUS * 0.866)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(ALL_INTERACTION | PLAYER_COLLISION_GROUP)
        .setSolverGroups(ALL_INTERACTION | PLAYER_COLLISION_GROUP);
      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z);
      rigidBody = world.createRigidBody(bodyDesc);
      collider = world.createCollider(desc, rigidBody);
    } catch (e) {
      console.error('Failed to create tile physics', e);
    }
    const tile: TileClient = {
      id,
      mesh,
      rigidBody,
      collider,
      health: tileHealth,
      maxHealth: tileHealth,
      isBreaking: false,
      baseColor,
    };
    tiles.push(tile);
    tilesById.set(id, tile);
  }

  /** Update a tile's colour to reflect its current health (green → yellow → red). */
  function updateTileColor(tile: TileClient) {
    const pct = Math.max(0, tile.health / tile.maxHealth);
    const mat = tile.mesh.material as THREE.MeshLambertMaterial;
    // Hue from 0.33 (green) at full health → 0.0 (red) at zero.
    const hue = pct * 0.33;
    // Darken slightly as the tile gets damaged.
    const lightness = 0.42 + pct * 0.12;
    mat.color.setHSL(hue, 0.7, lightness);
    mat.emissive.setHSL(hue, 0.7, 0.08 + (1 - pct) * 0.15);
  }

  function applyTileDamage(tile: TileClient, damage: number) {
    if (tile.isBreaking || damage <= 0) return;
    tile.health -= damage;
    updateTileColor(tile);
    if (tile.health <= 0) {
      breakTile(tile);
    }
  }

  /**
   * Damage all tiles within `radius` of `point`. Damage falls off linearly
   * from the centre to the edge of the blast radius.
   */
  function damageTilesAt(point: THREE.Vector3, radius: number, damage: number, sourcePeer: string | null) {
    const damaged: { tile: TileClient; amount: number }[] = [];
    for (const tile of tiles) {
      if (tile.isBreaking) continue;
      const dx = tile.mesh.position.x - point.x;
      const dz = tile.mesh.position.z - point.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > radius) continue;
      const falloff = 1 - (dist / radius);
      const amount = damage * falloff;
      if (amount > 0.5) {
        applyTileDamage(tile, amount);
        damaged.push({ tile, amount });
      }
    }
    // If this impact came from the local player, broadcast damage to peers
    // so they apply the same damage to their copy of the island.
    if (sourcePeer === null && netClient && mode !== 'single' && damaged.length > 0) {
      for (const { tile, amount } of damaged) {
        netClient.send({ kind: 'damage-tile', tileId: tile.id, damage: amount });
      }
    }
    if (damaged.length > 0) {
      playSound(breakSound, 0.3 + Math.min(0.4, damage / 100));
      addScore(damaged.length);
    }
  }

  function breakTile(tile: TileClient) {
    if (tile.isBreaking) return;
    tile.isBreaking = true;
    // NOTE: We intentionally do NOT set canJump=true here.
    // The old code granted an airborne jump whenever ANY tile broke,
    // which let players jump in mid-air when a tile they were standing
    // on was destroyed by a weapon. Jump eligibility is correctly
    // determined by getContactedTile() in the physics step — a player
    // is only "grounded" when they are physically touching a tile.
    try {
      if (tile.collider) world.removeCollider(tile.collider, false);
    } catch {
      /* ignore */
    }
    playSound(breakSound, 0.6);
    createParticleEffect(tile.mesh.position, tile.baseColor.getHex(), 14);
    addScore(5);
    const mat = tile.mesh.material as THREE.MeshStandardMaterial;
    const startY = tile.mesh.position.y;
    const tw = new Tween({ opacity: 1, y: startY })
      .to({ opacity: 0, y: startY - 1.5 }, 600)
      .easing(Easing.Quadratic.InOut)
      .onUpdate(({ opacity, y }) => {
        mat.opacity = opacity;
        tile.mesh.position.y = y;
      })
      .onComplete(() => {
        scene.remove(tile.mesh);
        mat.dispose();
        tile.mesh.geometry.dispose();
        try {
          if (tile.rigidBody) world.removeRigidBody(tile.rigidBody);
        } catch {
          /* ignore */
        }
        const idx = tiles.indexOf(tile);
        if (idx >= 0) tiles.splice(idx, 1);
        tilesById.delete(tile.id);
      });
    tweenGroup.add(tw);
    tw.start();
  }

  /**
   * Generate distributed spawn positions around the island center.
   * Players are placed in a circle with random offsets so they don't
   * overlap at the start. The host uses the same seed for all peers
   * so positions are deterministic across the network.
   */
  function getDistributedSpawns(
    center: { x: number; y: number; z: number },
    count: number,
    radius: number = 3,
  ): { x: number; y: number; z: number }[] {
    if (count <= 0) return [];
    if (count === 1) return [center];
    const positions: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < count; i++) {
      const angle = (2 * Math.PI * i) / count;
      const jitterX = (Math.random() - 0.5) * 0.5;
      const jitterZ = (Math.random() - 0.5) * 0.5;
      positions.push({
        x: center.x + Math.cos(angle) * radius + jitterX,
        y: center.y,
        z: center.z + Math.sin(angle) * radius + jitterZ,
      });
    }
    return positions;
  }

  function createSphere(id: string, pos: { x: number; y: number; z: number }, isLocal: boolean) {
    if (players[id]) return;
    const color = id === localPlayerId ? 0xff5252 : PLAYER_COLORS[Object.keys(players).length % PLAYER_COLORS.length];
    const geo = new THREE.SphereGeometry(PLAYER_RADIUS, 12, 12);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3, emissive: new THREE.Color(color), emissiveIntensity: 0.2 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = settings.graphicsQuality === 'high';
    mesh.position.set(pos.x, pos.y, pos.z);
    scene.add(mesh);

    // Player name label (Minecraft-style, above head)
    // Added directly to the scene (NOT as a child of the mesh) so it stays
    // upright and doesn't orbit with the ball's rotation. Position is updated
    // in interpolateRemotePlayers().
    const nameDiv = document.createElement('div');
    nameDiv.className = 'player-name-label';
    nameDiv.textContent = id.length > 10 ? id.slice(0, 10) + '...' : id;
    nameDiv.style.cssText = 'background: rgba(0,0,0,0.6); color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-family: monospace; white-space: nowrap; text-align: center; pointer-events: none; user-select: none;';
    const nameLabel = new CSS2DObject(nameDiv);
    nameLabel.position.set(pos.x, pos.y + PLAYER_RADIUS + 0.6, pos.z);
    scene.add(nameLabel);

    // Weapon group for this player (visible on remote players)
    // Added directly to the scene (NOT as a child of the mesh) so it doesn't
    // orbit with the ball's rotation. The weapon is positioned ABOVE the ball
    // (not on its surface) and rotated to face the player's aiming direction
    // (targetAzimuth). Updated every frame in interpolateRemotePlayers().
    const weaponGroup = new THREE.Group();
    // Initial position: above the ball center, offset forward (negative Z)
    const weaponHeight = PLAYER_RADIUS + 0.35; // well above the ball surface
    const weaponForward = 0.4;  // how far in front of the ball center
    const weaponSide = 0.25;    // slight offset to the right
    weaponGroup.position.set(
      pos.x + weaponSide,
      pos.y + weaponHeight,
      pos.z - weaponForward,
    );
    scene.add(weaponGroup);

    // Muzzle flash light — also scene-level, positioned relative to the weapon
    const muzzleFlash = new THREE.PointLight(0xffaa00, 0, 5);
    muzzleFlash.position.set(pos.x + weaponSide, pos.y + weaponHeight, pos.z - weaponForward - 0.5);
    scene.add(muzzleFlash);

    // Build a simple weapon mesh for remote players
    const remoteWeaponMesh = buildWeaponMesh('ak47');
    weaponGroup.add(remoteWeaponMesh);

    let rigidBody: RAPIER.RigidBody | undefined;
    let collider: RAPIER.Collider | undefined;
    try {
      if (isLocal) {
        const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(pos.x, pos.y, pos.z)
          .setLinearDamping(0.3);
        rigidBody = world.createRigidBody(bodyDesc);
        const cd = RAPIER.ColliderDesc.ball(PLAYER_RADIUS)
          .setRestitution(0.6)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
          .setCollisionGroups(PLAYER_COLLISION_GROUP | ALL_INTERACTION)
          .setSolverGroups(PLAYER_COLLISION_GROUP | ALL_INTERACTION);
        collider = world.createCollider(cd, rigidBody);
        ballRigidBody = rigidBody;
        ballCollider = collider;
        ballRigidBody.setEnabled(false);
      } else {
        const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z);
        rigidBody = world.createRigidBody(bodyDesc);
        const cd = RAPIER.ColliderDesc.ball(PLAYER_RADIUS)
          .setRestitution(0.6)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
          .setCollisionGroups(PLAYER_COLLISION_GROUP | ALL_INTERACTION)
          .setSolverGroups(PLAYER_COLLISION_GROUP | ALL_INTERACTION);
        collider = world.createCollider(cd, rigidBody);
      }
      if (collider) colliderHandleToPlayerId[collider.handle] = id;
    } catch (e) {
      console.error('Failed to create sphere physics', e);
    }
    players[id] = { id, mesh, rigidBody, collider, eliminated: false, color, targetPosition: pos, targetRotation: { x: 0, y: 0, z: 0, w: 1 }, targetAzimuth: 0, nameLabel, weaponGroup, muzzleFlash };
    pushHud();
  }

  /** Build a detailed geometric weapon mesh with animation groups.
   *  Parts that animate during reload (magazine, slide/bolt) are stored as
   *  named children so updateFpsWeapon can find and animate them. */
  function buildWeaponMesh(type: WeaponType): THREE.Group {
    const group = new THREE.Group();
    if (type === 'ak47') {
      const gunMetal = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.4, metalness: 0.5 });
      const darkMetal = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.45, metalness: 0.45 });
      const wood = new THREE.MeshStandardMaterial({ color: 0x8B5A2B, roughness: 0.65, metalness: 0.0 });
      const brass = new THREE.MeshStandardMaterial({ color: 0xb8860b, roughness: 0.35, metalness: 0.5 });
      const orangeTip = new THREE.MeshStandardMaterial({ color: 0xff6600, roughness: 0.5, metalness: 0.1, emissive: new THREE.Color(0xff6600), emissiveIntensity: 0.5 });

      // Barrel
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.018, 0.55, 8), darkMetal);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.01, -0.38);
      group.add(barrel);
      // Muzzle tip
      const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.05, 8), orangeTip);
      muzzle.rotation.x = Math.PI / 2;
      muzzle.position.set(0, 0.01, -0.66);
      group.add(muzzle);
      // Receiver body
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.06, 0.28), gunMetal);
      body.position.set(0, 0, 0.0);
      group.add(body);
      // Dust cover (top) — part of the bolt carrier group, animates on rack
      const dustCover = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.015, 0.18), darkMetal);
      dustCover.position.set(0, 0.037, -0.03);
      dustCover.name = 'slide';
      group.add(dustCover);
      // Wooden handguard
      const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.04, 0.18), wood);
      handguard.position.set(0, -0.01, -0.18);
      group.add(handguard);
      // Stock
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.055, 0.22), wood);
      stock.position.set(0, -0.01, 0.24);
      group.add(stock);
      // Butt plate
      const butt = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.06, 0.02), darkMetal);
      butt.position.set(0, -0.01, 0.35);
      group.add(butt);
      // Magazine (curved AK mag) — animates during reload
      const magGroup = new THREE.Group();
      magGroup.name = 'magazine';
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.13, 0.055), brass);
      mag.position.set(0, -0.09, 0.02);
      mag.rotation.x = 0.2;
      magGroup.add(mag);
      // Magazine base plate
      const magBase = new THREE.Mesh(new THREE.BoxGeometry(0.037, 0.012, 0.02), darkMetal);
      magBase.position.set(0, -0.155, 0.05);
      magBase.rotation.x = 0.2;
      magGroup.add(magBase);
      group.add(magGroup);
      // Pistol grip
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.035), darkMetal);
      grip.position.set(0, -0.06, 0.12);
      grip.rotation.x = 0.3;
      group.add(grip);
      // Gas tube (above barrel)
      const gasTube = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.2, 6), darkMetal);
      gasTube.rotation.x = Math.PI / 2;
      gasTube.position.set(0, 0.025, -0.2);
      group.add(gasTube);
      // Front sight post
      const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.025, 0.004), darkMetal);
      frontSight.position.set(0, 0.04, -0.44);
      group.add(frontSight);
      // Rear sight
      const rearSight = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.02, 0.006), darkMetal);
      rearSight.position.set(0, 0.04, -0.05);
      group.add(rearSight);
    } else {
      // Desert Eagle - big chrome pistol
      const chrome = new THREE.MeshStandardMaterial({ color: 0xd0d0d0, roughness: 0.2, metalness: 0.5 });
      const darkSteel = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.4, metalness: 0.45 });
      const blackGrip = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.8, metalness: 0.0 });
      const goldAccent = new THREE.MeshStandardMaterial({ color: 0xdaa520, roughness: 0.25, metalness: 0.5, emissive: new THREE.Color(0xdaa520), emissiveIntensity: 0.3 });
      const orangeTip = new THREE.MeshStandardMaterial({ color: 0xff6600, roughness: 0.5, metalness: 0.1, emissive: new THREE.Color(0xff6600), emissiveIntensity: 0.5 });

      // Barrel (thick, iconic DEagle)
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.32, 8), chrome);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(0, 0.015, -0.22);
      group.add(barrel);
      // Muzzle brake
      const muzzleBrake = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.014, 0.06, 8), darkSteel);
      muzzleBrake.rotation.x = Math.PI / 2;
      muzzleBrake.position.set(0, 0.015, -0.40);
      group.add(muzzleBrake);
      // Muzzle tip
      const muzzleTip = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.018, 0.02, 8), orangeTip);
      muzzleTip.rotation.x = Math.PI / 2;
      muzzleTip.position.set(0, 0.015, -0.43);
      group.add(muzzleTip);
      // Slide (top part, chrome) — animates during reload (racks back)
      const slideGroup = new THREE.Group();
      slideGroup.name = 'slide';
      const slide = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.04, 0.28), chrome);
      slide.position.set(0, 0.01, -0.04);
      slideGroup.add(slide);
      // Gold accent line on slide
      const accentLine = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.005, 0.04), goldAccent);
      accentLine.position.set(0, 0.032, -0.04);
      slideGroup.add(accentLine);
      // Front sight on slide
      const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.018, 0.004), darkSteel);
      frontSight.position.set(0, 0.035, -0.18);
      slideGroup.add(frontSight);
      // Rear sight on slide
      const rearSight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.015, 0.006), darkSteel);
      rearSight.position.set(0, 0.035, 0.08);
      slideGroup.add(rearSight);
      group.add(slideGroup);
      // Frame (lower receiver)
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.025, 0.16), darkSteel);
      frame.position.set(0, -0.015, 0.02);
      group.add(frame);
      // Trigger guard
      const triggerGuard = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.025, 0.05), darkSteel);
      triggerGuard.position.set(0, -0.035, 0.05);
      group.add(triggerGuard);
      // Magazine well + mag — animates during reload
      const magGroup = new THREE.Group();
      magGroup.name = 'magazine';
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.055, 0.038), darkSteel);
      mag.position.set(0, -0.05, 0.02);
      magGroup.add(mag);
      // Magazine base plate
      const magBase = new THREE.Mesh(new THREE.BoxGeometry(0.037, 0.008, 0.006), chrome);
      magBase.position.set(0, -0.08, 0.02);
      magGroup.add(magBase);
      group.add(magGroup);
      // Grip (black rubberized)
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.09, 0.04), blackGrip);
      grip.position.set(0, -0.06, 0.09);
      grip.rotation.x = 0.25;
      group.add(grip);
      // Grip gold insert
      const gripInsert = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.03, 0.005), goldAccent);
      gripInsert.position.set(0, -0.06, 0.07);
      gripInsert.rotation.x = 0.25;
      group.add(gripInsert);
      // Barrel wedge (distinctive DE top rail)
      const topRail = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.008, 0.12), chrome);
      topRail.position.set(0, 0.038, -0.12);
      group.add(topRail);
    }
    return group;
  }

  // ---------- FPS Weapon View Model ----------
  // A separate scene rendered on top for the first-person weapon
  const fpsWeaponScene = new THREE.Scene();
  const fpsWeaponCamera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 10);
  fpsWeaponCamera.position.set(0, 0, 0);
  const fpsAmbient = new THREE.AmbientLight(0xffffff, 1.8);
  fpsWeaponScene.add(fpsAmbient);
  const fpsDirLight = new THREE.DirectionalLight(0xffe4b5, 2.0);
  fpsDirLight.position.set(1, 2, 1);
  fpsWeaponScene.add(fpsDirLight);
  const fpsFillLight = new THREE.DirectionalLight(0xaabbff, 0.8);
  fpsFillLight.position.set(-2, 0, 1);
  fpsWeaponScene.add(fpsFillLight);

  let fpsWeaponGroup = new THREE.Group();
  fpsWeaponScene.add(fpsWeaponGroup);
  let currentFpsWeaponMesh: THREE.Group | null = null;

  function setFpsWeapon(type: WeaponType) {
    if (currentFpsWeaponMesh) {
      fpsWeaponGroup.remove(currentFpsWeaponMesh);
    }
    currentFpsWeaponMesh = buildWeaponMesh(type);
    // Scale up for first-person view
    currentFpsWeaponMesh.scale.set(2.5, 2.5, 2.5);
    fpsWeaponGroup.add(currentFpsWeaponMesh);
  }
  setFpsWeapon('ak47');

  // ---------- Shooting System ----------
  function handleShooting(dt: number) {
    if (!ballRigidBody || isSpectating || !physicsEnabled || isPaused) return;

    const wdef = WEAPONS[currentWeapon];
    const now = performance.now();

    // Handle reload
    if (isReloading) {
      if (now - reloadStartTime >= wdef.reloadTime * 1000) {
        isReloading = false;
        // Refill magazine from reserve ammo
        const needed = wdef.maxAmmo - ammo;
        const toLoad = Math.min(needed, reserveAmmo);
        ammo += toLoad;
        reserveAmmo -= toLoad;
        // Keep per-weapon state in sync
        weaponAmmoState[currentWeapon] = { ammo, reserveAmmo };
        pushHud();
      }
      return;
    }

    // Handle weapon switch
    if (isSwitchingWeapon) {
      if (now - weaponSwitchStartTime >= WEAPON_SWITCH_TIME * 1000) {
        isSwitchingWeapon = false;
        if (pendingWeapon) {
          // Save current weapon's ammo state before switching
          weaponAmmoState[currentWeapon] = { ammo, reserveAmmo };
          currentWeapon = pendingWeapon;
          pendingWeapon = null;
          // Restore the new weapon's saved ammo state
          const saved = weaponAmmoState[currentWeapon];
          ammo = saved.ammo;
          reserveAmmo = saved.reserveAmmo;
          isReloading = false;
          setFpsWeapon(currentWeapon);
          // Update remote weapon mesh too
          const lp = players[localPlayerId];
          if (lp?.weaponGroup) {
            while (lp.weaponGroup.children.length > 0) {
              lp.weaponGroup.remove(lp.weaponGroup.children[0]);
            }
            lp.weaponGroup.add(buildWeaponMesh(currentWeapon));
          }
        }
        pushHud();
      }
      return;
    }

    // Auto-reload when empty (if we have reserve ammo)
    if (ammo <= 0 && isFiring) {
      if (reserveAmmo > 0) {
        startReload();
      }
      return;
    }

    // Fire
    if (isFiring && ammo > 0) {
      const fireInterval = 1000 / wdef.fireRate;
      if (now - lastFireTime >= fireInterval) {
        lastFireTime = now;
        fire();
      }
    }
  }

  function fire() {
    if (!ballRigidBody) return;
    const wdef = WEAPONS[currentWeapon];
    ammo--;
    weaponRecoilOffset = 0.1;
    // Keep per-weapon state in sync
    weaponAmmoState[currentWeapon] = { ammo, reserveAmmo };

    // Camera recoil — push the view up and slightly sideways
    // AK-47: moderate kick per shot, fires fast so it stacks
    // Desert Eagle: heavy kick per shot, fires slow
    const isAk = currentWeapon === 'ak47';
    const pitchRecoil = isAk ? 0.012 : 0.035; // radians upward
    const yawRecoil = (Math.random() - 0.5) * (isAk ? 0.008 : 0.02); // random sideways
    cameraPitch += pitchRecoil;
    cameraAzimuth += yawRecoil;

    // Play firing sound
    playFireSound();

    // Eject shell casing
    ejectShell();

    // Muzzle flash
    muzzleFlashTimer = 50; // ms

    // Calculate shot direction from camera
    const pos = ballRigidBody.translation();
    const direction = new THREE.Vector3(0, 0, -1);
    // Apply camera azimuth and pitch — negate azimuth to match camera convention
    const euler = new THREE.Euler(cameraPitch, -cameraAzimuth, 0, 'YXZ');
    direction.applyEuler(euler);

    // Add spread
    const spreadX = (Math.random() - 0.5) * wdef.spread;
    const spreadY = (Math.random() - 0.5) * wdef.spread;
    direction.x += spreadX;
    direction.y += spreadY;
    direction.normalize();

    // Raycaster origin for hit detection
    const rayOrigin = new THREE.Vector3(pos.x, pos.y + 0.8, pos.z); // eye level

    // Check hits against other players
    let hitPlayer: PlayerClient | null = null;
    let hitDistance = wdef.range;

    for (const [id, p] of Object.entries(players)) {
      if (id === localPlayerId || p.eliminated) continue;
      // Simple sphere-ray intersection
      const playerPos = new THREE.Vector3(p.mesh.position.x, p.mesh.position.y, p.mesh.position.z);
      const toPlayer = playerPos.clone().sub(rayOrigin);
      const projLen = toPlayer.dot(direction);
      if (projLen < 0 || projLen > wdef.range) continue;
      const closestPoint = rayOrigin.clone().add(direction.clone().multiplyScalar(projLen));
      const distToCenter = closestPoint.distanceTo(playerPos);
      if (distToCenter < PLAYER_RADIUS && projLen < hitDistance) {
        hitPlayer = p;
        hitDistance = projLen;
      }
    }

    if (hitPlayer) {
      const hitId = hitPlayer.id;

      // Apply health damage to the hit player
      if (mode === 'single') {
        // Single player: we're authoritative — apply damage directly
        applyDamageToRemotePlayer(hitId, wdef.damage);
      } else if (isHost) {
        // Host is authoritative for damage — apply locally
        applyDamageToRemotePlayer(hitId, wdef.damage);
      }
      // Guest: damage is applied when the host's player-hit broadcast
      // arrives (the host re-broadcasts with damage after computing it).
      // We include damage in our message so the host can use it.

      // Deal knockback impulse to hit player
      const knockbackDir = direction.clone().multiplyScalar(wdef.knockback);
      knockbackDir.y = Math.max(knockbackDir.y, 2.0); // minimum upward impulse

      if (netClient && mode !== 'single') {
        // Include damage in the network message so the host/target can apply it
        netClient.send({ kind: 'player-hit', targetId: hitId, impulse: { x: knockbackDir.x, y: knockbackDir.y, z: knockbackDir.z }, damage: wdef.damage });
      } else if (hitPlayer.rigidBody && mode === 'single') {
        try { hitPlayer.rigidBody.applyImpulse({ x: knockbackDir.x, y: knockbackDir.y, z: knockbackDir.z }, true); } catch { /* ignore */ }
      }

      // Hit effect
      createParticleEffect(hitPlayer.mesh.position.clone().add(new THREE.Vector3(0, 0.5, 0)), 0xff0000, 6);
      addScore(25);
    }

    // Hit particles at impact point or end of range
    const impactPoint = rayOrigin.clone().add(direction.clone().multiplyScalar(hitDistance));
    if (!hitPlayer) {
      createParticleEffect(impactPoint, 0xffaa00, 3);
    }

    // Weapon damage to tiles — raycast against tile positions to find what
    // the bullet hit. Deals damage in a small radius at the impact point.
    // Tiles take MORE damage than players (2.5× multiplier) so weapons feel
    // destructive and the island crumbles quickly under sustained fire.
    //   - AK-47: rapid chipping (low per-shot, high rate → many broken tiles)
    //   - Desert Eagle: big per-shot crater (high damage, large radius)
    {
      const tileDamage = wdef.damage * 2.5; // tiles are softer than players
      const tileDamageRadius = isAk ? 1.1 : 1.6; // desert eagle has bigger blast
      // Find the closest tile along the ray
      let closestTileDist = hitDistance; // don't shoot through players
      let closestTile: TileClient | null = null;
      for (const tile of tiles) {
        if (tile.isBreaking) continue;
        const tilePos = tile.mesh.position;
        const toTile = new THREE.Vector3(tilePos.x - rayOrigin.x, tilePos.y - rayOrigin.y, tilePos.z - rayOrigin.z);
        const projLen = toTile.dot(direction);
        if (projLen < 0 || projLen > closestTileDist) continue;
        const closestPoint = rayOrigin.clone().add(direction.clone().multiplyScalar(projLen));
        const distToCenter = closestPoint.distanceTo(tilePos);
        // Hex tile has radius ~0.6, height ~0.5 (walls 3.0). Use a generous
        // hit radius so bullets hit tiles reliably.
        const hitRadius = tilePos.y > 2 ? 1.4 : 1.0; // walls are taller → easier to hit
        if (distToCenter < hitRadius && projLen < closestTileDist) {
          closestTileDist = projLen;
          closestTile = tile;
        }
      }
      if (closestTile) {
        const impactPos = rayOrigin.clone().add(direction.clone().multiplyScalar(closestTileDist));
        damageTilesAt(impactPos, tileDamageRadius, tileDamage, null);
      }
    }

    // Broadcast shot
    if (netClient && mode !== 'single') {
      netClient.send({
        kind: 'player-shot',
        id: localPlayerId,
        weapon: currentWeapon,
        direction: { x: direction.x, y: direction.y, z: direction.z },
        origin: { x: rayOrigin.x, y: rayOrigin.y, z: rayOrigin.z },
      });
    }

    // Play collision sound as gunshot substitute
    playSound(collisionSound, 0.5);
    pushHud();
  }

  function startReload() {
    if (isReloading || isSwitchingWeapon) return;
    const wdef = WEAPONS[currentWeapon];
    if (ammo >= wdef.maxAmmo) return; // magazine already full
    if (reserveAmmo <= 0) return; // no reserve ammo to reload with
    isReloading = true;
    reloadStartTime = performance.now();
    playReloadSound();
    pushHud();
  }

  function switchWeapon(weapon: WeaponType) {
    if (weapon === currentWeapon || isSwitchingWeapon || isReloading) return;
    isSwitchingWeapon = true;
    weaponSwitchStartTime = performance.now();
    pendingWeapon = weapon;
    pushHud();
  }

  // Shell ejection particles — brass casings that fly out of the weapon
  const shellParticles: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; maxLife: number }[] = [];
  const shellGeo = new THREE.CylinderGeometry(0.003, 0.003, 0.015, 4);
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xd4a017, metalness: 0.9, roughness: 0.2 });

  function ejectShell() {
    if (!currentFpsWeaponMesh || shellParticles.length >= 8) return;
    const isAk = currentWeapon === 'ak47';
    const shell = new THREE.Mesh(shellGeo, shellMat);
    // Start from ejection port position (right side of receiver)
    const ejectX = 0.25 + (isAk ? 0.02 : 0.01);
    const ejectY = -0.15;
    const ejectZ = -0.25;
    shell.position.set(ejectX, ejectY, ejectZ);
    // Random rotation for tumbling brass
    shell.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    // Velocity: right and slightly up + back
    const vel = new THREE.Vector3(
      0.8 + Math.random() * 0.5,
      0.3 + Math.random() * 0.3,
      -0.2 + Math.random() * 0.2
    );
    const life = 0.8 + Math.random() * 0.4;
    shellParticles.push({ mesh: shell, vel, life, maxLife: life });
    fpsWeaponScene.add(shell);
  }

  function updateFpsWeapon(dt: number) {
    if (isSpectating) {
      fpsWeaponScene.visible = false;
      return;
    }
    fpsWeaponScene.visible = true;

    // Weapon position
    const bobSpeed = 8;
    const bobAmount = 0.02;
    const isMoving = keys.w || keys.a || keys.s || keys.d || Math.abs(joystickX) > 0.15 || Math.abs(joystickY) > 0.15;

    if (isMoving && physicsEnabled) {
      weaponBobTime += dt * bobSpeed;
    } else {
      weaponBobTime += dt * 1.5;
    }

    const bobX = Math.sin(weaponBobTime) * (isMoving ? bobAmount * 3 : bobAmount);
    const bobY = Math.abs(Math.cos(weaponBobTime)) * (isMoving ? bobAmount * 2 : bobAmount * 0.5);

    // Recoil recovery
    weaponRecoilOffset *= 0.85;

    // Position weapon in front of camera
    fpsWeaponGroup.position.set(
      0.25 + bobX,
      -0.2 + bobY,
      -0.4 + weaponRecoilOffset
    );

    // Default rotation reset
    fpsWeaponGroup.rotation.x = 0;
    fpsWeaponGroup.rotation.z = 0;

    // ---- Per-part weapon animations ----
    // Find animated parts in the weapon mesh
    let magPart: THREE.Group | null = null;
    let slidePart: THREE.Object3D | null = null;
    if (currentFpsWeaponMesh) {
      // Use type assertion since traverse callback makes TS lose narrowing
      const foundParts = { mag: null as THREE.Group | null, slide: null as THREE.Object3D | null };
      currentFpsWeaponMesh.traverse((child) => {
        if (child.name === 'magazine' && child instanceof THREE.Group) foundParts.mag = child;
        if (child.name === 'slide') foundParts.slide = child;
      });
      magPart = foundParts.mag;
      slidePart = foundParts.slide;
    }

    // Weapon switch animation (lower weapon)
    if (isSwitchingWeapon) {
      const progress = (performance.now() - weaponSwitchStartTime) / (WEAPON_SWITCH_TIME * 1000);
      if (progress < 0.5) {
        fpsWeaponGroup.position.y -= progress * 0.8;
      } else {
        fpsWeaponGroup.position.y -= (1 - progress) * 0.8;
      }
    }

    // Fire recoil per-part animation — slide/bolt kicks back briefly
    if (weaponRecoilOffset > 0.02 && slidePart) {
      // Slide/bolt kicks back with recoil
      const isAk = currentWeapon === 'ak47';
      const slideOffset = isAk ? -weaponRecoilOffset * 0.8 : -weaponRecoilOffset * 0.6;
      slidePart!.position.z = slideOffset * 2.5; // scale with FPS weapon scale
    } else if (slidePart) {
      // Return slide to original position
      slidePart!.position.z *= 0.85;
    }

    // Reload animation — magazine drops out, new mag in, slide/bolt racks
    if (isReloading && magPart) {
      const wdef = WEAPONS[currentWeapon];
      const progress = Math.min(1, (performance.now() - reloadStartTime) / (wdef.reloadTime * 1000));
      const isAk = currentWeapon === 'ak47';

      if (progress < 0.3) {
        // Phase 1: Tilt weapon slightly, magazine starts to drop
        const t = progress / 0.3;
        fpsWeaponGroup.rotation.z = t * 0.4;
        fpsWeaponGroup.rotation.x = t * 0.3;
        fpsWeaponGroup.position.y -= t * 0.15;
        // Magazine drops down
        if (magPart) {
          magPart.position.y = -t * 0.15;
        }
      } else if (progress < 0.5) {
        // Phase 2: Magazine fully out, pause
        fpsWeaponGroup.rotation.z = 0.4;
        fpsWeaponGroup.rotation.x = 0.3;
        fpsWeaponGroup.position.y -= 0.15;
        if (magPart) {
          magPart.position.y = -0.15;
        }
      } else if (progress < 0.7) {
        // Phase 3: New magazine slides in, weapon straightens
        const t = (progress - 0.5) / 0.2;
        fpsWeaponGroup.rotation.z = 0.4 * (1 - t);
        fpsWeaponGroup.rotation.x = 0.3 * (1 - t);
        fpsWeaponGroup.position.y -= 0.15 * (1 - t);
        // Magazine rises back up
        if (magPart) {
          magPart.position.y = -0.15 * (1 - t);
        }
      } else {
        // Phase 4: Slide/bolt rack — pull back then release
        fpsWeaponGroup.rotation.z = 0;
        fpsWeaponGroup.rotation.x = 0;
        const t = (progress - 0.7) / 0.3;
        if (slidePart) {
          const isAkGun = currentWeapon === 'ak47';
          const rackDist = isAkGun ? 0.08 : 0.06;
          if (t < 0.5) {
            // Pull slide/bolt back
            slidePart.position.z = t * 2 * rackDist;
          } else {
            // Release slide/bolt forward (spring snap)
            slidePart.position.z = rackDist * (1 - (t - 0.5) * 2);
          }
        }
      }
    } else if (!isReloading) {
      // Smoothly restore any residual rotation
      fpsWeaponGroup.rotation.x *= 0.85;
      fpsWeaponGroup.rotation.z *= 0.85;
      // Reset magazine position
      if (magPart) {
        magPart.position.y *= 0.85;
        magPart.position.x *= 0.85;
      }
    }

    // Muzzle flash timer
    if (muzzleFlashTimer > 0) {
      muzzleFlashTimer -= dt * 1000;
      const lp = players[localPlayerId];
      if (lp?.muzzleFlash) {
        lp.muzzleFlash.intensity = muzzleFlashTimer > 0 ? 3 : 0;
      }
    }

    // Update shell ejection particles
    for (let i = shellParticles.length - 1; i >= 0; i--) {
      const sp = shellParticles[i];
      sp.life -= dt;
      if (sp.life <= 0) {
        fpsWeaponScene.remove(sp.mesh);
        shellParticles.splice(i, 1);
        continue;
      }
      sp.mesh.position.addScaledVector(sp.vel, dt);
      sp.vel.y -= 9.81 * dt * 0.3; // gravity for brass
      // Tumble the shell
      sp.mesh.rotation.x += dt * 15;
      sp.mesh.rotation.z += dt * 10;
      // Fade out
      const opacity = sp.life / sp.maxLife;
      (sp.mesh.material as THREE.MeshStandardMaterial).transparent = true;
      (sp.mesh.material as THREE.MeshStandardMaterial).opacity = opacity;
    }

    // Hide local player mesh from own camera (first-person)
    const lp = players[localPlayerId];
    if (lp) {
      // Hide the sphere mesh but keep it in scene for physics
      // We'll handle visibility in the camera update
    }
  }

  // ---------- Movement / jump ----------
  function handleJump() {
    if (!ballRigidBody || isSpectating || !physicsEnabled) return;
    // Coyote-time: allow jump if grounded OR within 200ms of last being grounded.
    const now = performance.now();
    const groundedNow = canJump || canJumpUntil > now;
    if (keys.space && groundedNow) {
      let jumpPower = 4;
      // If the player only recently left the ground (within 1.6s of a real
      // landing), keep the higher bounce power. This mirrors the original
      // game's feel and lets players chain bounces off hexagons.
      if (canJumpUntil + 1600 > now) jumpPower = 10;
      if (hasPowerUp('high_jump')) jumpPower *= 1.5;
      try {
        ballRigidBody.applyImpulse({ x: 0, y: jumpPower, z: 0 }, true);
      } catch {
        /* ignore */
      }
      if (ballCollider) {
        try { ballCollider.setRestitution(0); } catch { /* ignore */ }
      }
      playSound(jumpSound, 0.6);
      keys.space = false;
      canJump = false;
      canJumpUntil = 0;
      if (netClient && mode !== 'single') {
        netClient.send({ kind: 'jump', id: localPlayerId });
      }
    }
    // Jump buffering: if the player pressed jump while airborne, remember it
    // for up to 200ms so the jump fires as soon as we land. Without this, the
    // ball feels "stuck" — the player taps jump a hair too early and nothing
    // happens even after landing.
    if (keys.space && !groundedNow) {
      jumpBufferedUntil = now + 200;
    }
    // If we're grounded and a buffered jump is pending, fire it now.
    if (groundedNow && jumpBufferedUntil > now && !keys.space) {
      keys.space = true;
      jumpBufferedUntil = 0;
    }
  }

  function handleMovement(dt: number) {
    if (!ballRigidBody || isPaused || isSpectating || !physicsEnabled) return;
    // We use acceleration scaled by dt (not by frame count) — that is the
    // crucial change that makes movement FPS-independent.
    let moveAccel = 18.0;
    if (hasPowerUp('speed_boost')) moveAccel *= 1.5;

    let moveX = 0;
    let moveZ = 0;
    // Lower deadzone (0.15 instead of 0.5) so small joystick nudges still
    // register. The original 0.5 deadzone was too aggressive — on mobile it
    // felt like the ball wouldn't move unless you pushed the stick fully.
    if (keys.w || joystickY < -0.15) moveZ -= 1;
    if (keys.s || joystickY > 0.15) moveZ += 1;
    if (keys.a || joystickX < -0.15) moveX -= 1;
    if (keys.d || joystickX > 0.15) moveX += 1;
    const len = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (len > 0) {
      moveX /= len;
      moveZ /= len;
    }
    // Also scale by analog stick magnitude so partial nudges move slower.
    const stickMagX = Math.abs(joystickX) > 0.15 ? joystickX : 0;
    const stickMagY = Math.abs(joystickY) > 0.15 ? joystickY : 0;
    const stickMag = Math.min(1, Math.sqrt(stickMagX * stickMagX + stickMagY * stickMagY));
    const analogScale = (keys.w || keys.a || keys.s || keys.d) ? 1 : stickMag;
    // FPS movement: forward = (sin(az), 0, -cos(az)), right = (cos(az), 0, sin(az))
    // direction = moveX * right + (-moveZ) * forward
    //   X: moveX * cos(az) - moveZ * sin(az)
    //   Z: moveX * sin(az) + moveZ * cos(az)
    const ax = (moveX * Math.cos(cameraAzimuth) - moveZ * Math.sin(cameraAzimuth)) * moveAccel * dt * analogScale;
    const az = (moveX * Math.sin(cameraAzimuth) + moveZ * Math.cos(cameraAzimuth)) * moveAccel * dt * analogScale;
    if (ax !== 0 || az !== 0) {
      try {
        ballRigidBody.applyImpulse({ x: ax, y: 0, z: az }, true);
      } catch {
        /* ignore */
      }
    }
  }

  function getContactedTile(): TileClient | null {
    if (!ballRigidBody) return null;
    try {
      const p = ballRigidBody.translation();
      for (const tile of tiles) {
        if (!tile || tile.isBreaking) continue;
        const dx = p.x - tile.mesh.position.x;
        const dz = p.z - tile.mesh.position.z;
        const hd = Math.sqrt(dx * dx + dz * dz);
        const vd = p.y - tile.mesh.position.y;
        // Player centre must be within ~1 tile radius horizontally and
        // close to the tile's top surface vertically.
        if (hd < TILE_RADIUS * 1.3 && vd <= TILE_HEIGHT / 2 + PLAYER_RADIUS + 0.1 && vd >= -(TILE_HEIGHT / 2 + 0.5)) {
          return tile;
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  // ---------- Elimination ----------
  // The HOST is the single authority for eliminations and ranks in LAN mode.
  // Flow:
  //   - A player dies locally (falls off, HP=0) → local engine calls eliminatePlayer(id).
  //   - If the local player IS the host: compute rank, apply elimination, broadcast
  //     `player-eliminated` with the rank to all guests.
  //   - If the local player is a GUEST: send `player-eliminated` with rank=0 to the
  //     host. The host calls its own eliminatePlayer(id), which computes the rank
  //     and broadcasts the authoritative elimination to all OTHER guests.
  //   - Guests receiving `player-eliminated` with rank>0 apply the elimination
  //     locally using the host's rank (they do NOT recompute or re-broadcast).
  //
  // This ensures every peer sees the same ranks in the same order, even if two
  // players die at nearly the same time (the host serializes them).
  function eliminatePlayer(id: string) {
    const p = players[id];
    if (!p || p.eliminated) return;
    p.eliminated = true;
    createParticleEffect(p.mesh.position, 0xff4444, 22);
    if (id === localPlayerId) {
      addScore(50);
      isSpectating = true;
      callbacks.onSpectatingChange(true);
      if (ballRigidBody) {
        try { ballRigidBody.setEnabled(false); } catch { /* ignore */ }
      }
      // Pick the first alive player to spectate.
      const aliveForSpectate = Object.values(players).filter((pp) => !pp.eliminated);
      spectateTargetId = aliveForSpectate[0]?.id ?? null;
    }
    try { scene.remove(p.mesh); } catch { /* ignore */ }
    // Also remove scene-level children (weaponGroup, nameLabel, muzzleFlash)
    // that are NOT children of the mesh.
    if (p.weaponGroup) { try { scene.remove(p.weaponGroup); } catch { /* ignore */ } }
    if (p.nameLabel) { try { scene.remove(p.nameLabel); } catch { /* ignore */ } }
    if (p.muzzleFlash) { try { scene.remove(p.muzzleFlash); } catch { /* ignore */ } }
    try {
      if (p.rigidBody) world.removeRigidBody(p.rigidBody);
    } catch { /* ignore */ }
    if (p.collider) delete colliderHandleToPlayerId[p.collider.handle];
    // CRITICAL: After removing the rigid body from the world, null out the
    // local ball references. The WASM object backing ballRigidBody is freed
    // by world.removeRigidBody(), so any subsequent .linvel() / .translation()
    // call on it will crash with "RuntimeError: unreachable". Without this,
    // stepPhysics() continues executing after eliminatePlayer() returns and
    // tries to read velocity on the freed body.
    if (id === localPlayerId) {
      ballRigidBody = null;
      ballCollider = null;
    }

    // Compute rank: the host (and single-player) is authoritative.
    // Rank = (number of players still alive AFTER this elimination) + 1.
    // E.g. 4 players, one dies → 3 alive → rank = 4 (last place).
    //      2 players, one dies → 1 alive → rank = 2 (second place).
    //      The last alive player gets rank 1 (winner) in endGame().
    if (isHost || mode === 'single') {
      const alive = Object.values(players).filter((pp) => !pp.eliminated);
      p.rank = alive.length + 1;
      console.log(`[ENGINE] Player ${id.slice(0, 8)} eliminated. Rank: ${p.rank}. Alive: ${alive.length}`);
    }

    if (netClient && mode !== 'single') {
      if (isHost) {
        // Host broadcasts the AUTHORITATIVE elimination with the computed rank.
        netClient.send({ kind: 'player-eliminated', id, rank: p.rank ?? 0 });
      } else {
        // Guest tells the host it died (rank=0 = "please compute my rank").
        // The host will call eliminatePlayer(id) and broadcast the real rank.
        netClient.send({ kind: 'player-eliminated', id, rank: 0 });
      }
    }

    // End game check: if <= 1 players are alive, the game is over.
    const alive = Object.values(players).filter((pp) => !pp.eliminated);
    if (alive.length <= 1) {
      // Assign rank 1 to the winner (if there is one).
      if (alive[0]) alive[0].rank = 1;
      endGame(alive[0]?.id ?? null);
    }
    pushHud();
  }

  /** Guard against endGame being called multiple times (e.g. host calls it
   *  locally AND receives a game-ended broadcast). */
  let gameEnded = false;

  function endGame(winner: string | null) {
    if (gameEnded) return;
    gameEnded = true;
    // Ensure the winner has rank 1.
    if (winner) {
      const wp = players[winner];
      if (wp && !wp.rank) wp.rank = 1;
    }
    const rankings = Object.values(players)
      .map((p) => ({ id: p.id, rank: p.rank ?? null }))
      .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    console.log('[ENGINE] endGame. Winner:', winner?.slice(0, 8) ?? 'none', 'Rankings:', rankings.map((r) => `${r.id.slice(0, 6)}:#${r.rank}`).join(', '));
    callbacks.onEndGame(rankings, winner);
    // Host broadcasts game-ended so all guests show the end screen.
    if (netClient && mode !== 'single' && isHost) {
      netClient.send({ kind: 'game-ended', winner });
    }
  }

  // ---------- Networking ----------
  /** The engine's own onMessage callback, kept here so dispose() can remove it
   *  from the netClient's listener set. Without this, recreating the engine on
   *  restart would leave the OLD engine's listener attached — both engines
   *  would receive every event and step on each other. */
  let engineNetListener: ((ev: NetEvent) => void) | null = null;

  function setupNetworking() {
    if (!netClient) return;
    engineNetListener = (ev: NetEvent) => {
      switch (ev.type) {
        case 'open':
          // In server mode, adopt the server-assigned socket id as our local
          // player id. This is critical because the server's `init` event
          // references players by their socket.id, and our `localPlayerId`
          // started as 'local-host' (a placeholder). Without this update, the
          // host never creates its own sphere (the init handler's
          // `if (p.id === localPlayerId)` check never matches).
          if (mode === 'server' && ev.id && ev.id !== localPlayerId) {
            // Migrate any existing local player state to the new id.
            const oldEntry = players[localPlayerId];
            if (oldEntry) {
              players[ev.id] = oldEntry;
              delete players[localPlayerId];
            }
            localPlayerId = ev.id;
            // Update the netClient's id too (defensive — socket.ts already
            // does this, but LAN mode doesn't).
            try { (netClient as any).id = ev.id; } catch { /* ignore */ }
            console.log('[ENGINE] Adopted server-assigned id:', localPlayerId);
          }
          // For LAN/server guests: send join request
          if (!isHost) {
            netClient.send({ kind: 'new-player', id: localPlayerId, position: { x: (Math.random() - 0.5) * 6, y: 5, z: (Math.random() - 0.5) * 6 } });
          }
          break;
        case 'new-player': {
          if (ev.data.id !== localPlayerId && !players[ev.data.id]) {
            createSphere(ev.data.id, ev.data.position, false);
          }
          // If we are the host, ALWAYS (re)send init in response to a
          // new-player announcement. The guest may have missed an earlier
          // init (e.g. its engine listener wasn't registered yet when the
          // first init arrived — see the WebRTCNetGuest event-buffer comments).
          // The guest's init handler is idempotent (createTile / createSphere
          // both early-return on duplicate ids), so re-sending is safe.
          if (isHost) {
            netClient.send({
              kind: 'init',
              gameId: 'lan',
              creatorId: localPlayerId,
              players: Object.values(players).map((pp) => ({ id: pp.id, position: pp.targetPosition })),
              islandSeed,
              islandSize,
              startTimer: startTimerValue,
              serverStartTime: serverStartTime ?? Date.now() + startTimerValue * 1000,
            });
          }
          break;
        }
        case 'init': {
          // In server mode, BOTH host and guest receive 'init' from the server
          // (the server generates the island seed and sends it to everyone).
          // In LAN mode, only the guest receives 'init' from the host (the
          // host generated its own island in start()).
          const shouldProcessInit = !isHost || mode === 'server';
          if (shouldProcessInit) {
            // RESTART DETECTION: if we already have tiles / players / a ball,
            // this is a re-init (the host restarted the match). Tear down all
            // existing game state BEFORE applying the new init so the new
            // island / spawn positions are clean.
            const isReinit = tiles.length > 0 || Object.keys(players).length > 0 || ballRigidBody !== null;
            if (isReinit) {
              console.log('[ENGINE] Re-init received — tearing down previous match state for restart.');
              resetGameState({ keepListeners: true });
            }
            // CLOCK-SKEW FIX: do NOT copy the host's `serverStartTime` verbatim.
            // The host computed it as `hostNow + timer*1000` using the HOST's
            // wall clock. If the guest's clock differs from the host's (which
            // is common — phones, laptops, and servers rarely have perfectly
            // synced clocks), the guest's `remaining = serverStartTime -
            // guestNow` would be wildly wrong (e.g. 3637 seconds instead of 30).
            //
            // Instead, compute our OWN serverStartTime using our OWN clock +
            // the startTimer duration. This makes the countdown UI correct on
            // every device regardless of clock skew. The actual physics-enable
            // moment is already synchronized via the host's `game-started`
            // broadcast (guests don't enable physics on their own countdown),
            // so using different clocks for the UI is safe.
            startTimerValue = ev.data.startTimer;
            serverStartTime = Date.now() + startTimerValue * 1000;
            // Re-generate the island from the host's/server's seed + size so
            // both peers have the exact same layout.
            islandSeed = ev.data.islandSeed;
            islandSize = (ev.data.islandSize as IslandSize) || 'medium';
            // Only generate the island if we haven't already (the LAN host
            // generates it in start(); server-mode host and all guests get
            // it here). We check tiles.length to avoid double-generating.
            if (tiles.length === 0) {
              const islandTiles = generateIsland(islandSize, islandSeed);
              for (const t of islandTiles) createTile({ x: t.x, y: t.y, z: t.z }, t.id);
              // Spawn the deterministic powerup pickups — same positions on
              // every peer because they're derived from the island seed.
              spawnPowerupPickups();
            }
            // Create remote players (and ourselves)
            for (const p of ev.data.players) {
              if (p.id === localPlayerId) {
                // Only create our local sphere if it doesn't exist yet
                if (!players[p.id]) {
                  createSphere(p.id, p.position, true);
                }
              } else if (!players[p.id]) {
                createSphere(p.id, p.position, false);
              }
            }
            pushCountdown();
          }
          break;
        }
        case 'move': {
          const p = players[ev.data.id];
          if (p && ev.data.id !== localPlayerId && !p.eliminated) {
            p.targetPosition = ev.data.position;
            p.targetRotation = ev.data.rotation;
            // Store the remote player's facing direction for weapon orientation
            if (ev.data.cameraAzimuth !== undefined) {
              p.targetAzimuth = ev.data.cameraAzimuth;
            }
          }
          break;
        }
        case 'jump': {
          // Someone jumped — we only need this on the host side to relay/ack.
          // No physics sync needed since each peer is authoritative for its own ball.
          break;
        }
        case 'rotate': {
          // Reserved for future cosmetic use (e.g. arrow above head).
          break;
        }
        case 'damage-tile': {
          // A remote peer damaged a tile — apply the same damage locally so
          // the island stays in sync across all peers. sourcePeer is non-null
          // so we don't re-broadcast (avoids infinite loop).
          const tile = tilesById.get(ev.data.tileId);
          if (tile && !tile.isBreaking) {
            applyTileDamage(tile, ev.data.damage);
          }
          break;
        }
        case 'hexagon-collided':
        case 'hexagon-broken': {
          // Legacy messages from the old hexagon system — no longer used but
          // we ignore them gracefully if an older peer sends one.
          break;
        }
        case 'player-hit': {
          // Invincibility powerup: ignore knockback + damage from other players.
          if (ev.data.targetId === localPlayerId && !hasPowerUp('invincibility')) {
            // Apply knockback
            if (ballRigidBody) {
              try { ballRigidBody.applyImpulse(ev.data.impulse, true); } catch { /* ignore */ }
            }
            // Apply health damage from the shot
            const dmg = ev.data.damage ?? 0;
            if (dmg > 0) updateHealth(-dmg);
          }
          break;
        }
        case 'player-eliminated': {
          const p = players[ev.data.id];
          if (p && !p.eliminated) {
            if (isHost && ev.data.rank === 0) {
              // A guest is telling us it died (rank=0 = "please compute my
              // rank"). As the host, we're the authority — call our own
              // eliminatePlayer(id), which computes the rank, applies the
              // elimination locally, AND broadcasts the authoritative
              // elimination (with the real rank) to all OTHER guests.
              eliminatePlayer(ev.data.id);
            } else if (ev.data.rank > 0) {
              // We're a guest receiving the host's AUTHORITATIVE elimination
              // broadcast (rank > 0). Apply the elimination locally using the
              // host's rank. Do NOT recompute or re-broadcast — the host is
              // the authority and has already informed everyone.
              p.eliminated = true;
              p.rank = ev.data.rank;
              createParticleEffect(p.mesh.position, 0xff4444, 22);
              if (ev.data.id === localPlayerId) {
                isSpectating = true;
                callbacks.onSpectatingChange(true);
                if (ballRigidBody) ballRigidBody.setEnabled(false);
                // Pick the first alive player to spectate.
                const aliveForSpectate = Object.values(players).filter((pp) => !pp.eliminated);
                spectateTargetId = aliveForSpectate[0]?.id ?? null;
              }
              try { scene.remove(p.mesh); } catch { /* ignore */ }
              if (p.weaponGroup) { try { scene.remove(p.weaponGroup); } catch { /* ignore */ } }
              if (p.nameLabel) { try { scene.remove(p.nameLabel); } catch { /* ignore */ } }
              if (p.muzzleFlash) { try { scene.remove(p.muzzleFlash); } catch { /* ignore */ } }
              try {
                if (p.rigidBody) world.removeRigidBody(p.rigidBody);
              } catch { /* ignore */ }
              if (p.collider) delete colliderHandleToPlayerId[p.collider.handle];
              const alive = Object.values(players).filter((pp) => !pp.eliminated);
              if (alive.length <= 1) {
                if (alive[0]) alive[0].rank = 1;
                endGame(alive[0]?.id ?? null);
              }
              pushHud();
            }
            // If rank === 0 and we're NOT the host, ignore — the host will
            // process it and broadcast the authoritative rank back to us.
          }
          break;
        }
        case 'player-disconnected': {
          const p = players[ev.data.id];
          if (p) {
            try { scene.remove(p.mesh); } catch { /* ignore */ }
            if (p.weaponGroup) { try { scene.remove(p.weaponGroup); } catch { /* ignore */ } }
            if (p.nameLabel) { try { scene.remove(p.nameLabel); } catch { /* ignore */ } }
            if (p.muzzleFlash) { try { scene.remove(p.muzzleFlash); } catch { /* ignore */ } }
            try {
              if (p.rigidBody) world.removeRigidBody(p.rigidBody);
            } catch { /* ignore */ }
            delete players[ev.data.id];
            // If the spectated target disconnected, auto-switch to another
            // alive player.
            if (spectateTargetId === ev.data.id) {
              spectateTargetId = null;
            }
            const alive = Object.values(players).filter((pp) => !pp.eliminated);
            if (alive.length <= 1) {
              if (alive[0]) alive[0].rank = 1;
              endGame(alive[0]?.id ?? null);
            }
            pushHud();
          }
          break;
        }
        case 'game-ended': {
          endGame(ev.data.winner ?? null);
          break;
        }
        case 'game-started': {
          // Host's countdown expired and physics enabled. Enable physics on
          // our side too AND clear our countdown UI immediately. Without
          // clearing serverStartTime, our own pushCountdown() would keep
          // showing a countdown (e.g. "2", "1") for a couple more seconds
          // because our serverStartTime was set slightly later than the
          // host's (due to the network round-trip of the start-countdown
          // message). This way, the physics-enable moment is synchronized
          // across all peers via the host's `game-started` broadcast.
          //
          // Also cancel the fallback timer (if set) since we got the real
          // message — no need for the fallback anymore.
          if (gameStartedFallbackTimer !== null) {
            clearTimeout(gameStartedFallbackTimer);
            gameStartedFallbackTimer = null;
          }
          enablePhysics();
          serverStartTime = null;
          callbacks.onCountdown(null);
          break;
        }
        case 'powerup-collected': {
          // A peer collected a pickup — hide it on our side. The collector's
          // own client already applied the effect locally (in collectPowerup).
          handleRemotePowerupCollected(ev.data.powerupId, ev.data.playerId, ev.data.powerupType);
          break;
        }
        case 'powerup-respawned': {
          // Host broadcast a respawn at a NEW tile — move the pickup and show it.
          handleRemotePowerupRespawned(ev.data.powerupId, ev.data.newTileId, ev.data.position);
          break;
        }
        case 'peer-list': {
          // Lobby roster update. The engine doesn't need to act on this — the
          // LanModal handles the lobby UI. We just log it for debugging.
          console.log('[ENGINE] peer-list update:', ev.data.players.map((p) => p.id).join(', '));
          break;
        }
        case 'start-countdown': {
          // Host triggered the countdown. The engine's own start() should have
          // already set serverStartTime, but if for some reason it didn't
          // (e.g. this is a late-arriving start-countdown), set it now. This
          // is mostly a safety net.
          if (!serverStartTime) {
            serverStartTime = Date.now() + (ev.data.startTimer ?? 5) * 1000;
            startTimerValue = ev.data.startTimer ?? 5;
            pushCountdown();
            console.log('[ENGINE] start-countdown received; serverStartTime set to', serverStartTime);
          }
          break;
        }
        case 'player-shot': {
          // Remote player fired a weapon — show muzzle flash effect
          const shooter = players[ev.data.id];
          if (shooter && ev.data.id !== localPlayerId) {
            // Flash the muzzle light
            if (shooter.muzzleFlash) {
              shooter.muzzleFlash.intensity = 3;
              setTimeout(() => {
                if (shooter.muzzleFlash) shooter.muzzleFlash.intensity = 0;
              }, 50);
            }
            // Create a small tracer/particle effect
            const origin = new THREE.Vector3(ev.data.origin.x, ev.data.origin.y, ev.data.origin.z);
            createParticleEffect(origin, 0xffaa00, 3);
          }
          break;
        }
        case 'error':
          callbacks.onError(ev.message);
          break;
        case 'close':
          if (!disconnected) {
            disconnected = true;
            callbacks.onConnectionLost();
          }
          break;
      }
    };
    if (engineNetListener) {
      netClient.onMessage(engineNetListener);
    }
  }

  // ---------- Game start logic ----------
  function start() {
    if (mode === 'single') {
      // Generate the island for single-player mode.
      const islandTiles = generateIsland(islandSize, islandSeed);
      for (const t of islandTiles) createTile({ x: t.x, y: t.y, z: t.z }, t.id);
      // Scatter powerup pickups across the island — they're collected by
      // moving the ball over them, not granted randomly.
      spawnPowerupPickups();
      const spawn = getIslandSpawn(islandTiles);
      createSphere('local', spawn, true);
      serverStartTime = Date.now() + 5 * 1000;
      startTimerValue = 5;
      pushCountdown();
    } else if (isHost && mode === 'lan') {
      // LAN host: generate the island, wait for guests, count down.
      // The seed + size are sent to guests in the init message so they
      // regenerate the exact same island.
      const islandTiles = generateIsland(islandSize, islandSeed);
      for (const t of islandTiles) createTile({ x: t.x, y: t.y, z: t.z }, t.id);
      // Scatter powerup pickups — same positions on every peer because they
      // are derived from the island seed (which is sent in the init msg).
      spawnPowerupPickups();
      const spawn = getIslandSpawn(islandTiles);
      createSphere(localPlayerId, spawn, true);
      serverStartTime = Date.now() + startTimerValue * 1000;
      pushCountdown();
    }
    // SERVER host & SERVER guest: BOTH wait for the 'init' event from the
    // server. The server generates the island seed and sends it in init, so
    // the host doesn't generate its own island (unlike LAN mode where the
    // host IS the authority). This was a bug — the previous code generated
    // the island on the host's side AND ignored the init event (because of
    // the `if (!isHost)` guard in the init handler), so the host's island
    // seed didn't match what the server sent to guests.
    //
    // LAN guest: also waits for 'init' from the host (handled in setupNetworking).
    setupNetworking();
    // Safety net for guests: the WebRTC data channel may have opened BEFORE
    // the engine was created (the LanModal's `open` listener fires onStart →
    // App screen switch → Game mount → engine created). In that case, the
    // engine's `case 'open'` handler never runs and the guest never sends its
    // own `new-player` request from the engine side. The WebRTCNetGuest itself
    // sends `new-player` in its dc.onopen, but the host's `init` response can
    // arrive at any time relative to this point. The event buffer in
    // WebRTCNetGuest catches the race, but we ALSO re-send `new-player` here
    // to be defensive — the host's new-player handler always responds with a
    // fresh `init`, so the guest will get one. (The host side is idempotent.)
    if (mode !== 'single' && !isHost && netClient) {
      try {
        netClient.send({
          kind: 'new-player',
          id: localPlayerId,
          position: { x: (Math.random() - 0.5) * 6, y: 5, z: (Math.random() - 0.5) * 6 },
        });
      } catch {
        /* ignore — the data channel might not be open yet */
      }
    }
    lastFrameTime = performance.now() / 1000;
    animationFrameId = requestAnimationFrame(loop);
  }

  // ---------- Main loop ----------
  let lastSecondMarker = 0;
  function loop() {
    animationFrameId = requestAnimationFrame(loop);
    const now = performance.now() / 1000;
    let realDt = now - lastFrameTime;
    lastFrameTime = now;
    // Cap realDt to avoid huge jumps after tab switch
    if (realDt > 0.25) realDt = 0.25;

    // FPS measurement
    fpsAccum += realDt;
    fpsFrames++;
    if (fpsAccum >= 0.5) {
      realFps = fpsFrames / fpsAccum;
      fpsSmoothed = fpsSmoothed * 0.6 + realFps * 0.4;
      fpsAccum = 0;
      fpsFrames = 0;
    }

    if (isPaused) {
      renderer.render(scene, camera);
      css2dRenderer.render(scene, camera);
      return;
    }

    // GAME ENDED: stop stepping physics / running match simulation. The loop
    // keeps running (so the end-game scene stays visible and the camera can
    // still orbit), but we skip:
    //   - world.step() (the Rapier world may contain removed rigid bodies
    //     whose colliders' handles have been recycled, which causes spurious
    //     collision events and crashes when the loop tries to read
    //     ballRigidBody.translation() on a body that was removed via
    //     eliminatePlayer → world.removeRigidBody)
    //   - send move/jump to peers (the match is over — sending moves just
    //     wastes bandwidth and confuses guests that may already be showing
    //     the end-game screen)
    //   - per-second survival score
    //   - powerup pickup collection / respawn (would otherwise keep
    //     collecting pickups and broadcasting to peers after the game ended)
    //   - tile impact damage (would otherwise keep damaging the island)
    //
    // We DO keep:
    //   - particles (so death explosions finish playing)
    //   - tweens (so any in-flight animations finish)
    //   - camera (so the spectator cam can keep orbiting)
    //   - renderer.render (so the canvas stays live)
    if (gameEnded) {
      // Only update cosmetic things — particles + tweens — so death effects
      // and island-break animations finish gracefully. Use a real (unscaled)
      // dt here so they don't speed up/slow down with gameSpeed after death.
      updateParticles(realDt);
      tweenGroup.update(now * 1000);
      updateCamera(realDt);
      renderer.render(scene, camera);
      css2dRenderer.render(scene, camera);
      return;
    }

    // Apply game speed by scaling simulated time.
    const scaledDt = realDt * settings.gameSpeed;

    // ----- Fixed-timestep physics -----
    physicsAccumulator += scaledDt;
    let steps = 0;
    while (physicsAccumulator >= PHYSICS_DT && steps < MAX_STEPS_PER_FRAME) {
      stepPhysics(PHYSICS_DT);
      physicsAccumulator -= PHYSICS_DT;
      steps++;
    }
    // Drop backlog if we hit the cap (avoids spiral of death on slow devices)
    if (physicsAccumulator > PHYSICS_DT * MAX_STEPS_PER_FRAME) {
      physicsAccumulator = 0;
    }

    // ----- Per-frame simulation that needs real (scaled) dt -----
    updateParticles(scaledDt);
    updatePowerUps(scaledDt);
    // Spin / hover / collect / respawn the scattered powerup pickups.
    updatePowerupPickups(scaledDt, performance.now());
    tweenGroup.update(now * 1000);

    // Per-second survival score
    const nowSec = Math.floor(now * 1000 / 1000);
    if (lastSecondMarker === 0) lastSecondMarker = nowSec;
    if (nowSec > lastSecondMarker) {
      lastSecondMarker = nowSec;
      if (physicsEnabled && !isSpectating) {
        addScore(1);
        // Powerups are no longer randomly granted to the player — they are
        // scattered on the map as pickups. See spawnPowerupPickups +
        // updatePowerupPickups. The old spawnRandomPowerUp() is now a no-op.
      }
    }

    // Send our movement to peers (skipped after the game has ended — see the
    // gameEnded early-return above).
    if (mode !== 'single' && netClient && ballRigidBody && !isPaused) {
      const t = now * 1000;
      if (t - lastSendTime >= SEND_INTERVAL) {
        try {
          const p = ballRigidBody.translation();
          const r = ballRigidBody.rotation();
          netClient.send({
            kind: 'move',
            id: localPlayerId,
            position: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
            rotation: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), z: +r.z.toFixed(2), w: +r.w.toFixed(2) },
            cameraAzimuth: +cameraAzimuth.toFixed(2),
          });
          lastSendTime = t;
        } catch {
          /* ignore */
        }
      }
    }

    // Countdown check (every frame; cheap)
    if (serverStartTime) {
      const elapsed = Date.now() - serverStartTime;
      // Failsafe: if more than 10 seconds past the countdown end and physics
      // still isn't enabled, force it. This handles edge cases where the
      // countdown callback might not fire properly after a restart.
      if (elapsed > startTimerValue * 1000 + 10000 && !physicsEnabled) {
        console.warn('[ENGINE] Countdown failsafe triggered — forcing physics enable');
        enablePhysics();
        serverStartTime = null;
        callbacks.onCountdown(null);
      } else {
        pushCountdown();
      }
    }

    // Camera (uses real dt so it feels identical at any FPS)
    updateCamera(realDt);

    // FPS weapon rendering
    updateFpsWeapon(realDt);
    handleShooting(realDt);

    renderer.render(scene, camera);
    // Render FPS weapon on top
    if (!isSpectating && !isPaused) {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(fpsWeaponScene, fpsWeaponCamera);
      renderer.autoClear = true;
    }
    // Render CSS2D labels
    css2dRenderer.render(scene, camera);
  }

  function stepPhysics(dt: number) {
    // Defensive: never step physics after the game has ended. The world may
    // contain removed rigid bodies, and calling world.step() with stale
    // collider handles can crash Rapier or fire spurious collision events.
    if (gameEnded) return;
    if (!physicsEnabled) {
      // Still step remote kinematic bodies so they appear in the right place even pre-game
      updateRemoteKinematics();
      // IMPORTANT: Interpolate remote players toward their targetPosition EVEN
      // WHEN PHYSICS IS DISABLED (during the countdown). Without this, the
      // host receives `move` messages from the guest (which can move on the
      // guest's side once the guest's own countdown expires), updates
      // `p.targetPosition`, but the guest's mesh on the host's screen stays
      // frozen at the spawn position because the interpolation loop below was
      // gated by `physicsEnabled`. This was the "movement not visible to host
      // until timer runs out" bug.
      interpolateRemotePlayers();
      return;
    }

    // Push remote kinematic bodies toward their target
    updateRemoteKinematics();

    // Jump & movement use the *physics* dt so the simulation is identical
    // regardless of how many physics steps we run per frame.
    handleJump();
    handleMovement(dt);

    // Apply input → camera azimuth (consumes accumulated look delta proportionally)
    // (Camera azimuth is updated on input events, so just consume here.)
    void dt;

    try {
      world.step(eventQueue);
    } catch (e) {
      console.error('world.step failed', e);
    }

    // Collision events
    eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const local = ballCollider?.handle ?? -1;
      let other = -1;
      if (h1 === local) other = h2;
      else if (h2 === local) other = h1;
      if (other === -1) return;
      const otherId = colliderHandleToPlayerId[other];
      if (otherId && otherId !== localPlayerId && ballRigidBody) {
        const myPos = ballRigidBody.translation();
        const op = players[otherId];
        if (op) {
          const dx = op.mesh.position.x - myPos.x;
          const dz = op.mesh.position.z - myPos.z;
          const dist = Math.sqrt(dx * dx + dz * dz) || 0.01;
          const pushForce = 5.0;
          const impulse = { x: (dx / dist) * pushForce, y: 2.0, z: (dz / dist) * pushForce };
          if (netClient && mode !== 'single') {
            netClient.send({ kind: 'player-hit', targetId: otherId, impulse });
          } else if (op.rigidBody && mode === 'single') {
            try { op.rigidBody.applyImpulse(impulse, true); } catch { /* ignore */ }
          }
        }
      }
    });

    // Update local player mesh from physics
    if (ballRigidBody) {
      try {
        const p = ballRigidBody.translation();
        const r = ballRigidBody.rotation();
        const lp = players[localPlayerId];
        if (lp) {
          lp.mesh.position.set(p.x, p.y, p.z);
          lp.mesh.quaternion.set(r.x, r.y, r.z, r.w);
          // Also update scene-level children (weaponGroup, nameLabel, muzzleFlash)
          // that are not children of the mesh. Even though they're hidden in
          // first-person, the muzzle flash needs to be near the player to
          // illuminate nearby surfaces.
          const weaponHeight = PLAYER_RADIUS + 0.35;
          const weaponForwardDist = 0.4;
          const weaponSideDist = 0.25;
          const fwdX = Math.sin(cameraAzimuth);
          const fwdZ = -Math.cos(cameraAzimuth);
          const rgtX = Math.cos(cameraAzimuth);
          const rgtZ = Math.sin(cameraAzimuth);
          if (lp.weaponGroup) {
            lp.weaponGroup.position.set(
              p.x + rgtX * weaponSideDist + fwdX * weaponForwardDist,
              p.y + weaponHeight,
              p.z + rgtZ * weaponSideDist + fwdZ * weaponForwardDist,
            );
            lp.weaponGroup.rotation.set(0, -cameraAzimuth, 0);
          }
          if (lp.nameLabel) {
            lp.nameLabel.position.set(p.x, p.y + PLAYER_RADIUS + 0.6, p.z);
          }
          if (lp.muzzleFlash) {
            const flashFwd = weaponForwardDist + 0.5;
            lp.muzzleFlash.position.set(
              p.x + rgtX * weaponSideDist + fwdX * flashFwd,
              p.y + weaponHeight,
              p.z + rgtZ * weaponSideDist + fwdZ * flashFwd,
            );
          }
        }
        // Death check
        if (p.y < DEATH_Y_LEVEL && !lp?.eliminated) eliminatePlayer(localPlayerId);
      } catch {
        /* ignore — body may have been removed during eliminatePlayer */
      }
    }

    // After eliminatePlayer, ballRigidBody is nulled and gameEnded may be true.
    // Bail out of the rest of stepPhysics to avoid accessing freed WASM objects.
    if (gameEnded || !ballRigidBody) return;

    // Falling damage (skipped while invincibility is active — the player
    // still falls but takes no HP loss from hard landings.)
    try {
      const pos = ballRigidBody.translation();
      if (pos.y < -5 && !hasPowerUp('invincibility')) {
        const v = ballRigidBody.linvel();
        if (v.y < -10) updateHealth(-5);
      }
    } catch {
      /* ignore */
    }

    // Interpolate remote players (also runs when physicsEnabled=false, via
    // the early-return branch above — see comment there for why).
    interpolateRemotePlayers();

    // ---- Island tile contact + impact damage ----
    const contacted = getContactedTile();
    const wasGrounded = canJump;
    canJump = !!contacted;

    // Track peak downward velocity while airborne so we can convert it to
    // impact damage on landing.
    try {
      if (ballRigidBody) {
        const vel = ballRigidBody.linvel();
        if (!contacted) {
          wasAirborne = true;
          if (vel.y < 0 && -vel.y > maxFallSpeed) {
            maxFallSpeed = -vel.y;
          }
        } else {
          // Just landed — if we were airborne with enough downward speed,
          // deal damage to the tiles under us.
          if (wasAirborne && maxFallSpeed > MIN_IMPACT_SPEED) {
            const now = performance.now();
            if (now - lastImpactTime > IMPACT_DEBOUNCE_MS) {
              lastImpactTime = now;
              const bp = ballRigidBody.translation();
              // speedFactor: 1× at 10 m/s, up to 3× at 30+ m/s.
              const speedFactor = Math.min(IMPACT_SPEED_MAX_FACTOR, maxFallSpeed / IMPACT_SPEED_REFERENCE);
              const damage = BASE_TILE_DAMAGE * settings.islandDamageMultiplier * speedFactor;
              const radius = IMPACT_RADIUS_BASE + speedFactor * IMPACT_RADIUS_SCALE;
              // sourcePeer = null means "this is the local player's impact —
              // broadcast to peers". Remote impacts pass a non-null sourcePeer
              // so we don't re-broadcast.
              damageTilesAt(new THREE.Vector3(bp.x, bp.y, bp.z), radius, damage, null);
              playSound(collisionSound, 0.3 + speedFactor * 0.15);
            }
          }
          wasAirborne = false;
          maxFallSpeed = 0;
        }
      }
    } catch {
      /* ignore — rigid body may have been freed */
    }

    // Coyote-time: when the ball is grounded, open a small window during
    // which the player can still jump after leaving the ground.
    if (contacted) {
      canJumpUntil = performance.now() + 200;
    }
    if (contacted && lastGroundedTileId !== contacted.id) {
      playSound(collisionSound, 0.25);
      lastGroundedTileId = contacted.id;
    } else if (!contacted) {
      lastGroundedTileId = null;
    }
    // If we just left the ground without jumping, keep canJump true for the
    // coyote window so the player can still recover with a late jump.
    if (!contacted && wasGrounded && canJumpUntil > performance.now()) {
      canJump = true;
    }
  }

  function updateRemoteKinematics() {
    for (const [id, p] of Object.entries(players)) {
      if (id === localPlayerId || p.eliminated) continue;
      if (p.rigidBody && p.rigidBody.isKinematic()) {
        const pos = p.mesh.position;
        const q = p.mesh.quaternion;
        try {
          p.rigidBody.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
          p.rigidBody.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Lerp each remote player's mesh toward its targetPosition (received via
   * `move` messages) and slerp its quaternion toward targetRotation. This
   * smooths out network jitter and makes remote players appear to move
   * continuously rather than teleporting between snapshots.
   *
   * CRITICAL: This MUST run regardless of `physicsEnabled`. The host receives
   * `move` messages from guests even during the pre-game countdown (when
   * physicsEnabled=false). If we only interpolate inside the
   * physicsEnabled-gated block, the host's screen shows remote players frozen
   * at spawn until the host's own countdown expires — which can be much later
   * than the guest's countdown if there's clock skew between devices. The
   * classic "movement not visible to host until timer runs out" bug.
   *
   * Death check: if a remote player's targetPosition falls below the death
   * level, we eliminate them locally as a fallback (the host will broadcast
   * the elimination if it's authoritative).
   */
  function interpolateRemotePlayers() {
    for (const [id, p] of Object.entries(players)) {
      if (id === localPlayerId || p.eliminated) continue;
      const tp = new THREE.Vector3(p.targetPosition.x, p.targetPosition.y, p.targetPosition.z);
      p.mesh.position.lerp(tp, 0.2);
      const tq = new THREE.Quaternion(p.targetRotation.x, p.targetRotation.y, p.targetRotation.z, p.targetRotation.w);
      p.mesh.quaternion.slerp(tq, 0.2);

      // Position the weapon group, name label, and muzzle flash in world space.
      // The weapon is held ABOVE the ball (not on its surface) and rotated to
      // face the player's aiming direction (targetAzimuth).
      const ballPos = p.mesh.position;
      const az = p.targetAzimuth;

      // Weapon offset relative to the player's facing direction:
      //   - "forward" = the direction the player is looking (azimuth)
      //   - The weapon sits above the ball, slightly to the right and forward
      const weaponHeight = PLAYER_RADIUS + 0.35;
      const weaponForwardDist = 0.4;
      const weaponSideDist = 0.25;

      // Convert the local offset (side, height, forward) into world space
      // using the azimuth angle. "Forward" is -Z at azimuth=0, so:
      //   worldX = ballPos.x + side*cos(az) + forward*sin(az)
      //   worldZ = ballPos.z - side*sin(az) + forward*cos(az)
      // Wait, let me think again. The camera look target is:
      //   lookTarget.x = pos.x + sin(az) * cos(pitch)  → forward direction is +sin(az) in X
      //   lookTarget.z = pos.z - cos(az) * cos(pitch)  → forward direction is -cos(az) in Z
      // So the forward vector is (sin(az), 0, -cos(az))
      // And the right vector is (cos(az), 0, sin(az))
      const forwardX = Math.sin(az);
      const forwardZ = -Math.cos(az);
      const rightX = Math.cos(az);
      const rightZ = Math.sin(az);

      if (p.weaponGroup) {
        p.weaponGroup.position.set(
          ballPos.x + rightX * weaponSideDist + forwardX * weaponForwardDist,
          ballPos.y + weaponHeight,
          ballPos.z + rightZ * weaponSideDist + forwardZ * weaponForwardDist,
        );
        // Rotate the weapon to face the player's aiming direction.
        // The weapon mesh is built pointing down -Z (barrel towards -Z),
        // so we rotate around Y by -azimuth to align with the facing direction.
        p.weaponGroup.rotation.set(0, -az, 0);
      }
      if (p.nameLabel) {
        p.nameLabel.position.set(ballPos.x, ballPos.y + PLAYER_RADIUS + 0.6, ballPos.z);
      }
      if (p.muzzleFlash) {
        const flashForward = weaponForwardDist + 0.5;
        p.muzzleFlash.position.set(
          ballPos.x + rightX * weaponSideDist + forwardX * flashForward,
          ballPos.y + weaponHeight,
          ballPos.z + rightZ * weaponSideDist + forwardZ * flashForward,
        );
      }
      if (tp.y < DEATH_Y_LEVEL && !p.eliminated) {
        // Remote player fell — host will broadcast, but as a fallback we eliminate locally too.
        if (isHost || mode === 'single') eliminatePlayer(id);
      }
    }
  }

  function updateCamera(dt: number) {
    // Determine follow target.
    let targetId: string | null = localPlayerId;
    if (isSpectating) {
      const alive = Object.values(players).filter((p) => !p.eliminated);
      // If our current spectate target is dead, gone, or unset, auto-pick
      // the first alive player.
      if (!spectateTargetId || !players[spectateTargetId] || players[spectateTargetId].eliminated) {
        spectateTargetId = alive[0]?.id ?? null;
      }
      targetId = spectateTargetId;
    }
    if (!targetId || !players[targetId]) return;
    const tp = players[targetId].mesh.position;

    if (isSpectating) {
      // Spectating: third-person follow camera
      const sens = settings.cameraSensitivity;
      cameraAzimuth += lookDelta * sens;
      lookDelta = 0;
      lookDeltaY = 0;

      const offsetDistance = 11;
      const offsetHeight = 6;
      const desiredX = tp.x - offsetDistance * Math.cos(cameraAzimuth);
      const desiredY = tp.y + offsetHeight;
      const desiredZ = tp.z - offsetDistance * Math.sin(cameraAzimuth);
      const k = 1 - Math.exp(-dt * 12);
      camera.position.x += (desiredX - camera.position.x) * k;
      camera.position.y += (desiredY - camera.position.y) * k;
      camera.position.z += (desiredZ - camera.position.z) * k;
      camera.lookAt(tp.x, tp.y + 0.5, tp.z);

      // Show the spectated player
      const spectatedPlayer = players[targetId];
      if (spectatedPlayer) {
        spectatedPlayer.mesh.visible = true;
        if (spectatedPlayer.nameLabel) spectatedPlayer.nameLabel.visible = true;
        if (spectatedPlayer.weaponGroup) spectatedPlayer.weaponGroup.visible = true;
      }
    } else {
      // First-person camera — no positional smoothing needed because the
      // camera IS the player. Smoothing the position to the ball causes
      // jitter when jumping + looking down: the camera Y lags behind the
      // ball Y, but the look direction uses the *desired* position, so the
      // view direction flips rapidly between "above target" and "below
      // target" each frame. Snapping the camera directly to the ball
      // eliminates this mismatch entirely.
      const sens = settings.cameraSensitivity;
      cameraAzimuth += lookDelta * sens;
      cameraPitch += lookDeltaY * sens;
      lookDelta = 0;
      lookDeltaY = 0;

      // Clamp pitch
      cameraPitch = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, cameraPitch));

      // Snap camera directly to ball eye position — no lerp/smoothing.
      // The ball's physics already provide smooth motion; adding a lerp
      // on top just introduces lag and jitter.
      const eyeOffset = PLAYER_HEIGHT * 0.4;
      camera.position.set(tp.x, tp.y + eyeOffset, tp.z);

      // Look direction based on azimuth + pitch
      // Positive azimuth = look right, so look target shifts +X with sin(az)
      const lookTarget = new THREE.Vector3(
        camera.position.x + Math.sin(cameraAzimuth) * Math.cos(cameraPitch),
        camera.position.y + Math.sin(cameraPitch),
        camera.position.z - Math.cos(cameraAzimuth) * Math.cos(cameraPitch),
      );
      camera.lookAt(lookTarget);

      // Hide local player mesh in first-person (don't see your own sphere)
      const localPlayer = players[localPlayerId];
      if (localPlayer) {
        localPlayer.mesh.visible = false;
        if (localPlayer.nameLabel) localPlayer.nameLabel.visible = false;
        if (localPlayer.weaponGroup) localPlayer.weaponGroup.visible = false;
      }

      // Show remote player meshes and name labels
      for (const [id, p] of Object.entries(players)) {
        if (id !== localPlayerId && !p.eliminated) {
          p.mesh.visible = true;
          if (p.nameLabel) p.nameLabel.visible = true;
          if (p.weaponGroup) p.weaponGroup.visible = true;
        }
      }
    }
    void dt;
  }

  // ---------- Public API ----------
  function setInput(k: keyof typeof keys, v: boolean) {
    keys[k] = v;
  }
  function setJoystick(x: number, y: number) {
    joystickX = x;
    joystickY = y;
  }
  function addLookDelta(dx: number) {
    lookDelta += dx;
  }
  function jump() {
    keys.space = true;
    // Will be consumed by handleJump in next physics step
  }
  function setPaused(p: boolean) {
    isPaused = p;
    if (ballRigidBody) {
      try { ballRigidBody.setEnabled(p ? false : physicsEnabled); } catch { /* ignore */ }
    }
  }
  function switchSpectator() {
    if (!isSpectating) return;
    const alive = Object.values(players).filter((p) => !p.eliminated);
    if (alive.length < 2) return;
    // Sort by id for a STABLE, predictable order. The old code used camera
    // distance to guess the "current" target, which was unreliable because
    // the camera smoothly follows the target and might be far from it by the
    // time the user presses switch.
    alive.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let curIdx = alive.findIndex((p) => p.id === spectateTargetId);
    if (curIdx < 0) curIdx = 0;
    const next = alive[(curIdx + 1) % alive.length];
    if (next) {
      spectateTargetId = next.id;
      // Don't instantly teleport the camera — updateCamera() will smoothly
      // glide to the new target. This avoids the jarring jump of the old code.
      console.log('[ENGINE] Spectate target switched to:', next.id.slice(0, 8));
    }
  }
  function updateSettings(s: Settings) {
    settings = s;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    // Shadows remain disabled for FPS optimization
  }
  function resize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    css2dRenderer.setSize(window.innerWidth, window.innerHeight);
    fpsWeaponCamera.aspect = window.innerWidth / window.innerHeight;
    fpsWeaponCamera.updateProjectionMatrix();
  }
  function getFps() { return Math.round(fpsSmoothed); }

  /**
   * Tear down all per-match state: tiles, players, powerup pickups, particles,
   * the local ball, and all bookkeeping (score/health/powerups/spectating/etc).
   * The Three.js scene / renderer / physics world / camera / lighting / audio
   * are kept intact — only match content is removed.
   *
   * Called from:
   *  - restart() — when the user clicks the Restart button
   *  - the init handler — when a re-init arrives from the host (guest side)
   *
   * `keepListeners` should be true when called from inside the init handler,
   * because the listener is mid-dispatch and we still want the rest of the
   * init handling to run after resetGameState returns.
   */
  function resetGameState(_opts?: { keepListeners?: boolean }) {
    // Cancel any pending game-started fallback timer.
    if (gameStartedFallbackTimer !== null) {
      clearTimeout(gameStartedFallbackTimer);
      gameStartedFallbackTimer = null;
    }

    // Remove all particles.
    for (const p of particles) {
      try { scene.remove(p.mesh); } catch { /* ignore */ }
      try { (p.mesh.material as THREE.Material).dispose(); } catch { /* ignore */ }
      try { p.mesh.geometry.dispose(); } catch { /* ignore */ }
    }
    particles.length = 0;

    // Remove all powerup pickups (mesh + halo + disposals).
    for (const pickup of powerupPickups) {
      try { scene.remove(pickup.mesh); } catch { /* ignore */ }
      try { scene.remove(pickup.haloMesh); } catch { /* ignore */ }
      try { (pickup.mesh.material as THREE.Material).dispose(); } catch { /* ignore */ }
      try { (pickup.haloMesh.material as THREE.Material).dispose(); } catch { /* ignore */ }
      try { pickup.mesh.geometry.dispose(); } catch { /* ignore */ }
      try { pickup.haloMesh.geometry.dispose(); } catch { /* ignore */ }
    }
    powerupPickups.length = 0;
    powerupPickupsById.clear();

    // Remove all tile meshes from the scene (no need to remove rigid bodies
    // individually — we recreate the entire physics World below).
    // Don't dispose the shared geometries (groundTileGeo, wallTileGeo) —
    // they're reused across rounds.
    for (const tile of tiles) {
      try { scene.remove(tile.mesh); } catch { /* ignore */ }
      try { (tile.mesh.material as THREE.Material).dispose(); } catch { /* ignore */ }
    }
    tiles.length = 0;
    tilesById.clear();

    // Remove all player meshes, weapon groups, name labels, and muzzle flashes from the scene.
    for (const id of Object.keys(players)) {
      const p = players[id];
      try { scene.remove(p.mesh); } catch { /* ignore */ }
      try { (p.mesh.material as THREE.Material).dispose(); } catch { /* ignore */ }
      try { p.mesh.geometry.dispose(); } catch { /* ignore */ }
      // weaponGroup, nameLabel, and muzzleFlash are direct children of the scene
      // (not the mesh), so we must remove them separately.
      if (p.weaponGroup) {
        try { scene.remove(p.weaponGroup); } catch { /* ignore */ }
        // Dispose weapon mesh children
        p.weaponGroup.traverse((child) => {
          if ((child as any).geometry) try { (child as any).geometry.dispose(); } catch { /* ignore */ }
          if ((child as any).material) {
            const mat = (child as any).material;
            if (Array.isArray(mat)) mat.forEach((m: THREE.Material) => { try { m.dispose(); } catch { /* ignore */ } });
            else try { mat.dispose(); } catch { /* ignore */ }
          }
        });
      }
      if (p.nameLabel) {
        try { scene.remove(p.nameLabel); } catch { /* ignore */ }
      }
      if (p.muzzleFlash) {
        try { scene.remove(p.muzzleFlash); } catch { /* ignore */ }
      }
      delete players[id];
    }

    // CRITICAL: Recreate the entire Rapier physics World instead of removing
    // bodies individually. After removing many bodies from a Rapier World,
    // the WASM memory gets into an inconsistent state that causes
    // "recursive use of an object detected which would lead to unsafe aliasing
    // in rust" errors when new bodies are created. A fresh World avoids this.
    // The old World is dropped and its WASM memory freed by GC.
    world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    eventQueue = new RAPIER.EventQueue(true);
    // Clear the collider→player mapping since all colliders are gone.
    colliderHandleToPlayerId = {};

    // Drop the local ball references — the old World is gone.
    ballRigidBody = null;
    ballCollider = null;

    // Reset per-match bookkeeping.
    playerScore = 0;
    playerHealth = 100;
    for (const k of Object.keys(powerUps)) delete powerUps[k];
    isSpectating = false;
    spectateTargetId = null;
    isPaused = false;
    physicsEnabled = false;
    gameEnded = false;
    disconnected = false;
    serverStartTime = null;
    cameraAzimuth = 0;
    lookDelta = 0;
    lastGroundedTileId = null;
    canJump = false;
    canJumpUntil = 0;
    jumpBufferedUntil = 0;
    wasAirborne = false;
    maxFallSpeed = 0;
    lastImpactTime = 0;
    physicsAccumulator = 0;
    keys.w = false; keys.a = false; keys.s = false; keys.d = false; keys.space = false;
    joystickX = 0;
    joystickY = 0;

    // Reset weapon state
    currentWeapon = 'ak47';
    ammo = WEAPONS.ak47.maxAmmo;
    reserveAmmo = WEAPONS.ak47.reserveAmmo;
    weaponAmmoState.ak47 = { ammo: WEAPONS.ak47.maxAmmo, reserveAmmo: WEAPONS.ak47.reserveAmmo };
    weaponAmmoState.desert_eagle = { ammo: WEAPONS.desert_eagle.maxAmmo, reserveAmmo: WEAPONS.desert_eagle.reserveAmmo };
    isReloading = false;
    isFiring = false;
    isSwitchingWeapon = false;
    reloadStartTime = 0;
    lastFireTime = 0;
    weaponSwitchStartTime = 0;
    pendingWeapon = null;
    weaponRecoilOffset = 0;
    weaponBobTime = 0;
    muzzleFlashTimer = 0;
    cameraPitch = -0.3;
    lookDeltaY = 0;
    setFpsWeapon('ak47');
    playerHealth = 100;

    // Notify the UI to clear its end-game / spectating / pause / countdown
    // state. The new match will re-push all of these as it starts.
    try { callbacks.onReset?.(); } catch { /* ignore */ }
    callbacks.onSpectatingChange(false);
    callbacks.onCountdown(null);
    pushHud();
  }

  /**
   * Restart the current match. Tears down all match state and starts a fresh
   * round with a brand-new island seed.
   *
   * Behaviour by mode:
   *  - single: regenerate the island + ball + powerups locally, restart the
   *    countdown. No network involvement.
   *  - LAN host: same as single, AND broadcast a fresh `init` message to all
   *    connected guests so they tear down their state and start the new match
   *    too. Only the host can restart in LAN mode — guests see a toast instead
   *    (handled by the UI layer, which doesn't call this on guests).
   *  - LAN guest: no-op (the UI layer shouldn't call this on guests; if it
   *    does, we just bail out).
   *  - server: not supported via this path (the server is authoritative).
   *    Returns false so the UI can fall back to "exit to menu".
   */
  function restart(): boolean {
    // Only the host (or single-player) can initiate a restart.
    if (mode === 'lan' && !isHost) {
      console.warn('[ENGINE] restart() called on a LAN guest — only the host can restart. Ignoring.');
      return false;
    }
    if (mode === 'server') {
      console.warn('[ENGINE] restart() not supported in server mode (server is authoritative).');
      return false;
    }

    console.log('[ENGINE] restart() — tearing down match state and starting a new round.');

    // Capture connected peer IDs BEFORE resetGameState clears the players map.
    // On restart, ALL players spawn at the same point (the island center),
    // regardless of where they died in the previous round.
    const peerIds: string[] = [];
    if (mode === 'lan' && isHost) {
      for (const id of Object.keys(players)) {
        if (id !== localPlayerId) peerIds.push(id);
      }
    }

    resetGameState();

    // Generate a brand-new island seed so the new match has a different layout.
    islandSeed = Math.floor(Math.random() * 1e9);

    if (mode === 'single') {
      const islandTiles = generateIsland(islandSize, islandSeed);
      for (const t of islandTiles) createTile({ x: t.x, y: t.y, z: t.z }, t.id);
      spawnPowerupPickups();
      const spawn = getIslandSpawn(islandTiles);
      createSphere('local', spawn, true);
      // Immediately position the camera at the new spawn point so the player
      // doesn't see the old death position during the countdown.
      camera.position.set(spawn.x, spawn.y + PLAYER_HEIGHT * 0.4, spawn.z);
      cameraAzimuth = 0;
      cameraPitch = -0.3;
      serverStartTime = Date.now() + 5 * 1000;
      startTimerValue = 5;
      pushCountdown();
    } else if (mode === 'lan' && isHost) {
      const islandTiles = generateIsland(islandSize, islandSeed);
      for (const t of islandTiles) createTile({ x: t.x, y: t.y, z: t.z }, t.id);
      spawnPowerupPickups();
      const spawn = getIslandSpawn(islandTiles);
      // Distribute players around the island center so they don't spawn
      // on top of each other. Each player gets a unique position in a circle.
      const allPlayerIds = [localPlayerId, ...peerIds];
      const spawns = getDistributedSpawns(spawn, allPlayerIds.length, 3);
      for (let i = 0; i < allPlayerIds.length; i++) {
        const pid = allPlayerIds[i];
        const pspawn = spawns[i];
        createSphere(pid, pspawn, pid === localPlayerId);
      }
      const hostSpawn = spawns[0];
      camera.position.set(hostSpawn.x, hostSpawn.y + PLAYER_HEIGHT * 0.4, hostSpawn.z);
      cameraAzimuth = 0;
      cameraPitch = -0.3;
      serverStartTime = Date.now() + startTimerValue * 1000;
      pushCountdown();
      if (netClient) {
        try {
          // Send each player their own spawn position (distributed, not overlapping)
          const allPlayers = allPlayerIds.map((id, i) => ({ id, position: spawns[i] }));
          netClient.send({
            kind: 'init',
            gameId: 'lan',
            creatorId: localPlayerId,
            players: allPlayers,
            islandSeed,
            islandSize,
            startTimer: startTimerValue,
            serverStartTime: serverStartTime,
          });
        } catch (e) {
          console.warn('[ENGINE] Failed to broadcast init on restart:', e);
        }
      }
    }
    return true;
  }

  function dispose() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    // Clear the game-started fallback timer if it's still pending.
    if (gameStartedFallbackTimer !== null) {
      clearTimeout(gameStartedFallbackTimer);
      gameStartedFallbackTimer = null;
    }
    // Remove our onMessage listener from the net client so a subsequently-
    // created engine (e.g. on restart) doesn't have its events double-handled
    // by this disposed engine's listener.
    if (netClient && engineNetListener) {
      try { netClient.offMessage(engineNetListener); } catch { /* ignore */ }
      engineNetListener = null;
    }
    try { renderer.dispose(); } catch { /* ignore */ }
    // NOTE: We deliberately do NOT close the net client here. The Game
    // component owns the net client and may reuse it across StrictMode
    // remounts. The Game component's own cleanup effect closes the client
    // on real unmount.
    // Drop all meshes / materials
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    // Remove canvas from DOM
    const el = renderer.domElement;
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  return {
    start,
    setInput,
    setJoystick,
    addLookDelta,
    addLookDeltaY: (dy: number) => { lookDeltaY += dy; },
    jump,
    setPaused,
    switchSpectator,
    updateSettings,
    resize,
    getFps,
    dispose,
    restart,
    getLocalPlayerId: () => localPlayerId,
    getCanvas: () => renderer.domElement,
    getCss2dElement: () => css2dRenderer.domElement,
    ensureAudio,
    // Weapon API
    switchWeapon,
    startReload,
    setFiring: (v: boolean) => { isFiring = v; },
    getCurrentWeapon: () => currentWeapon,
  };
}
