/**
 * Socket.io client that wraps the existing Node.js + Socket.io server (kept as
 * a menu option). Translates socket events into NetEvent for the engine.
 */
import { io, type Socket } from 'socket.io-client';
import type { NetClient, NetMessage, NetEvent } from './types';

// ============================================================================
// URL normalization & mixed-content protection
// ============================================================================
//
// PROBLEM: When the client is deployed on HTTPS (e.g. Vercel, Netlify, GitHub
// Pages with custom domain), the browser BLOCKS any WebSocket connection to an
// insecure `ws://` or `http://` server. This is called "mixed content blocking"
// and it's a hard browser security policy — there is NO JavaScript workaround
// that can bypass it. The only solutions are:
//   1. Serve the game server over HTTPS/WSS (with SSL certificates), OR
//   2. Serve the client over HTTP (not HTTPS).
//
// Since the user can't change Vercel's HTTPS, the server MUST support WSS.
// What we CAN do in JS:
//   - Auto-upgrade `http://` → `https://` and `ws://` → `wss://` when the
//     client is on HTTPS. This prevents the silent mixed-content block and
//     gives the connection a chance to succeed (if the server actually
//     supports TLS on the same port).
//   - If the user entered a bare `host:port`, prepend the appropriate scheme
//     based on the current page's protocol.
//   - Emit a clear, actionable error if the connection fails, explaining the
//     mixed-content issue and how to fix it (add SSL to the server, or use a
//     reverse proxy like Cloudflare/ngrok/localtunnel that provides automatic
//     SSL).

export interface NormalizedUrl {
  /** The normalized URL (always has a protocol, upgraded to wss/https if needed). */
  url: string;
  /** True if we upgraded the protocol from insecure to secure. */
  upgraded: boolean;
  /** True if the connection would be mixed content (HTTPS page → HTTP server). */
  mixedContent: boolean;
  /** Human-readable warning, if any. */
  warning: string | null;
}

/**
 * Normalize a user-entered server URL for Socket.io connection.
 *
 * - If no protocol is given, prepend `https://` (or `http://` on http pages).
 * - If the page is HTTPS and the URL is `http://`/`ws://`, upgrade to
 *   `https://`/`wss://` to avoid mixed-content blocking.
 * - Socket.io accepts both `http(s)://` and `ws(s)://` URLs; we normalize to
 *   `http(s)://` because that's what the server actually speaks (Socket.io
 *   internally upgrades to WebSocket).
 */
export function normalizeServerUrl(raw: string): NormalizedUrl {
  let url = raw.trim();
  let upgraded = false;
  let warning: string | null = null;

  const pageIsHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';

  // Strip trailing slash for consistency.
  url = url.replace(/\/+$/, '');

  // If the user entered a `ws://` or `wss://` URL, convert to `http://` / `https://`.
  // Socket.io treats them equivalently, but normalizing to http(s) avoids edge
  // cases with some Socket.io server configs.
  if (url.startsWith('ws://')) {
    url = 'http://' + url.slice('ws://'.length);
  } else if (url.startsWith('wss://')) {
    url = 'https://' + url.slice('wss://'.length);
  }

  // If no protocol, prepend one based on the page protocol.
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = (pageIsHttps ? 'https://' : 'http://') + url;
  }

  // MIXED-CONTENT PROTECTION: if the page is HTTPS and the URL is http://,
  // the browser will block the WebSocket upgrade. Auto-upgrade to https://
  // and warn the user.
  const mixedContent = pageIsHttps && url.startsWith('http://');
  if (mixedContent) {
    url = 'https://' + url.slice('http://'.length);
    upgraded = true;
    warning =
      'Auto-upgraded server URL from http:// to https:// because this page is served over HTTPS. ' +
      'Browsers block insecure WebSocket connections from HTTPS pages (mixed content). ' +
      'If the connection fails, your game server must be configured to accept HTTPS/WSS connections ' +
      '(e.g. with SSL certificates, or behind a reverse proxy like Cloudflare, nginx, or ngrok).';
  }

  return { url, upgraded, mixedContent, warning };
}

export class SocketNetClient implements NetClient {
  readonly id: string;
  readonly isHost: boolean;
  private socket: Socket;
  private listeners = new Set<(ev: NetEvent) => void>();
  private closed = false;
  /** Stores the mixed-content warning (if any) so we can include it in the
   *  error message if the connection fails. */
  private mixedContentWarning: string | null = null;

  constructor(serverUrl: string, opts: { isHost: boolean; gameId?: string | null; startTimer?: number; playerId: string }) {
    this.isHost = opts.isHost;
    this.id = opts.playerId;

    // Normalize the URL: auto-upgrade http→https on HTTPS pages to avoid
    // mixed-content blocking. Store the warning so we can surface it if the
    // connection fails.
    const normalized = normalizeServerUrl(serverUrl);
    this.mixedContentWarning = normalized.warning;
    if (normalized.warning) {
      console.warn('[Socket] ' + normalized.warning);
    }
    console.log('[Socket] Connecting to:', normalized.url, normalized.upgraded ? '(upgraded from http)' : '');

    this.socket = io(normalized.url, {
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
    this.socket.on('player-shot', (data: any) => this.emit({ type: 'player-shot', data: { id: data.id, weapon: data.weapon, direction: data.direction, origin: data.origin } }));
    this.socket.on('player-eliminated', (data: any) => this.emit({ type: 'player-eliminated', data: { id: data.id ?? data.playerId, rank: data.rank } }));
    this.socket.on('player-disconnected', (data: any) => this.emit({ type: 'player-disconnected', data: { id: data.id } }));
    this.socket.on('game-ended', (data: any) => this.emit({ type: 'game-ended', data: { winner: data?.winner ?? null } }));
    this.socket.on('game-started', () => this.emit({ type: 'game-started', data: {} }));
    this.socket.on('powerup-collected', (data: any) => this.emit({ type: 'powerup-collected', data: { powerupId: data.powerupId, playerId: data.playerId, powerupType: data.powerupType } }));
    this.socket.on('powerup-respawned', (data: any) => this.emit({ type: 'powerup-respawned', data: { powerupId: data.powerupId, newTileId: data.newTileId, position: data.position } }));
    this.socket.on('peer-list', (data: any) => this.emit({ type: 'peer-list', data: { players: data.players ?? [] } }));
    this.socket.on('start-countdown', (data: any) => this.emit({ type: 'start-countdown', data: { startTimer: data.startTimer ?? 5 } }));

    this.socket.on('error', (data: any) => this.emit({ type: 'error', message: data?.message ?? 'Server error' }));
    this.socket.on('connect_error', (err: any) => {
      // Build a detailed, actionable error message. The most common cause of
      // connection failure when the client is on HTTPS (Vercel, Netlify, etc.)
      // is mixed-content blocking — the browser silently blocks the WebSocket
      // upgrade to ws:// because the page is https://. We already auto-upgrade
      // the URL in the constructor, but if the server doesn't support WSS the
      // connection still fails. Surface a clear explanation + fix.
      const pageIsHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
      let msg = 'Failed to connect to server.';
      if (err?.message) msg += `\nError: ${err.message}`;
      if (pageIsHttps) {
        msg += '\n\n⚠️ This page is served over HTTPS, so the browser blocks insecure (ws://) WebSocket connections.';
        msg += '\n\nTo fix this, your game server MUST accept HTTPS/WSS connections. Options:';
        msg += '\n  1. Run the server with SSL certificates (the server.cjs auto-detects Let\'s Encrypt certs at /etc/letsencrypt/live/...).';
        msg += '\n  2. Put the server behind a reverse proxy that provides SSL (Cloudflare, nginx, Caddy, Traefik).';
        msg += '\n  3. Use a tunneling service that gives you an HTTPS URL (ngrok, localtunnel, Cloudflare Tunnel).';
        msg += '\n  4. For local testing: serve the client over HTTP too (npm run preview on http://localhost:4173), so both sides are HTTP.';
      } else {
        msg += '\n\nCheck that the server is running and the URL/port is correct.';
      }
      if (this.mixedContentWarning) {
        msg += '\n\n' + this.mixedContentWarning;
      }
      this.emit({ type: 'error', message: msg });
    });
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
      case 'player-shot':
        this.socket.emit('player-shot', { gameId: gameIdStore, id: msg.id, weapon: msg.weapon, direction: msg.direction, origin: msg.origin });
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
      case 'peer-list':
        // Server-mode: server is the authority for the roster; clients don't
        // send peer-list. Ignore.
        break;
      case 'start-countdown':
        // Server-mode: server manages the countdown via the init event's
        // serverStartTime. Ignore.
        break;
    }
  }

  onMessage(cb: (ev: NetEvent) => void) {
    this.listeners.add(cb);
  }
  offMessage(cb: (ev: NetEvent) => void) {
    this.listeners.delete(cb);
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
