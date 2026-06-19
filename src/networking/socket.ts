/**
 * Socket.io client that wraps the existing Node.js + Socket.io server (kept as
 * a menu option). Translates socket events into NetEvent for the engine.
 */
import { io, type Socket } from 'socket.io-client';
import type { NetClient, NetMessage, NetEvent } from './types';

export class SocketNetClient implements NetClient {
  readonly id: string;
  readonly isHost: boolean;
  private socket: Socket;
  private listeners = new Set<(ev: NetEvent) => void>();
  private closed = false;

  constructor(serverUrl: string, opts: { isHost: boolean; gameId?: string | null; startTimer?: number; playerId: string }) {
    this.isHost = opts.isHost;
    this.id = opts.playerId;
    this.socket = io(serverUrl, {
      transports: ['websocket'],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    this.socket.on('connect', () => {
      // Use server-assigned id as our actual player id.
      // (Engine uses whatever id we pass to it via constructor — we set it before.)
      // Emit our open event so the engine knows we're ready.
      if (opts.isHost) {
        // Host: create a new game. Send startTimer + islandSeed/size if we
        // have them (the engine generates the seed, but at socket-creation
        // time we don't have it yet — the server generates a fallback).
        this.socket.emit('create-game', {
          startTimer: opts.startTimer ?? 30,
          serverStartTime: Date.now() + (opts.startTimer ?? 30) * 1000,
        });
      } else {
        // Guest: join an existing game. If gameId is null/empty, the server
        // auto-joins us to the most recent active game (see server.cjs).
        this.socket.emit('join-game', { gameId: opts.gameId ?? null });
      }
      if (this.socket.id) (this as any).id = this.socket.id;
      this.emit({ type: 'open', id: this.socket.id ?? this.id });
    });

    this.socket.on('init', (data: any) => {
      // Reassign our local player id to what the server thinks we are
      if (this.socket.id) (this as any).id = this.socket.id;
      const { kind: _k1, ...rest1 } = data;
      void _k1;
      this.emit({ type: 'init', data: rest1 });
    });

    this.socket.on('new-player', (data: any) => this.emit({ type: 'new-player', data: { id: data.id, position: data.position } }));
    this.socket.on('player-moved', (data: any) => this.emit({ type: 'move', data: { id: data.id, position: data.position, rotation: data.rotation } }));
    this.socket.on('player-jumped', (data: any) => this.emit({ type: 'jump', data: { id: data.id } }));
    this.socket.on('player-rotated', (data: any) => this.emit({ type: 'rotate', data: { id: data.id, cameraAzimuth: data.cameraAzimuth } }));
    this.socket.on('hexagon-collided', (data: any) => this.emit({ type: 'hexagon-collided', data: { index: data.index, playerId: data.playerId } }));
    this.socket.on('hexagon-broken', (data: any) => this.emit({ type: 'hexagon-broken', data: { index: data.index } }));
    this.socket.on('damage-tile', (data: any) => this.emit({ type: 'damage-tile', data: { tileId: data.tileId, damage: data.damage } }));
    this.socket.on('player-hit', (data: any) => this.emit({ type: 'player-hit', data: { targetId: data.targetId, impulse: data.impulse } }));
    this.socket.on('player-eliminated', (data: any) => this.emit({ type: 'player-eliminated', data: { id: data.id ?? data.playerId, rank: data.rank } }));
    this.socket.on('player-disconnected', (data: any) => this.emit({ type: 'player-disconnected', data: { id: data.id } }));
    this.socket.on('game-ended', (data: any) => this.emit({ type: 'game-ended', data: { winner: data?.winner ?? null } }));
    this.socket.on('game-started', () => this.emit({ type: 'game-started', data: {} }));
    this.socket.on('powerup-collected', (data: any) => this.emit({ type: 'powerup-collected', data: { powerupId: data.powerupId, playerId: data.playerId, powerupType: data.powerupType } }));
    this.socket.on('powerup-respawned', (data: any) => this.emit({ type: 'powerup-respawned', data: { powerupId: data.powerupId, newTileId: data.newTileId, position: data.position } }));

    this.socket.on('error', (data: any) => this.emit({ type: 'error', message: data?.message ?? 'Server error' }));
    this.socket.on('connect_error', () => this.emit({ type: 'error', message: 'Failed to connect to server.' }));
    this.socket.on('disconnect', () => this.emit({ type: 'close' }));
  }

  send(msg: NetMessage) {
    if (this.closed) return;
    // Translate back to socket.io event names matching server.js
    switch (msg.kind) {
      case 'move':
        this.socket.emit('move', { gameId: gameIdStore, id: msg.id, position: msg.position, rotation: msg.rotation });
        break;
      case 'jump':
        this.socket.emit('jump', { gameId: gameIdStore, id: msg.id, eventId: Date.now().toString() });
        break;
      case 'rotate':
        this.socket.emit('rotate', { gameId: gameIdStore, id: msg.id, cameraAzimuth: msg.cameraAzimuth });
        break;
      case 'hexagon-collided':
        this.socket.emit('hexagon-collided', { gameId: gameIdStore, index: msg.index, playerId: msg.playerId, eventId: Date.now().toString() });
        break;
      case 'break-hexagon':
        this.socket.emit('break-hexagon', { gameId: gameIdStore, index: msg.index });
        break;
      case 'damage-tile':
        this.socket.emit('damage-tile', { gameId: gameIdStore, tileId: msg.tileId, damage: msg.damage });
        break;
      case 'player-hit':
        this.socket.emit('player-hit', { gameId: gameIdStore, targetId: msg.targetId, impulse: msg.impulse });
        break;
      case 'player-eliminated':
        this.socket.emit('player-eliminated', { gameId: gameIdStore, playerId: msg.id });
        break;
      case 'new-player':
      case 'init':
      case 'game-ended':
      case 'player-disconnected':
      case 'hexagon-broken':
      case 'hexagon-collided':
        // Server-controlled or handled above; we don't send these from client.
        break;
      case 'game-started':
        // Host broadcasts game-started when the countdown ends. The server
        // relays it to all players in the room. Include the gameId so the
        // server knows which room to broadcast to.
        this.socket.emit('game-started', { gameId: gameIdStore });
        break;
      case 'powerup-collected':
        this.socket.emit('powerup-collected', { gameId: gameIdStore, powerupId: msg.powerupId, playerId: msg.playerId, powerupType: msg.powerupType });
        break;
      case 'powerup-respawned':
        this.socket.emit('powerup-respawned', { gameId: gameIdStore, powerupId: msg.powerupId, newTileId: msg.newTileId, position: msg.position });
        break;
    }
  }

  onMessage(cb: (ev: NetEvent) => void) {
    this.listeners.add(cb);
  }

  private emit(ev: NetEvent) {
    this.listeners.forEach((cb) => cb(ev));
  }

  /** Engine calls this after the init event tells us our gameId. */
  setGameId(id: string) {
    gameIdStore = id;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.disconnect(); } catch { /* ignore */ }
    this.emit({ type: 'close' });
  }
}

// Simple module-level state — SocketNetClient is created once per game session.
let gameIdStore: string = '';
