/**
 * WebRTC-based LAN multiplayer client.
 *
 * Pure peer-to-peer: NO server required. Two peers exchange SDP offer/answer
 * out-of-band (copy-paste / QR code) and then the RTCDataChannel takes over.
 *
 * Browsers automatically gather mDNS ICE candidates for hosts on the same LAN,
 * so once the offer/answer is exchanged, all traffic stays on the local network.
 *
 * Flow (intuitive — host invites guest):
 *   1. HOST: createOffer() → compressed invite code (QR + text)
 *   2. GUEST: paste/scan host's code → acceptOffer() → compressed answer code
 *   3. HOST: paste/scan guest's answer → acceptAnswer() → connected
 *
 * Topology: star — the host is the authoritative peer. One host can have N
 * guests (we open one RTCPeerConnection per guest on the host side, and one on
 * each guest). Host relays guest↔guest traffic.
 *
 * Codes are compressed with the browser's built-in deflate stream (60–70%
 * smaller) and base64url-encoded so they fit comfortably in a QR code.
 *
 * Robustness notes:
 *   - We DO NOT tear down the connection when the ICE/DTLS state briefly goes
 *     'disconnected' — that's a normal transient state on flaky Wi-Fi and on
 *     mobile network switching. We only treat 'failed' or 'closed' as fatal.
 *   - We add a public Google STUN server as a fallback. mDNS candidates are
 *     preferred for same-LAN traffic, but the STUN server makes the connection
 *     survive NAT'd networks and between-tab testing on the same machine
 *     (where mDNS is sometimes blocked by browser anti-fingerprinting).
 */
import type { NetClient, NetMessage, NetEvent } from './types';

const LABEL = 'bounceroyale';

// mDNS works for same-LAN, but STUN gives us a server-reflexive fallback
// candidate that survives NAT and works between two browser tabs on the same
// machine (where Chrome sometimes blocks mDNS for anti-fingerprinting).
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const PC_CONFIG: RTCConfiguration = {
  iceServers: ICE_SERVERS,
  iceTransportPolicy: 'all',
  bundlePolicy: 'max-bundle',
};

// ============================================================================
// Compression helpers — deflate via CompressionStream + URL-safe base64.
// Falls back to raw JSON if the browser lacks CompressionStream (very old).
// ============================================================================

function hasCompression(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

function bytesToBase64Url(bytes: Uint8Array): string {
  // URL-safe base64: '+' → '-', '/' → '_', strip '=' padding.
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
  }
  let b64 = btoa(bin);
  b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64;
}

function base64UrlToBytes(b64: string): Uint8Array {
  let s = b64.replace(/-/g, '+').replace(/_/g, '/');
  // Re-pad
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Compress an SDP payload string into a short, QR-friendly text code. */
export async function compressCode(plain: string): Promise<string> {
  if (!hasCompression()) return 'u' + plain; // 'u' prefix = uncompressed marker
  const stream = new Blob([plain]).stream().pipeThrough(new CompressionStream('deflate'));
  const buf = await new Response(stream).arrayBuffer();
  return 'c' + bytesToBase64Url(new Uint8Array(buf)); // 'c' prefix = compressed
}

/** Reverse of compressCode. */
export async function decompressCode(code: string): Promise<string> {
  if (!code) throw new Error('Empty code');
  const prefix = code[0];
  const rest = code.slice(1);

  if (prefix === 'u') return rest; // uncompressed
  if (prefix === 'c') {
    if (!hasCompression()) throw new Error('Browser missing DecompressionStream');
    const bytes = base64UrlToBytes(rest);
    // FIX: Cast to ArrayBuffer to satisfy strict TypeScript Blob types
    const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('deflate'));
    return await new Response(stream).text();
  }
  // Backwards compat: legacy payloads were raw JSON.
  return code;
}

// ============================================================================
// Host
// ============================================================================

/** Create the host-side WebRTC client. Call .createOffer() to get the invite code. */
export class WebRTCNetHost implements NetClient {
  readonly isHost = true;
  readonly id: string;
  private peerConns = new Map<string, RTCPeerConnection>();
  private dataChannels = new Map<string, RTCDataChannel>();
  private listeners = new Set<(ev: NetEvent) => void>();
  private peerListeners = new Set<(peers: string[]) => void>();
  /** peerId → pc awaiting a guest's answer. */
  private pendingOffers = new Map<string, RTCPeerConnection>();
  private closed = false;

  constructor(id: string) {
    this.id = id;
  }

  /**
   * Generate the host's invite code. Display this to the user (QR + text).
   *
   * The host creates a fresh RTCPeerConnection + data channel and produces an
   * SDP offer. The guest will accept this offer and produce an answer, which
   * the host then applies via acceptAnswer().
   */
  async createOffer(): Promise<string> {
    const peerId = `g-${Math.random().toString(36).slice(2, 9)}`;
    const pc = this.createPeerConnection(peerId);
    // Host creates the data channel — the guest receives it via ondatachannel.
    const dc = pc.createDataChannel(LABEL, { ordered: false, maxRetransmits: 0 });
    this.bindDataChannel(peerId, dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceComplete(pc);

    this.pendingOffers.set(peerId, pc);

    const payload = JSON.stringify({ sdp: pc.localDescription, peerId, hostId: this.id });
    return compressCode(payload);
  }

  /** Apply the guest's compressed answer to finalize a pending connection. */
  async acceptAnswer(compressedAnswer: string): Promise<void> {
    const decoded = await decompressCode(compressedAnswer);
    const parsed = JSON.parse(decoded) as { sdp: RTCSessionDescriptionInit; peerId?: string };
    const peerId = parsed.peerId;
    if (!peerId) throw new Error('Answer missing peerId');
    const pc = this.pendingOffers.get(peerId) || this.peerConns.get(peerId);
    if (!pc) throw new Error('No pending offer for peerId: ' + peerId);
    console.log('Applying answer for peer:', peerId);
    console.log('Current signaling state:', pc.signalingState);
    await pc.setRemoteDescription(parsed.sdp);
    this.pendingOffers.delete(peerId);
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection(PC_CONFIG);
    this.peerConns.set(peerId, pc);

    pc.onconnectionstatechange = () => {
      console.log(
        '[HOST]',
        peerId,
        'Connection State:',
        pc.connectionState
      );

      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.handlePeerDisconnect(peerId);
      }
    };
    pc.oniceconnectionstatechange = () => {
      console.log(
        '[HOST]',
        peerId,
        'ICE State:',
        pc.iceConnectionState
      );

      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce(); } catch { }
      }
    };
    pc.ondatachannel = (e) => {
      // Fires if the guest created the channel (legacy flow) — bind it.
      this.bindDataChannel(peerId, e.channel);
    };
    return pc;
  }

  private bindDataChannel(peerId: string, dc: RTCDataChannel) {
    this.dataChannels.set(peerId, dc);
    dc.binaryType = 'arraybuffer';
    // Buffer small messages so a burst of position updates doesn't drop.
    try { dc.bufferedAmountLowThreshold = 65536; } catch { /* ignore */ }
    dc.onopen = () => {
      console.log('[HOST]', peerId, 'DataChannel OPEN');
      this.emit({ type: 'new-player', data: { id: peerId, position: { x: (Math.random() - 0.5) * 6, y: 5, z: (Math.random() - 0.5) * 6 } } });
      this.emitPeerChange();
    };
    dc.onmessage = (e) => this.handleRawMessage(peerId, e.data as string);
    // Treat data channel close as a recoverable signal — wait a moment, then
    // only fire peer-disconnected if the channel is *still* closed. This
    // avoids the "connects for a split second then disconnects" symptom that
    // happens when Chrome briefly flaps the data channel during ICE consent
    // freshness checks.
    dc.onclose = () => {
      console.log('[HOST]', peerId, 'DataChannel CLOSED');
      setTimeout(() => {
        if (dc.readyState === 'closed') this.handlePeerDisconnect(peerId);
      }, 1500);
    };
    dc.onerror = (e) => {
      console.warn('DataChannel error from', peerId, e);
      // Don't tear down on transient errors — let onclose/onconnectionstatechange decide.
    };
  }

  private handleRawMessage(fromPeer: string, raw: string) {
    try {
      const msg = JSON.parse(raw) as NetMessage;
      switch (msg.kind) {
        case 'move':
          this.emit({ type: 'move', data: { id: fromPeer, position: msg.position, rotation: msg.rotation } });
          break;
        case 'jump':
          this.emit({ type: 'jump', data: { id: fromPeer } });
          break;
        case 'rotate':
          this.emit({ type: 'rotate', data: { id: fromPeer, cameraAzimuth: msg.cameraAzimuth } });
          break;
        case 'hexagon-collided':
          this.emit({ type: 'hexagon-collided', data: { index: msg.index, playerId: fromPeer } });
          break;
        case 'break-hexagon':
          this.emit({ type: 'hexagon-broken', data: { index: msg.index } });
          break;
        case 'damage-tile':
          this.emit({ type: 'damage-tile', data: { tileId: msg.tileId, damage: msg.damage } });
          break;
        case 'player-hit':
          this.emit({ type: 'player-hit', data: { targetId: msg.targetId, impulse: msg.impulse } });
          break;
        case 'player-eliminated':
          // Guest telling host it died — re-broadcast with rank 0, host computes rank
          this.emit({ type: 'player-eliminated', data: { id: fromPeer, rank: 0 } });
          break;
        case 'new-player': {
          // Guest announcing itself to host
          this.emit({ type: 'new-player', data: { id: fromPeer, position: msg.position } });
          break;
        }
        case 'init': {
          // Host forwarding init data to a guest (rarely needed in this direction)
          this.emit({
            type: 'init', data: {
              gameId: msg.gameId,
              creatorId: msg.creatorId,
              players: msg.players,
              islandSeed: msg.islandSeed,
              islandSize: msg.islandSize,
              startTimer: msg.startTimer,
              serverStartTime: msg.serverStartTime,
            }
          });
          break;
        }
        case 'game-started':
          this.emit({ type: 'game-started', data: {} });
          break;
        case 'game-ended':
          this.emit({ type: 'game-ended', data: { winner: msg.winner ?? null } });
          break;
        case 'player-disconnected':
          this.emit({ type: 'player-disconnected', data: { id: fromPeer } });
          break;
        default:
          // ignore unknown
          break;
      }
    } catch (e) {
      console.warn('Bad message from peer', fromPeer, e);
    }
  }

  private handlePeerDisconnect(peerId: string) {
    const had = this.dataChannels.has(peerId);
    this.dataChannels.delete(peerId);
    const pc = this.peerConns.get(peerId);
    if (pc) {
      try { pc.close(); } catch { /* ignore */ }
      this.peerConns.delete(peerId);
    }
    this.pendingOffers.delete(peerId);
    if (had) {
      this.emit({ type: 'player-disconnected', data: { id: peerId } });
    }
    this.emitPeerChange();
  }

  private emitPeerChange() {
    const peers = Array.from(this.dataChannels.keys());
    this.peerListeners.forEach((cb) => cb(peers));
  }

  /** Broadcast to all connected guests. */
  send(msg: NetMessage) {
    const raw = JSON.stringify(msg);
    for (const dc of this.dataChannels.values()) {
      if (dc.readyState === 'open') {
        try { dc.send(raw); } catch { /* ignore */ }
      }
    }
  }

  onMessage(cb: (ev: NetEvent) => void) {
    this.listeners.add(cb);
  }
  onPeerChange(cb: (peers: string[]) => void) {
    this.peerListeners.add(cb);
    cb(Array.from(this.dataChannels.keys()));
  }

  private emit(ev: NetEvent) {
    this.listeners.forEach((cb) => cb(ev));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const dc of this.dataChannels.values()) {
      try { dc.close(); } catch { /* ignore */ }
    }
    for (const pc of this.peerConns.values()) {
      try { pc.close(); } catch { /* ignore */ }
    }
    this.dataChannels.clear();
    this.peerConns.clear();
    this.pendingOffers.clear();
    this.emit({ type: 'close' });
  }
}

// ============================================================================
// Guest
// ============================================================================

/** Create the guest-side WebRTC client. */
export class WebRTCNetGuest implements NetClient {
  readonly isHost = false;
  readonly id: string;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private listeners = new Set<(ev: NetEvent) => void>();
  private closed = false;
  // Guard against firing 'close' multiple times and against firing it on
  // transient disconnects — we only emit 'close' after the channel has been
  // down for >1.5s, OR when the user explicitly calls close().
  private closeTimer: number | null = null;

  constructor(id: string) {
    this.id = id;
  }

  /**
   * Accept the host's compressed offer and produce a compressed answer.
   *
   * The guest receives the host's data channel via ondatachannel — it does
   * NOT create its own. The returned string should be sent back to the host
   * (via QR code or copy-paste), and the host applies it with acceptAnswer().
   */
  async acceptOffer(compressedOffer: string): Promise<string> {
    if (this.pc) throw new Error('Guest already has an active offer');
    const decoded = await decompressCode(compressedOffer);
    const parsed = JSON.parse(decoded) as { sdp: RTCSessionDescriptionInit; peerId?: string; hostId?: string };

    this.pc = new RTCPeerConnection(PC_CONFIG);
    // Guest receives the host's data channel.
    this.pc.ondatachannel = (e) => {
      this.dc = e.channel;
      this.bindDataChannel(this.dc);
    };
    this.pc.onconnectionstatechange = () => {
      console.log(
        '[GUEST]',
        'Connection State:',
        this.pc?.connectionState
      );

      if (!this.pc) return;

      if (
        this.pc.connectionState === 'failed' ||
        this.pc.connectionState === 'closed'
      ) {
        this.scheduleClose();
      }
    };
    this.pc.oniceconnectionstatechange = () => {
      console.log(
        '[GUEST]',
        'ICE State:',
        this.pc?.iceConnectionState
      );

      if (!this.pc) return;

      if (this.pc.iceConnectionState === 'failed') {
        try { this.pc.restartIce(); } catch { }
      }
    };

    await this.pc.setRemoteDescription(parsed.sdp);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitForIceComplete(this.pc);

    const payload = JSON.stringify({ sdp: this.pc.localDescription, peerId: parsed.peerId });
    return compressCode(payload);
  }

  private bindDataChannel(dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer';
    try { dc.bufferedAmountLowThreshold = 65536; } catch { /* ignore */ }
    dc.onopen = () => {
      console.log('[GUEST] DataChannel OPEN');
      // Cancel any pending close — we reconnected.
      if (this.closeTimer !== null) {
        clearTimeout(this.closeTimer);
        this.closeTimer = null;
      }
      this.emit({ type: 'open', id: this.id });
      // Identify ourselves to the host
      this.send({ kind: 'new-player', id: this.id, position: { x: (Math.random() - 0.5) * 6, y: 5, z: (Math.random() - 0.5) * 6 } });
    };
    dc.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as NetMessage;
        switch (msg.kind) {
          case 'init':
            this.emit({
              type: 'init', data: {
                gameId: msg.gameId,
                creatorId: msg.creatorId,
                players: msg.players,
                islandSeed: msg.islandSeed,
                islandSize: msg.islandSize,
                startTimer: msg.startTimer,
                serverStartTime: msg.serverStartTime,
              }
            });
            break;
          case 'new-player':
            this.emit({ type: 'new-player', data: { id: msg.id, position: msg.position } });
            break;
          case 'move':
            this.emit({ type: 'move', data: { id: msg.id, position: msg.position, rotation: msg.rotation } });
            break;
          case 'jump':
            this.emit({ type: 'jump', data: { id: msg.id } });
            break;
          case 'rotate':
            this.emit({ type: 'rotate', data: { id: msg.id, cameraAzimuth: msg.cameraAzimuth } });
            break;
          case 'hexagon-collided':
            this.emit({ type: 'hexagon-collided', data: { index: msg.index, playerId: msg.playerId } });
            break;
          case 'break-hexagon':
            this.emit({ type: 'hexagon-broken', data: { index: msg.index } });
            break;
          case 'damage-tile':
            this.emit({ type: 'damage-tile', data: { tileId: msg.tileId, damage: msg.damage } });
            break;
          case 'player-hit':
            this.emit({ type: 'player-hit', data: { targetId: msg.targetId, impulse: msg.impulse } });
            break;
          case 'player-eliminated':
            this.emit({ type: 'player-eliminated', data: { id: msg.id, rank: msg.rank } });
            break;
          case 'player-disconnected':
            this.emit({ type: 'player-disconnected', data: { id: msg.id } });
            break;
          case 'game-ended':
            this.emit({ type: 'game-ended', data: { winner: msg.winner ?? null } });
            break;
          case 'game-started':
            this.emit({ type: 'game-started', data: {} });
            break;
          default:
            // ignore
            break;
        }
      } catch (err) {
        console.warn('Bad message from host', err);
      }
    };
    dc.onclose = () => {
      console.log('[GUEST] DataChannel CLOSED');
      // Give ICE a moment to recover before declaring the connection lost.
      this.scheduleClose();
    };
    dc.onerror = (e) => {
      console.warn('Guest datachannel error', e);
      // Don't tear down — let onclose/onconnectionstatechange decide.
    };
  }

  private scheduleClose() {
    if (this.closeTimer !== null) return;
    if (this.closed) return;
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      // Re-check: maybe the channel reopened during the wait.
      if (this.dc && this.dc.readyState === 'open') return;
      if (this.pc && (this.pc.connectionState === 'connected' || this.pc.connectionState === 'connecting')) return;
      this.emit({ type: 'close' });
    }, 2000);
  }

  send(msg: NetMessage) {
    if (this.dc && this.dc.readyState === 'open') {
      try { this.dc.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  onMessage(cb: (ev: NetEvent) => void) {
    this.listeners.add(cb);
  }

  private emit(ev: NetEvent) {
    this.listeners.forEach((cb) => cb(ev));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    try { this.dc?.close(); } catch { /* ignore */ }
    try { this.pc?.close(); } catch { /* ignore */ }
    this.emit({ type: 'close' });
  }
}

// ============================================================================
// ICE gathering helper
// ============================================================================

/**
 * Wait for ICE gathering to produce enough candidates for a reliable
 * cross-device connection.
 *
 * The problem we're solving: on a LAN, the browser gathers mDNS/host
 * candidates almost instantly (< 10 ms), but STUN (server-reflexive)
 * candidates take 200–800 ms because they require a round-trip to the STUN
 * server. If we resolve too early (as soon as the first candidate arrives),
 * the SDP only contains the mDNS candidate — which works between two tabs on
 * the same machine but does NOT resolve across devices on the same Wi-Fi
 * (each browser has its own mDNS responder).
 *
 * Strategy: wait until we've seen at least one `srflx` (STUN) candidate, then
 * give a short grace period for any additional candidates. If no srflx
 * candidate arrives within the timeout, fall back to whatever we have (better
 * than blocking forever — the user might be on a network that blocks STUN).
 */
function waitForIceComplete(pc: RTCPeerConnection, timeoutMs = 6000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    let done = false;
    let gotSrflx = false;
    let gotAnyCandidate = false;

    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', stateCheck);
      pc.removeEventListener('icecandidate', candidateCheck);
      resolve();
    };
    const stateCheck = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const candidateCheck = (e: RTCPeerConnectionIceEvent) => {
      if (e.candidate) {
        gotAnyCandidate = true;
        // Check the candidate type. The candidate string contains a typ= field.
        const cand = e.candidate.candidate || '';
        if (cand.includes('typ srflx') || cand.includes('typ prflx') || cand.includes('typ relay')) {
          // Got a server-reflexive, peer-reflexive, or relay candidate —
          // these are the ones that work cross-device. Give a short grace
          // period for any more candidates, then resolve.
          gotSrflx = true;
          setTimeout(finish, 300);
        }
        // If we only have host/mDNS candidates so far, keep waiting for STUN.
      } else {
        // null candidate = ICE gathering complete.
        finish();
      }
    };
    pc.addEventListener('icegatheringstatechange', stateCheck);
    pc.addEventListener('icecandidate', candidateCheck);

    // If we get at least one candidate but no srflx within 2.5s, resolve
    // anyway — the network might block STUN, and host candidates are better
    // than nothing (they'll work for same-machine testing at least).
    setTimeout(() => {
      if (gotAnyCandidate && !done) finish();
    }, 2500);

    // Hard timeout.
    setTimeout(finish, timeoutMs);
  });
}
