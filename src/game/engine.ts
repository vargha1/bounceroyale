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

import type { NetClient, NetMessage, NetEvent } from '../networking/types';
import type { Settings } from '../store/settings';
import { generateIsland, getIslandSpawn, type IslandTile, type IslandSize } from './island';

// ---------- Constants ----------
const DEATH_Y_LEVEL = -10;
const PHYSICS_HZ = 60;
const PHYSICS_DT = 1 / PHYSICS_HZ;
const MAX_STEPS_PER_FRAME = 5; // safety cap to prevent spiral-of-death
const PLAYER_RADIUS = 0.5;

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
}

export interface EngineHudState {
  score: number;
  health: number;
  powerUps: { type: string; remaining: number }[];
  aliveCount: number;
  totalPlayers: number;
  isHost: boolean;
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
  scene.background = new THREE.Color(0x0a0a14);
  scene.fog = new THREE.Fog(0x0a0a14, 30, 80);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 8, 14);

  const renderer = new THREE.WebGLRenderer({
    antialias: settings.graphicsQuality !== 'low',
    powerPreference: 'high-performance',
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.graphicsQuality === 'high' ? 2 : 1));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Critical for mobile: prevent the canvas from triggering browser gestures
  // (pan, zoom, pull-to-refresh) that would otherwise eat our touch events.
  renderer.domElement.style.touchAction = 'none';
  renderer.domElement.style.display = 'block';
  renderer.shadowMap.enabled = settings.graphicsQuality === 'high';
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  // Lighting
  const ambient = new THREE.AmbientLight(0x6a6a8a, 0.6);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffe4b5, 1.4);
  sun.position.set(10, 20, 8);
  sun.castShadow = settings.graphicsQuality === 'high';
  if (sun.castShadow) {
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -20;
    sun.shadow.camera.right = 20;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
  }
  scene.add(sun);

  const rim = new THREE.DirectionalLight(0x4060ff, 0.4);
  rim.position.set(-8, 5, -10);
  scene.add(rim);

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

  // Physics
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const eventQueue = new RAPIER.EventQueue(true);

  // World geometry (death floor for visualization only — actual death by Y check)
  const floorGeo = new THREE.CircleGeometry(80, 64);
  const floorMat = new THREE.MeshBasicMaterial({ color: 0x12122a, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  const floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = DEATH_Y_LEVEL;
  scene.add(floorMesh);

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
  const colliderHandleToPlayerId: Record<number, string> = {};
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
  let cameraAzimuth = 0;
  let lastGroundedTileId: string | null = null;
  let canJump = false;
  let canJumpUntil = 0;
  let jumpBufferedUntil = 0;
  let lastSendTime = 0;
  const SEND_INTERVAL = 33; // ~30 updates/s

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
    callbacks.onState({
      score: playerScore,
      health: Math.round(playerHealth),
      powerUps: Object.values(powerUps)
        .filter((p) => p.active)
        .map((p) => ({ type: p.type, remaining: Math.max(0, p.duration - (performance.now() - p.startTime)) })),
      aliveCount: Object.values(players).filter((p) => !p.eliminated).length,
      totalPlayers: Object.keys(players).length,
      isHost,
    });
  }

  function pushCountdown() {
    if (!serverStartTime) {
      callbacks.onCountdown(null);
      return;
    }
    const remaining = Math.max(0, Math.ceil((serverStartTime - Date.now()) / 1000));
    if (remaining <= 0) {
      // Timer has expired — enable physics, clear the countdown UI, and
      // null out serverStartTime so we don't keep re-entering this branch.
      // (Previously the "0" stayed on screen forever because the second
      // call to pushCountdown saw physicsEnabled=true and skipped the
      // onCountdown(null) call.)
      if (!physicsEnabled) {
        enablePhysics();
      }
      callbacks.onCountdown(null);
      serverStartTime = null;
      return;
    }
    callbacks.onCountdown(remaining);
  }

  function enablePhysics() {
    physicsEnabled = true;
    if (ballRigidBody) {
      ballRigidBody.setEnabled(true);
      ballRigidBody.wakeUp();
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
    if (playerHealth <= 0) {
      const id = localPlayerId;
      if (id && !players[id]?.eliminated) eliminatePlayer(id);
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

  function createParticleEffect(pos: THREE.Vector3, color: number, count: number) {
    const geo = new THREE.SphereGeometry(0.12, 6, 6);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(pos);
      m.position.add(new THREE.Vector3((Math.random() - 0.5) * 1.5, Math.random() * 1.5, (Math.random() - 0.5) * 1.5));
      const vel = new THREE.Vector3((Math.random() - 0.5) * 8, Math.random() * 8 + 4, (Math.random() - 0.5) * 8);
      const life = 0.8 + Math.random() * 0.5;
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

  function createTile(pos: { x: number; y: number; z: number }, id: string) {
    if (tilesById.has(id)) return; // dedupe — stable IDs mean this can be called twice in multiplayer
    const geo = createHexagonGeometry(TILE_RADIUS, TILE_HEIGHT);
    // Colour by height: low = sandy beach, mid = grass, high = rock.
    // Island heights span ~[0.3, 3.5] (see island.ts) — pick thresholds so
    // we get a visible mix of sand (valleys & edges), grass (mid), and rock
    // (peaks) instead of everything ending up grass.
    const baseColor = new THREE.Color();
    const heightFactor = Math.min(1, pos.y / 3.5);
    if (heightFactor < 0.25) {
      baseColor.setHSL(0.12, 0.55, 0.62); // warm sand
    } else if (heightFactor < 0.55) {
      baseColor.setHSL(0.33, 0.65, 0.42); // grass green
    } else {
      baseColor.setHSL(0.08, 0.15, 0.45); // rock grey-brown
    }
    const mat = new THREE.MeshStandardMaterial({
      color: baseColor.clone(),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1,
      roughness: 0.85,
      metalness: 0.05,
      emissive: baseColor.clone(),
      emissiveIntensity: 0.12,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.castShadow = settings.graphicsQuality === 'high';
    mesh.receiveShadow = settings.graphicsQuality === 'high';
    scene.add(mesh);

    let rigidBody: RAPIER.RigidBody | undefined;
    let collider: RAPIER.Collider | undefined;
    try {
      // Use a cuboid collider for the tile — much faster than a convex hull
      // and close enough for a small hex. Half-extents approximate the hex's
      // inscribed rectangle.
      const desc = RAPIER.ColliderDesc.cuboid(TILE_RADIUS * 0.9, TILE_HEIGHT / 2, TILE_RADIUS * 0.866)
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
      health: TILE_MAX_HEALTH,
      maxHealth: TILE_MAX_HEALTH,
      isBreaking: false,
      baseColor,
    };
    tiles.push(tile);
    tilesById.set(id, tile);
  }

  /** Update a tile's colour to reflect its current health (green → yellow → red). */
  function updateTileColor(tile: TileClient) {
    const pct = Math.max(0, tile.health / tile.maxHealth);
    const mat = tile.mesh.material as THREE.MeshStandardMaterial;
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
    canJump = true;
    canJumpUntil = performance.now() + 1000;
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

  function createSphere(id: string, pos: { x: number; y: number; z: number }, isLocal: boolean) {
    if (players[id]) return;
    const color = id === localPlayerId ? 0xff5252 : PLAYER_COLORS[Object.keys(players).length % PLAYER_COLORS.length];
    const geo = new THREE.SphereGeometry(PLAYER_RADIUS, 24, 24);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3, emissive: new THREE.Color(color), emissiveIntensity: 0.2 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = settings.graphicsQuality === 'high';
    mesh.position.set(pos.x, pos.y, pos.z);
    scene.add(mesh);

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
    players[id] = { id, mesh, rigidBody, collider, eliminated: false, color, targetPosition: pos, targetRotation: { x: 0, y: 0, z: 0, w: 1 } };
    pushHud();
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
    const adjustedAzimuth = cameraAzimuth + Math.PI / 2;
    const ax = (moveX * Math.cos(adjustedAzimuth) - moveZ * Math.sin(adjustedAzimuth)) * moveAccel * dt * analogScale;
    const az = (moveX * Math.sin(adjustedAzimuth) + moveZ * Math.cos(adjustedAzimuth)) * moveAccel * dt * analogScale;
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
  function eliminatePlayer(id: string) {
    const p = players[id];
    if (!p || p.eliminated) return;
    p.eliminated = true;
    createParticleEffect(p.mesh.position, 0xff4444, 22);
    if (id === localPlayerId) {
      addScore(50);
      isSpectating = true;
      callbacks.onSpectatingChange(true);
      if (ballRigidBody) ballRigidBody.setEnabled(false);
    }
    try { scene.remove(p.mesh); } catch { /* ignore */ }
    try {
      if (p.rigidBody) world.removeRigidBody(p.rigidBody);
    } catch { /* ignore */ }
    if (p.collider) delete colliderHandleToPlayerId[p.collider.handle];

    // Single-player & LAN host: compute rank locally. Server-mode: server sends rank.
    if (mode === 'single' || mode === 'lan') {
      const alive = Object.values(players).filter((pp) => !pp.eliminated);
      p.rank = alive.length + 1;
    }

    if (netClient && mode !== 'single') {
      // Host broadcasts elimination with the rank it computed.
      if (isHost) {
        netClient.send({ kind: 'player-eliminated', id, rank: p.rank ?? 0 });
      } else {
        // Guest tells host it died; host will broadcast the rank.
        netClient.send({ kind: 'player-eliminated', id, rank: 0 });
      }
    }

    // End game?
    const alive = Object.values(players).filter((pp) => !pp.eliminated);
    if (alive.length <= 1) {
      endGame(alive[0]?.id ?? null);
    }
    pushHud();
  }

  function endGame(winner: string | null) {
    const rankings = Object.values(players)
      .map((p) => ({ id: p.id, rank: p.rank ?? null }))
      .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    callbacks.onEndGame(rankings, winner);
  }

  // ---------- Networking ----------
  function setupNetworking() {
    if (!netClient) return;
    netClient.onMessage((ev: NetEvent) => {
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
            serverStartTime = ev.data.serverStartTime;
            startTimerValue = ev.data.startTimer;
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
          // Invincibility powerup: ignore knockback impulses from other players.
          if (ev.data.targetId === localPlayerId && ballRigidBody && !hasPowerUp('invincibility')) {
            try { ballRigidBody.applyImpulse(ev.data.impulse, true); } catch { /* ignore */ }
          }
          break;
        }
        case 'player-eliminated': {
          const p = players[ev.data.id];
          if (p && !p.eliminated) {
            p.eliminated = true;
            p.rank = ev.data.rank || (Object.values(players).filter((pp) => !pp.eliminated).length + 1);
            if (ev.data.id === localPlayerId) {
              isSpectating = true;
              callbacks.onSpectatingChange(true);
              if (ballRigidBody) ballRigidBody.setEnabled(false);
            }
            try { scene.remove(p.mesh); } catch { /* ignore */ }
            try {
              if (p.rigidBody) world.removeRigidBody(p.rigidBody);
            } catch { /* ignore */ }
            const alive = Object.values(players).filter((pp) => !pp.eliminated);
            if (alive.length <= 1) endGame(alive[0]?.id ?? null);
            pushHud();
          }
          break;
        }
        case 'player-disconnected': {
          const p = players[ev.data.id];
          if (p) {
            try { scene.remove(p.mesh); } catch { /* ignore */ }
            try {
              if (p.rigidBody) world.removeRigidBody(p.rigidBody);
            } catch { /* ignore */ }
            delete players[ev.data.id];
            const alive = Object.values(players).filter((pp) => !pp.eliminated);
            if (alive.length <= 1) endGame(alive[0]?.id ?? null);
            pushHud();
          }
          break;
        }
        case 'game-ended': {
          endGame(ev.data.winner ?? null);
          break;
        }
        case 'game-started': {
          enablePhysics();
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
    });
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

    // Send our movement to peers
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
          });
          lastSendTime = t;
        } catch {
          /* ignore */
        }
      }
    }

    // Countdown check (every frame; cheap)
    if (serverStartTime) pushCountdown();

    // Camera (uses real dt so it feels identical at any FPS)
    updateCamera(realDt);

    renderer.render(scene, camera);
  }

  function stepPhysics(dt: number) {
    if (!physicsEnabled) {
      // Still step remote kinematic bodies so they appear in the right place even pre-game
      updateRemoteKinematics();
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
        }
        // Death check
        if (p.y < DEATH_Y_LEVEL && !lp?.eliminated) eliminatePlayer(localPlayerId);
        // Falling damage (skipped while invincibility is active — the player
        // still falls but takes no HP loss from hard landings.)
        if (p.y < -5 && !hasPowerUp('invincibility')) {
          const v = ballRigidBody.linvel();
          if (v.y < -10) updateHealth(-5);
        }
      } catch {
        /* ignore */
      }
    }

    // Interpolate remote players
    for (const [id, p] of Object.entries(players)) {
      if (id === localPlayerId || p.eliminated) continue;
      const tp = new THREE.Vector3(p.targetPosition.x, p.targetPosition.y, p.targetPosition.z);
      p.mesh.position.lerp(tp, 0.2);
      const tq = new THREE.Quaternion(p.targetRotation.x, p.targetRotation.y, p.targetRotation.z, p.targetRotation.w);
      p.mesh.quaternion.slerp(tq, 0.2);
      if (tp.y < DEATH_Y_LEVEL && !p.eliminated) {
        // Remote player fell — host will broadcast, but as a fallback we eliminate locally too.
        if (isHost || mode === 'single') eliminatePlayer(id);
      }
    }

    // ---- Island tile contact + impact damage ----
    const contacted = getContactedTile();
    const wasGrounded = canJump;
    canJump = !!contacted;

    // Track peak downward velocity while airborne so we can convert it to
    // impact damage on landing.
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
            const pos = ballRigidBody.translation();
            // speedFactor: 1× at 10 m/s, up to 3× at 30+ m/s.
            const speedFactor = Math.min(IMPACT_SPEED_MAX_FACTOR, maxFallSpeed / IMPACT_SPEED_REFERENCE);
            const damage = BASE_TILE_DAMAGE * settings.islandDamageMultiplier * speedFactor;
            const radius = IMPACT_RADIUS_BASE + speedFactor * IMPACT_RADIUS_SCALE;
            // sourcePeer = null means "this is the local player's impact —
            // broadcast to peers". Remote impacts pass a non-null sourcePeer
            // so we don't re-broadcast.
            damageTilesAt(new THREE.Vector3(pos.x, pos.y, pos.z), radius, damage, null);
            playSound(collisionSound, 0.3 + speedFactor * 0.15);
          }
        }
        wasAirborne = false;
        maxFallSpeed = 0;
      }
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

  function updateCamera(dt: number) {
    // Determine follow target
    let targetId: string | null = localPlayerId;
    if (isSpectating) {
      const alive = Object.values(players).filter((p) => !p.eliminated);
      targetId = alive[0]?.id ?? null;
    }
    if (!targetId || !players[targetId]) return;
    const tp = players[targetId].mesh.position;

    // Consume look delta (scaled by sensitivity & frame dt for smoothing)
    const sens = settings.cameraSensitivity;
    cameraAzimuth += lookDelta * sens;
    lookDelta = 0;

    const offsetDistance = 11;
    const offsetHeight = 6;
    const desiredX = tp.x - offsetDistance * Math.cos(cameraAzimuth);
    const desiredY = tp.y + offsetHeight;
    const desiredZ = tp.z - offsetDistance * Math.sin(cameraAzimuth);
    // Smooth camera follow using dt-independent lerp factor
    const k = 1 - Math.exp(-dt * 12);
    camera.position.x += (desiredX - camera.position.x) * k;
    camera.position.y += (desiredY - camera.position.y) * k;
    camera.position.z += (desiredZ - camera.position.z) * k;
    camera.lookAt(tp.x, tp.y + 0.5, tp.z);
    void dt;
  }

  // ---------- Public API ----------
  function setInput(k: keyof typeof keys, v: boolean) {
    keys[k] = v;
  }
  function setJoystick(x: number, y: number) {
    console.log('joystick', x, y, 'physicsEnabled=', physicsEnabled, 'ballRigidBody=', !!ballRigidBody);
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
    // Find current target (closest mesh to camera) and move to next
    let curIdx = 0;
    let bestDist = Infinity;
    alive.forEach((p, i) => {
      const d = p.mesh.position.distanceTo(camera.position);
      if (d < bestDist) { bestDist = d; curIdx = i; }
    });
    const next = alive[(curIdx + 1) % alive.length];
    if (next) {
      const pos = next.mesh.position;
      camera.position.set(pos.x - 12, pos.y + 8, pos.z - 12);
      camera.lookAt(pos);
    }
  }
  function updateSettings(s: Settings) {
    const oldQuality = settings.graphicsQuality;
    settings = s;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, s.graphicsQuality === 'high' ? 2 : 1));
    if (oldQuality !== s.graphicsQuality) {
      renderer.shadowMap.enabled = s.graphicsQuality === 'high';
    }
  }
  function resize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  function getFps() { return Math.round(fpsSmoothed); }
  function dispose() {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
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
    jump,
    setPaused,
    switchSpectator,
    updateSettings,
    resize,
    getFps,
    dispose,
    getLocalPlayerId: () => localPlayerId,
    getCanvas: () => renderer.domElement,
    ensureAudio,
  };
}
