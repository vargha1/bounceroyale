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
 * Player ID convention
 * --------------------
 * The host generates a `peerId` (e.g. `g-abc123`) when it creates the offer
 * and embeds it in the SDP payload. The guest MUST adopt that peerId as its
 * own NetClient.id when accepting the offer — this is the single source of
 * truth for the guest's player id on both sides. Otherwise the host's
 * `players` map and the guest's `localPlayerId` disagree, and the guest never
 * creates a local sphere (the classic "only host can move" bug).
 *
 * Hotspot / no-internet LAN support
 * ---------------------------------
 * Chrome's mDNS anti-fingerprinting obfuscates local IPs as `xxxx.local`
 * hostnames. These resolve between two tabs on the same machine but NOT across
 * devices — each device has its own mDNS responder. On a router-based Wi-Fi,
 * STUN (server-reflexive) candidates provide a fallback. But on a mobile
 * hotspot without internet routing, STUN fails AND mDNS doesn't resolve, so
 * the connection silently fails.
 *
 * Fix: the host and/or guest can optionally enter their own local IP (e.g.
 * `192.168.43.1` for Android hotspot, `172.20.10.1` for iOS, `10.181.207.147`
 * for a PC on a phone-hotspot Wi-Fi). We DO NOT modify the SDP text — instead
 * we extract extra `RTCIceCandidateInit` objects that mirror the mDNS
 * candidates' ports but use the manual IP, ship them as a separate
 * `extraCandidates` field in the compressed payload, and the receiver applies
 * them via the proper `addIceCandidate()` API. This is robust against browser
 * parser quirks (manually-edited SDP candidate lines caused
 * `Failed to parse SessionDescription` errors on some mobile browsers).
 *
 * Robustness notes:
 *   - We DO NOT tear down the connection when the ICE/DTLS state briefly goes
 *     'disconnected' — that's a normal transient state on flaky Wi-Fi and on
 *     mobile network switching. We only treat 'failed' or 'closed' as fatal.
 *   - We add a public Google STUN server as a fallback. mDNS candidates are
 *     preferred for same-LAN traffic, but the STUN server makes the connection
 *     survive NAT'd networks and between-tab testing on the same machine
 *     (where mDNS is sometimes blocked by browser anti-fingerprinting).
 *   - The guest BUFFERS NetEvents that arrive before any listener is
 *     registered. This closes a real race: the data channel opens, the guest
 *     fires `open` + sends `new-player`, the host responds with `init` — all
 *     before React has finished mounting the Game component and registering
 *     the engine's listener. Without buffering, that `init` is lost forever
 *     and the guest never creates its local sphere.
 */
import type { NetClient, NetMessage, NetEvent } from './types';

const LABEL = 'bounceroyale';

// mDNS works for same-LAN, but STUN gives us a server-reflexive fallback
// candidate that survives NAT and works between two browser tabs on the same
// machine (where Chrome sometimes blocks mDNS for anti-fingerprinting).
//
// NOTE: We intentionally do NOT add a TURN server. TURN would relay traffic
// through a public server, defeating the purpose of "no server required" LAN
// play. If both mDNS and STUN fail (e.g. mobile hotspot with no internet),
// the host can manually enter its local IP — see createOffer(manualHostIp).
// Multiple STUN servers for redundancy. Google's are usually reachable, but
// some corporate/college networks block them. Adding OpenRelay and others
// increases the chance that at least one works. We intentionally do NOT add
// a TURN server (TURN would relay traffic through a public server, defeating
// the purpose of "no server required" LAN play AND costing bandwidth). If
// both mDNS and STUN fail on your network, use the manual LAN IP field.
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun.stunprotocol.org:3478' },
  { urls: 'stun:stun.services.mozilla.com:3478' },
  { urls: 'stun:stun.sipgate.net:3478' },
  { urls: 'stun:stun.ekiga.net:3478' },
];

// ============================================================================
// Extra ICE candidates for manual LAN IP (hotspot fix)
// ============================================================================
//
// PROBLEM: On mobile hotspots without internet, Chrome's mDNS anti-fingerprinting
// produces candidates like `a=candidate:1234 1 udp 2122252543 abcdef-1234.local
// 54321 typ host` that don't resolve across devices (each device has its own
// mDNS responder), and STUN can't reach the internet through the hotspot. So
// the connection silently fails.
//
// PREVIOUS APPROACH (BROKEN): Inject extra `a=candidate:` lines into the SDP
// text by mirroring the mDNS ports but using the host's manual LAN IP. This
// caused `Failed to parse SessionDescription` errors on some browsers because
// the manually-constructed candidate strings didn't perfectly match the
// browser's internal candidate format (missing optional fields like `ufrag`,
// `network-id`, etc. that some parsers strictly require).
//
// CURRENT APPROACH (ROBUST): Don't touch the SDP at all. Instead:
//   1. Sender (host or guest) inspects its own local SDP for mDNS candidates
//      and constructs `RTCIceCandidateInit` objects using the manual IP and
//      the same port as each mDNS candidate.
//   2. Sender includes these `extraCandidates` as a separate JSON field in
//      the compressed payload (alongside the untouched SDP).
//   3. Receiver calls `setRemoteDescription(untouchedSdp)` — this ALWAYS
//      parses because the SDP is exactly what the browser generated.
//   4. Receiver calls `addIceCandidate(cand)` for each extra candidate.
//      This is the proper WebRTC API for adding remote candidates, and the
//      browser validates/handles them internally.
//
// This is more robust than SDP text manipulation because:
//   - The SDP is never modified, so it always parses.
//   - The browser's `addIceCandidate` handles candidate validation
//     internally, including any browser-specific quirks.
//   - We don't need to worry about line endings, missing optional fields,
//     or parser strictness differences between browsers.

/** Shape of an extra ICE candidate we ship in the offer/answer payload. */
export interface ExtraIceCandidate {
  /** Candidate string WITHOUT the `a=` prefix, e.g. `"candidate:900000001 1 udp 2122252542 192.168.43.1 54321 typ host generation 0"`. */
  candidate: string;
  /** Media-section mid (e.g. "0"). */
  sdpMid: string | null;
  /** Media-section index (0-based). */
  sdpMLineIndex: number | null;
  /** Optional ufrag (parsed from the SDP's `a=ice-ufrag:` line). */
  usernameFragment?: string | null;
}

/**
 * Inspect an SDP body and produce extra IP-based ICE candidates by mirroring
 * the ports of existing mDNS (`*.local`) candidates. The returned candidates
 * use the manual IP instead of the mDNS hostname, with the same port — so the
 * browser IS actually listening on that port (it just advertised it via mDNS).
 *
 * The priority is decremented by 1 so ICE prefers the original mDNS candidate
 * (which works for same-machine testing) but falls back to the IP candidate
 * when mDNS doesn't resolve (cross-device on a hotspot).
 *
 * We track the current `a=mid:` value and m-line index so each candidate
 * carries the right `sdpMid` / `sdpMLineIndex` for `addIceCandidate`.
 */
function extractExtraCandidates(sdp: string, manualIp: string): ExtraIceCandidate[] {
  if (!sdp || !manualIp) return [];
  const ip = manualIp.trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    console.warn('[WebRTC] manual IP is not a valid IPv4, ignoring:', ip);
    return [];
  }
  const out: ExtraIceCandidate[] = [];
  const lines = sdp.split(/\r?\n/);
  let currentMLineIndex = -1;
  let currentMid: string | null = null;
  let currentUfrag: string | null = null;
  let foundationCounter = 900000000;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      currentMLineIndex++;
      // Reset per-media-section ufrag (it can be overridden at media level).
      currentUfrag = null;
    } else if (line.startsWith('a=mid:')) {
      currentMid = line.slice('a=mid:'.length).trim();
    } else if (line.startsWith('a=ice-ufrag:')) {
      currentUfrag = line.slice('a=ice-ufrag:'.length).trim();
    } else if (line.startsWith('a=candidate:') && line.includes('.local')) {
      // Parse: a=candidate:<foundation> <component> <transport> <priority> <addr> <port> typ host ...
      // We rebuild the candidate string with the manual IP and a fresh numeric
      // foundation. We KEEP all the optional extensions (ufrag, generation,
      // network-id, etc.) from the original line so the browser accepts it.
      const candidateValue = line.slice('a=candidate:'.length);
      const parts = candidateValue.split(' ');
      if (parts.length >= 6) {
        const component = parts[1];
        const transport = parts[2];
        const priorityStr = parts[3];
        const port = parts[5];
        // Swap foundation (parts[0]) and address (parts[4]).
        const newFoundation = String(foundationCounter++);
        parts[0] = newFoundation;
        // Decrement priority by 1 so mDNS is preferred (works for same-machine).
        const priorityNum = parseInt(priorityStr, 10);
        if (!isNaN(priorityNum)) parts[3] = String(Math.max(1, priorityNum - 1));
        // Swap the .local address for the manual IP.
        parts[4] = ip;
        const newCandidateValue = parts.join(' ');
        out.push({
          candidate: `candidate:${newCandidateValue}`,
          sdpMid: currentMid,
          sdpMLineIndex: currentMLineIndex >= 0 ? currentMLineIndex : null,
          usernameFragment: currentUfrag,
        });
      }
    }
  }
  console.log(`[WebRTC] Extracted ${out.length} extra IP candidates for ${ip}`);
  return out;
}

/**
 * Apply a list of extra ICE candidates to a peer connection via the proper
 * `addIceCandidate` API. Must be called AFTER `setRemoteDescription` has
 * succeeded. Errors on individual candidates are logged but don't abort the
 * loop — some candidates may be invalid (e.g. UDP blocked) but others may
 * still work.
 */
async function applyExtraCandidates(pc: RTCPeerConnection, candidates: ExtraIceCandidate[]): Promise<void> {
  if (!pc || !candidates || candidates.length === 0) return;
  for (const c of candidates) {
    try {
      const init: RTCIceCandidateInit = {
        candidate: c.candidate,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
      };
      if (c.usernameFragment) init.usernameFragment = c.usernameFragment;
      await pc.addIceCandidate(init);
      console.log('[WebRTC] Added extra ICE candidate:', c.candidate);
    } catch (e) {
      console.warn('[WebRTC] Failed to add extra ICE candidate (non-fatal):', c.candidate, e);
    }
  }
}

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
  /** Set of peerIds for which we've already applied a guest's answer.
   *  Used to make `acceptAnswer` idempotent — duplicate clicks on the Connect
   *  button (which happen because ICE takes a few seconds and there's no
   *  visible feedback) would otherwise hit a wrong-state error. */
  private appliedAnswers = new Set<string>();
  /** The last manualHostIp passed to createOffer, so regenerateOffer can
   *  reuse it without the caller having to pass it again. */
  private lastManualHostIp: string | undefined;
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
   *
   * @param manualHostIp Optional host LAN IP (e.g. `192.168.43.1` or
   *                     `10.181.207.147`). When set, we extract extra IP-based
   *                     ICE candidates from the host's local SDP (mirroring the
   *                     mDNS ports but using the manual IP) and include them in
   *                     the compressed payload. The guest applies them via
   *                     `addIceCandidate`, which lets ICE reach the host on
   *                     networks where mDNS is blocked (mobile hotspots,
   *                     restrictive routers).
   */
  async createOffer(manualHostIp?: string): Promise<string> {
    this.lastManualHostIp = manualHostIp;
    const peerId = `g-${Math.random().toString(36).slice(2, 9)}`;
    const pc = this.createPeerConnection(peerId);
    // Host creates the data channel — the guest receives it via ondatachannel.
    const dc = pc.createDataChannel(LABEL, { ordered: false, maxRetransmits: 0 });
    this.bindDataChannel(peerId, dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceComplete(pc);

    this.pendingOffers.set(peerId, pc);

    // IMPORTANT: we do NOT modify the SDP text. The local description is
    // sent as-is. If the host provided a manual IP, we extract extra IP-based
    // ICE candidates and include them as a separate field in the payload —
    // the guest applies them via `addIceCandidate` (the proper WebRTC API).
    // This avoids `Failed to parse SessionDescription` errors that arise
    // from manually editing SDP candidate lines.
    const localSdp = pc.localDescription ?? undefined;
    let extraCandidates: ExtraIceCandidate[] = [];
    if (manualHostIp && localSdp && typeof localSdp.sdp === 'string') {
      extraCandidates = extractExtraCandidates(localSdp.sdp, manualHostIp);
    }

    const payload = JSON.stringify({
      sdp: localSdp,
      peerId,
      hostId: this.id,
      extraCandidates,
    });
    return compressCode(payload);
  }

  /**
   * Apply the guest's compressed answer to finalize a pending connection.
   * Also applies any extra IP candidates the guest included (for hotspot).
   *
   * IDEMPOTENT: if the same answer is applied twice (e.g. the user clicks
   * "Connect" twice because the first click seemed to do nothing), the
   * second call is a no-op and returns success. This prevents the
   * `Failed to set remote answer sdp: Called in wrong state: stable` error
   * that arises when the second call hits a PC whose signaling state has
   * already moved past `have-local-offer`.
   *
   * If the pending PC for this peerId has been torn down (because the first
   * connection attempt failed ICE), we throw a clear error that the UI can
   * catch and prompt the user to generate a fresh offer.
   */
  async acceptAnswer(compressedAnswer: string): Promise<void> {
    const decoded = await decompressCode(compressedAnswer);
    const parsed = JSON.parse(decoded) as {
      sdp: RTCSessionDescriptionInit;
      peerId?: string;
      extraCandidates?: ExtraIceCandidate[];
    };
    const peerId = parsed.peerId;
    if (!peerId) throw new Error('Answer missing peerId');

    // Idempotency guard: if we've already successfully applied an answer for
    // this peerId, silently return. The user may click Connect multiple times
    // because ICE takes a few seconds to establish and there's no visible
    // feedback. Without this guard, the second click tries to call
    // setRemoteDescription on a PC in `stable` state, which throws.
    if (this.appliedAnswers.has(peerId)) {
      console.log('[HOST] Answer already applied for peer:', peerId, '— ignoring duplicate click');
      return;
    }

    const pc = this.pendingOffers.get(peerId) || this.peerConns.get(peerId);
    if (!pc) {
      // The pending PC was torn down (e.g. ICE failed on a previous attempt).
      // Throw a clear, actionable error — the UI should prompt the user to
      // generate a fresh offer.
      throw new Error(
        'No pending connection for this answer. The previous attempt may have failed — ' +
        'please generate a fresh invite code and have the guest re-join.'
      );
    }

    // Guard against applying in the wrong state (e.g. the PC is somehow
    // already in `stable` because of a race). If we're not in
    // `have-local-offer`, the answer can't be applied.
    if (pc.signalingState !== 'have-local-offer') {
      console.warn('[HOST] PC for', peerId, 'is in state', pc.signalingState, '— cannot apply answer');
      // If we're already stable AND a data channel is open, treat as success
      // (the connection was already established, this is a duplicate click).
      if (pc.signalingState === 'stable' && this.dataChannels.has(peerId) && this.dataChannels.get(peerId)!.readyState === 'open') {
        console.log('[HOST] Data channel already open for', peerId, '— treating as success');
        this.appliedAnswers.add(peerId);
        return;
      }
      throw new Error(
        `Cannot apply answer: connection is in state "${pc.signalingState}". ` +
        'Please generate a fresh invite code and try again.'
      );
    }

    console.log('Applying answer for peer:', peerId, '(state:', pc.signalingState + ')');
    try {
      await pc.setRemoteDescription(parsed.sdp);
    } catch (e: any) {
      // setRemoteDescription failed — the PC is now in a broken state. Tear
      // it down so a subsequent attempt can create a fresh PC.
      console.error('[HOST] setRemoteDescription failed:', e);
      this.handlePeerDisconnect(peerId);
      throw e;
    }
    this.appliedAnswers.add(peerId);
    this.pendingOffers.delete(peerId);

    // Apply any extra IP candidates the guest sent (symmetric to what we do
    // for the guest when it applies our offer). Non-fatal if any fail.
    if (parsed.extraCandidates && parsed.extraCandidates.length > 0) {
      console.log('[HOST] Applying', parsed.extraCandidates.length, 'extra candidates from guest');
      // Apply asynchronously — don't block the caller. If they fail, ICE
      // will still try the original candidates.
      applyExtraCandidates(pc, parsed.extraCandidates).catch((e) => {
        console.warn('[HOST] applyExtraCandidates threw (non-fatal):', e);
      });
    }
  }

  /**
   * Regenerate the host's invite code for a fresh connection attempt. Call
   * this when the previous attempt failed (ICE failure, wrong-state error,
   * etc.) and the user wants to try again. Tears down any stale PC for the
   * given peerId (or all peers if no peerId given) and creates a fresh one.
   *
   * If `peerId` is omitted, tears down ALL pending/stale connections and
   * returns a brand new offer.
   */
  async regenerateOffer(manualHostIp?: string): Promise<string> {
    // Fall back to the last manualHostIp used in createOffer so the caller
    // doesn't need to track it.
    const ip = manualHostIp ?? this.lastManualHostIp;
    // Tear down all pending PCs (any that haven't received a successful
    // answer yet). Active connections (with open data channels) are left
    // alone so we don't kick out connected guests.
    for (const [pid, pc] of this.pendingOffers.entries()) {
      if (!this.dataChannels.has(pid) || this.dataChannels.get(pid)!.readyState !== 'open') {
        console.log('[HOST] Tearing down stale pending PC for', pid);
        try { pc.close(); } catch { /* ignore */ }
        this.pendingOffers.delete(pid);
        this.peerConns.delete(pid);
        this.appliedAnswers.delete(pid);
      }
    }
    // Also tear down any PCs in `peerConns` that don't have an open data
    // channel (e.g. a previous failed attempt that was moved out of
    // pendingOffers).
    for (const [pid, pc] of this.peerConns.entries()) {
      if (this.dataChannels.has(pid) && this.dataChannels.get(pid)!.readyState === 'open') continue;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        console.log('[HOST] Tearing down failed PC for', pid);
        try { pc.close(); } catch { /* ignore */ }
        this.peerConns.delete(pid);
        this.appliedAnswers.delete(pid);
      }
    }
    return this.createOffer(ip);
  }

  /** Returns true if there's a pending PC awaiting an answer for this peerId. */
  hasPendingOffer(peerId: string): boolean {
    const pc = this.pendingOffers.get(peerId) || this.peerConns.get(peerId);
    return !!pc && pc.signalingState === 'have-local-offer';
  }

  /** Returns true if any data channel is currently open (i.e. a guest is
   *  connected and we shouldn't tear anything down). */
  hasOpenDataChannel(): boolean {
    for (const dc of this.dataChannels.values()) {
      if (dc.readyState === 'open') return true;
    }
    return false;
  }

  private createPeerConnection(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection(PC_CONFIG);
    this.peerConns.set(peerId, pc);

    // Log every local ICE candidate as it's gathered. This is critical for
    // debugging ICE failures on hotspots — without this log, you can't tell
    // whether the host even gathered an mDNS candidate, a STUN candidate,
    // or only an IP candidate. The candidate string includes the address
    // type (`typ host` / `typ srflx` / etc.) so you can see what's available.
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const cand = e.candidate.candidate || '';
        // Truncate the long random mDNS hostnames for readability.
        const pretty = cand.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.local/g, '<mdns>.local');
        console.log('[HOST]', peerId, 'local ICE candidate:', pretty);
      } else {
        console.log('[HOST]', peerId, 'ICE gathering complete');
      }
    };
    // Also log the selected candidate pair once ICE succeeds — this tells
    // us exactly which candidate the connection is using (e.g. mDNS vs the
    // manual IP vs STUN), which is invaluable for diagnosing hotspot issues.
    pc.oniceconnectionstatechange = () => {
      console.log('[HOST]', peerId, 'ICE State:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        // Read the selected local + remote candidate pair.
        try {
          const stats = pc.getStats();
          stats.then((report) => {
            report.forEach((s) => {
              if (s.type === 'candidate-pair' && (s as any).selected) {
                const local = (s as any).localCandidateId;
                const remote = (s as any).remoteCandidateId;
                let localCand: any = null;
                let remoteCand: any = null;
                report.forEach((r) => {
                  if (r.id === local) localCand = r;
                  if (r.id === remote) remoteCand = r;
                });
                console.log('[HOST]', peerId, 'selected ICE pair:',
                  '\n  local :', localCand ? `${localCand.candidate}` : '?',
                  '\n  remote:', remoteCand ? `${remoteCand.candidate}` : '?');
              }
            });
          }).catch(() => { /* ignore */ });
        } catch { /* ignore */ }
      }
      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce(); } catch { }
      }
    };
    pc.onconnectionstatechange = () => {
      console.log('[HOST]', peerId, 'Connection State:', pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.handlePeerDisconnect(peerId);
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
      // The guest's player id is the host-assigned peerId (the guest adopts it
      // in acceptOffer()). So `fromPeer` (the WebRTC connection's peerId) and
      // `msg.id` (the player id the guest claims) should be identical for
      // player-related messages. We prefer `msg.id` when present so the engine
      // sees the exact id the guest's localPlayerId is set to — defensive
      // against any future drift. For messages without an id field (e.g.
      // damage-tile, game-ended), we use fromPeer only where the engine
      // actually needs a player id.
      const playerId = (msg as any).id && typeof (msg as any).id === 'string'
        ? (msg as any).id as string
        : fromPeer;
      switch (msg.kind) {
        case 'move':
          this.emit({ type: 'move', data: { id: playerId, position: msg.position, rotation: msg.rotation } });
          break;
        case 'jump':
          this.emit({ type: 'jump', data: { id: playerId } });
          break;
        case 'rotate':
          this.emit({ type: 'rotate', data: { id: playerId, cameraAzimuth: msg.cameraAzimuth } });
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
          this.emit({ type: 'player-eliminated', data: { id: playerId, rank: 0 } });
          break;
        case 'new-player': {
          // Guest announcing itself to host. Use the id the guest claims (which
          // is the host-assigned peerId, after the acceptOffer fix). This makes
          // the host's `players` map key match the guest's localPlayerId.
          this.emit({ type: 'new-player', data: { id: playerId, position: msg.position } });
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
        case 'powerup-collected':
          this.emit({
            type: 'powerup-collected',
            data: {
              powerupId: msg.powerupId,
              playerId: playerId,
              powerupType: msg.powerupType,
            },
          });
          break;
        case 'powerup-respawned':
          this.emit({
            type: 'powerup-respawned',
            data: {
              powerupId: msg.powerupId,
              newTileId: msg.newTileId,
              position: msg.position,
            },
          });
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
    this.appliedAnswers.delete(peerId);
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
    this.appliedAnswers.clear();
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
  /**
   * Events that arrived before any listener was registered. The data channel
   * can open (and the host can send `init`) BEFORE React finishes mounting the
   * Game component and registering the engine's listener — without buffering,
   * that `init` is lost forever and the guest never creates its local sphere.
   *
   * We replay the buffer (deduped by event type where appropriate) as soon as
   * the first listener attaches.
   */
  private pendingEvents: NetEvent[] = [];
  private openEmitted = false;

  constructor(id: string) {
    this.id = id;
  }

  /**
   * Accept the host's compressed offer and produce a compressed answer.
   *
   * The guest receives the host's data channel via ondatachannel — it does
   * NOT create its own. The returned string should be sent back to the host
   * (via QR code or copy-paste), and the host applies it with acceptAnswer().
   *
   * IMPORTANT: the guest adopts the host-assigned `peerId` from the offer as
   * its own NetClient.id. This is the single source of truth — both sides
   * must agree on the guest's player id or the host's `players` map and the
   * guest's `localPlayerId` will disagree, and the guest will never create a
   * local sphere (the classic "only host can move" bug).
   *
   * @param manualGuestIp Optional guest LAN IP (e.g. `10.181.207.148`).
   *                      Mirrors the host's manualHostIp — when set, we extract
   *                      extra IP-based ICE candidates from the guest's local
   *                      SDP and include them in the answer payload. The host
   *                      applies them via `addIceCandidate` so it can reach the
   *                      guest on networks where mDNS is blocked. Symmetric to
   *                      the host side: both peers need at least one working
   *                      candidate each for ICE to succeed reliably.
   */
  async acceptOffer(compressedOffer: string, manualGuestIp?: string): Promise<string> {
    if (this.pc) throw new Error('Guest already has an active offer');
    const decoded = await decompressCode(compressedOffer);
    const parsed = JSON.parse(decoded) as {
      sdp: RTCSessionDescriptionInit;
      peerId?: string;
      hostId?: string;
      extraCandidates?: ExtraIceCandidate[];
    };

    // Adopt the host-assigned peerId as our own id. Cast to `any` because the
    // field is `readonly` (compile-time only — at runtime it's mutable). This
    // mirrors what SocketNetClient does when the server tells it its socket
    // id. Done BEFORE any event fires so listeners see the canonical id.
    if (parsed.peerId) {
      (this as any).id = parsed.peerId;
      console.log('[GUEST] Adopted host-assigned peerId:', parsed.peerId);
    }

    this.pc = new RTCPeerConnection(PC_CONFIG);
    // Guest receives the host's data channel.
    this.pc.ondatachannel = (e) => {
      this.dc = e.channel;
      this.bindDataChannel(this.dc);
    };
    // Log local ICE candidates — symmetric to the host side. Critical for
    // diagnosing hotspot failures (e.g. did the guest gather any candidate
    // the host can actually reach?).
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        const cand = e.candidate.candidate || '';
        const pretty = cand.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.local/g, '<mdns>.local');
        console.log('[GUEST] local ICE candidate:', pretty);
      } else {
        console.log('[GUEST] ICE gathering complete');
      }
    };
    this.pc.onconnectionstatechange = () => {
      console.log('[GUEST]', 'Connection State:', this.pc?.connectionState);
      if (!this.pc) return;
      if (
        this.pc.connectionState === 'failed' ||
        this.pc.connectionState === 'closed'
      ) {
        this.scheduleClose();
      }
    };
    this.pc.oniceconnectionstatechange = () => {
      console.log('[GUEST]', 'ICE State:', this.pc?.iceConnectionState);
      if (!this.pc) return;
      // Log the selected candidate pair on success — same as host side.
      if (this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed') {
        try {
          const stats = this.pc.getStats();
          stats.then((report) => {
            report.forEach((s) => {
              if (s.type === 'candidate-pair' && (s as any).selected) {
                const local = (s as any).localCandidateId;
                const remote = (s as any).remoteCandidateId;
                let localCand: any = null;
                let remoteCand: any = null;
                report.forEach((r) => {
                  if (r.id === local) localCand = r;
                  if (r.id === remote) remoteCand = r;
                });
                console.log('[GUEST] selected ICE pair:',
                  '\n  local :', localCand ? `${localCand.candidate}` : '?',
                  '\n  remote:', remoteCand ? `${remoteCand.candidate}` : '?');
              }
            });
          }).catch(() => { /* ignore */ });
        } catch { /* ignore */ }
      }
      if (this.pc.iceConnectionState === 'failed') {
        try { this.pc.restartIce(); } catch { }
      }
    };

    // Apply the host's offer SDP. The SDP is sent UNMODIFIED by the host
    // (we no longer inject candidates into the SDP text), so this call
    // always parses cleanly. If the host included `extraCandidates`, we
    // apply them via `addIceCandidate` AFTER setRemoteDescription succeeds.
    await this.pc.setRemoteDescription(parsed.sdp);
    if (parsed.extraCandidates && parsed.extraCandidates.length > 0) {
      console.log('[GUEST] Applying', parsed.extraCandidates.length, 'extra candidates from host');
      // Apply asynchronously — don't block the answer generation. Any
      // failures are non-fatal (logged inside applyExtraCandidates).
      applyExtraCandidates(this.pc, parsed.extraCandidates).catch((e) => {
        console.warn('[GUEST] applyExtraCandidates threw (non-fatal):', e);
      });
    }

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitForIceComplete(this.pc);

    // IMPORTANT: we do NOT modify the SDP text. If the guest provided a
    // manual IP, we extract extra IP-based ICE candidates from the local
    // SDP and include them as a separate field in the answer payload —
    // the host applies them via `addIceCandidate`.
    const localSdp = this.pc.localDescription ?? undefined;
    let extraCandidates: ExtraIceCandidate[] = [];
    if (manualGuestIp && localSdp && typeof localSdp.sdp === 'string') {
      extraCandidates = extractExtraCandidates(localSdp.sdp, manualGuestIp);
    }

    const payload = JSON.stringify({
      sdp: localSdp,
      peerId: parsed.peerId,
      extraCandidates,
    });
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
          case 'powerup-collected':
            this.emit({
              type: 'powerup-collected',
              data: {
                powerupId: msg.powerupId,
                playerId: msg.playerId,
                powerupType: msg.powerupType,
              },
            });
            break;
          case 'powerup-respawned':
            this.emit({
              type: 'powerup-respawned',
              data: {
                powerupId: msg.powerupId,
                newTileId: msg.newTileId,
                position: msg.position,
              },
            });
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
    // If events arrived before any listener was registered, replay them now.
    // The most important case is the `init` message from the host, which can
    // arrive in the small window between the data channel opening (which
    // triggers LanModal's onStart → App screen switch → Game mount) and the
    // engine calling onMessage() in setupNetworking(). Without this replay,
    // the guest silently misses init and never creates its local sphere.
    if (this.pendingEvents.length > 0) {
      const pending = this.pendingEvents.slice();
      this.pendingEvents = [];
      console.log('[GUEST] Replaying', pending.length, 'buffered events to new listener');
      // Defer to a microtask so the caller's setup completes first.
      queueMicrotask(() => {
        for (const ev of pending) {
          try { cb(ev); } catch (e) { console.warn('[GUEST] replay threw', e); }
        }
      });
    }
  }

  private emit(ev: NetEvent) {
    if (this.listeners.size === 0) {
      // No listener yet — buffer. We dedupe `open` (only ever emit once) but
      // keep all other events because they may carry unique data (e.g. init).
      if (ev.type === 'open') {
        if (this.openEmitted) return;
        this.openEmitted = true;
      }
      this.pendingEvents.push(ev);
      // Cap the buffer so a runaway peer can't OOM us.
      if (this.pendingEvents.length > 200) {
        this.pendingEvents.splice(0, this.pendingEvents.length - 200);
      }
      return;
    }
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
 * THE BUG THIS FIXES: the previous version had a 2.5-second early-resolve that
 * fired as soon as ANY candidate was gathered (usually mDNS within ~10ms).
 * STUN (server-reflexive) candidates take 200ms–5s because they require a
 * round-trip to the STUN server. On many networks (especially slow Wi-Fi,
 * corporate networks, or networks where Google's STUN is blocked and we fall
 * back to other STUN servers), STUN takes longer than 2.5s. The old code would
 * resolve with only mDNS candidates, the offer/answer would be sent, and ICE
 * would fail because mDNS hostnames don't resolve across devices.
 *
 * NEW STRATEGY (patient):
 *   1. Wait for `iceGatheringState === 'complete'` — this is the most reliable
 *      signal that ALL candidates (including STUN) have been gathered.
 *   2. If we get a `srflx` (STUN) candidate, wait 500ms for any additional
 *      candidates, then resolve (fast path — we have what we need).
 *   3. If we ONLY have mDNS/host candidates after 6 seconds, assume STUN is
 *      blocked and resolve with what we have (so the user isn't waiting
 *      forever — the manual IP field is the workaround for this case).
 *   4. Hard timeout at 12 seconds (fallback for very slow networks).
 *
 * The key change: we NO LONGER resolve early just because we got an mDNS
 * candidate. We always give STUN at least 6 seconds to respond.
 */
function waitForIceComplete(pc: RTCPeerConnection, timeoutMs = 12000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      console.log('[WebRTC] ICE gathering already complete');
      return resolve();
    }
    let done = false;
    let gotSrflx = false;
    let gotAnyCandidate = false;
    let candidateTypes: string[] = [];
    let mdnsOnlyTimer: number | null = null;

    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', stateCheck);
      pc.removeEventListener('icecandidate', candidateCheck);
      if (mdnsOnlyTimer !== null) clearTimeout(mdnsOnlyTimer);
      console.log('[WebRTC] ICE gathering finished. Candidates:', candidateTypes.join(', ') || 'none',
        gotSrflx ? '(has srflx ✓)' : '(NO srflx ✗ — cross-device may fail, use manual IP)');
      resolve();
    };
    const stateCheck = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const candidateCheck = (e: RTCPeerConnectionIceEvent) => {
      if (e.candidate) {
        gotAnyCandidate = true;
        const cand = e.candidate.candidate || '';
        // Extract the candidate type for logging.
        const typMatch = cand.match(/typ (\w+)/);
        const typ = typMatch ? typMatch[1] : 'unknown';
        candidateTypes.push(typ);

        if (cand.includes('typ srflx') || cand.includes('typ prflx') || cand.includes('typ relay')) {
          // Got a server-reflexive, peer-reflexive, or relay candidate —
          // these are the ones that work cross-device. Give a short grace
          // period for any more candidates, then resolve.
          gotSrflx = true;
          setTimeout(finish, 500);
        }
        // If we only have host/mDNS candidates so far, keep waiting for STUN.
        // Don't resolve early — the old 2.5s early-resolve was the bug.
      } else {
        // null candidate = ICE gathering complete.
        finish();
      }
    };
    pc.addEventListener('icegatheringstatechange', stateCheck);
    pc.addEventListener('icecandidate', candidateCheck);

    // If we ONLY have mDNS/host candidates after 6 seconds, assume STUN is
    // blocked on this network and resolve with what we have. The user can
    // use the manual IP field as a workaround. (Previously this was 2.5s,
    // which was too short — STUN often takes 3–5s on real networks.)
    mdnsOnlyTimer = window.setTimeout(() => {
      if (gotAnyCandidate && !gotSrflx && !done) {
        console.warn('[WebRTC] Only mDNS/host candidates after 6s — STUN appears blocked.',
          'Cross-device connection will likely fail. Use the manual LAN IP field as a workaround.');
        finish();
      }
    }, 6000);

    // Hard timeout — 12s. If we still haven't finished, give up.
    setTimeout(finish, timeoutMs);
  });
}
