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
let lastMovePosition: { x: number; y: number; z: number } | null = null;
let lastMoveRotation: { x: number; y: number; z: number; w: number } | null = null;
let lastFrameTime: number = performance.now();
lastFrameTime == 0;
let lastGroundedHexId: string | null = null;
let canJump: boolean = true;
let canJumpUntil: number = 0;
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
let jumpSound!: THREE.Audio;
let collisionSound!: THREE.Audio;
let breakSound!: THREE.Audio;
const hexagonMaterial = new THREE.MeshStandardMaterial({
  color: 0x00ff00,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 1,
});

// Collision groups
const ALL_INTERACTION = 0x00010001;

let scene!: THREE.Scene;
let camera!: THREE.PerspectiveCamera;
let renderer!: THREE.WebGLRenderer;
let audioListener!: THREE.AudioListener;
let world: RAPIER.World | null = null;
let eventQueue: RAPIER.EventQueue | null = null;
let rigidBodies: { mesh: THREE.Mesh; rigidBody?: RAPIER.RigidBody; collider?: RAPIER.Collider }[] = [];
let hexagonsClient: {
  id: string;
  mesh: THREE.Mesh;
  rigidBody?: RAPIER.RigidBody;
  collider?: RAPIER.Collider;
  collisionCount: number;
  isBreaking: boolean;
}[] = [];

function isMobileUserAgent(): boolean {
  const userAgent = navigator.userAgent;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
}

const hexagons: { x: number; y: number; z: number }[] = [
  { x: 0, y: 0, z: 0 },
  { x: 4, y: 0, z: 0 },
  { x: -4, y: 0, z: 0 },
  { x: 2, y: 0, z: (4 * Math.sqrt(3)) / 2 },
  { x: -2, y: 0, z: (4 * Math.sqrt(3)) / 2 },
  { x: 6, y: 0, z: (4 * Math.sqrt(3)) / 2 },
  { x: -6, y: 0, z: (4 * Math.sqrt(3)) / 2 },
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

function breakHexagon(
  hexagon: {
    id: string;
    mesh: THREE.Mesh;
    rigidBody?: RAPIER.RigidBody;
    collider?: RAPIER.Collider;
    collisionCount: number;
    isBreaking: boolean;
  }
): void {
  if (hexagon.isBreaking) return;
  hexagon.isBreaking = true;
  canJump = true;
  console.log(performance.now())
  canJumpUntil = performance.now() + 1000;
  console.log(canJumpUntil);

  try {
    if (hexagon.collider && world) {
      world.removeCollider(hexagon.collider, false);
    }
  } catch (e) {
    // swallow if collider already removed
  }

  if (breakSound && breakSound.isPlaying === false) {
    breakSound.play();
  }

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
      try {
        scene.remove(hexagon.mesh);
      } catch (e) { }
      try {
        if (hexagon.rigidBody && world) {
          world.removeRigidBody(hexagon.rigidBody);
        }
      } catch (e) { }
      rigidBodies = rigidBodies.filter((body) => body.mesh !== hexagon.mesh);
      hexagonsClient = hexagonsClient.filter((h) => h !== hexagon);
    });
  tweenGroup.add(tween);
  tween.start();
}

function handleJumping(): void {
  if (!ballRigidBody || isSpectating) return;

  if (keys.space && (canJump || canJumpUntil > performance.now())) {
    let jumpPower = 4; // default jump power

    if (canJumpUntil + 1600 > performance.now()) {
      jumpPower = 10; // boosted jump power for breaking hex
    }

    try {
      ballRigidBody.applyImpulse({ x: 0, y: jumpPower, z: 0 }, true);
    } catch (e) { }

    if (ballCollider) {
      try { ballCollider.setRestitution(0); } catch (e) { }
    }

    if (jumpSound && jumpSound.isPlaying === false) jumpSound.play();
    keys.space = false;
    canJump = false;
    canJumpUntil = 0;

    if (socket && playerId && gameId) {
      try { socket.emit('jump', { gameId, id: playerId }); } catch (e) { }
    }
  }
}

let physicsEnabled: boolean = false;

function animate(time: number): void {
  // keep the loop alive
  animationFrameId = requestAnimationFrame(animate);

  lastFrameTime = time;

  // Basic guards
  if (!scene || !camera || !renderer) return;

  // If single-player and paused, render a static frame and don't advance physics
  if (isPaused && mode === 'single') {
    renderer.render(scene, camera);
    return;
  }

  // Step physics only when world exists and physics is enabled
  if (world && physicsEnabled) {
    try {
      if (eventQueue) {
        // some Rapier builds accept an EventQueue
        world.step(eventQueue);
      } else {
        world.step();
      }
    } catch (e) {
      try { world.step(); } catch (err) { /* ignore */ }
    }
  }

  // --- Update meshes from rigid bodies ---
  for (const entry of rigidBodies) {
    const { mesh, rigidBody } = entry;
    if (rigidBody) {
      try {
        const pos = rigidBody.translation();
        const rot = rigidBody.rotation();
        mesh.position.set(pos.x, pos.y, pos.z);
        mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      } catch (e) {
        // reading translation/rotation might fail if body removed; ignore
      }
    }
  }

  // --- Landing / grounding detection (proximity-based) ---
  let isGrounded = false;
  let contactedHexagon: typeof hexagonsClient[0] | null = null;

  if (ballRigidBody) {
    contactedHexagon = getContactedHexagon();
    if (contactedHexagon) isGrounded = true;
  }

  // update canJump from grounding state (so player can press space to jump)
  canJump = isGrounded;

  // detect a *new landing* (was not grounded last frame, now is)
  if (isGrounded && contactedHexagon) {
    if (lastGroundedHexId !== contactedHexagon.id) {
      // new landing on this hex
      contactedHexagon.collisionCount = (contactedHexagon.collisionCount || 0) + 1;
      console.log(`Landed on ${contactedHexagon.id} count=${contactedHexagon.collisionCount}`);

      if (contactedHexagon.collisionCount === 1) {
        try { collisionSound.play(); } catch (e) { }
      }

      if (contactedHexagon.collisionCount >= 3) {
        breakHexagon(contactedHexagon);

        // emit break event only for this hex index (multiplayer sync)
        if (socket && gameId) {
          const index = hexagonsClient.indexOf(contactedHexagon);
          if (index >= 0) {
            try { socket.emit('break-hexagon', { gameId, index, playerId }); } catch (e) { }
          }
        }

        // reset counter for safety
        contactedHexagon.collisionCount = 0;
      }
    }
    // remember current grounded hex id
    lastGroundedHexId = contactedHexagon.id;
  } else {
    // not grounded -> clear last grounded so next landing counts
    lastGroundedHexId = null;
  }

  // --- Input handling (jump & movement) ---
  handleJumping();
  try { handleMovement(); } catch (e) { }

  // --- Send movement updates for our player in multiplayer ---
  if (mode !== 'single' && socket && playerId && ballRigidBody) {
    try {
      const pos = ballRigidBody.translation();
      const rot = ballRigidBody.rotation();
      const roundedPosition = { x: Number(pos.x.toFixed(2)), y: Number(pos.y.toFixed(2)), z: Number(pos.z.toFixed(2)) };
      const roundedRotation = { x: Number(rot.x.toFixed(2)), y: Number(rot.y.toFixed(2)), z: Number(rot.z.toFixed(2)), w: Number(rot.w.toFixed(2)) };

      const positionChanged =
        !lastMovePosition ||
        Math.abs(roundedPosition.x - lastMovePosition.x) > 0.01 ||
        Math.abs(roundedPosition.y - lastMovePosition.y) > 0.01 ||
        Math.abs(roundedPosition.z - lastMovePosition.z) > 0.01;
      const rotationChanged =
        !lastMoveRotation ||
        Math.abs(roundedRotation.x - lastMoveRotation.x) > 0.01 ||
        Math.abs(roundedRotation.y - lastMoveRotation.y) > 0.01 ||
        Math.abs(roundedRotation.z - lastMoveRotation.z) > 0.01 ||
        Math.abs(roundedRotation.w - lastMoveRotation.w) > 0.01;

      if (positionChanged || rotationChanged) {
        try { socket.emit('move', { gameId, id: playerId, position: roundedPosition, rotation: roundedRotation }); } catch (e) { }
        lastMovePosition = roundedPosition;
        lastMoveRotation = roundedRotation;
      }
    } catch (e) {
      // ignore translation/rotation read errors
    }
  }

  // --- Camera follow logic ---
  let targetPlayerId: string | null = null;
  if (isSpectating) {
    const alivePlayers = Object.entries(playersClient).filter(([_, p]) => !p.eliminated);
    targetPlayerId = alivePlayers.length > 0 ? alivePlayers[0][0] : null;
  } else {
    targetPlayerId = mode === 'single' ? 'local' : playerId;
  }

  let spherePosition = { x: 0, y: 0, z: 0 };
  if (targetPlayerId && playersClient[targetPlayerId]) {
    const mp = playersClient[targetPlayerId].mesh.position;
    spherePosition = { x: mp.x, y: mp.y, z: mp.z };
  }

  const offsetDistance = 10;
  const offsetHeight = 5;
  camera.position.set(
    spherePosition.x - offsetDistance * Math.cos(cameraAzimuth),
    spherePosition.y + offsetHeight,
    spherePosition.z - offsetDistance * Math.sin(cameraAzimuth)
  );
  camera.lookAt(spherePosition.x, spherePosition.y, spherePosition.z);

  // update tweens and render
  try { tweenGroup.update(time); } catch (e) { }
  renderer.render(scene, camera);
}


// Other functions (mostly unchanged)
function initPhysics(): void {
  const gravity = { x: 0, y: -9.81, z: 0 };
  world = new RAPIER.World(gravity);
  try {
    eventQueue = new RAPIER.EventQueue(true);
  } catch (e) {
    // some builds might not accept parameter; try fallback
    try {
      // @ts-ignore
      eventQueue = new RAPIER.EventQueue();
    } catch (err) {
      eventQueue = null;
    }
  }
}

function createHexagonShape(radius: number = 2, height: number = 1): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const vertices: number[] = [];
  const indices: number[] = [];
  const angle: number = Math.PI / 3;

  // top ring (0..5)
  for (let i = 0; i < 6; i++) {
    const x: number = radius * Math.cos(i * angle);
    const z: number = radius * Math.sin(i * angle);
    vertices.push(x, height / 2, z);
  }

  // bottom ring (6..11)
  for (let i = 0; i < 6; i++) {
    const x: number = radius * Math.cos(i * angle);
    const z: number = radius * Math.sin(i * angle);
    vertices.push(x, -height / 2, z);
  }

  // center top (12) and center bottom (13)
  vertices.push(0, height / 2, 0);
  vertices.push(0, -height / 2, 0);

  // top faces (fan from center top 12)
  for (let i = 0; i < 6; i++) {
    indices.push(12, i, (i + 1) % 6);
  }

  // bottom faces (fan from center bottom 13) -- note winding order reversed
  for (let i = 0; i < 6; i++) {
    indices.push(13, 6 + ((i + 1) % 6), 6 + i);
  }

  // side faces
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
  const mesh: THREE.Mesh = new THREE.Mesh(geometry, hexagonMaterial.clone());
  mesh.position.set(position.x, position.y, position.z);
  scene.add(mesh);

  const id = `hex-${position.x}-${position.y}-${position.z}-${Date.now()}-${Math.random()}`;

  if (isLocal && world) {
    const vertices: Float32Array = new Float32Array(geometry.attributes.position.array as Iterable<number>);
    let colliderDesc: RAPIER.ColliderDesc | null = null;
    try {
      // try convex hull
      colliderDesc = RAPIER.ColliderDesc.convexHull(vertices)!
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(ALL_INTERACTION)
        .setSolverGroups(ALL_INTERACTION);
    } catch (e) {
      // fallback to triangle mesh or cuboid if convexHull not available
      try {
        colliderDesc = RAPIER.ColliderDesc.cuboid(2, 0.5, 2)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
          .setCollisionGroups(ALL_INTERACTION)
          .setSolverGroups(ALL_INTERACTION);
      } catch (err) {
        colliderDesc = null;
      }
    }

    const rigidBodyDesc: RAPIER.RigidBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z);
    const rigidBody: RAPIER.RigidBody = world.createRigidBody(rigidBodyDesc);
    let collider: RAPIER.Collider | undefined = undefined;
    if (colliderDesc) {
      collider = world.createCollider(colliderDesc, rigidBody);
    }

    const hexagon = { id, mesh, rigidBody, collider, collisionCount: 0, isBreaking: false };
    hexagonsClient.push(hexagon);
    rigidBodies.push({ mesh, rigidBody, collider });
  } else {
    const hexagon = { id, mesh, collisionCount: 0, isBreaking: false };
    hexagonsClient.push(hexagon);
    rigidBodies.push({ mesh });
  }
}

function createSphere(id: string, position: { x: number; y: number; z: number }, isCreator: boolean = false): void {
  const geometry: THREE.SphereGeometry = new THREE.SphereGeometry(0.5, 16, 16);
  const material: THREE.MeshStandardMaterial = new THREE.MeshStandardMaterial({ color: isCreator ? 0xff0000 : 0x0000ff });
  const mesh: THREE.Mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position.x, position.y, position.z);
  scene.add(mesh);

  if (world) {
    const rigidBodyDesc: RAPIER.RigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setLinearDamping(0.3);
    const rigidBody: RAPIER.RigidBody = world.createRigidBody(rigidBodyDesc);
    const colliderDesc: RAPIER.ColliderDesc = RAPIER.ColliderDesc.ball(0.5)
      .setRestitution(0.8)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setCollisionGroups(ALL_INTERACTION)
      .setSolverGroups(ALL_INTERACTION);
    const collider: RAPIER.Collider = world.createCollider(colliderDesc, rigidBody);
    rigidBodies.push({ mesh, rigidBody, collider });
    playersClient[id] = { mesh, rigidBody, collider, eliminated: false };
    if (id === playerId || (mode === 'single' && id === 'local')) {
      ballRigidBody = rigidBody;
      ballCollider = collider;
      // disable until countdown ends
      try {
        ballRigidBody.setEnabled(false);
      } catch (e) { }
    }
  } else {
    playersClient[id] = { mesh, eliminated: false };
    rigidBodies.push({ mesh });
  }
}

function handleMovement(): void {
  if (!ballRigidBody || isPaused || isSpectating || !physicsEnabled) return;
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
    try {
      ballRigidBody.applyImpulse({ x: impulseX, y: 0, z: impulseZ }, true);
    } catch (e) { }
  }
}

function getContactedHexagon(): typeof hexagonsClient[0] | null {
  if (!ballRigidBody) return null;
  try {
    const ballPos = ballRigidBody.translation();
    for (const hex of hexagonsClient) {
      if (!hex || hex.isBreaking) continue;
      // horizontal distance (x,z)
      const dx = ballPos.x - hex.mesh.position.x;
      const dz = ballPos.z - hex.mesh.position.z;
      const horizontalDist = Math.sqrt(dx * dx + dz * dz);
      // vertical difference: ball above/below hex center
      const verticalDiff = ballPos.y - hex.mesh.position.y;
      // thresholds: tune as needed (hex radius ~2, ball radius 0.5)
      if (horizontalDist < 2.5 && verticalDiff <= 1.1 && verticalDiff >= -1.0) {
        return hex;
      }
    }
  } catch (e) {
    // if anything goes wrong with reading translation, treat as no contact
    return null;
  }
  return null;
}


function isTouchInJoystick(touch: Touch): boolean {
  const joystick = document.querySelector('.joystick') as HTMLElement | null;
  if (!joystick) return false;
  const rect = joystick.getBoundingClientRect();
  return touch.clientX >= rect.left && touch.clientX <= rect.right && touch.clientY >= rect.top && touch.clientY <= rect.bottom;
}

function isTouchInJumpButton(touch: Touch): boolean {
  const jumpButton = document.querySelector('.jump-button') as HTMLElement | null;
  if (!jumpButton) return false;
  const rect = jumpButton.getBoundingClientRect();
  return touch.clientX >= rect.left && touch.clientX <= rect.right && touch.clientY >= rect.top && touch.clientY <= rect.bottom;
}

function updateJoystickCenter(): void {
  const joystick = document.querySelector('.joystick') as HTMLElement | null;
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
      const joystickInner = document.querySelector('.joystick-inner') as HTMLElement | null;
      if (joystickInner) {
        // use pixel transform to avoid percentage math confusion
        joystickInner.style.transform = `translate(${joystickX * 30}px, ${joystickY * 30}px)`;
      }
    } else if (touch.identifier === rotationTouchId) {
      const deltaX = touch.clientX - touchStartX;
      cameraAzimuth += deltaX * 0.002;
      touchStartX = touch.clientX;
      if (socket && playerId && gameId) {
        try {
          socket.emit('rotate', { gameId, id: playerId, cameraAzimuth: Number(cameraAzimuth.toFixed(2)) });
        } catch (e) { }
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
      const joystickInner = document.querySelector('.joystick-inner') as HTMLElement | null;
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
  const deltaX: number = (event as any).movementX || 0;
  cameraAzimuth += deltaX * sensitivity;
  if (socket && playerId && gameId) {
    try {
      socket.emit('rotate', { gameId, id: playerId, cameraAzimuth: Number(cameraAzimuth.toFixed(2)) });
    } catch (e) { }
  }
}

function startCountdown(seconds: number, serverTime?: number): void {
  const countdownElement = document.getElementById('countdown') as HTMLElement | null;
  if (!countdownElement) return;
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
        try {
          ballRigidBody.setEnabled(true);
        } catch (e) { }
      }
      if (eliminationCheckInterval) clearInterval(eliminationCheckInterval);
      eliminationCheckInterval = setInterval(checkPlayerElimination, 100);
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
      const rank = mode === 'single' ? 1 : alivePlayers.length;
      player.rank = rank;
      if (id === playerId || (mode === 'single' && id === 'local')) {
        playerRank = rank;
        isSpectating = true;
        if (ballRigidBody) {
          try {
            ballRigidBody.setEnabled(false);
          } catch (e) { }
          try {
            scene.remove(player.mesh);
          } catch (e) { }
          rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
        }
        const joystick = document.querySelector('.joystick') as HTMLElement | null;
        const jumpButton = document.querySelector('.jump-button') as HTMLElement | null;
        if (joystick) joystick.style.display = 'none';
        if (jumpButton) jumpButton.style.display = 'none';
        if (socket && playerId && gameId) {
          try {
            socket.emit('player-eliminated', { gameId, id: playerId, rank });
          } catch (e) { }
        }
        if (mode === 'single') {
          showEndGameModal();
        }
      } else if (player.rigidBody) {
        try {
          world!.removeRigidBody(player.rigidBody);
        } catch (e) { }
        try {
          scene.remove(player.mesh);
        } catch (e) { }
        rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
      }
    }
  });

  if (mode !== 'single') {
    const remainingPlayers = Object.entries(playersClient).filter(([_, player]) => !player.eliminated);
    if (remainingPlayers.length === 1 && !isSpectating) {
      const [id, player] = remainingPlayers[0];
      player.rank = 1;
      if (id === playerId) {
        playerRank = 1;
        isSpectating = true;
        if (ballRigidBody) {
          try {
            ballRigidBody.setEnabled(false);
          } catch (e) { }
          try {
            scene.remove(player.mesh);
          } catch (e) { }
          rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
        }
        const joystick = document.querySelector('.joystick') as HTMLElement | null;
        const jumpButton = document.querySelector('.jump-button') as HTMLElement | null;
        if (joystick) joystick.style.display = 'none';
        if (jumpButton) jumpButton.style.display = 'none';
        if (socket && playerId && gameId) {
          try {
            socket.emit('player-eliminated', { gameId, id: playerId, rank: 1 });
          } catch (e) { }
        }
      }
      showEndGameModal();
    } else if (remainingPlayers.length === 0) {
      showEndGameModal();
    }
  }
}

function showEndGameModal(): void {
  let modal = document.getElementById('end-game-modal') as HTMLElement | null;
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

    const exitButton = document.getElementById('exit-to-menu') as HTMLElement | null;
    if (exitButton) {
      exitButton.addEventListener('click', () => {
        if (modal) modal.style.display = 'none';
        window.exitGame();
      });
    }

    const lang = document.documentElement.lang || 'en';
    modalContent.querySelectorAll('[data-en]').forEach((el) => {
      const attr = el.getAttribute(`data-${lang}`);
      if (attr) el.textContent = attr;
    });
  }

  const rankingsDiv = document.getElementById('rankings') as HTMLElement | null;
  if (!rankingsDiv) return;
  const rankings = Object.entries(playersClient)
    .filter(([_, player]) => player.rank)
    .sort((a, b) => a[1].rank! - b[1].rank!)
    .map(([id, player]) => {
      const rankText = document.documentElement.lang === 'fa' ? `رتبه ${player.rank}` : `Rank ${player.rank}`;
      return `<p>${id === playerId ? 'You' : `Player ${id}`}: ${rankText}</p>`;
    })
    .join('');
  rankingsDiv.innerHTML = rankings || (document.documentElement.lang === 'fa' ? 'بدون رتبه‌بندی' : 'No rankings available');
  document.exitPointerLock();
  document.body.style.cursor = "default";
  modal.style.display = 'flex';
}

function initMultiplayer(): void {
  const serverUrl = serverIp || 'https://game.safahanbattery.ir:8443';
  socket = io(serverUrl, {
    transports: ['websocket'],
  });

  socket.on('connect', () => {
    playerId = socket!.id;
    creatorId = mode === 'create' ? playerId : null;
    if (mode === 'create') {
      hexagons.forEach((pos) => createHexagon(pos, true));
      createSphere(playerId!, { x: 0, y: 5, z: 0 }, true);
      serverStartTime = Date.now() + startTimer * 1000;
      try {
        socket!.emit('create-game', { startTimer, serverStartTime });
      } catch (e) { }
    } else {
      try {
        socket!.emit('join-game', { gameId });
      } catch (e) { }
    }
  });

  socket.on('init', (data: { gameId: string; creatorId: string; players: { id: string; position: { x: number; y: number; z: number } }[]; hexagons: { x: number; y: number; z: number }[]; startTimer: number; serverStartTime: number }) => {
    gameId = data.gameId;
    creatorId = data.creatorId;
    startTimer = data.startTimer;
    serverStartTime = data.serverStartTime;
    data.hexagons.forEach((pos) => createHexagon(pos, true));
    data.players.forEach((player) => {
      if (player.id !== playerId && !playersClient[player.id]) {
        createSphere(player.id, player.position, player.id === creatorId);
      }
    });
    totalPlayers = data.players.length;
    physicsEnabled = false;
    if (ballRigidBody) {
      try {
        ballRigidBody.setEnabled(false);
      } catch (e) { }
    }
    startCountdown(startTimer, serverStartTime);
  });

  socket.on('new-player', (data: { id: string; position: { x: number; y: number; z: number } }) => {
    if (data.id !== playerId && !playersClient[data.id]) {
      createSphere(data.id, data.position, data.id === creatorId);
      totalPlayers++;
    }
  });

  socket.on('player-moved', (data: { id: string; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } }) => {
    const player = playersClient[data.id];
    if (player && data.id !== playerId && !player.eliminated) {
      player.mesh.position.set(data.position.x, data.position.y, data.position.z);
      player.mesh.quaternion.set(data.rotation.x, data.rotation.y, data.rotation.z, data.rotation.w);
      if (player.rigidBody) {
        try {
          player.rigidBody.setTranslation({ x: data.position.x, y: data.position.y, z: data.position.z }, true);
          player.rigidBody.setRotation({ x: data.rotation.x, y: data.rotation.y, z: data.rotation.z, w: data.rotation.w }, true);
        } catch (e) { }
      }
    }
  });

  socket.on('player-jumped', (data: { id: string }) => {
    if (data.id !== playerId) {
      const player = playersClient[data.id];
      if (player && !player.eliminated && player.rigidBody) {
        try {
          player.rigidBody.applyImpulse({ x: 0, y: 4, z: 0 }, true);
        } catch (e) { }
      }
    }
  });

  socket.on('player-disconnected', (data: { id: string }) => {
    const player = playersClient[data.id];
    if (player && !player.eliminated) {
      player.eliminated = true;
      player.rank = Object.entries(playersClient).filter(([_, p]) => !p.eliminated).length + 1;
      try {
        scene.remove(player.mesh);
      } catch (e) { }
      if (player.rigidBody && world) {
        try {
          world.removeRigidBody(player.rigidBody);
        } catch (e) { }
      }
      rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
      delete playersClient[data.id];
      checkPlayerElimination();
    }
  });

  socket.on('player-eliminated', (data: { id: string; rank: number }) => {
    const player = playersClient[data.id];
    if (player && !player.eliminated) {
      player.eliminated = true;
      player.rank = data.rank;
      if (data.id !== playerId) {
        try {
          scene.remove(player.mesh);
        } catch (e) { }
        if (player.rigidBody && world) {
          try {
            world.removeRigidBody(player.rigidBody);
          } catch (e) { }
        }
        rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
      }
      checkPlayerElimination();
    }
  });

  socket.on('hexagon-broken', (data: { index: number; playerId: string }) => {
    const hexagon = hexagonsClient[data.index];
    if (hexagon && !hexagon.isBreaking && data.playerId !== playerId) {
      console.log(`Received hexagon-broken event for hexagon ${hexagon.id} from player ${data.playerId}`);
      breakHexagon(hexagon);
    }
  });

  socket.on('game-ended', () => {
    window.exitGame();
    alert('Game ended: Host disconnected');
  });

  socket.on('error', (data: { message: string }) => {
    alert(data.message);
  });

  socket.on('connect_error', () => {
    alert('Failed to connect to server. Please try again.');
  });
}

function togglePause(): void {
  const pauseModal = document.getElementById('pause-modal') as HTMLElement | null;
  if (!pauseModal) return;

  if (!isPaused && !isSpectating) {
    isPaused = true;
    pauseModal.style.display = 'flex';
    if (ballRigidBody) {
      try {
        ballRigidBody.setEnabled(false);
      } catch (e) { }
    }
    if (animationFrameId && mode === 'single') {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    try {
      if (document.exitPointerLock) document.exitPointerLock();
    } catch (e) { }
  } else if (isPaused) {
    isPaused = false;
    pauseModal.style.display = 'none';
    if (ballRigidBody) {
      try {
        ballRigidBody.setEnabled(true);
      } catch (e) { }
    }
    if (mode === 'single' && !animationFrameId) {
      animate(performance.now());
    }
    try {
      if (!isMobileUserAgent() && renderer && renderer.domElement && (renderer.domElement.requestPointerLock)) {
        renderer.domElement.requestPointerLock();
      }
    } catch (e) { }
  }
}

window.resumeGame = function resumeGame(): void {
  if (isSpectating) return;
  isPaused = false;
  const pauseModal = document.getElementById('pause-modal') as HTMLElement | null;
  if (pauseModal) pauseModal.style.display = 'none';
  if (ballRigidBody) {
    try {
      ballRigidBody.setEnabled(true);
    } catch (e) { }
  }
  if (mode === 'single' && !animationFrameId) {
    animate(performance.now());
  }
  try {
    if (!isMobileUserAgent() && renderer && renderer.domElement && (renderer.domElement.requestPointerLock)) {
      renderer.domElement.requestPointerLock();
    }
  } catch (e) { }
};

window.exitGame = function exitGame(): void {
  isPaused = false;
  isSpectating = false;
  if (eliminationCheckInterval) {
    clearInterval(eliminationCheckInterval);
    eliminationCheckInterval = null;
  }
  if (socket) {
    try {
      socket.disconnect();
    } catch (e) { }
    socket = null;
  }
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (scene) {
    try { scene.clear(); } catch (e) { }
  }
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
  lastMovePosition = null;
  lastMoveRotation = null;
  canJump = true;
  const canvas = renderer?.domElement;
  if (canvas && canvas.parentNode) {
    canvas.parentNode.removeChild(canvas);
  }
  const header = document.querySelector('header');
  const aside = document.querySelector('aside');
  const main = document.querySelector('main');
  if (header) header.classList.remove('hidden');
  if (aside) aside.classList.remove('hidden');
  if (main) main.classList.remove('hidden');
  const countdownElement = document.getElementById('countdown') as HTMLElement | null;
  if (countdownElement) countdownElement.style.display = 'none';
  const endGameModal = document.getElementById('end-game-modal');
  if (endGameModal) (endGameModal as HTMLElement).style.display = 'none';
  const joystick = document.querySelector('.joystick') as HTMLElement | null;
  const jumpButton = document.querySelector('.jump-button') as HTMLElement | null;
  if (joystick) joystick.style.display = 'none';
  if (jumpButton) jumpButton.style.display = 'none';
  document.body.style.cursor = 'default';
  try {
    if (document.exitPointerLock) document.exitPointerLock();
  } catch (e) { }
};

function init(): void {
  initPhysics();
  if (mode === 'single') {
    hexagons.forEach((pos) => createHexagon(pos));
    createSphere('local', { x: 0, y: 5, z: 0 }, true);
    totalPlayers = 1;
    startCountdown(5);
  } else {
    initMultiplayer();
  }

  const style: HTMLStyleElement = document.createElement('style');
  style.textContent = `
    @media (min-width: 769px) {
      .joystick, .jump-button {
        display: none;
      }
    }
  `;
  document.body.style.cursor = 'none';
  document.head.appendChild(style);

  const joystick: HTMLDivElement = document.createElement('div');
  joystick.className = 'joystick';
  const joystickInner: HTMLDivElement = document.createElement('div');
  joystickInner.className = 'joystick-inner';
  joystickInner.style.transform = 'translate(-50%, -50%)';
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
      case 'w':
        keys.w = true;
        break;
      case 'a':
        keys.a = true;
        break;
      case 's':
        keys.s = true;
        break;
      case 'd':
        keys.d = true;
        break;
      case ' ':
        keys.space = true;
        break;
      case 'escape':
        if (!keys.escape) {
          keys.escape = true;
          togglePause();
        }
        break;
    }
    try {
      if (!isPaused && !isMobileUserAgent() && renderer && renderer.domElement && (renderer.domElement.requestPointerLock)) {
        renderer.domElement.requestPointerLock();
      }
    } catch (e) { }
  });

  window.addEventListener('keyup', (event: KeyboardEvent) => {
    switch (event.key.toLowerCase()) {
      case 'w':
        keys.w = false;
        break;
      case 'a':
        keys.a = false;
        break;
      case 's':
        keys.s = false;
        break;
      case 'd':
        keys.d = false;
        break;
      case ' ':
        keys.space = false;
        break;
      case 'escape':
        keys.escape = false;
        break;
    }
  });

  window.addEventListener('touchstart', handleTouchStart, { passive: false });
  window.addEventListener('touchmove', handleTouchMove, { passive: false });
  window.addEventListener('touchend', handleTouchEnd, { passive: false });
  window.addEventListener('mousemove', handleMouseMove);

  const canvas = renderer.domElement;
  try {
    if (!isMobileUserAgent() && canvas.requestPointerLock) canvas.requestPointerLock();
  } catch (e) { }

  document.addEventListener('pointerlockerror', () => { });

  window.addEventListener('resize', () => {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    updateJoystickCenter();
  });

  lastFrameTime = performance.now();
  // start the animation loop
  if (!animationFrameId) animate(performance.now());
}

// Start function (unchanged logic but safe)
window.start = function start(gameMode: string, ip?: string, timer?: number, selectedGameId?: string): void {
  mode = gameMode;
  serverIp = ip || null;
  startTimer = timer || 30;
  gameId = selectedGameId || null;

  const header = document.querySelector('header');
  const aside = document.querySelector('aside');
  const main = document.querySelector('main');
  if (header) header.classList.add('hidden');
  if (aside) aside.classList.add('hidden');
  if (main) main.classList.add('hidden');

  const gm = document.getElementById('game-mode-modal');
  if (gm) gm.style.display = 'none';
  const jg = document.getElementById('join-game-modal');
  if (jg) jg.style.display = 'none';
  const cg = document.getElementById('create-game-modal');
  if (cg) cg.style.display = 'none';

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  audioListener = new THREE.AudioListener();
  camera.add(audioListener);
  jumpSound = new THREE.Audio(audioListener);
  collisionSound = new THREE.Audio(audioListener);
  breakSound = new THREE.Audio(audioListener);

  const audioLoader = new THREE.AudioLoader();
  audioLoader.load('/sounds/jump.mp3', (buffer) => {
    try {
      jumpSound.setBuffer(buffer).setVolume(0.5);
    } catch (e) { }
  });
  audioLoader.load('/sounds/collision.mp3', (buffer) => {
    try {
      collisionSound.setBuffer(buffer).setVolume(0.5);
    } catch (e) { }
  });
  audioLoader.load('/sounds/break.mp3', (buffer) => {
    try {
      breakSound.setBuffer(buffer).setVolume(0.5);
    } catch (e) { }
  });

  camera.position.set(0, 5, 10);
  camera.lookAt(0, 0, 0);

  const ambientLight: THREE.AmbientLight = new THREE.AmbientLight(0x404040);
  scene.add(ambientLight);
  const directionalLight: THREE.DirectionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
  directionalLight.position.set(0, 1, 0);
  scene.add(directionalLight);

  init();
};
