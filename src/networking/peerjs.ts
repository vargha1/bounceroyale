/**
 * Short-code LAN multiplayer client built on PeerJS.
 *
 * The host registers a PeerJS peer whose id is derived from a short room code
 * (e.g. `K7QXM`). A guest types that code and connects to the host peer. The
 * free public PeerJS broker only relays the WebRTC handshake (offer / answer /
 * ICE); all game traffic then flows device-to-device over an RTCDataChannel,
 * exactly like the manual copy/paste flow in webrtc.ts — just without the
 * giant codes.
 *
 * Both classes implement NetClient with the same NetEvent mapping,
 * `peer-list` / `start-countdown` lobby messages and pre-listener event
 * buffering as WebRTCNetHost / WebRTCNetGuest, so Game and the engine are
 * unaware of which transport is in use.
 *
 * Requires internet access during the handshake only. For offline hotspot
 * play, use the manual flow in webrtc.ts.
 */
import Peer, { type DataConnection } from 'peerjs';
import type { NetClient, NetMessage, NetEvent } from './types';

/** Unambiguous characters only (no 0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;
/** Namespaces our peer ids on the shared public broker. */
const PEER_PREFIX = 'bounceroyale-';
const MAX_CODE_ATTEMPTS = 6;
const CONNECT_TIMEOUT_MS = 15000;
const HOST_CONNECT_TIMEOUT_MS = 25000;
const MAX_BUFFERED_EVENTS = 200;

/**
 * ICE servers for host and guest. The PeerJS default is a single Google STUN
 * server, which fails when either side is behind a strict NAT. Extra STUN plus
 * a public TURN relay let the data channel open in those cases.
 */
const PEER_OPTIONS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turns:openrelay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
  },
};

export function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/** Uppercase, strip whitespace/dashes and ambiguous look-alikes the user may type. */
export function normalizeRoomCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '')
    .replace(/[IL]/g, '')
    .replace(/[01]/g, '');
}

export function isValidRoomCode(code: string): boolean {
  return code.length === ROOM_CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

const randomSuffix = (len: number) => Math.random().toString(36).slice(2, 2 + len);

/** Error type thrown by host/guest setup, with a stable `kind` the UI can map to a message. */
export class PeerSetupError extends Error {
  constructor(public kind: 'not-found' | 'broker' | 'timeout' | 'host-unreachable' | 'unknown', message: string) {
    super(message);
  }
}

function brokerError(err: any): PeerSetupError {
  const type = err?.type as string | undefined;
  if (type === 'peer-unavailable') return new PeerSetupError('not-found', 'No game with that code.');
  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed') {
    return new PeerSetupError('broker', 'Could not reach the matchmaking service. Check your internet connection.');
  }
  return new PeerSetupError('unknown', err?.message ?? 'Connection error');
}

/** Shared listener set + pre-listener buffering used by host and guest. */
class EventHub {
  private listeners = new Set<(ev: NetEvent) => void>();
  private pending: NetEvent[] = [];
  private openEmitted = false;

  constructor(private tag: string) {}

  emit(ev: NetEvent) {
    if (this.listeners.size === 0) {
      // No listener yet (e.g. the lobby is done but the engine hasn't mounted):
      // buffer so `init` / `peer-list` aren't lost. `open` fires at most once.
      if (ev.type === 'open') {
        if (this.openEmitted) return;
        this.openEmitted = true;
      }
      this.pending.push(ev);
      if (this.pending.length > MAX_BUFFERED_EVENTS) {
        this.pending.splice(0, this.pending.length - MAX_BUFFERED_EVENTS);
      }
      return;
    }
    this.listeners.forEach((cb) => cb(ev));
  }

  add(cb: (ev: NetEvent) => void) {
    this.listeners.add(cb);
    if (this.pending.length > 0) {
      const replay = this.pending;
      this.pending = [];
      queueMicrotask(() => {
        for (const ev of replay) {
          try { cb(ev); } catch (e) { console.warn(this.tag, 'replay threw', e); }
        }
      });
    }
  }

  remove(cb: (ev: NetEvent) => void) {
    this.listeners.delete(cb);
  }
}

// ============================================================================
// Host
// ============================================================================

export class PeerNetHost implements NetClient {
  readonly isHost = true;
  private _id = '';
  private _code = '';
  private peer: Peer | null = null;
  private conns = new Map<string, DataConnection>();
  private hub = new EventHub('[PEER HOST]');
  private peerListeners = new Set<(peers: string[]) => void>();
  private closed = false;
  private locked = false;

  get id() { return this._id; }
  /** The short room code guests type to join. Valid after open() resolves. */
  get code() { return this._code; }

  /**
   * Register with the broker under a fresh room code. Retries with a new code
   * if the id is already taken. Resolves with the code.
   */
  async open(): Promise<string> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = generateRoomCode();
      try {
        await this.register(code);
        return code;
      } catch (e) {
        if (e instanceof PeerSetupError || (e as any)?.type !== 'unavailable-id') throw e;
        // id taken on the broker — loop and try another code
      }
    }
    throw new PeerSetupError('unknown', 'Could not allocate a room code. Please try again.');
  }

  private register(code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const peer = new Peer(PEER_PREFIX + code, PEER_OPTIONS);
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try { peer.destroy(); } catch { /* ignore */ }
        reject(new PeerSetupError('timeout', 'Matchmaking service did not respond. Check your internet connection.'));
      }, CONNECT_TIMEOUT_MS);

      peer.on('open', () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.peer = peer;
        this._code = code;
        this._id = `host-${code}`;
        this.bindPeer(peer);
        resolve();
      });
      peer.on('error', (err: any) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        try { peer.destroy(); } catch { /* ignore */ }
        if (err?.type === 'unavailable-id') reject(err);
        else reject(brokerError(err));
      });
    });
  }

  private bindPeer(peer: Peer) {
    peer.on('connection', (conn) => {
      if (this.locked || this.closed) {
        // Game already started — late joiners can't be added mid-match.
        conn.on('open', () => { try { conn.close(); } catch { /* ignore */ } });
        return;
      }
      const playerId = conn.peer.startsWith(PEER_PREFIX) ? conn.peer.slice(PEER_PREFIX.length) : conn.peer;
      conn.on('open', () => {
        if (this.locked || this.closed) { try { conn.close(); } catch { /* ignore */ } return; }
        this.conns.set(playerId, conn);
        console.log('[PEER HOST]', playerId, 'connected');
        this.hub.emit({ type: 'new-player', data: { id: playerId, position: { x: (Math.random() - 0.5) * 6, y: 5, z: (Math.random() - 0.5) * 6 } } });
        this.emitPeerChange();
        // Let the guest attach its listeners before the roster arrives.
        window.setTimeout(() => this.broadcastPeerList(), 50);
      });
      conn.on('data', (data) => this.handleMessage(playerId, data as NetMessage));
      conn.on('close', () => this.handleDisconnect(playerId, conn));
      conn.on('error', (e) => console.warn('[PEER HOST] connection error from', playerId, e));
    });
    // Broker link dropped (e.g. Wi-Fi blip). Existing P2P links keep working;
    // try to restore the broker link so more guests can still join.
    peer.on('disconnected', () => {
      if (!this.closed && !peer.destroyed) {
        try { peer.reconnect(); } catch { /* ignore */ }
      }
    });
    peer.on('error', (err: any) => console.warn('[PEER HOST] peer error', err?.type, err));
  }

  private handleMessage(fromPeer: string, msg: NetMessage) {
    if (!msg || typeof msg !== 'object') return;
    // The guest's claimed id equals its peer id; prefer it when present.
    const playerId = typeof (msg as any).id === 'string' ? ((msg as any).id as string) : fromPeer;
    switch (msg.kind) {
      case 'move':
        this.hub.emit({ type: 'move', data: { id: playerId, position: msg.position, rotation: msg.rotation, cameraAzimuth: msg.cameraAzimuth } });
        break;
      case 'jump':
        this.hub.emit({ type: 'jump', data: { id: playerId } });
        break;
      case 'rotate':
        this.hub.emit({ type: 'rotate', data: { id: playerId, cameraAzimuth: msg.cameraAzimuth } });
        break;
      case 'hexagon-collided':
        this.hub.emit({ type: 'hexagon-collided', data: { index: msg.index, playerId: fromPeer } });
        break;
      case 'break-hexagon':
        this.hub.emit({ type: 'hexagon-broken', data: { index: msg.index } });
        break;
      case 'damage-tile':
        this.hub.emit({ type: 'damage-tile', data: { tileId: msg.tileId, damage: msg.damage } });
        break;
      case 'player-hit':
        this.hub.emit({ type: 'player-hit', data: { targetId: msg.targetId, impulse: msg.impulse, damage: msg.damage } });
        break;
      case 'player-shot':
        this.hub.emit({ type: 'player-shot', data: { id: playerId, weapon: msg.weapon, direction: msg.direction, origin: msg.origin } });
        break;
      case 'player-eliminated':
        // Guest reporting its own death; host computes the rank.
        this.hub.emit({ type: 'player-eliminated', data: { id: playerId, rank: 0 } });
        break;
      case 'new-player':
        this.hub.emit({ type: 'new-player', data: { id: playerId, position: msg.position } });
        this.broadcastPeerList();
        break;
      case 'game-started':
        this.hub.emit({ type: 'game-started', data: {} });
        break;
      case 'game-ended':
        this.hub.emit({ type: 'game-ended', data: { winner: msg.winner ?? null } });
        break;
      case 'powerup-collected':
        this.hub.emit({ type: 'powerup-collected', data: { powerupId: msg.powerupId, playerId, powerupType: msg.powerupType } });
        break;
      case 'powerup-respawned':
        this.hub.emit({ type: 'powerup-respawned', data: { powerupId: msg.powerupId, newTileId: msg.newTileId, position: msg.position } });
        break;
      case 'player-disconnected':
        this.hub.emit({ type: 'player-disconnected', data: { id: fromPeer } });
        break;
      default:
        // init / peer-list / start-countdown are host→guest only.
        break;
    }
  }

  private handleDisconnect(playerId: string, conn: DataConnection) {
    // Ignore a stale close for a connection we've already replaced/removed.
    if (this.conns.get(playerId) !== conn) return;
    this.conns.delete(playerId);
    console.log('[PEER HOST]', playerId, 'disconnected');
    this.hub.emit({ type: 'player-disconnected', data: { id: playerId } });
    this.broadcastPeerList();
    this.emitPeerChange();
  }

  private openConns(): DataConnection[] {
    return Array.from(this.conns.values()).filter((c) => c.open);
  }

  private emitPeerChange() {
    const peers = this.openConns().map((c) => c.peer.slice(PEER_PREFIX.length));
    this.peerListeners.forEach((cb) => cb(peers));
  }

  /** Broadcast the lobby roster (host + connected guests) to every guest and locally. */
  broadcastPeerList() {
    const players = [
      { id: this.id, isHost: true },
      ...Array.from(this.conns.entries())
        .filter(([, c]) => c.open)
        .map(([id]) => ({ id, isHost: false })),
    ];
    const msg: NetMessage = { kind: 'peer-list', players };
    for (const c of this.openConns()) {
      try { c.send(msg); } catch { /* ignore */ }
    }
    this.hub.emit({ type: 'peer-list', data: { players } });
  }

  /** Tell all guests to leave the lobby and start their countdown. */
  broadcastStartCountdown(startTimer: number) {
    const msg: NetMessage = { kind: 'start-countdown', startTimer };
    for (const c of this.openConns()) {
      try { c.send(msg); } catch { /* ignore */ }
    }
  }

  /** Refuse any further joiners (call when the match starts). */
  lock() {
    this.locked = true;
  }

  send(msg: NetMessage) {
    for (const c of this.openConns()) {
      try { c.send(msg); } catch { /* ignore */ }
    }
  }

  onMessage(cb: (ev: NetEvent) => void) { this.hub.add(cb); }
  offMessage(cb: (ev: NetEvent) => void) { this.hub.remove(cb); }

  onPeerChange(cb: (peers: string[]) => void) {
    this.peerListeners.add(cb);
    cb(this.openConns().map((c) => c.peer.slice(PEER_PREFIX.length)));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.conns.values()) {
      try { c.close(); } catch { /* ignore */ }
    }
    this.conns.clear();
    try { this.peer?.destroy(); } catch { /* ignore */ }
    this.hub.emit({ type: 'close' });
  }
}

// ============================================================================
// Guest
// ============================================================================

export class PeerNetGuest implements NetClient {
  readonly isHost = false;
  readonly id: string;
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private hub = new EventHub('[PEER GUEST]');
  private closed = false;

  constructor() {
    this.id = `g-${randomSuffix(8)}`;
  }

  /** Connect to the host that owns `code`. Resolves once the data channel is open. */
  join(code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e: PeerSetupError) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        try { this.peer?.destroy(); } catch { /* ignore */ }
        this.peer = null;
        reject(e);
      };
      // Phase 1: reach the broker. Phase 2 (after `open`): open the data channel to the host.
      let timer = window.setTimeout(
        () => fail(new PeerSetupError('timeout', 'Matchmaking service did not respond. Check your internet connection.')),
        CONNECT_TIMEOUT_MS,
      );

      const peer = new Peer(PEER_PREFIX + this.id, PEER_OPTIONS);
      this.peer = peer;

      peer.on('error', (err: any) => {
        if (!settled) { fail(brokerError(err)); return; }
        console.warn('[PEER GUEST] peer error', err?.type, err);
      });

      peer.on('open', () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(
          () => fail(new PeerSetupError('host-unreachable', 'Found the room but could not open a connection to the host.')),
          HOST_CONNECT_TIMEOUT_MS,
        );
        const conn = peer.connect(PEER_PREFIX + code, { serialization: 'json', reliable: false });
        this.conn = conn;
        conn.on('open', () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          console.log('[PEER GUEST] connected to host', code);
          this.hub.emit({ type: 'open', id: this.id });
          // Identify ourselves to the host.
          this.send({ kind: 'new-player', id: this.id, position: { x: (Math.random() - 0.5) * 6, y: 5, z: (Math.random() - 0.5) * 6 } });
          resolve();
        });
        conn.on('data', (data) => this.handleMessage(data as NetMessage));
        conn.on('close', () => {
          if (!settled) { fail(new PeerSetupError('unknown', 'The host closed the connection.')); return; }
          if (!this.closed) this.hub.emit({ type: 'close' });
        });
        conn.on('error', (e) => console.warn('[PEER GUEST] connection error', e));
      });
    });
  }

  private handleMessage(msg: NetMessage) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.kind) {
      case 'init':
        this.hub.emit({
          type: 'init',
          data: {
            gameId: msg.gameId,
            creatorId: msg.creatorId,
            players: msg.players,
            islandSeed: msg.islandSeed,
            islandSize: msg.islandSize,
            startTimer: msg.startTimer,
            serverStartTime: msg.serverStartTime,
          },
        });
        break;
      case 'new-player':
        this.hub.emit({ type: 'new-player', data: { id: msg.id, position: msg.position } });
        break;
      case 'move':
        this.hub.emit({ type: 'move', data: { id: msg.id, position: msg.position, rotation: msg.rotation, cameraAzimuth: msg.cameraAzimuth } });
        break;
      case 'jump':
        this.hub.emit({ type: 'jump', data: { id: msg.id } });
        break;
      case 'rotate':
        this.hub.emit({ type: 'rotate', data: { id: msg.id, cameraAzimuth: msg.cameraAzimuth } });
        break;
      case 'hexagon-collided':
        this.hub.emit({ type: 'hexagon-collided', data: { index: msg.index, playerId: msg.playerId } });
        break;
      case 'break-hexagon':
        this.hub.emit({ type: 'hexagon-broken', data: { index: msg.index } });
        break;
      case 'damage-tile':
        this.hub.emit({ type: 'damage-tile', data: { tileId: msg.tileId, damage: msg.damage } });
        break;
      case 'player-hit':
        this.hub.emit({ type: 'player-hit', data: { targetId: msg.targetId, impulse: msg.impulse, damage: msg.damage } });
        break;
      case 'player-shot':
        this.hub.emit({ type: 'player-shot', data: { id: msg.id, weapon: msg.weapon, direction: msg.direction, origin: msg.origin } });
        break;
      case 'player-eliminated':
        this.hub.emit({ type: 'player-eliminated', data: { id: msg.id, rank: msg.rank } });
        break;
      case 'player-disconnected':
        this.hub.emit({ type: 'player-disconnected', data: { id: msg.id } });
        break;
      case 'game-ended':
        this.hub.emit({ type: 'game-ended', data: { winner: msg.winner ?? null } });
        break;
      case 'game-started':
        this.hub.emit({ type: 'game-started', data: {} });
        break;
      case 'powerup-collected':
        this.hub.emit({ type: 'powerup-collected', data: { powerupId: msg.powerupId, playerId: msg.playerId, powerupType: msg.powerupType } });
        break;
      case 'powerup-respawned':
        this.hub.emit({ type: 'powerup-respawned', data: { powerupId: msg.powerupId, newTileId: msg.newTileId, position: msg.position } });
        break;
      case 'peer-list':
        this.hub.emit({ type: 'peer-list', data: { players: msg.players } });
        break;
      case 'start-countdown':
        this.hub.emit({ type: 'start-countdown', data: { startTimer: msg.startTimer } });
        break;
      default:
        break;
    }
  }

  send(msg: NetMessage) {
    if (this.conn && this.conn.open) {
      try { this.conn.send(msg); } catch { /* ignore */ }
    }
  }

  onMessage(cb: (ev: NetEvent) => void) { this.hub.add(cb); }
  offMessage(cb: (ev: NetEvent) => void) { this.hub.remove(cb); }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.conn?.close(); } catch { /* ignore */ }
    try { this.peer?.destroy(); } catch { /* ignore */ }
    this.hub.emit({ type: 'close' });
  }
}
