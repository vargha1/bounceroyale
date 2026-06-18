/**
 * Network protocol types shared between the LAN (WebRTC) and Server (socket.io) transports.
 *
 * The host is authoritative for: hexagon break events, player eliminations, ranks, game start.
 * Each peer is authoritative for its own movement & jump input.
 *
 * Messages are JSON-serializable so they work over both WebSocket and RTCDataChannel.
 */

export type NetMode = 'single' | 'lan' | 'server';

export type MoveMessage = {
  kind: 'move';
  id: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
};

export type JumpMessage = {
  kind: 'jump';
  id: string;
};

export type RotateMessage = {
  kind: 'rotate';
  id: string;
  cameraAzimuth: number;
};

export type HexagonCollidedMessage = {
  kind: 'hexagon-collided';
  index: number;
  playerId: string;
};

export type BreakHexagonMessage = {
  kind: 'break-hexagon';
  index: number;
};

export type HexagonBrokenMessage = {
  kind: 'hexagon-broken';
  index: number;
};

/** Damage a specific island tile by a given amount (used by the destructible-island system). */
export type DamageTileMessage = {
  kind: 'damage-tile';
  tileId: string;
  damage: number;
};

export type PlayerHitMessage = {
  kind: 'player-hit';
  targetId: string;
  impulse: { x: number; y: number; z: number };
};

export type PlayerEliminatedMessage = {
  kind: 'player-eliminated';
  id: string;
  rank: number;
};

export type PlayerDisconnectedMessage = {
  kind: 'player-disconnected';
  id: string;
};

export type GameEndedMessage = {
  kind: 'game-ended';
  winner?: string | null;
};

export type GameStartedMessage = {
  kind: 'game-started';
};

export type InitMessage = {
  kind: 'init';
  gameId: string;
  creatorId: string;
  players: { id: string; position: { x: number; y: number; z: number } }[];
  /** Deterministic island seed — guests regenerate the same island from this. */
  islandSeed: number;
  /** Island size preset. */
  islandSize: string;
  startTimer: number;
  serverStartTime: number;
};

export type NewPlayerMessage = {
  kind: 'new-player';
  id: string;
  position: { x: number; y: number; z: number };
};

/** Powerup pickup collected by a player. Broadcast so all peers hide the pickup. */
export type PowerupCollectedMessage = {
  kind: 'powerup-collected';
  /** ID of the powerup pickup (deterministic across peers). */
  powerupId: string;
  /** ID of the player who collected it. */
  playerId: string;
  /** Powerup type, so receivers know what effect to apply if needed. */
  powerupType: string;
};

/** A previously-collected powerup has respawned. Broadcast so all peers show it again.
 *  The host picks a NEW random tile for the respawn (not the original tile) and
 *  sends the new position + tileId so all peers move the pickup to the same spot. */
export type PowerupRespawnedMessage = {
  kind: 'powerup-respawned';
  powerupId: string;
  /** New tile ID the pickup now sits above. */
  newTileId: string;
  /** New world position (above the new tile) — saves peers from having to look
   *  up the tile by id (which might not exist yet on a freshly-joined guest). */
  position: { x: number; y: number; z: number };
};

export type NetMessage =
  | MoveMessage
  | JumpMessage
  | RotateMessage
  | HexagonCollidedMessage
  | BreakHexagonMessage
  | HexagonBrokenMessage
  | DamageTileMessage
  | PlayerHitMessage
  | PlayerEliminatedMessage
  | PlayerDisconnectedMessage
  | GameEndedMessage
  | GameStartedMessage
  | InitMessage
  | NewPlayerMessage
  | PowerupCollectedMessage
  | PowerupRespawnedMessage;

export type NetEvent =
  | { type: 'open'; id: string }
  | { type: 'init'; data: Omit<InitMessage, 'kind'> }
  | { type: 'new-player'; data: Omit<NewPlayerMessage, 'kind'> }
  | { type: 'move'; data: Omit<MoveMessage, 'kind'> }
  | { type: 'jump'; data: Omit<JumpMessage, 'kind'> }
  | { type: 'rotate'; data: Omit<RotateMessage, 'kind'> }
  | { type: 'hexagon-collided'; data: Omit<HexagonCollidedMessage, 'kind'> }
  | { type: 'hexagon-broken'; data: Omit<BreakHexagonMessage, 'kind'> }
  | { type: 'damage-tile'; data: Omit<DamageTileMessage, 'kind'> }
  | { type: 'player-hit'; data: Omit<PlayerHitMessage, 'kind'> }
  | { type: 'player-eliminated'; data: Omit<PlayerEliminatedMessage, 'kind'> }
  | { type: 'player-disconnected'; data: Omit<PlayerDisconnectedMessage, 'kind'> }
  | { type: 'game-ended'; data: Omit<GameEndedMessage, 'kind'> }
  | { type: 'game-started'; data: Omit<GameStartedMessage, 'kind'> }
  | { type: 'powerup-collected'; data: Omit<PowerupCollectedMessage, 'kind'> }
  | { type: 'powerup-respawned'; data: Omit<PowerupRespawnedMessage, 'kind'> }
  | { type: 'error'; message: string }
  | { type: 'close' };

export interface NetClient {
  readonly id: string;
  readonly isHost: boolean;
  send(msg: NetMessage): void;
  onMessage(cb: (event: NetEvent) => void): void;
  onPeerChange?(cb: (peers: string[]) => void): void;
  close(): void;
}
