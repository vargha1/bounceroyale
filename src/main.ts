import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d';
import { Tween, Group, Easing } from '@tweenjs/tween.js';
import io, { Socket } from 'socket.io-client';

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
const DEATH_Y_LEVEL = -10; // Players die if they fall below this Y level
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
let playersClient: { [id: string]: { mesh: THREE.Mesh; rigidBody?: RAPIER.RigidBody; collider?: RAPIER.Collider; eliminated?: boolean; rank?: number; targetPosition?: { x: number; y: number; z: number }; targetRotation?: { x: number; y: number; z: number; w: number } } } = {};
let jumpSound!: THREE.Audio;
let collisionSound!: THREE.Audio;
let breakSound!: THREE.Audio;
let audioContextInitialized: boolean = false;

// Game features
let playerScore: number = 0;
let playerHealth: number = 100;
let powerUps: { [id: string]: { type: string; duration: number; startTime: number; active: boolean } } = {};
let particles: { mesh: THREE.Mesh; velocity: THREE.Vector3; life: number; maxLife: number }[] = [];
const hexagonMaterial = new THREE.MeshStandardMaterial({
  color: 0x00ff00,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 1,
});

// Collision groups
const ALL_INTERACTION = 0x00010001;
const PLAYER_COLLISION_GROUP = 0x00020002;

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
  collisionCount?: number;
  isBreaking: boolean;
}[] = [];
let colliderHandleToPlayerId: { [handle: number]: string } = {};

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

function initializeAudioContext(): void {
  if (audioContextInitialized) return;
  
  try {
    // Try to resume audio context if it's suspended
    if (audioListener.context.state === 'suspended') {
      audioListener.context.resume();
    }
    audioContextInitialized = true;
    console.log('Audio context initialized');
  } catch (e) {
    console.error('Error initializing audio context:', e);
  }
}

function playSound(sound: THREE.Audio, volume: number = 0.5): void {
  if (!sound || !audioContextInitialized) return;
  
  try {
    initializeAudioContext();
    sound.setVolume(volume);
    if (!sound.isPlaying) {
      sound.play();
    }
  } catch (e) {
    console.error('Error playing sound:', e);
  }
}

function createParticleEffect(position: THREE.Vector3, color: number = 0xffffff, count: number = 10): void {
  for (let i = 0; i < count; i++) {
    const geometry = new THREE.SphereGeometry(0.1, 4, 4);
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 });
    const particle = new THREE.Mesh(geometry, material);
    
    particle.position.copy(position);
    particle.position.add(new THREE.Vector3(
      (Math.random() - 0.5) * 2,
      Math.random() * 2,
      (Math.random() - 0.5) * 2
    ));
    
    const velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 10,
      Math.random() * 10 + 5,
      (Math.random() - 0.5) * 10
    );
    
    const life = 1.0 + Math.random() * 0.5;
    particles.push({ mesh: particle, velocity, life, maxLife: life });
    scene.add(particle);
  }
}

function updateParticles(deltaTime: number): void {
  for (let i = particles.length - 1; i >= 0; i--) {
    const particle = particles[i];
    particle.life -= deltaTime;
    
    if (particle.life <= 0) {
      scene.remove(particle.mesh);
      particles.splice(i, 1);
      continue;
    }
    
    // Update position
    particle.mesh.position.add(particle.velocity.clone().multiplyScalar(deltaTime));
    
    // Apply gravity
    particle.velocity.y -= 9.81 * deltaTime;
    
    // Update opacity
    const material = particle.mesh.material as THREE.MeshBasicMaterial;
    material.opacity = particle.life / particle.maxLife;
  }
}

function addPowerUp(type: string, duration: number = 10000): void {
  const powerUpId = `${type}_${Date.now()}`;
  powerUps[powerUpId] = {
    type,
    duration,
    startTime: performance.now(),
    active: true
  };
  
  console.log(`Power-up activated: ${type} for ${duration}ms`);
  updatePowerUpUI();
}

function updatePowerUps(): void {
  const currentTime = performance.now();
  
  for (const [id, powerUp] of Object.entries(powerUps)) {
    if (currentTime - powerUp.startTime > powerUp.duration) {
      powerUp.active = false;
      delete powerUps[id];
      console.log(`Power-up expired: ${powerUp.type}`);
    }
  }
  
  // Apply health regeneration
  if (hasPowerUp('health_regen')) {
    updateHealth(0.5); // Regenerate 0.5 health per frame
  }
  
  updatePowerUpUI();
}

function hasPowerUp(type: string): boolean {
  return Object.values(powerUps).some(p => p.type === type && p.active);
}

function addScore(points: number): void {
  playerScore += points;
  updateScoreUI();
}

function updateHealth(change: number): void {
  playerHealth = Math.max(0, Math.min(100, playerHealth + change));
  updateScoreUI();
  
  if (playerHealth <= 0) {
    const localId = mode === 'single' ? 'local' : playerId;
    if (localId && !playersClient[localId]?.eliminated) {
      eliminatePlayer(localId);
    }
  }
}

function updateScoreUI(): void {
  let scoreUI = document.getElementById('score-ui');
  if (!scoreUI) {
    scoreUI = document.createElement('div');
    scoreUI.id = 'score-ui';
    scoreUI.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 10px 15px;
      border-radius: 8px;
      z-index: 100;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: 16px;
    `;
    document.body.appendChild(scoreUI);
  }
  scoreUI.innerHTML = `
    <div>Score: ${playerScore}</div>
    <div>Health: ${playerHealth}%</div>
  `;
}

function updatePowerUpUI(): void {
  let powerUpUI = document.getElementById('powerup-ui');
  if (!powerUpUI) {
    powerUpUI = document.createElement('div');
    powerUpUI.id = 'powerup-ui';
    powerUpUI.style.cssText = `
      position: fixed;
      top: 60px;
      right: 20px;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 10px 15px;
      border-radius: 8px;
      z-index: 100;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-size: 14px;
    `;
    document.body.appendChild(powerUpUI);
  }
  
  const activePowerUps = Object.values(powerUps).filter(p => p.active);
  if (activePowerUps.length > 0) {
    powerUpUI.innerHTML = activePowerUps.map(p => {
      const remaining = Math.max(0, p.duration - (performance.now() - p.startTime));
      return `${p.type}: ${Math.ceil(remaining / 1000)}s`;
    }).join('<br>');
    powerUpUI.style.display = 'block';
  } else {
    powerUpUI.style.display = 'none';
  }
}

function spawnRandomPowerUp(): void {
  if (Math.random() < 0.1) { // 10% chance every call
    const powerUpTypes = ['speed_boost', 'high_jump', 'invincibility', 'health_regen'];
    const randomType = powerUpTypes[Math.floor(Math.random() * powerUpTypes.length)];
    addPowerUp(randomType, 15000); // 15 seconds duration
  }
}

function breakHexagon(
  hexagon: {
    id: string;
    mesh: THREE.Mesh;
    rigidBody?: RAPIER.RigidBody;
    collider?: RAPIER.Collider;
    isBreaking: boolean;
  }
): void {
  if (hexagon.isBreaking) return;
  hexagon.isBreaking = true;
  canJump = true;
  canJumpUntil = performance.now() + 1000;

  try {
    if (hexagon.collider && world) {
      world.removeCollider(hexagon.collider, false);
    }
  } catch (e) {
    console.error('Error removing collider:', e);
  }

  playSound(breakSound, 0.7);
  
  // Add particle effect
  createParticleEffect(hexagon.mesh.position, 0x00ff00, 15);
  
  // Add score for breaking hexagon
  addScore(10);

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
      } catch (e) {
        console.error('Error removing hexagon mesh:', e);
      }
      try {
        if (hexagon.rigidBody && world) {
          world.removeRigidBody(hexagon.rigidBody);
        }
      } catch (e) {
        console.error('Error removing hexagon rigidBody:', e);
      }
      rigidBodies = rigidBodies.filter((body) => body.mesh !== hexagon.mesh);
      hexagonsClient = hexagonsClient.filter((h) => h !== hexagon);
    });
  tweenGroup.add(tween);
  tween.start();
}

function handleJumping(): void {
  if (!ballRigidBody || isSpectating || !physicsEnabled) return;

  if (keys.space && (canJump || canJumpUntil > performance.now())) {
    let jumpPower = 4;
    if (canJumpUntil + 1600 > performance.now()) {
      jumpPower = 10;
    }
    
    // Apply power-up effects
    if (hasPowerUp('high_jump')) {
      jumpPower *= 1.5;
    }

    try {
      ballRigidBody.applyImpulse({ x: 0, y: jumpPower, z: 0 }, true);
    } catch (e) {
      console.error('Error applying jump impulse:', e);
    }

    if (ballCollider) {
      try { ballCollider.setRestitution(0); } catch (e) {
        console.error('Error setting restitution:', e);
      }
    }

    playSound(jumpSound, 0.6);
    keys.space = false;
    canJump = false;
    canJumpUntil = 0;

    if (socket && playerId && gameId) {
      const jumpEventId = Date.now().toString();
      try {
        socket.emit('jump', { gameId, id: playerId, eventId: jumpEventId });
        setTimeout(() => {
          if (!jumpAcknowledged[jumpEventId]) {
            console.warn(`Jump event ${jumpEventId} not acknowledged, retrying...`);
            socket!.emit('jump', { gameId, id: playerId, eventId: jumpEventId });
          }
        }, 1000);
      } catch (e) {
        console.error('Error emitting jump event:', e);
      }
      jumpAcknowledged[jumpEventId] = false;
    }
  }
}

let physicsEnabled: boolean = false;
const jumpAcknowledged: { [eventId: string]: boolean } = {};
let lastSendTime: number = 0;
const sendInterval = 33; // ~30 updates per second

function eliminatePlayer(playerId: string): void {
  const player = playersClient[playerId];
  if (!player || player.eliminated) return;
  
  player.eliminated = true;
  const remainingPlayers = Object.entries(playersClient).filter(([_, p]) => !p.eliminated);
  player.rank = remainingPlayers.length + 1;
  
  console.log(`Player ${playerId} eliminated with rank ${player.rank}`);
  
  // Add particle effect for elimination
  createParticleEffect(player.mesh.position, 0xff0000, 20);
  
  // Add score for elimination
  addScore(50);
  
  if (playerId === (mode === 'single' ? 'local' : playerId)) {
    // Local player eliminated
    isSpectating = true;
    if (ballRigidBody) {
      try {
        ballRigidBody.setEnabled(false);
      } catch (e) {
        console.error('Error disabling eliminated player rigidBody:', e);
      }
    }
    
    // Hide controls
    const joystick = document.querySelector('.joystick') as HTMLElement | null;
    const jumpButton = document.querySelector('.jump-button') as HTMLElement | null;
    if (joystick) joystick.style.display = 'none';
    if (jumpButton) jumpButton.style.display = 'none';
    
    // Show spectating UI
    showSpectatingUI();
  }
  
  // Remove player mesh from scene
  try {
    scene.remove(player.mesh);
  } catch (e) {
    console.error('Error removing eliminated player mesh:', e);
  }
  
  // Remove physics body
  if (player.rigidBody && world) {
    try {
      world.removeRigidBody(player.rigidBody);
    } catch (e) {
      console.error('Error removing eliminated player rigidBody:', e);
    }
  }
  
  // Remove from collider map
  if (player.collider) {
    delete colliderHandleToPlayerId[player.collider.handle];
  }
  
  // Clean up references
  rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
  
  // Check if game should end
  const alivePlayers = Object.entries(playersClient).filter(([_, p]) => !p.eliminated);
  if (alivePlayers.length <= 1) {
    showEndGameModal();
  }
  
  // Notify server in multiplayer mode
  if (mode !== 'single' && socket && gameId) {
    try {
      socket.emit('player-eliminated', { gameId, playerId, rank: player.rank });
    } catch (e) {
      console.error('Error emitting player-eliminated event:', e);
    }
  }
}

function showSpectatingUI(): void {
  // Create spectating UI if it doesn't exist
  let spectatingUI = document.getElementById('spectating-ui');
  if (!spectatingUI) {
    spectatingUI = document.createElement('div');
    spectatingUI.id = 'spectating-ui';
    spectatingUI.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 10px 20px;
      border-radius: 8px;
      z-index: 100;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;
    spectatingUI.innerHTML = `
      <div>Spectating - Press TAB to switch players</div>
    `;
    document.body.appendChild(spectatingUI);
  }
  spectatingUI.style.display = 'block';
}

function hideSpectatingUI(): void {
  const spectatingUI = document.getElementById('spectating-ui');
  if (spectatingUI) {
    spectatingUI.style.display = 'none';
  }
}

function switchSpectatingPlayer(): void {
  if (!isSpectating) return;
  
  const alivePlayers = Object.entries(playersClient).filter(([_, p]) => !p.eliminated);
  if (alivePlayers.length === 0) return;
  
  // Find current spectating target
  let currentIndex = 0;
  const currentTarget = alivePlayers.find(([id, _]) => {
    const player = playersClient[id];
    return player && player.mesh.position.distanceTo(camera.position) < 15;
  });
  
  if (currentTarget) {
    currentIndex = alivePlayers.findIndex(([id, _]) => id === currentTarget[0]);
  }
  
  // Switch to next player
  const nextIndex = (currentIndex + 1) % alivePlayers.length;
  const nextPlayerId = alivePlayers[nextIndex][0];
  
  // Update camera to follow next player
  const nextPlayer = playersClient[nextPlayerId];
  if (nextPlayer) {
    const pos = nextPlayer.mesh.position;
    camera.position.set(pos.x - 10, pos.y + 5, pos.z - 10);
    camera.lookAt(pos.x, pos.y, pos.z);
  }
}

function animate(time: number): void {
  animationFrameId = requestAnimationFrame(animate);
  lastFrameTime = time;

  if (!scene || !camera || !renderer) return;

  if (isPaused && mode === 'single') {
    renderer.render(scene, camera);
    return;
  }

  if (world && physicsEnabled) {
    // Update kinematic bodies for remote players before stepping
    for (const [id, player] of Object.entries(playersClient)) {
      if (id !== (mode === 'single' ? 'local' : playerId) && player.rigidBody && !player.eliminated) {
        const pos = player.mesh.position;
        const quat = player.mesh.quaternion;
        player.rigidBody.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
        player.rigidBody.setNextKinematicRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
      }
    }

    try {
      if (eventQueue) {
        world.step(eventQueue);
      } else {
        world.step();
      }
    } catch (e) {
      console.error('Error stepping physics world:', e);
      try { world.step(); } catch (err) {
        console.error('Fallback physics step failed:', err);
      }
    }
    
    // Handle collisions
    if (eventQueue) {
      eventQueue.drainCollisionEvents((handle1, handle2, started) => {
        if (!started) return;
        
        let localColliderHandle = ballCollider ? ballCollider.handle : -1;
        let otherHandle = -1;
        
        if (handle1 === localColliderHandle) otherHandle = handle2;
        else if (handle2 === localColliderHandle) otherHandle = handle1;
        
        if (otherHandle !== -1) {
          const otherPlayerId = colliderHandleToPlayerId[otherHandle];
          if (otherPlayerId && otherPlayerId !== playerId) {
            // Collision with another player
            console.log(`Collided with player ${otherPlayerId}`);
            
            // Calculate impulse to push them away
            if (ballRigidBody) {
               const myPos = ballRigidBody.translation();
               const otherPlayer = playersClient[otherPlayerId];
               if (otherPlayer) {
                 const otherPos = otherPlayer.mesh.position;
                 const dx = otherPos.x - myPos.x;
                 const dz = otherPos.z - myPos.z;
                 const dist = Math.sqrt(dx*dx + dz*dz) || 0.01; // Avoid div by zero
                 
                 // Push force depends on our speed? Or just a fixed "bounce"
                 // Let's use a fixed bounce + some velocity factor
                 const pushForce = 5.0; 
                 const impulse = {
                   x: (dx / dist) * pushForce,
                   y: 2.0, // Slight pop up
                   z: (dz / dist) * pushForce
                 };
                 
                 socket?.emit('player-hit', { 
                   gameId, 
                   targetId: otherPlayerId, 
                   impulse 
                 });
               }
            }
          }
        }
      });
    }
  }

  // Update local player
  if (ballRigidBody) {
    try {
      const pos = ballRigidBody.translation();
      const rot = ballRigidBody.rotation();
      const localId = mode === 'single' ? 'local' : playerId;
      playersClient[localId!].mesh.position.set(pos.x, pos.y, pos.z);
      playersClient[localId!].mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      
      // Check for player death (falling below death level)
      if (pos.y < DEATH_Y_LEVEL && !playersClient[localId!].eliminated) {
        eliminatePlayer(localId!);
      }
      
      // Reduce health when falling fast
      if (pos.y < -5 && ballRigidBody) {
        const velocity = ballRigidBody.linvel();
        if (velocity.y < -10) {
          updateHealth(-5);
        }
      }
    } catch (e) {
      console.error('Error updating local player mesh:', e);
    }
  }

  // Smoothly interpolate non-local players
  for (const [id, player] of Object.entries(playersClient)) {
    if (id !== (mode === 'single' ? 'local' : playerId) && player.targetPosition && player.targetRotation && !player.eliminated) {
      const targetPos = new THREE.Vector3(player.targetPosition.x, player.targetPosition.y, player.targetPosition.z);
      const targetQuat = new THREE.Quaternion(player.targetRotation.x, player.targetRotation.y, player.targetRotation.z, player.targetRotation.w);
      player.mesh.position.lerp(targetPos, 0.1);
      player.mesh.quaternion.slerp(targetQuat, 0.1);
      
      // Check for remote player death (falling below death level)
      if (targetPos.y < DEATH_Y_LEVEL) {
        eliminatePlayer(id);
      }
    }
  }

  let isGrounded = false;
  let contactedHexagon: typeof hexagonsClient[0] | null = null;

  if (ballRigidBody) {
    contactedHexagon = getContactedHexagon();
    if (contactedHexagon) isGrounded = true;
  }

  canJump = isGrounded;

  if (isGrounded && contactedHexagon) {
    if (lastGroundedHexId !== contactedHexagon.id) {
      playSound(collisionSound, 0.4);
      if (!contactedHexagon.isBreaking && socket && gameId && playerId && mode !== 'single') {
        const index = hexagonsClient.indexOf(contactedHexagon);
        if (index >= 0) {
          const collisionEventId = Date.now().toString();
          try {
            socket.emit('hexagon-collided', { gameId, index, playerId, eventId: collisionEventId });
            setTimeout(() => {
              if (!collisionAcknowledged[collisionEventId]) {
                console.warn(`Collision event ${collisionEventId} not acknowledged, retrying...`);
                socket!.emit('hexagon-collided', { gameId, index, playerId, eventId: collisionEventId });
              }
            }, 1000);
          } catch (e) {
            console.error('Error emitting hexagon-collided event:', e);
          }
          collisionAcknowledged[collisionEventId] = false;

          // If we are the creator, we must also count our own collision locally
          if (playerId === creatorId) {
             const hexagon = hexagonsClient[index];
             if (hexagon && !hexagon.isBreaking) {
               hexagon.collisionCount = (hexagon.collisionCount || 0) + 1;
               console.log(`(Local) Hexagon ${index} hit by creator. Count: ${hexagon.collisionCount}`);
               if (hexagon.collisionCount >= 3) {
                 try {
                   socket.emit('break-hexagon', { gameId, index });
                 } catch (e) {
                   console.error('Error emitting break-hexagon:', e);
                 }
               }
             }
          }
        }
      } else if (mode === 'single' && !contactedHexagon.isBreaking) {
        contactedHexagon.collisionCount = (contactedHexagon.collisionCount || 0) + 1;
        if (contactedHexagon.collisionCount >= 3) {
          breakHexagon(contactedHexagon);
        }
      }
      lastGroundedHexId = contactedHexagon.id;
    }
  } else {
    lastGroundedHexId = null;
  }

  handleJumping();
  try { handleMovement(); } catch (e) {
    console.error('Error in handleMovement:', e);
  }

  if (mode !== 'single' && socket && playerId && ballRigidBody && (time - lastSendTime >= sendInterval)) {
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
        try { socket.emit('move', { gameId, id: playerId, position: roundedPosition, rotation: roundedRotation }); } catch (e) {
          console.error('Error emitting move event:', e);
        }
        lastMovePosition = roundedPosition;
        lastMoveRotation = roundedRotation;
        lastSendTime = time;
      }
    } catch (e) {
      console.error('Error reading translation/rotation:', e);
    }
  }

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

  // Update camera position
  if (!isSpectating) {
    const offsetDistance = 10;
    const offsetHeight = 5;
    camera.position.set(
      spherePosition.x - offsetDistance * Math.cos(cameraAzimuth),
      spherePosition.y + offsetHeight,
      spherePosition.z - offsetDistance * Math.sin(cameraAzimuth)
    );
    camera.lookAt(spherePosition.x, spherePosition.y, spherePosition.z);
  } else {
    // Spectating mode - follow the target player
    const offsetDistance = 12;
    const offsetHeight = 8;
    camera.position.set(
      spherePosition.x - offsetDistance * Math.cos(cameraAzimuth),
      spherePosition.y + offsetHeight,
      spherePosition.z - offsetDistance * Math.sin(cameraAzimuth)
    );
    camera.lookAt(spherePosition.x, spherePosition.y, spherePosition.z);
  }

  try { tweenGroup.update(time); } catch (e) {
    console.error('Error updating tween:', e);
  }
  
  // Update particles
  const deltaTime = (time - lastFrameTime) / 1000;
  updateParticles(deltaTime);
  
  // Update power-ups
  updatePowerUps();
  
  // Add survival score every second
  if (Math.floor(time / 1000) !== Math.floor(lastFrameTime / 1000)) {
    addScore(1);
    spawnRandomPowerUp();
  }
  
  renderer.render(scene, camera);
}

function initPhysics(): void {
  const gravity = { x: 0, y: -9.81, z: 0 };
  world = new RAPIER.World(gravity);
  try {
    eventQueue = new RAPIER.EventQueue(true);
  } catch (e) {
    try {
      // @ts-ignore
      eventQueue = new RAPIER.EventQueue();
    } catch (err) {
      console.error('Error creating event queue:', err);
      eventQueue = null;
    }
  }
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
    indices.push(13, 6 + ((i + 1) % 6), 6 + i);
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
  const mesh: THREE.Mesh = new THREE.Mesh(geometry, hexagonMaterial.clone());
  mesh.position.set(position.x, position.y, position.z);
  scene.add(mesh);

  const id = `hex-${position.x}-${position.y}-${position.z}-${Date.now()}-${Math.random()}`;

  if (isLocal && world) {
    const vertices: Float32Array = new Float32Array(geometry.attributes.position.array as Iterable<number>);
    let colliderDesc: RAPIER.ColliderDesc | null = null;
    try {
      colliderDesc = RAPIER.ColliderDesc.convexHull(vertices)!
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(ALL_INTERACTION | PLAYER_COLLISION_GROUP)
        .setSolverGroups(ALL_INTERACTION | PLAYER_COLLISION_GROUP);
    } catch (e) {
      console.error('Error creating convex hull collider:', e);
      try {
        colliderDesc = RAPIER.ColliderDesc.cuboid(2, 0.5, 2)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
          .setCollisionGroups(ALL_INTERACTION | PLAYER_COLLISION_GROUP)
          .setSolverGroups(ALL_INTERACTION | PLAYER_COLLISION_GROUP);
      } catch (err) {
        console.error('Error creating cuboid collider:', err);
        colliderDesc = null;
      }
    }

    const rigidBodyDesc: RAPIER.RigidBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z);
    const rigidBody: RAPIER.RigidBody = world.createRigidBody(rigidBodyDesc);
    let collider: RAPIER.Collider | undefined = undefined;
    if (colliderDesc) {
      collider = world.createCollider(colliderDesc, rigidBody);
    }

    let collisionCount = 0;
    const hexagon = { id, mesh, rigidBody, collider, collisionCount, isBreaking: false };
    hexagonsClient.push(hexagon);
    rigidBodies.push({ mesh, rigidBody, collider });
  } else {
    const hexagon = { id, mesh, isBreaking: false };
    hexagonsClient.push(hexagon);
    rigidBodies.push({ mesh });
  }
}

function createSphere(id: string, position: { x: number; y: number; z: number }, isCreator: boolean = false): void {
  if (playersClient[id]) return; // Prevent creating duplicate spheres
  const geometry: THREE.SphereGeometry = new THREE.SphereGeometry(0.5, 16, 16);
  const material: THREE.MeshStandardMaterial = new THREE.MeshStandardMaterial({ color: isCreator ? 0xff0000 : 0x0000ff });
  const mesh: THREE.Mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position.x, position.y, position.z);
  scene.add(mesh);

  if (world) {
    let rigidBody: RAPIER.RigidBody | undefined;
    let collider: RAPIER.Collider | undefined;
    if (id === playerId || (mode === 'single' && id === 'local')) {
      const rigidBodyDesc: RAPIER.RigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setLinearDamping(0.3);
      rigidBody = world.createRigidBody(rigidBodyDesc);
      const colliderDesc: RAPIER.ColliderDesc = RAPIER.ColliderDesc.ball(0.5)
        .setRestitution(0.8)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(PLAYER_COLLISION_GROUP | ALL_INTERACTION)
        .setSolverGroups(PLAYER_COLLISION_GROUP | ALL_INTERACTION);
      collider = world.createCollider(colliderDesc, rigidBody);
      if (id === playerId || (mode === 'single' && id === 'local')) {
        ballRigidBody = rigidBody;
        ballCollider = collider;
        try {
          ballRigidBody.setEnabled(false);
        } catch (e) {
          console.error('Error disabling ballRigidBody:', e);
        }
      }
    } else {
      const rigidBodyDesc: RAPIER.RigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(position.x, position.y, position.z);
      rigidBody = world.createRigidBody(rigidBodyDesc);
      const colliderDesc: RAPIER.ColliderDesc = RAPIER.ColliderDesc.ball(0.5)
        .setRestitution(0.8)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setCollisionGroups(PLAYER_COLLISION_GROUP | ALL_INTERACTION)
        .setSolverGroups(PLAYER_COLLISION_GROUP | ALL_INTERACTION);
      collider = world.createCollider(colliderDesc, rigidBody);
    }
    if (collider) {
      colliderHandleToPlayerId[collider.handle] = id;
    }
    rigidBodies.push({ mesh, rigidBody, collider });
    playersClient[id] = { mesh, rigidBody, collider, eliminated: false, targetPosition: position, targetRotation: { x: 0, y: 0, z: 0, w: 1 } };
  } else {
    playersClient[id] = { mesh, eliminated: false, targetPosition: position, targetRotation: { x: 0, y: 0, z: 0, w: 1 } };
    rigidBodies.push({ mesh });
  }
}

function handleMovement(): void {
  if (!ballRigidBody || isPaused || isSpectating || !physicsEnabled) return;
  let moveImpulse: number = 0.05;
  
  // Apply speed power-up
  if (hasPowerUp('speed_boost')) {
    moveImpulse *= 1.5;
  }
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
    } catch (e) {
      console.error('Error applying movement impulse:', e);
    }
  }
}

function getContactedHexagon(): typeof hexagonsClient[0] | null {
  if (!ballRigidBody) return null;
  try {
    const ballPos = ballRigidBody.translation();
    for (const hex of hexagonsClient) {
      if (!hex || hex.isBreaking) continue;
      const dx = ballPos.x - hex.mesh.position.x;
      const dz = ballPos.z - hex.mesh.position.z;
      const horizontalDist = Math.sqrt(dx * dx + dz * dz);
      const verticalDiff = ballPos.y - hex.mesh.position.y;
      if (horizontalDist < 2.5 && verticalDiff <= 1.1 && verticalDiff >= -1.0) {
        return hex;
      }
    }
  } catch (e) {
    console.error('Error reading ball position:', e);
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
        joystickInner.style.transform = `translate(${joystickX * 30}px, ${joystickY * 30}px)`;
      }
    } else if (touch.identifier === rotationTouchId) {
      const deltaX = touch.clientX - touchStartX;
      cameraAzimuth += deltaX * 0.002;
      touchStartX = touch.clientX;
      if (socket && playerId && gameId) {
        try {
          socket.emit('rotate', { gameId, id: playerId, cameraAzimuth: Number(cameraAzimuth.toFixed(2)) });
        } catch (e) {
          console.error('Error emitting rotate event:', e);
        }
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
    } catch (e) {
      console.error('Error emitting rotate event:', e);
    }
  }
}

function startCountdown(seconds: number, serverTime?: number, callback?: () => void): void {
  const countdownElement = document.getElementById('countdown') as HTMLElement | null;
  if (!countdownElement) return;
  countdownElement.style.display = 'block';
  countdownElement.style.opacity = '1';

  // If serverTime is not provided, we assume 'seconds' is the remaining duration from NOW
  const endTime = serverTime ? (serverTime + seconds * 1000) : (Date.now() + seconds * 1000);

  const countdown = () => {
    const timeLeft = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
    if (timeLeft <= 0) {
      countdownElement.style.display = 'none';
      if (callback) callback();
      return;
    }
    countdownElement.textContent = timeLeft.toString();
    setTimeout(countdown, 100);
  };
  countdown();
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

const collisionAcknowledged: { [eventId: string]: boolean } = {};

function initMultiplayer(): void {
  // Use provided serverIp, or fallback to current hostname with default port 3000
  // If the page is served over HTTPS, use wss, otherwise ws
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = serverIp || "game.safahanbattery.ir";
  const port = serverIp ? '' : ':8443'; // Assume port 3000 for local dev if no IP provided
  
  // If serverIp contains a full URL (e.g. https://example.com), use it directly
  let serverUrl = '';
  if (serverIp && (serverIp.startsWith('http') || serverIp.startsWith('ws'))) {
      serverUrl = serverIp;
  } else {
      serverUrl = `${protocol}://${host}${port}`;
  }

  console.log(`Connecting to server at: ${serverUrl}`);

  socket = io(serverUrl, {
    transports: ['websocket'],
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
  });

  socket!.on('connect', () => {
    console.log('Connected to server:', socket!.id);
    playerId = socket!.id;
    creatorId = mode === 'create' ? playerId : null;
    if (mode === 'create') {
      hexagons.forEach((pos) => createHexagon(pos, true));
      createSphere(playerId!, { x: 0, y: 5, z: 0 }, true);
      serverStartTime = Date.now() + startTimer * 1000;
      try {
        socket!.emit('create-game', { startTimer, serverStartTime });
      } catch (e) {
        console.error('Error emitting create-game:', e);
      }
    } else {
      try {
        socket!.emit('join-game', { gameId });
      } catch (e) {
        console.error('Error emitting join-game:', e);
      }
    }
  });

  socket!.on('init', (data: { gameId: string; creatorId: string; players: { id: string; position: { x: number; y: number; z: number } }[]; hexagons: { x: number; y: number; z: number }[]; startTimer: number; serverStartTime: number; remainingTime?: number }) => {
    console.log('Received init:', data);
    gameId = data.gameId;
    creatorId = data.creatorId;
    startTimer = data.startTimer;
    serverStartTime = data.serverStartTime;
    if (mode !== 'create') {
      data.hexagons.forEach((pos) => createHexagon(pos, true));
    }
    data.players.forEach((player) => {
      if (player.id === playerId) {
        createSphere(player.id, player.position, player.id === creatorId);
      } else if (!playersClient[player.id]) {
        createSphere(player.id, player.position, player.id === creatorId);
      }
    });
    totalPlayers = data.players.length;
    physicsEnabled = false;
    if (ballRigidBody) {
      try {
        ballRigidBody.setEnabled(false);
      } catch (e) {
        console.error('Error disabling ballRigidBody:', e);
      }
    }
    
    // Use remainingTime if provided, otherwise fallback to calculating (which might be skewed)
    const timeToStart = data.remainingTime !== undefined ? data.remainingTime : startTimer;
    
    // If game has already started (remainingTime <= 0), enable physics immediately
    if (timeToStart <= 0) {
      physicsEnabled = true;
      if (ballRigidBody) {
        try {
          ballRigidBody.setEnabled(true);
        } catch (e) {
          console.error('Error enabling ballRigidBody:', e);
        }
      }
    } else {
      // Otherwise, start countdown
      startCountdown(timeToStart, undefined, () => {
        physicsEnabled = true;
        if (ballRigidBody) {
          try {
            ballRigidBody.setEnabled(true);
          } catch (e) {
            console.error('Error enabling ballRigidBody:', e);
          }
        }
      });
    }
  });

  socket!.on('game-started', () => {
    physicsEnabled = true;
    if (ballRigidBody) {
      try {
        ballRigidBody.setEnabled(true);
      } catch (e) {
        console.error('Error enabling ballRigidBody:', e);
      }
    }
    console.log('Game started, physics enabled');
  });

  socket!.on('new-player', (data: { id: string; position: { x: number; y: number; z: number } }) => {
    if (data.id !== playerId && !playersClient[data.id]) {
      createSphere(data.id, data.position, data.id === creatorId);
      totalPlayers++;
      console.log(`New player joined: ${data.id}`);
    }
  });

  socket!.on('player-moved', (data: { id: string; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } }) => {
    const player = playersClient[data.id];
    if (player && data.id !== playerId && !player.eliminated) {
      player.targetPosition = data.position;
      player.targetRotation = data.rotation;
    }
  });

  socket!.on('player-jumped', (data: { id: string; eventId: string }) => {
    if (data.id !== playerId) {
      const player = playersClient[data.id];
      if (player && !player.eliminated) {
        player.mesh.position.y += 0.1; // Visual feedback for jump
      }
    }
    if (data.eventId && jumpAcknowledged[data.eventId] !== undefined) {
      jumpAcknowledged[data.eventId] = true;
    }
  });

  socket!.on('player-rotated', (data: { id: string; cameraAzimuth: number }) => {
    if (data.id !== playerId) {
      const player = playersClient[data.id];
      if (player && !player.eliminated) {
        // Optionally use cameraAzimuth for visual effects
      }
    }
  });

  socket!.on('player-disconnected', (data: { id: string }) => {
    const player = playersClient[data.id];
    if (player && !player.eliminated) {
      player.eliminated = true;
      player.rank = Object.entries(playersClient).filter(([_, p]) => !p.eliminated).length + 1;
      try {
        scene.remove(player.mesh);
      } catch (e) {
        console.error('Error removing disconnected player mesh:', e);
      }
      if (player.rigidBody && world) {
        try {
          world.removeRigidBody(player.rigidBody);
        } catch (e) {
          console.error('Error removing disconnected player rigidBody:', e);
        }
      }
      if (player.collider) {
        delete colliderHandleToPlayerId[player.collider.handle];
      }
      rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
      delete playersClient[data.id];
      const remainingPlayers = Object.entries(playersClient).filter(([_, p]) => !p.eliminated);
      if (remainingPlayers.length <= 1) {
        showEndGameModal();
      }
      console.log(`Player disconnected: ${data.id}`);
    }
  });

  socket!.on('player-eliminated', (data: { id: string; rank: number }) => {
    const player = playersClient[data.id];
    if (player && !player.eliminated) {
      player.eliminated = true;
      player.rank = data.rank;
      if (data.id === playerId) {
        playerRank = data.rank;
        isSpectating = true;
        if (ballRigidBody) {
          try {
            ballRigidBody.setEnabled(false);
          } catch (e) {
            console.error('Error disabling eliminated player rigidBody:', e);
          }
          try {
            scene.remove(player.mesh);
          } catch (e) {
            console.error('Error removing eliminated player mesh:', e);
          }
          rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
        }
        const joystick = document.querySelector('.joystick') as HTMLElement | null;
        const jumpButton = document.querySelector('.jump-button') as HTMLElement | null;
        if (joystick) joystick.style.display = 'none';
        if (jumpButton) jumpButton.style.display = 'none';
        showEndGameModal();
      } else {
        try {
          scene.remove(player.mesh);
        } catch (e) {
          console.error('Error removing eliminated player mesh:', e);
        }
        if (player.rigidBody && world) {
          try {
            world.removeRigidBody(player.rigidBody);
          } catch (e) {
            console.error('Error removing eliminated player rigidBody:', e);
          }
        }
        rigidBodies = rigidBodies.filter((body) => body.mesh !== player.mesh);
      }
      const remainingPlayers = Object.entries(playersClient).filter(([_, p]) => !p.eliminated);
      if (remainingPlayers.length <= 1) {
        showEndGameModal();
      }
      console.log(`Player eliminated: ${data.id} with rank ${data.rank}`);
    }
  });

  socket!.on('hexagon-collided-ack', (data: { eventId: string }) => {
    if (data.eventId && collisionAcknowledged[data.eventId] !== undefined) {
      collisionAcknowledged[data.eventId] = true;
    }
  });

  socket!.on('hexagon-collided', (data: { index: number; playerId: string }) => {
    // Only the creator manages game state (breaking hexagons)
    if (playerId === creatorId) {
      const hexagon = hexagonsClient[data.index];
      if (hexagon && !hexagon.isBreaking) {
        hexagon.collisionCount = (hexagon.collisionCount || 0) + 1;
        console.log(`Hexagon ${data.index} hit by ${data.playerId}. Count: ${hexagon.collisionCount}`);
        
        if (hexagon.collisionCount >= 3) {
          try {
            socket!.emit('break-hexagon', { gameId, index: data.index });
          } catch (e) {
            console.error('Error emitting break-hexagon:', e);
          }
        }
      }
    }
  });

  socket!.on('hexagon-broken', (data: { index: number; playerId: string }) => {
    const hexagon = hexagonsClient[data.index];
    if (hexagon && !hexagon.isBreaking) {
      console.log(`Breaking hexagon ${hexagon.id} by player ${data.playerId}`);
      breakHexagon(hexagon);
    }
  });

  socket!.on('sync', (data: { players: { id: string; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } }[] }) => {
    data.players.forEach((playerData) => {
      if (playerData.id === playerId && ballRigidBody) {
        try {
          const serverPos = playerData.position;
          const localPos = ballRigidBody.translation();
          const delta = {
            x: serverPos.x - localPos.x,
            y: serverPos.y - localPos.y,
            z: serverPos.z - localPos.z,
          };
          const distance = Math.sqrt(delta.x * delta.x + delta.y * delta.y + delta.z * delta.z);
          if (distance > 0.5) {
            console.log(`Reconciling position for player ${playerId}: server=${JSON.stringify(serverPos)}, local=${JSON.stringify(localPos)}`);
            ballRigidBody.setTranslation(serverPos, true);
            ballRigidBody.setRotation(playerData.rotation, true);
          }
        } catch (e) {
          console.error('Error reconciling player position:', e);
        }
      } else {
        const player = playersClient[playerData.id];
        if (player && !player.eliminated) {
          player.targetPosition = playerData.position;
          player.targetRotation = playerData.rotation;
        }
      }
    });
  });

  socket!.on('player-hit', (data: { targetId: string; impulse: { x: number; y: number; z: number } }) => {
    if (data.targetId === playerId && ballRigidBody) {
      console.log('I was hit! Applying impulse:', data.impulse);
      try {
        ballRigidBody.applyImpulse(data.impulse, true);
      } catch (e) {
        console.error('Error applying hit impulse:', e);
      }
    }
  });

  socket!.on('game-ended', () => {
    showEndGameModal();
    // alert('Game ended: Host disconnected');
  });

  socket!.on('error', (data: { message: string }) => {
    console.error('Server error:', data.message);
    alert(data.message);
  });

  socket!.on('connect_error', () => {
    console.error('Connection error');
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
      } catch (e) {
        console.error('Error disabling ballRigidBody on pause:', e);
      }
    }
    if (animationFrameId && mode === 'single') {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    try {
      if (document.exitPointerLock) document.exitPointerLock();
    } catch (e) {
      console.error('Error exiting pointer lock:', e);
    }
  } else if (isPaused) {
    isPaused = false;
    pauseModal.style.display = 'none';
    if (ballRigidBody) {
      try {
        ballRigidBody.setEnabled(true);
      } catch (e) {
        console.error('Error enabling ballRigidBody on resume:', e);
      }
    }
    if (mode === 'single' && !animationFrameId) {
      animate(performance.now());
    }
    try {
      if (!isMobileUserAgent() && renderer && renderer.domElement && renderer.domElement.requestPointerLock) {
        renderer.domElement.requestPointerLock();
      }
    } catch (e) {
      console.error('Error requesting pointer lock:', e);
    }
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
    } catch (e) {
      console.error('Error enabling ballRigidBody on resume:', e);
    }
  }
  if (mode === 'single' && !animationFrameId) {
    animate(performance.now());
  }
  try {
    if (!isMobileUserAgent() && renderer && renderer.domElement && renderer.domElement.requestPointerLock) {
      renderer.domElement.requestPointerLock();
    }
  } catch (e) {
    console.error('Error requesting pointer lock:', e);
  }
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
    } catch (e) {
      console.error('Error disconnecting socket:', e);
    }
    socket = null;
  }
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (scene) {
    try { scene.clear(); } catch (e) {
      console.error('Error clearing scene:', e);
    }
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
  hideSpectatingUI();
  
  // Clean up UI elements
  const scoreUI = document.getElementById('score-ui');
  const powerUpUI = document.getElementById('powerup-ui');
  if (scoreUI) scoreUI.remove();
  if (powerUpUI) powerUpUI.remove();
  
  // Reset game state
  playerScore = 0;
  playerHealth = 100;
  powerUps = {};
  particles = [];
  document.body.style.cursor = 'default';
  try {
    if (document.exitPointerLock) document.exitPointerLock();
  } catch (e) {
    console.error('Error exiting pointer lock:', e);
  }
};

function init(): void {
  initPhysics();
  if (mode === 'single') {
    hexagons.forEach((pos) => createHexagon(pos));
    createSphere('local', { x: 0, y: 5, z: 0 }, true);
    totalPlayers = 1;
    startCountdown(5, Date.now(), () => {
      physicsEnabled = true;
      if (ballRigidBody) {
        try {
          ballRigidBody.setEnabled(true);
        } catch (e) {
          console.error('Error enabling ballRigidBody:', e);
        }
      }
    });
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
    // Initialize audio context on first key press
    initializeAudioContext();
    
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
      case 'tab':
        if (isSpectating) {
          switchSpectatingPlayer();
        }
        break;
    }
    try {
      if (!isPaused && !isMobileUserAgent() && renderer && renderer.domElement && renderer.domElement.requestPointerLock) {
        renderer.domElement.requestPointerLock();
      }
    } catch (e) {
      console.error('Error requesting pointer lock on keydown:', e);
    }
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

  window.addEventListener('touchstart', (event) => {
    initializeAudioContext();
    handleTouchStart(event);
  }, { passive: false });
  window.addEventListener('touchmove', handleTouchMove, { passive: false });
  window.addEventListener('touchend', handleTouchEnd, { passive: false });
  window.addEventListener('mousemove', (event) => {
    initializeAudioContext();
    handleMouseMove(event);
  });

  const canvas = renderer.domElement;
  try {
    if (!isMobileUserAgent() && canvas.requestPointerLock) canvas.requestPointerLock();
  } catch (e) {
    console.error('Error requesting pointer lock on init:', e);
  }

  document.addEventListener('pointerlockerror', () => {
    console.error('Pointer lock error occurred');
  });

  window.addEventListener('resize', () => {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    updateJoystickCenter();
  });

  lastFrameTime = performance.now();
  if (!animationFrameId) animate(performance.now());
}

window.start = function start(gameMode: string, ip?: string, timer?: number, selectedGameId?: string): void {
  mode = gameMode;
  serverIp = ip || "game.safahanbattery.ir:8443";
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
  
  // Initialize audio context on first user interaction
  initializeAudioContext();

  const audioLoader = new THREE.AudioLoader();
  audioLoader.load('/sounds/jump.mp3', (buffer) => {
    try {
      jumpSound.setBuffer(buffer).setVolume(0.5);
    } catch (e) {
      console.error('Error loading jump sound:', e);
    }
  });
  audioLoader.load('/sounds/collision.mp3', (buffer) => {
    try {
      collisionSound.setBuffer(buffer).setVolume(0.5);
    } catch (e) {
      console.error('Error loading collision sound:', e);
    }
  });
  audioLoader.load('/sounds/break.mp3', (buffer) => {
    try {
      breakSound.setBuffer(buffer).setVolume(0.5);
    } catch (e) {
      console.error('Error loading break sound:', e);
    }
  });

  camera.position.set(0, 5, 10);
  camera.lookAt(0, 0, 0);

  const ambientLight: THREE.AmbientLight = new THREE.AmbientLight(0x404040);
  scene.add(ambientLight);
  const directionalLight: THREE.DirectionalLight = new THREE.DirectionalLight(0xffffff, 0.5);
  directionalLight.position.set(0, 1, 0);
  scene.add(directionalLight);

  init();
  
  // Initialize UI
  updateScoreUI();
};