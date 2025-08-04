import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { Tween, Group, Easing } from '@tweenjs/tween.js';
import { Socket } from 'socket.io-client';
import io from 'socket.io-client';

// Client setup
let mode: string = 'single';
let serverIp: string | null = null;
let gameId: string | null = null;
let startTimer: number = 30;
let socket: typeof Socket | null = null;
let playerId: string | null = null;
let creatorId: string | null = null;
let isPaused: boolean = false;
let animationFrameId: number | null = null;
let playerRank: number | null = null;
playerRank == null;
let isSpectating: boolean = false;
let totalPlayers: number = 0;
let serverStartTime: number | null = null;
let eliminationCheckInterval: NodeJS.Timeout | null = null;

// Three.js and Rapier setup
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let audioListener: THREE.AudioListener;
let world: RAPIER.World | null = null;
let eventQueue: RAPIER.EventQueue | null = null;
let rigidBodies: { mesh: THREE.Mesh; rigidBody?: RAPIER.RigidBody; collider?: RAPIER.Collider }[] = [];
let hexagonsClient: {
  mesh: THREE.Mesh;
  rigidBody?: RAPIER.RigidBody;
  collider?: RAPIER.Collider;
  collisionCount: number;
  isBreaking: boolean;
}[] = [];
let canJump: boolean = true;
let isJumpOnBroken: boolean = false;
let ballRigidBody: RAPIER.RigidBody | null = null;
let ballCollider: RAPIER.Collider | null = null;
const keys: { w: boolean; a: boolean; s: boolean; d: boolean; space: boolean; escape: boolean } = {
  w: false,
  a: false,
  s: false,
  d: false,
  space: false,
  escape: false,
};
let cameraAzimuth: number = 0;
let joystickActive: boolean = false;
let joystickX: number = 0;
let joystickY: number = 0;
let joystickTouchId: number | null = null;
let rotationTouchId: number | null = null;
let joystickCenterX: number = 0;
let joystickCenterY: number = 0;
let touchStartX: number = 0;
const tweenGroup: Group = new Group();
let playersClient: { [id: string]: { mesh: THREE.Mesh; rigidBody?: RAPIER.RigidBody; collider?: RAPIER.Collider; eliminated?: boolean; rank?: number } } = {};
let jumpSound: THREE.Audio;
let collisionSound: THREE.Audio;
let breakSound: THREE.Audio;

// Collision groups
const BALL_BALL_INTERACTION = 0x00010001; // Ball-to-ball and ball-to-hexagon interactions
const BALL_HEXAGON_INTERACTION = 0x00010001;

function isMobileUserAgent() {
  const userAgent = navigator.userAgent;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
}

const hexagons: { x: number; y: number; z: number }[] = [
  { x: 0, y: 0, z: 0 },
  { x: 4, y: 0, z: 0 },
  { x: -4, y: 0, z: 0 },
  { x: 2, y: 0, z: 4 * Math.sqrt(3) / 2 },
  { x: -2, y: 0, z: 4 * Math.sqrt(3) / 2 },
  { x: 6, y: 0, z: 4 * Math.sqrt(3) / 2 },
  { x: -6, y: 0, z: 4 * Math.sqrt(3) / 2 },
  { x: 0, y: 0, z: 4 * Math.sqrt(3) },
  { x: 4, y: 0, z: 4 * Math.sqrt(3) },
];

// Declare global functions
declare global {
  interface Window {
    start: (gameMode: string, ip?: string, timer?: number, selectedGameId?: string) => void;
    resumeGame: () => void;
    exitGame: () => void;
  }
}

// Start function
window.start = function start(gameMode: string, ip?: string, timer?: number, selectedGameId?: string): void {
  mode = gameMode;
  serverIp = ip || null;
  startTimer = timer || 30;
  gameId = selectedGameId || null;

  // Hide UI elements
  document.querySelector('header')!.classList.add('hidden');
  document.querySelector('aside')!.classList.add('hidden');
  document.querySelector('main')!.classList.add('hidden');
  document.getElementById('game-mode-modal')!.style.display = 'none';
  document.getElementById('join-game-modal')!.style.display = 'none';
  document.getElementById('create-game-modal')!.style.display = 'none';

  // Initialize Three.js
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // Initialize audio
  audioListener = new THREE.AudioListener();
  camera.add(audioListener);
  jumpSound = new THREE.Audio(audioListener);
  collisionSound = new THREE.Audio(audioListener);
  breakSound = new THREE.Audio(audioListener);

  const audioLoader = new THREE.AudioLoader();
  audioLoader.load('/sounds/jump.mp3', (buffer) => jumpSound.setBuffer(buffer).setVolume(0.5));
  audioLoader.load('/sounds/collision.mp3', (buffer) => collisionSound.setBuffer(buffer).setVolume(0.5));
  audioLoader.load('/sounds/break.mp3', (buffer) => breakSound.setBuffer(buffer).setVolume(0.5));

  camera.position.set(0, 5, 10);
  camera.lookAt(0, 0, 0);

  // Add lighting
  const ambientLight: THREE.AmbientLight = new THREE.AmbientLight(0x404040);
  scene.add(ambientLight);
  const directionalLight: THREE.DirectionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
  directionalLight.position.set(0, 1, 0);
  scene.add(directionalLight);

  // Initialize client
  init();
};

// Physics and rendering functions
function initPhysics(): void {
  const gravity = { x: 0, y: -9.81, z: 0 };
  world = new RAPIER.World(gravity);
  eventQueue = new RAPIER.EventQueue(true);
}

function createHexagonShape(radius: number = 2, height: number = 1): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const vertices: number[] = [];
  const indices: number[] = [];
  const angle: number = Math.PI / 3;

  for (let i = 0; i < 6; i++) {
    const x: number = radius * Math.cos(i * angle);
    const z: number = radius * Math.sin(i * angle);
    vertices.push(x, height / 2, z);
  }

  for (let i = 0; i < 6; i++) {
    const x: number = radius * Math.cos(i * angle);
    const z: number = radius * Math.sin(i * angle);
    vertices.push(x, -height / 2, z);
  }

  vertices.push(0, height / 2, 0);
  vertices.push(0, -height / 2, 0);

  for (let i = 0; i < 6; i++) {
    indices.push(12, i, (i + 1) % 6);
  }

  for (let i = 0; i < 6; i++) {
    indices.push(13, 6 + (i + 1) % 6, 6 + i);
  }

  for (let i = 0; i < 6; i++) {
    const next: number = (i + 1) % 6;
    indices.push(i, next, 6 + i);
    indices.push(next, 6 + next, 6 + i);
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createHexagon(position: { x: number; y: number; z: number }, isLocal: boolean = true): void {
  const geometry: THREE.BufferGeometry = createHexagonShape();
  const material: THREE.MeshStandardMaterial = new THREE.MeshStandardMaterial({
    color: 0x00ff00,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 1,
  });
  const mesh: THREE.Mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position.x, position.y, position.z);
  scene.add(mesh);

  if (isLocal && world) {
    const vertices: Float32Array = new Float32Array(geometry.attributes.position.array);
    const colliderDesc: RAPIER.ColliderDesc = RAPIER.ColliderDesc.convexHull(vertices)!
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setCollisionGroups(BALL_HEXAGON_INTERACTION)
      .setSolverGroups(BALL_HEXAGON_INTERACTION);
    const rigidBodyDesc: RAPIER.RigidBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z);
    const rigidBody: RAPIER.RigidBody = world.createRigidBody(rigidBodyDesc);
    const collider: RAPIER.Collider = world.createCollider(colliderDesc, rigidBody);

    const hexagon = { mesh, rigidBody, collider, collisionCount: 0, isBreaking: false };
    hexagonsClient.push(hexagon);
    rigidBodies.push({ mesh, rigidBody, collider });
  } else {
    const hexagon = { mesh, collisionCount: 0, isBreaking: false };
    hexagonsClient.push(hexagon);
    rigidBodies.push({ mesh });
  }
}

function createSphere(id: string, position: { x: number; y: number; z: number }, isCreator: boolean = false): void {
  const geometry: THREE.SphereGeometry = new THREE.SphereGeometry(0.5, 32, 32);
  const material: THREE.MeshStandardMaterial = new THREE.MeshStandardMaterial({ color: isCreator ? 0xff0000 : 0x0000ff });
  const mesh: THREE.Mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position.x, position.y, position.z);
  scene.add(mesh);

  if ((mode === 'single' || id === playerId) && world) {
    const rigidBodyDesc: RAPIER.RigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setLinearDamping(0.5);
    ballRigidBody = world.createRigidBody(rigidBodyDesc);
    const colliderDesc: RAPIER.ColliderDesc = RAPIER.ColliderDesc.ball(0.5)
      .setRestitution(0.8)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setCollisionGroups(BALL_BALL_INTERACTION)
      .setSolverGroups(BALL_BALL_INTERACTION);
    ballCollider = world.createCollider(colliderDesc, ballRigidBody);
    rigidBodies.push({ mesh, rigidBody: ballRigidBody, collider: ballCollider });
    playersClient[id] = { mesh, rigidBody: ballRigidBody, collider: ballCollider, eliminated: false };
  } else {
    playersClient[id] = { mesh, eliminated: false };
    rigidBodies.push({ mesh });
  }
  console.log('Created sphere:', { id, isCreator, position });
}

function breakHexagon(
  hexagon: {
    mesh: THREE.Mesh;
    rigidBody?: RAPIER.RigidBody;
    collider?: RAPIER.Collider;
    collisionCount: number;
    isBreaking: boolean;
  }
): void {
  if (hexagon.isBreaking) return;
  hexagon.isBreaking = true;

  if (hexagon.collider && world) {
    world.removeCollider(hexagon.collider, false);
  }

  isJumpOnBroken = true;
  canJump = true;
  setTimeout(() => {
    canJump = false;
    isJumpOnBroken = false;
  }, 250);

  breakSound.play();

  const material: THREE.MeshStandardMaterial = hexagon.mesh.material as THREE.MeshStandardMaterial;
  const initialPosition: THREE.Vector3 = hexagon.mesh.position.clone();

  const tween = new Tween({ opacity: 1, y: initialPosition.y })
    .to({ opacity: 0, y: initialPosition.y - 1 }, 1000)
    .easing(Easing.Quadratic.InOut)
    .onUpdate(({ opacity, y }: { opacity: number; y: number }) => {
      material.opacity = opacity;
      hexagon.mesh.position.y = y;
    })
    .onComplete(() => {
      scene.remove(hexagon.mesh);
      if (hexagon.rigidBody && world) {
        world.removeRigidBody(hexagon.rigidBody);
      }
      rigidBodies = rigidBodies.filter((body) => body.mesh !== hexagon.mesh);
      hexagonsClient = hexagonsClient.filter((h) => h !== hexagon);
    });
  tweenGroup.add(tween);
  tween.start();

  setTimeout(() => {
    material.opacity = 0;
    hexagon.mesh.position.y = initialPosition.y - 1;
  }, 1000);
}

function handleJumping(): void {
  if (!ballRigidBody || !canJump || isSpectating) return;
  if (keys.space) {
    const jumpImpulse: number = isJumpOnBroken ? 10 : 4;
    ballRigidBody.applyImpulse({ x: 0, y: jumpImpulse, z: 0 }, true);
    if (ballCollider) ballCollider.setRestitution(0);
    jumpSound.play();
    keys.space = false;
    canJump = false;
    if (socket && playerId && gameId) socket.emit('jump', { gameId, id: playerId });
  }
}

function handleMovement(): void {
  if (!ballRigidBody || isPaused || isSpectating) return;
  const moveImpulse: number = 0.05;
  let moveX: number = 0;
  let moveZ: number = 0;

  if (keys.w || joystickY < -0.5) moveZ -= 1;
  if (keys.s || joystickY > 0.5) moveZ += 1;
  if (keys.a || joystickX < -0.5) moveX -= 1;
  if (keys.d || joystickX > 0.5) moveX += 1;

  const length: number = Math.sqrt(moveX * moveX + moveZ * moveZ);
  if (length > 0) {
    moveX /= length;
    moveZ /= length;
  }

  const adjustedAzimuth = cameraAzimuth + Math.PI / 2;
  const impulseX: number = (moveX * Math.cos(adjustedAzimuth) - moveZ * Math.sin(adjustedAzimuth)) * moveImpulse;
  const impulseZ: number = (moveX * Math.sin(adjustedAzimuth) + moveZ * Math.cos(adjustedAzimuth)) * moveImpulse;

  if (impulseX !== 0 || impulseZ !== 0) {
    ballRigidBody.applyImpulse({ x: impulseX, y: 0, z: impulseZ }, true);
  }
}

function isTouchInJoystick(touch: Touch): boolean {
  const joystick = document.querySelector('.joystick') as HTMLElement;
  if (!joystick) return false;
  const rect = joystick.getBoundingClientRect();
  return (
    touch.clientX >= rect.left &&
    touch.clientX <= rect.right &&
    touch.clientY >= rect.top &&
    touch.clientY <= rect.bottom
  );
}

function isTouchInJumpButton(touch: Touch): boolean {
  const jumpButton = document.querySelector('.jump-button') as HTMLElement;
  if (!jumpButton) return false;
  const rect = jumpButton.getBoundingClientRect();
  return (
    touch.clientX >= rect.left &&
    touch.clientX <= rect.right &&
    touch.clientY >= rect.top &&
    touch.clientY <= rect.bottom
  );
}

function updateJoystickCenter(): void {
  const joystick = document.querySelector('.joystick') as HTMLElement;
  if (joystick) {
    const rect = joystick.getBoundingClientRect();
    joystickCenterX = rect.left + rect.width / 2;
    joystickCenterY = rect.top + rect.height / 2;
  }
}

function handleTouchStart(event: TouchEvent): void {
  if (isPaused || isSpectating) return;
  event.preventDefault();
  updateJoystickCenter();
  for (let i = 0; i < event.touches.length; i++) {
    const touch = event.touches[i];
    if (isTouchInJoystick(touch) && joystickTouchId === null) {
      joystickTouchId = touch.identifier;
      joystickActive = true;
      joystickX = 0;
      joystickY = 0;
    } else if (!isTouchInJumpButton(touch) && rotationTouchId === null) {
      rotationTouchId = touch.identifier;
      touchStartX = touch.clientX;
    }
  }
}

function handleTouchMove(event: TouchEvent): void {
  if (isPaused || isSpectating) return;
  event.preventDefault();
  updateJoystickCenter();
  for (let i = 0; i < event.touches.length; i++) {
    const touch = event.touches[i];
    if (touch.identifier === joystickTouchId && joystickActive) {
      const deltaX = (touch.clientX - joystickCenterX) / 50;
      const deltaY = (touch.clientY - joystickCenterY) / 50;
      joystickX = Math.max(-1, Math.min(1, deltaX));
      joystickY = Math.max(-1, Math.min(1, deltaY));
      const joystickInner = document.querySelector('.joystick-inner') as HTMLElement;
      if (joystickInner) {
        joystickInner.style.transform = `translate(${joystickX * 30 - 50}%, ${joystickY * 30 - 50}%)`;
      }
    } else if (touch.identifier === rotationTouchId) {
      const deltaX = touch.clientX - touchStartX;
      cameraAzimuth += deltaX * 0.002;
      touchStartX = touch.clientX;
      if (socket && playerId && gameId) {
        socket.emit('rotate', { gameId, id: playerId, cameraAzimuth });
      }
    }
  }
}

function handleTouchEnd(event: TouchEvent): void {
  if (isPaused || isSpectating) return;
  event.preventDefault();
  const remainingTouches = event.changedTouches;
  for (let i = 0; i < remainingTouches.length; i++) {
    const touch = remainingTouches[i];
    if (touch.identifier === joystickTouchId) {
      joystickActive = false;
      joystickX = 0;
      joystickY = 0;
      joystickTouchId = null;
      const joystickInner = document.querySelector('.joystick-inner') as HTMLElement;
      if (joystickInner) {
        joystickInner.style.transform = 'translate(-50%, -50%)';
      }
    } else if (touch.identifier === rotationTouchId) {
      rotationTouchId = null;
      touchStartX = 0;
    }
  }
}

function handleMouseMove(event: MouseEvent): void {
  if (isPaused || isSpectating) return;
  const sensitivity: number = 0.002;
  const deltaX: number = event.movementX || 0;
  cameraAzimuth += deltaX * sensitivity;
  if (socket && playerId && gameId) {
    socket.emit('rotate', { gameId, id: playerId, cameraAzimuth });
  }
}

let physicsEnabled: boolean = false;
function startCountdown(seconds: number, serverTime?: number): void {
  const countdownElement = document.getElementById('countdown') as HTMLElement;
  countdownElement.style.display = 'block';
  countdownElement.style.opacity = '1';

  const startTime = serverTime || Date.now();
  const endTime = startTime + seconds * 1000;

  const countdown = () => {
    const timeLeft = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
    if (timeLeft <= 0) {
      countdownElement.style.display = 'none';
      physicsEnabled = true;
      if (ballRigidBody) {
        ballRigidBody.setEnabled(true);
      }
      // Start elimination check after countdown
      eliminationCheckInterval = setInterval(checkPlayerElimination, 100);
      console.log('Countdown finished, physics enabled, elimination check started:', { mode, physicsEnabled });
      return;
    }
    countdownElement.textContent = timeLeft.toString();
    setTimeout(countdown, 100);
  };
  countdown();
}

function checkPlayerElimination(): void {
  if (!world || !physicsEnabled) return;

  const alivePlayers = Object.entries(playersClient).filter(([_, player]) => !player.eliminated);
  totalPlayers = Math.max(totalPlayers, alivePlayers.length);

  Object.entries(playersClient).forEach(([id, player]) => {
    if (!player.eliminated && player.mesh.position.y < -5) {
      player.eliminated = true;
      const rank = alivePlayers.length;
      player.rank = rank;
      if (id === playerId || (mode === 'single' && id === 'local')) {
        playerRank = rank;
        isSpectating = true;
        if (ballRigidBody) {
          ballRigidBody.setEnabled(false);
          scene.remove(player.mesh);
          rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
        }
        const joystick = document.querySelector('.joystick') as HTMLElement;
        const jumpButton = document.querySelector('.jump-button') as HTMLElement;
        if (joystick) joystick.style.display = 'none';
        if (jumpButton) jumpButton.style.display = 'none';
        if (socket && playerId && gameId) {
          socket.emit('player-eliminated', { gameId, id: playerId, rank });
        }
      } else if (player.rigidBody) {
        world!.removeRigidBody(player.rigidBody);
        scene.remove(player.mesh);
        rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
      }
      console.log(`Player ${id} eliminated with rank ${rank}`);
    }
  });

  // Check if game is over
  const remainingPlayers = Object.entries(playersClient).filter(([_, player]) => !player.eliminated);
  if (remainingPlayers.length === 1 && !isSpectating) {
    const [id, player] = remainingPlayers[0];
    player.rank = 1;
    if (id === playerId || (mode === 'single' && id === 'local')) {
      playerRank = 1;
      isSpectating = true;
      if (ballRigidBody) {
        ballRigidBody.setEnabled(false);
        scene.remove(player.mesh);
        rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
      }
      const joystick = document.querySelector('.joystick') as HTMLElement;
      const jumpButton = document.querySelector('.jump-button') as HTMLElement;
      if (joystick) joystick.style.display = 'none';
      if (jumpButton) jumpButton.style.display = 'none';
      if (socket && playerId && gameId) {
        socket.emit('player-eliminated', { gameId, id: playerId, rank: 1 });
      }
    }
    console.log(`Player ${id} wins with rank 1`);
    showEndGameModal();
  } else if (remainingPlayers.length === 0) {
    showEndGameModal();
  }
}

function showEndGameModal(): void {
  let modal = document.getElementById('end-game-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'end-game-modal';
    const modalContent = document.createElement('div');
    modalContent.className = 'modal-content';
    modalContent.innerHTML = `
      <h2 data-en="Game Over" data-fa="بازی تمام شد">Game Over</h2>
      <div id="rankings"></div>
      <button id="exit-to-menu" data-en="Exit to Menu" data-fa="خروج به منو">Exit to Menu</button>
    `;
    modal.appendChild(modalContent);
    document.body.appendChild(modal);

    const exitButton = document.getElementById('exit-to-menu') as HTMLElement;
    exitButton.addEventListener('click', () => {
      modal!.style.display = 'none';
      window.exitGame();
    });

    // Update language
    const lang = document.documentElement.lang || 'en';
    modalContent.querySelectorAll('[data-en]').forEach(el => {
      el.textContent = el.getAttribute(`data-${lang}`);
    });
  }

  const rankingsDiv = document.getElementById('rankings') as HTMLElement;
  const rankings = Object.entries(playersClient)
    .filter(([_, player]) => player.rank)
    .sort((a, b) => (a[1].rank! - b[1].rank!))
    .map(([id, player]) => {
      const rankText = document.documentElement.lang === 'fa' ? `رتبه ${player.rank}` : `Rank ${player.rank}`;
      return `<p>${id === playerId ? 'You' : `Player ${id}`}: ${rankText}</p>`;
    })
    .join('');
  rankingsDiv.innerHTML = rankings || (document.documentElement.lang === 'fa' ? 'بدون رتبه‌بندی' : 'No rankings available');

  modal.style.display = 'flex';
}

function initMultiplayer(): void {
  const serverUrl = serverIp || process.env.SERVER_URL || 'https://game.safahanbattery.ir:8443';
  socket = io(serverUrl, {
    transports: ['websocket']
  });

  socket.on('connect', () => {
    playerId = socket!.id;
    creatorId = mode === 'create' ? playerId : null;
    if (mode === 'create') {
      hexagons.forEach(pos => createHexagon(pos, true));
      createSphere(playerId!, { x: 0, y: 5, z: 0 }, true);
      serverStartTime = Date.now() + startTimer * 1000;
      socket!.emit('create-game', { startTimer, serverStartTime });
    } else {
      socket!.emit('join-game', { gameId });
    }
    console.log('Connected:', { playerId, creatorId, mode, gameId });
  });

  socket.on('init', (data: { gameId: string, creatorId: string, players: { id: string; position: { x: number; y: number; z: number } }[], hexagons: { x: number; y: number; z: number }[], startTimer: number, serverStartTime: number }) => {
    gameId = data.gameId;
    creatorId = data.creatorId;
    startTimer = data.startTimer;
    serverStartTime = data.serverStartTime;
    data.hexagons.forEach(pos => createHexagon(pos, true));
    data.players.forEach(player => {
      if (player.id !== playerId || !playersClient[player.id]) {
        createSphere(player.id, player.position, player.id === creatorId);
      }
    });
    totalPlayers = data.players.length;
    physicsEnabled = false;
    if (ballRigidBody) ballRigidBody.setEnabled(false);
    startCountdown(startTimer, serverStartTime);
    console.log('Init received:', { gameId, creatorId, players: data.players, startTimer, serverStartTime });
  });

  socket.on('new-player', (data: { id: string; position: { x: number; y: number; z: number } }) => {
    if (data.id !== playerId && !playersClient[data.id]) {
      createSphere(data.id, data.position, data.id === creatorId);
      totalPlayers++;
    }
    console.log('New player:', data);
  });

  socket.on('player-moved', (data: { id: string; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } }) => {
    const player = playersClient[data.id];
    if (player && data.id !== playerId && !player.eliminated) {
      player.mesh.position.set(data.position.x, data.position.y, data.position.z);
      player.mesh.quaternion.set(data.rotation.x, data.rotation.y, data.rotation.z, data.rotation.w);
    }
    console.log('Player moved:', data);
  });

  socket.on('player-jumped', (data: { id: string }) => {
    if (data.id !== playerId) {
      const player = playersClient[data.id];
      if (player && !player.eliminated) {
        player.mesh.position.y += 0.1; // Visual jump effect
      }
    }
    console.log('Player jumped:', data);
  });

  socket.on('player-disconnected', (data: { id: string }) => {
    const player = playersClient[data.id];
    if (player && !player.eliminated) {
      player.eliminated = true;
      player.rank = Object.entries(playersClient).filter(([_, p]) => !p.eliminated).length + 1;
      scene.remove(player.mesh);
      rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
      delete playersClient[data.id];
      console.log(`Player ${data.id} disconnected with rank ${player.rank}`);
      checkPlayerElimination();
    }
  });

  socket.on('player-eliminated', (data: { id: string; rank: number }) => {
    const player = playersClient[data.id];
    if (player && !player.eliminated) {
      player.eliminated = true;
      player.rank = data.rank;
      if (data.id !== playerId) {
        scene.remove(player.mesh);
        rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
      }
      console.log(`Player ${data.id} eliminated with rank ${data.rank}`);
      checkPlayerElimination();
    }
  });

  socket.on('hexagon-broken', (data: { index: number }) => {
    const hexagon = hexagonsClient[data.index];
    if (hexagon && !hexagon.isBreaking) {
      breakHexagon(hexagon);
    }
    console.log('Hexagon broken:', data);
  });

  socket.on('game-ended', () => {
    window.exitGame();
    alert('Game ended: Host disconnected');
  });

  socket.on('error', (data: { message: string }) => {
    console.error('Server error:', data.message);
    alert(data.message);
  });

  socket.on('connect_error', (err: any) => {
    console.error('Socket.IO connection error:', err);
    alert('Failed to connect to server. Please try again.');
  });
}

function togglePause(): void {
  const pauseModal = document.getElementById('pause-modal') as HTMLElement;
  if (!isPaused && !isSpectating) {
    isPaused = true;
    pauseModal.style.display = 'flex';
    if (ballRigidBody) {
      ballRigidBody.setEnabled(false);
    }
    if (animationFrameId && mode === 'single') {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    document.exitPointerLock();
    console.log('Game paused:', { mode, isPaused });
  } else if (isPaused) {
    isPaused = false;
    pauseModal.style.display = 'none';
    if (ballRigidBody) {
      ballRigidBody.setEnabled(true);
    }
    if (mode === 'single' && !animationFrameId) {
      animate(performance.now());
    }
    if (!isMobileUserAgent) { renderer.domElement.requestPointerLock() }
    console.log('Game resumed:', { mode, isPaused });
  }
}

window.resumeGame = function resumeGame(): void {
  if (isSpectating) return;
  isPaused = false;
  const pauseModal = document.getElementById('pause-modal') as HTMLElement;
  pauseModal.style.display = 'none';
  if (ballRigidBody) {
    ballRigidBody.setEnabled(true);
  }
  if (mode === 'single' && !animationFrameId) {
    animate(performance.now());
  }
  if (!isMobileUserAgent) { renderer.domElement.requestPointerLock() }
  console.log('Resume game called');
};

window.exitGame = function exitGame(): void {
  isPaused = false;
  isSpectating = false;
  if (eliminationCheckInterval) {
    clearInterval(eliminationCheckInterval);
    eliminationCheckInterval = null;
  }
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  scene.clear();
  rigidBodies = [];
  hexagonsClient = [];
  playersClient = {};
  ballRigidBody = null;
  ballCollider = null;
  world = null;
  eventQueue = null;
  gameId = null;
  playerRank = null;
  totalPlayers = 0;
  serverStartTime = null;
  const canvas = renderer.domElement;
  if (canvas && canvas.parentNode) {
    canvas.parentNode.removeChild(canvas);
  }
  document.querySelector('header')!.classList.remove('hidden');
  document.querySelector('aside')!.classList.remove('hidden');
  document.querySelector('main')!.classList.remove('hidden');
  const countdownElement = document.getElementById('countdown') as HTMLElement;
  countdownElement.style.display = 'none';
  const endGameModal = document.getElementById('end-game-modal');
  if (endGameModal) endGameModal.style.display = 'none';
  const joystick = document.querySelector(".joystick") as HTMLElement;
  const jumpButton = document.querySelector(".jump-button") as HTMLElement;
  if (joystick) joystick.style.display = 'none';
  if (jumpButton) jumpButton.style.display = 'none';
  document.body.style.cursor = "default";
  document.exitPointerLock();
  console.log('Game exited');
};

function animate(time: number): void {
  if ((isPaused && mode === 'single') || !world) return;
  animationFrameId = requestAnimationFrame(animate);

  if (eventQueue) {
    handleJumping();
    handleMovement();
    eventQueue.drainCollisionEvents((handle1: number, handle2: number, started: boolean) => {
      if (started) {
        const collider1: RAPIER.Collider = world!.getCollider(handle1);
        const collider2: RAPIER.Collider = world!.getCollider(handle2);
        if (ballCollider && (collider1 === ballCollider || collider2 === ballCollider)) {
          const hexagon = hexagonsClient.find((h) => h.collider === collider1 || h.collider === collider2);
          if (hexagon && !hexagon.isBreaking) {
            hexagon.collisionCount++;
            canJump = true;
            if (hexagon.collisionCount === 1 && ballCollider) {
              ballCollider.setRestitution(0);
            }
            if (hexagon.collisionCount >= 3) {
              breakHexagon(hexagon);
              if (socket && gameId) {
                const index = hexagonsClient.indexOf(hexagon);
                socket.emit('break-hexagon', { gameId, index });
              }
            }
          } else {
            const otherPlayer = Object.values(playersClient).find(
              (p) => p.collider === collider1 || p.collider === collider2
            );
            if (otherPlayer && ballCollider && (collider1 === ballCollider || collider2 === ballCollider)) {
              collisionSound.play();
            }
          }
        }
      }
    });
    if (physicsEnabled) {
      world.step(eventQueue);
    }

    rigidBodies.forEach(({ mesh, rigidBody }) => {
      if (rigidBody && physicsEnabled) {
        const position = rigidBody.translation();
        const rotation = rigidBody.rotation();
        mesh.position.set(position.x, position.y, position.z);
        mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
        if (mode !== 'single' && socket && playerId && playersClient[playerId]?.rigidBody === rigidBody && gameId) {
          socket.emit('move', { gameId, id: playerId, position, rotation });
        }
      }
    });
  }

  // Camera update
  let targetPlayerId: string | null = null;
  if (isSpectating) {
    const alivePlayers = Object.entries(playersClient).filter(([_, player]) => !player.eliminated);
    targetPlayerId = alivePlayers.length > 0 ? alivePlayers[0][0] : null;
  } else {
    targetPlayerId = mode === 'single' ? 'local' : playerId;
  }

  let spherePosition = { x: 0, y: 0, z: 0 };
  if (targetPlayerId && playersClient[targetPlayerId]) {
    spherePosition = playersClient[targetPlayerId].mesh.position;
  }

  const offsetDistance: number = 10;
  const offsetHeight: number = 5;
  camera.position.set(
    spherePosition.x - offsetDistance * Math.cos(cameraAzimuth),
    spherePosition.y + offsetHeight,
    spherePosition.z - offsetDistance * Math.sin(cameraAzimuth)
  );
  camera.lookAt(spherePosition.x, spherePosition.y, spherePosition.z);

  tweenGroup.update(time);
  renderer.render(scene, camera);
}

function init(): void {
  initPhysics();
  if (mode === 'single') {
    hexagons.forEach(pos => createHexagon(pos));
    createSphere('local', { x: 0, y: 5, z: 0 }, true);
    totalPlayers = 1;
    startCountdown(5);
  } else {
    initMultiplayer();
  }

  // Add UI elements
  const style: HTMLStyleElement = document.createElement('style');
  style.textContent = `
    @media (min-width: 769px) {
      .joystick, .jump-button {
        display: none;
      }
    }
  `;
  document.body.style.cursor = "none";
  document.head.appendChild(style);

  const joystick: HTMLDivElement = document.createElement('div');
  joystick.className = 'joystick';
  const joystickInner: HTMLDivElement = document.createElement('div');
  joystickInner.className = 'joystick-inner';
  joystick.appendChild(joystickInner);
  document.body.appendChild(joystick);

  const jumpButton: HTMLDivElement = document.createElement('div');
  jumpButton.className = 'jump-button';
  jumpButton.textContent = document.documentElement.lang === 'fa' ? 'پرش' : 'Jump';
  jumpButton.addEventListener('touchstart', (event) => {
    event.stopPropagation();
    keys.space = true;
  });
  jumpButton.addEventListener('touchend', (event) => {
    event.stopPropagation();
    keys.space = false;
  });
  document.body.appendChild(jumpButton);

  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (isSpectating) return;
    switch (event.key.toLowerCase()) {
      case 'w': keys.w = true; break;
      case 'a': keys.a = true; break;
      case 's': keys.s = true; break;
      case 'd': keys.d = true; break;
      case ' ': keys.space = true; break;
      case 'escape':
        if (!keys.escape) {
          keys.escape = true;
          togglePause();
        }
        break;
    }
    if (!isPaused && !isMobileUserAgent) renderer.domElement.requestPointerLock();
  });

  window.addEventListener('keyup', (event: KeyboardEvent) => {
    switch (event.key.toLowerCase()) {
      case 'w': keys.w = false; break;
      case 'a': keys.a = false; break;
      case 's': keys.s = false; break;
      case 'd': keys.d = false; break;
      case ' ': keys.space = false; break;
      case 'escape': keys.escape = false; break;
    }
  });

  window.addEventListener('touchstart', handleTouchStart, { passive: false });
  window.addEventListener('touchmove', handleTouchMove, { passive: false });
  window.addEventListener('touchend', handleTouchEnd, { passive: false });
  window.addEventListener('mousemove', handleMouseMove);

  const canvas = renderer.domElement;
  if (!isMobileUserAgent) { canvas.requestPointerLock() }

  document.addEventListener('pointerlockerror', () => { });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    updateJoystickCenter();
  });

  animate(performance.now());
}