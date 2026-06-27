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
const STUN_SERVERS: RTCIceServer[] = [
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
// Network status & dynamic ICE config
// ============================================================================
//
// PROBLEM: On a mobile-hotspot network without internet routing, STUN servers
// are unreachable. The browser still tries to gather STUN candidates, taking
// 5-12 seconds before timing out. This makes "hotspot host + guest" play
// painfully slow — the user clicks "Start Hosting" and waits ~10 seconds
// before the invite code even appears.
//
// FIX: Detect whether the device thinks it has internet (navigator.onLine +
// a manual override flag). When we believe we're offline (hotspot without
// internet), use NO STUN servers — only mDNS + manual IP candidates. ICE
// gathering completes in ~50ms instead of 6-10s. Connections are also more
// reliable because we don't waste time on candidates that will never work.
//
// The user can force "LAN-only / hotspot mode" in the UI even if
// navigator.onLine is true (e.g., mobile data is on but they want to play
// purely on the hotspot LAN).

/** Network status used to decide which ICE servers to use. */
export type NetworkStatus = 'online' | 'offline';

/**
 * Detect the device's current network status. We use `navigator.onLine` as
 * a fast first check. The user can override this via the `forceOffline`
 * argument (e.g., they know they're on a hotspot without internet even if
 * mobile data is on).
 */
export function getNetworkStatus(forceOffline = false): NetworkStatus {
  if (forceOffline) return 'offline';
  if (typeof navigator === 'undefined') return 'online';
  return navigator.onLine ? 'online' : 'offline';
}

/**
 * Build the appropriate RTCConfiguration based on the network status.
 * - Online: mDNS + STUN servers (current behavior, works on regular Wi-Fi)
 * - Offline: mDNS only (no STUN servers, faster gathering on hotspots)
 *
 * We always use `iceTransportPolicy: 'all'` and `bundlePolicy: 'max-bundle'`.
 */
export function createPCConfig(forceOffline = false): RTCConfiguration {
  const status = getNetworkStatus(forceOffline);
  const iceServers = status === 'online' ? STUN_SERVERS : [];
  console.log('[WebRTC] ICE config:', status === 'online'
    ? `online — using ${iceServers.length} STUN servers`
    : 'offline — mDNS only (no STUN, faster on hotspot)');
  return {
    iceServers,
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
  };
}

// ============================================================================
// Local IP auto-detection (for the manual IP field UX)
// ============================================================================
//
// We use the well-known WebRTC IP-discovery trick: create a temporary
// RTCPeerConnection with NO STUN servers, createDataChannel + createOffer +
// setLocalDescription, and listen for ICE candidates. The local candidates
// contain the device's local IP address.
//
// Caveats:
//   - Chrome with mDNS anti-fingerprinting enabled (default since Chrome 75+)
//     will produce only `*.local` candidates, not raw IPs. In that case we
//     return an empty array and the UI prompts the user to enter their IP
//     manually with clear instructions.
//   - Firefox, Safari, and Chrome with mDNS disabled (e.g., via flag) WILL
//     return raw IPs. We filter for IPv4 only (LAN IPs are always IPv4).
//   - The trick completes in <500ms because there's no STUN to wait for.

/**
 * Detect this device's local IPv4 addresses using the WebRTC ICE candidate
 * trick. Resolves to an array of unique IPv4 strings (may be empty on Chrome
 * with mDNS obfuscation enabled — see comment above).
 *
 * The UI should call this when the user opens the LAN modal and offer the
 * detected IPs as clickable suggestions for the manual IP field.
 */
export function detectLocalIps(): Promise<string[]> {
  return new Promise((resolve) => {
    const ips = new Set<string>();
    let pc: RTCPeerConnection | null = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      try { pc?.close(); } catch { /* ignore */ }
      // Filter to private IPv4 ranges (LAN IPs) — public IPs from this trick
      // are unlikely to be useful for LAN play and might leak privacy.
      const lanIps = Array.from(ips).filter((ip) => isPrivateIpv4(ip));
      resolve(lanIps);
    };

    try {
      pc = new RTCPeerConnection({ iceServers: [], iceCandidatePoolSize: 0 });
      // Must create a data channel for ICE candidates to be generated.
      pc.createDataChannel('detect');
      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          // null candidate = gathering complete
          finish();
          return;
        }
        const cand = e.candidate.candidate || '';
        // Extract IPv4 address from the candidate string.
        const match = cand.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (match) ips.add(match[1]);
      };
      pc.createOffer()
        .then((offer) => pc!.setLocalDescription(offer))
        .catch(() => finish());
    } catch {
      finish();
      return;
    }

    // Hard timeout — never block the UI longer than 1.5s. On Chrome with
    // mDNS, candidates arrive almost instantly; on slow devices we still
    // cap at 1.5s.
    setTimeout(finish, 1500);
  });
}

/** Check if an IPv4 string is in a private range (10.x, 172.16-31.x, 192.168.x). */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Carrier-grade NAT — also typically LAN-side on hotspots.
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Common hotspot host IPs for quick-pick in the UI.
 *  - Android hotspot host: 192.168.43.1
 *  - iOS hotspot host: 172.20.10.1
 *  - Windows Mobile Hotspot: 192.168.137.1
 *  - Typical home router: 192.168.1.1 / 192.168.0.1 (less useful as a "your IP"
 *    value but listed so users don't confuse gateway with their own IP)
 */
export const COMMON_HOTSPOT_HOST_IPS = [
  { ip: '192.168.43.1', label: 'Android hotspot host' },
  { ip: '172.20.10.1', label: 'iOS hotspot host' },
  { ip: '192.168.137.1', label: 'Windows Mobile Hotspot' },
  { ip: '10.0.0.1', label: 'Some Android / Linux hotspots' },
];

// ============================================================================
// Manual LAN IP — SDP rewriting (hotspot fix, v2)
// ============================================================================
//
// PROBLEM (v1 approach — extra candidates): We extracted extra IP candidates
// and shipped them in a separate JSON field. The receiver applied them via
// `addIceCandidate`. This was robust against SDP parser issues BUT had a
// subtle problem: ICE tries candidates in PRIORITY ORDER. The original mDNS
// candidate has priority 2113937151 (host, highest). Our extra IP candidate
// was priority 2113937150 (decremented by 1). ICE tried mDNS first, the
// mDNS hostname didn't resolve cross-device, and Chrome's ICE agent marked
// the pair as "disconnected" before properly trying the IP candidate. The
// connection then quickly went "failed" without ever giving the manual IP
// candidate a fair chance.
//
// PROBLEM (v0 approach — SDP text manipulation): We tried to construct
// candidate strings from scratch, which caused `Failed to parse
// SessionDescription` on some browsers because we missed optional fields.
//
// SOLUTION (v2 — surgical SDP rewrite): When the user provides a manual IP,
// we surgically REWRITE the mDNS hostname in the existing candidate lines of
// the LOCAL SDP. We:
//   - ONLY replace the `<uuid>.local` token with the manual IP
//   - Keep the rest of the candidate line byte-for-byte identical (foundation,
//     component, transport, priority, port, all extensions, ufrag, etc.)
//   - Also keep the mDNS candidate as a SECOND extra candidate (lower priority)
//     so same-machine testing still works
//
// This means:
//   - The remote side receives a normal-looking SDP with a `host` candidate
//     pointing at the manual IP. setRemoteDescription parses cleanly.
//   - ICE has exactly ONE host candidate per m-line — the manual IP. No
//     priority conflict, no wasted mDNS attempts.
//   - We DON'T need addIceCandidate or extraCandidates in the payload anymore.
//
// For symmetric connections (same-machine testing where mDNS DOES work), we
// also include the original mDNS candidate as an extra candidate with lower
// priority. This is shipped in the `extraCandidates` field and applied by the
// receiver via addIceCandidate.

/** Shape of an extra ICE candidate we ship in the offer/answer payload. */
export interface ExtraIceCandidate {
  /** Candidate string WITHOUT the `a=` prefix, e.g. `"candidate:800000000 1 udp 2113937 192.168.43.1 54321 typ host generation 0"`. */
  candidate: string;
  /** Media-section mid (e.g. "0"). */
  sdpMid: string | null;
  /** Media-section index (0-based). */
  sdpMLineIndex: number | null;
  /** Optional ufrag (parsed from the SDP's `a=ice-ufrag:` line). */
  usernameFragment?: string | null;
}

/**
 * Rewrite a local SDP body, replacing every `<uuid>.local` mDNS hostname in
 * candidate lines with the manual IP. Returns the rewritten SDP. The rewrite
 * is surgical — only the hostname token changes, everything else is
 * byte-for-byte identical, so the browser accepts the SDP without parse
 * errors.
 *
 * Returns the original SDP unchanged if `manualIp` is empty or invalid.
 */
function rewriteSdpWithManualIp(sdp: string, manualIp: string): string {
  if (!sdp || !manualIp) return sdp;
  const ip = manualIp.trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    console.warn('[WebRTC] manual IP is not a valid IPv4, ignoring:', ip);
    return sdp;
  }
  // Match mDNS hostnames in candidate lines. Chrome's format is
  // `<8-4-4-4-12 hex>.local`. We're lenient and match any `<chars>.local`
  // token inside a candidate line.
  const lines = sdp.split(/\r?\n/);
  let rewroteCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('a=candidate:')) continue;
    if (!line.includes('.local')) continue;
    // Replace the FIRST occurrence of `<token>.local` with the manual IP.
    // Candidate lines have the form:
    //   a=candidate:<foundation> <component> <transport> <priority> <addr> <port> typ host ...
    // The address (5th space-separated field after `a=candidate:`) is the
    // mDNS hostname. We replace just that token.
    const newLine = line.replace(/([a-f0-9-]{6,}|[a-zA-Z0-9-]{6,})\.local\b/, ip);
    if (newLine !== line) {
      lines[i] = newLine;
      rewroteCount++;
    }
  }
  if (rewroteCount > 0) {
    console.log(`[WebRTC] Rewrote ${rewroteCount} mDNS candidate(s) in SDP to use manual IP ${ip}`);
  }
  return lines.join('\r\n');
}

/**
 * Extract the original mDNS candidates from an SDP (BEFORE rewriting) as
 * ExtraIceCandidate objects, so we can ship them in the `extraCandidates`
 * field for same-machine testing. The receiver applies them via
 * addIceCandidate with LOWER priority (so the manual IP wins cross-device,
 * but mDNS still works for same-machine).
 *
 * This is symmetric: the host does this for its offer, the guest does it for
 * its answer. Both sides end up with both candidates available.
 */
function extractMdnsCandidatesAsExtra(sdp: string): ExtraIceCandidate[] {
  if (!sdp) return [];
  const out: ExtraIceCandidate[] = [];
  const lines = sdp.split(/\r?\n/);
  let currentMLineIndex = -1;
  let currentMid: string | null = null;
  let currentUfrag: string | null = null;
  let foundationCounter = 800000000;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      currentMLineIndex++;
      currentUfrag = null;
    } else if (line.startsWith('a=mid:')) {
      currentMid = line.slice('a=mid:'.length).trim();
    } else if (line.startsWith('a=ice-ufrag:')) {
      currentUfrag = line.slice('a=ice-ufrag:'.length).trim();
    } else if (line.startsWith('a=candidate:') && line.includes('.local')) {
      // Rebuild the candidate with a fresh foundation and a much lower
      // priority so the manual IP (in the rewritten SDP) wins cross-device
      // but the mDNS candidate still works for same-machine testing.
      const candidateValue = line.slice('a=candidate:'.length);
      const parts = candidateValue.split(' ');
      if (parts.length >= 6) {
        const priorityStr = parts[3];
        const newFoundation = String(foundationCounter++);
        parts[0] = newFoundation;
        // Drop priority dramatically (1000x lower) so ICE only tries mDNS
        // after the manual IP candidate fails. This avoids the
        // "mDNS-fails-first-then-ICE-gives-up" race.
        const priorityNum = parseInt(priorityStr, 10);
        if (!isNaN(priorityNum)) parts[3] = String(Math.max(1, Math.floor(priorityNum / 1000)));
        out.push({
          candidate: `candidate:${parts.join(' ')}`,
          sdpMid: currentMid,
          sdpMLineIndex: currentMLineIndex >= 0 ? currentMLineIndex : null,
          usernameFragment: currentUfrag,
        });
      }
    }
  }
  return out;
}

/**
 * Extract and log all candidate lines from an SDP body. Used for diagnostics
 * — when a connection fails, this tells you exactly what candidates ICE had
 * to work with (host mDNS, host IP, srflx, etc.) and whether any of them are
 * reachable cross-device.
 *
 * The log output looks like:
 *   [HOST] Guest answer candidates (3):
 *     1. host  10.181.207.148:54321  (reachable ✓)
 *     2. host  <mdns>.local:54321    (NOT reachable cross-device ✗)
 *     3. srflx 37.202.130.141:38533  (public IP, useless on LAN ✗)
 */
function logSdpCandidates(sdp: string, prefix: string): void {
  if (!sdp) return;
  const lines = sdp.split(/\r?\n/);
  const candidates: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('a=candidate:')) continue;
    const value = line.slice('a=candidate:'.length);
    const parts = value.split(' ');
    if (parts.length < 6) continue;
    const priority = parts[3];
    const addr = parts[4];
    const port = parts[5];
    const typMatch = value.match(/typ (\w+)/);
    const typ = typMatch ? typMatch[1] : 'unknown';
    // Determine reachability for cross-device LAN play
    let reachable = '?';
    let note = '';
    if (typ === 'host') {
      if (addr.endsWith('.local')) {
        reachable = '✗';
        note = 'mDNS does NOT resolve cross-device';
      } else if (/^(\d{1,3}\.){3}\d{1,3}$/.test(addr)) {
        reachable = '✓';
        note = 'IP candidate — reachable if firewall allows';
      }
    } else if (typ === 'srflx') {
      reachable = '✗';
      note = 'public IP — useless on LAN/hotspot';
    } else if (typ === 'relay') {
      reachable = '✓';
      note = 'TURN relay — needs internet';
    }
    // Truncate mDNS hostnames for readability
    const prettyAddr = addr.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.local/g, '<mdns>.local');
    candidates.push(`${typ}\t${prettyAddr}:${port}\t[${reachable}]\t${note}`);
  }
  if (candidates.length === 0) {
    console.warn(`${prefix} candidates: NONE — the remote side didn't gather any candidates. ICE will fail.`);
  } else {
    console.log(`${prefix} candidates (${candidates.length}):`);
    candidates.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
  }
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

// PC_CONFIG is now built dynamically via createPCConfig() so we can adapt to
// the device's online/offline status (hotspot without internet = skip STUN).
// The old static `PC_CONFIG` constant is removed; each call site that needs
// an RTCConfiguration calls createPCConfig(forceOffline) instead.

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
  /** Whether to skip STUN servers entirely (hotspot without internet). Set
   *  via the constructor so all peer connections created by this host use
   *  the same offline-aware configuration. */
  private forceOffline: boolean;
  private closed = false;
  /**
   * Events that arrived before any listener was registered. In the new lobby
   * flow, the host's WebRTCNetHost is created in LanModal BEFORE the engine
   * exists (the engine is only created when the host clicks "Start Game").
   * Guests can send `new-player` and other messages during the lobby phase —
   * without buffering, those events would be lost forever (the host's
   * LanModal only listens for `peer-list` events, not full NetEvents).
   *
   * We replay the buffer (deduped by event type where appropriate) as soon as
   * the first listener attaches. The buffer is capped to prevent OOM from a
   * runaway peer.
   *
   * The LanModal's listener (registered during lobby setup) typically
   * drains this buffer when it attaches. Subsequent listeners (e.g. the
   * engine's) receive events live from then on.
   */
  private pendingEvents: NetEvent[] = [];

  constructor(id: string, opts?: { forceOffline?: boolean }) {
    this.id = id;
    this.forceOffline = !!opts?.forceOffline;
  }

  /**
   * Generate the host's invite code. Display this to the user (QR + text).
   *
   * The host creates a fresh RTCPeerConnection + data channel and produces an
   * SDP offer. The guest will accept this offer and produce an answer, which
   * the host then applies via acceptAnswer().
   *
   * AUTOMATIC OFFLINE DETECTION: If `manualHostIp` is provided (the user
   * explicitly entered a LAN IP), we treat that as a strong hint that we're
   * on a hotspot and should skip STUN — STUN's public-IP candidates would
   * just confuse ICE and waste 5-10s of gathering time. We temporarily
   * override the offline flag for this connection.
   *
   * @param manualHostIp Optional host LAN IP (e.g. `192.168.43.1` or
   *                     `10.181.207.147`). When set, we rewrite the SDP's
   *                     mDNS hostnames to use this IP directly, so the remote
   *                     side gets a clean `host` candidate pointing at the
   *                     manual IP. This is the v2 fix — see the comment block
   *                     above `rewriteSdpWithManualIp`.
   */
  async createOffer(manualHostIp?: string): Promise<string> {
    this.lastManualHostIp = manualHostIp;
    // If the user provided a manual LAN IP, treat that as a hint that we're
    // on a hotspot. Skip STUN entirely — its public-IP candidates would
    // confuse ICE on a hotspot (the guest can't route back to the host's
    // public IP). This is the v2 automatic offline detection.
    const effectiveOffline = this.forceOffline || !!manualHostIp;
    if (effectiveOffline !== this.forceOffline) {
      console.log('[HOST] Manual IP provided — automatically enabling offline mode (skipping STUN)');
    }
    const peerId = `g-${Math.random().toString(36).slice(2, 9)}`;
    const pc = this.createPeerConnection(peerId, effectiveOffline);
    // Host creates the data channel — the guest receives it via ondatachannel.
    const dc = pc.createDataChannel(LABEL, { ordered: false, maxRetransmits: 0 });
    this.bindDataChannel(peerId, dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceComplete(pc, 12000, effectiveOffline);

    this.pendingOffers.set(peerId, pc);

    // Manual-IP fix: if the user provided a manual LAN IP, surgically rewrite
    // the mDNS hostnames in the local SDP to use that IP. This way the remote
    // side gets a clean `host` candidate pointing at the manual IP and ICE
    // tries it FIRST (no priority conflict with mDNS). We also extract the
    // original mDNS candidate(s) as low-priority extras so same-machine
    // testing still works (mDNS resolves between two tabs on the same
    // browser).
    const localSdp = pc.localDescription;
    let sdpToSend: RTCSessionDescriptionInit | undefined;
    let extraCandidates: ExtraIceCandidate[] = [];
    if (manualHostIp && localSdp && typeof localSdp.sdp === 'string') {
      // Extract the original mDNS candidates FIRST (before rewriting), so we
      // can ship them as low-priority extras for same-machine testing.
      extraCandidates = extractMdnsCandidatesAsExtra(localSdp.sdp);
      // Rewrite the SDP — replace mDNS hostnames with the manual IP.
      const rewrittenSdp = rewriteSdpWithManualIp(localSdp.sdp, manualHostIp);
      // IMPORTANT: Build the RTCSessionDescriptionInit as a PLAIN OBJECT with
      // explicit `type` and `sdp` fields. Spreading `pc.localDescription`
      // (an RTCSessionDescription WebIDL object) does NOT reliably copy the
      // `type` field because it may not be enumerable — and the receiver's
      // `setRemoteDescription` then fails with "Failed to parse
      // SessionDescription". Building it explicitly avoids this.
      sdpToSend = { type: 'offer', sdp: rewrittenSdp };
      console.log(`[HOST] Offer SDP rewritten with manual IP ${manualHostIp}. ` +
        `${extraCandidates.length} mDNS candidate(s) shipped as low-priority extras.`);
    } else {
      // No manual IP — send the original local description as-is.
      sdpToSend = localSdp
        ? { type: localSdp.type, sdp: localSdp.sdp }
        : undefined;
    }

    const payload = JSON.stringify({
      sdp: sdpToSend,
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
    // Defensive: normalize the parsed answer SDP into a clean init object with
    // explicit type + sdp. Guards against malformed payloads from the guest.
    const answerSdpInit: RTCSessionDescriptionInit = {
      type: (parsed.sdp && parsed.sdp.type) ? parsed.sdp.type : 'answer',
      sdp: (parsed.sdp && typeof parsed.sdp.sdp === 'string') ? parsed.sdp.sdp : '',
    };
    if (!answerSdpInit.sdp) {
      throw new Error('Guest answer SDP is empty or missing. Please ask the guest to regenerate the answer code.');
    }
    console.log('[HOST] setRemoteDescription — type:', answerSdpInit.type, 'sdp length:', answerSdpInit.sdp.length);

    // Log the candidates we received from the guest. This is CRITICAL for
    // diagnosing connection failures — if the guest's answer only contains
    // mDNS candidates (which the host can't resolve cross-device) and no
    // IP candidates, the connection will fail unless the guest also provided
    // a manual IP. This log tells you exactly what candidates ICE has to
    // work with.
    logSdpCandidates(answerSdpInit.sdp!, '[HOST] Guest answer');

    try {
      await pc.setRemoteDescription(answerSdpInit);
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
        // Clean up dataChannels IMMEDIATELY so emitPeerChange (fired by
        // dc.onclose after a delay) doesn't see a stale entry and mistakenly
        // trigger the host's onPeerChange callback with a non-empty list.
        this.dataChannels.delete(pid);
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
        this.dataChannels.delete(pid);
        try { pc.close(); } catch { /* ignore */ }
        this.peerConns.delete(pid);
        this.appliedAnswers.delete(pid);
      }
    }
    // NOTE: We intentionally do NOT call emitPeerChange() here. The new
    // createOffer() below will add a new peerId to dataChannels (via
    // bindDataChannel), but that data channel is in "connecting" state, not
    // "open". Calling emitPeerChange now would emit [newPeerId] with
    // length > 0, which would trigger the host's onPeerChange callback and
    // mistakenly start the game. The next legitimate emitPeerChange will
    // fire when the new data channel actually opens (dc.onopen).
    return this.createOffer(ip);
  }

  /**
   * Create a fresh invite code for an ADDITIONAL guest — WITHOUT tearing down
   * any existing connections. This is the key method for 3+ device play: the
   * host already has guest 1 connected, and now wants to invite guest 2.
   *
   * Each call generates a brand-new peerId + RTCPeerConnection + data channel
   * + SDP offer. Existing connected guests are untouched. The host can call
   * this multiple times to invite as many guests as desired.
   *
   * Reuses the last manualHostIp (if any) so the user doesn't have to re-enter
   * their LAN IP for every additional guest.
   */
  async createAnotherOffer(manualHostIp?: string): Promise<string> {
    const ip = manualHostIp ?? this.lastManualHostIp;
    console.log('[HOST] Creating invite code for an additional guest. Existing connections:',
      Array.from(this.dataChannels.entries()).filter(([_, dc]) => dc.readyState === 'open').length);
    return this.createOffer(ip);
  }

  /**
   * Broadcast a `start-countdown` message to ALL connected guests. Called by
   * the host's lobby UI when the host clicks "Start Game". Guests receive
   * this and transition from the lobby into the actual game (mount engine,
   * generate island, start countdown).
   *
   * The host itself does NOT need this message — its own LanModal calls
   * `onStart` directly when the host clicks "Start Game".
   */
  broadcastStartCountdown(startTimer: number) {
    const msg: NetMessage = { kind: 'start-countdown', startTimer };
    const raw = JSON.stringify(msg);
    let sent = 0;
    for (const dc of this.dataChannels.values()) {
      if (dc.readyState === 'open') {
        try { dc.send(raw); sent++; } catch { /* ignore */ }
      }
    }
    console.log('[HOST] Broadcast start-countdown to', sent, 'guest(s). startTimer=', startTimer);
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

  private createPeerConnection(peerId: string, forceOfflineOverride?: boolean): RTCPeerConnection {
    // Build the ICE config dynamically — when forceOffline is set (or
    // navigator.onLine is false), we skip STUN servers entirely so ICE
    // gathering completes in milliseconds instead of waiting 5-10s for STUN
    // to time out on a hotspot without internet.
    //
    // forceOfflineOverride lets createOffer() temporarily enable offline mode
    // when the user provided a manual IP (a strong hint they're on a hotspot).
    const offline = forceOfflineOverride ?? this.forceOffline;
    const pc = new RTCPeerConnection(createPCConfig(offline));
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
        // Trigger an ICE restart. The PC will re-gather candidates and try
        // again. Don't immediately tear down — give ICE restart a chance.
        try { pc.restartIce(); } catch { /* ignore */ }
      }
    };
    pc.onconnectionstatechange = () => {
      console.log('[HOST]', peerId, 'Connection State:', pc.connectionState);
      if (pc.connectionState === 'failed') {
        // Don't immediately disconnect — give ICE restart (triggered above)
        // a 5-second window to recover. Only tear down if we're still failed
        // after that. This handles transient firewall flaps and NAT timeouts
        // that often happen on hotspot connections.
        setTimeout(() => {
          // Re-check: maybe ICE recovered.
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            this.handlePeerDisconnect(peerId);
          }
        }, 5000);
      } else if (pc.connectionState === 'closed') {
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
      // Broadcast the updated lobby roster to ALL connected guests (including
      // the just-connected one) so everyone's lobby UI shows the new player.
      // Slight delay (50ms) to let the guest's dc.onopen finish and its
      // message listener attach — without this, the new guest could miss the
      // peer-list broadcast entirely.
      setTimeout(() => this.broadcastPeerList(), 50);
    };
    dc.onmessage = (e) => this.handleRawMessage(peerId, e.data as string);
    // Treat data channel close as a recoverable signal — wait a moment, then
    // only fire peer-disconnected if the channel is *still* closed. This
    // avoids the "connects for a split second then disconnects" symptom that
    // happens when Chrome briefly flaps the data channel during ICE consent
    // freshness checks.
    dc.onclose = () => {
      console.log('[HOST]', peerId, 'DataChannel CLOSED');
      // Wait 5 seconds before tearing down — matches the grace period in
      // onconnectionstatechange. During this window, ICE restart might
      // recover the connection (e.g. after a transient firewall flap or
      // NAT timeout). If the data channel reopens, we cancel the teardown.
      setTimeout(() => {
        // Re-check: maybe the data channel reopened (ICE recovered) or a
        // new data channel was bound to this peerId.
        const currentDc = this.dataChannels.get(peerId);
        if (currentDc && currentDc.readyState === 'open') {
          console.log('[HOST]', peerId, 'DataChannel recovered — skipping teardown');
          return;
        }
        // Also check if the PC is still in a recovering state
        const pc = this.peerConns.get(peerId);
        if (pc && (pc.connectionState === 'connected' || pc.connectionState === 'connecting')) {
          console.log('[HOST]', peerId, 'PC still recovering — skipping teardown');
          return;
        }
        this.handlePeerDisconnect(peerId);
      }, 5000);
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
        case 'player-shot':
          this.emit({ type: 'player-shot', data: { id: playerId, weapon: msg.weapon, direction: msg.direction, origin: msg.origin } });
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
          // BROADCAST the new roster to ALL guests so everyone's lobby UI
          // updates. The host is the source of truth for the lobby roster.
          this.broadcastPeerList();
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
        case 'peer-list':
          // Guests don't normally send peer-list to the host (host is the
          // authority), but ignore gracefully if one arrives.
          break;
        case 'start-countdown':
          // Guests don't send this to the host (host triggers countdown), but
          // ignore gracefully if one arrives.
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
      // Refresh the lobby roster on remaining peers so the disconnected
      // player is removed from everyone's UI.
      this.broadcastPeerList();
    }
    this.emitPeerChange();
  }

  /**
   * Broadcast the current lobby roster (host + all connected guests) to every
   * connected guest. Called whenever a guest joins or disconnects so every
   * peer's lobby UI shows the same up-to-date player list.
   *
   * The host's own id is always first in the list with isHost=true. Each
   * connected guest's peerId follows with isHost=false.
   */
  broadcastPeerList() {
    const players = [
      { id: this.id, isHost: true },
      ...Array.from(this.dataChannels.keys())
        .filter((id) => this.dataChannels.get(id)!.readyState === 'open')
        .map((id) => ({ id, isHost: false })),
    ];
    const msg: NetMessage = { kind: 'peer-list', players };
    const raw = JSON.stringify(msg);
    let sent = 0;
    for (const dc of this.dataChannels.values()) {
      if (dc.readyState === 'open') {
        try { dc.send(raw); sent++; } catch { /* ignore */ }
      }
    }
    console.log('[HOST] Broadcast peer-list to', sent, 'guest(s):', players.map((p) => p.id).join(', '));
    // Also emit locally so the host's own lobby UI updates.
    this.emit({ type: 'peer-list', data: { players } });
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
    // If events arrived before any listener was registered, replay them now.
    // The most important cases are `new-player` (so the engine creates a
    // sphere for an already-connected guest when the engine finally mounts)
    // and `peer-list` (so the lobby UI shows the current roster). We replay
    // ALL event types except `close` (which is terminal and should only fire
    // once — see the close() method).
    if (this.pendingEvents.length > 0) {
      const pending = this.pendingEvents.slice();
      this.pendingEvents = [];
      console.log('[HOST] Replaying', pending.length, 'buffered events to new listener');
      // Defer to a microtask so the caller's setup completes first.
      queueMicrotask(() => {
        for (const ev of pending) {
          try { cb(ev); } catch (e) { console.warn('[HOST] replay threw', e); }
        }
      });
    }
  }
  offMessage(cb: (ev: NetEvent) => void) {
    this.listeners.delete(cb);
  }
  onPeerChange(cb: (peers: string[]) => void) {
    this.peerListeners.add(cb);
    cb(Array.from(this.dataChannels.keys()));
  }

  private emit(ev: NetEvent) {
    if (this.listeners.size === 0) {
      // No listener yet — buffer. We cap the buffer so a runaway peer can't
      // OOM us. We DO buffer `close` too (the close() method sets closed=true
      // first, so any subsequent emit calls are no-ops anyway).
      this.pendingEvents.push(ev);
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
  /** Whether to skip STUN servers entirely (hotspot without internet). */
  private forceOffline: boolean;

  constructor(id: string, opts?: { forceOffline?: boolean }) {
    this.id = id;
    this.forceOffline = !!opts?.forceOffline;
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

    // AUTOMATIC OFFLINE DETECTION (symmetric to host): if the guest provided a
    // manual LAN IP, OR if the host's offer SDP contains a manual IP (not a
    // *.local hostname), we infer we're on a hotspot and skip STUN. The host's
    // offer SDP having an IP instead of mDNS is a strong signal that the host
    // is in manual-IP mode (hotspot).
    const offerSdp = typeof parsed.sdp?.sdp === 'string' ? parsed.sdp.sdp : '';
    const offerHasManualIp = /\.local\b/.test(offerSdp) === false && /a=candidate:.*\d+\.\d+\.\d+\.\d+/.test(offerSdp);
    const effectiveOffline = this.forceOffline || !!manualGuestIp || offerHasManualIp;
    if (effectiveOffline !== this.forceOffline) {
      console.log('[GUEST] Detected hotspot/manual-IP scenario — automatically enabling offline mode (skipping STUN)');
    }

    this.pc = new RTCPeerConnection(createPCConfig(effectiveOffline));
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
      if (this.pc.connectionState === 'failed') {
        // Don't immediately close — give ICE restart (triggered in the ice
        // state handler) a 5-second window to recover. Only schedule a close
        // if we're still failed after that.
        setTimeout(() => {
          if (this.pc && (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed')) {
            this.scheduleClose();
          }
        }, 5000);
      } else if (this.pc.connectionState === 'closed') {
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

    // Apply the host's offer SDP. The host may have rewritten its mDNS
    // hostnames to use a manual IP (when the user provided one) — that's
    // fine, the SDP still parses cleanly because we only swapped the
    // hostname token. If the host also shipped extra mDNS candidates (for
    // same-machine testing), apply them via addIceCandidate.
    // Defensive: normalize the parsed SDP into a clean RTCSessionDescriptionInit
    // with explicit type + sdp fields. This guards against malformed payloads
    // (e.g. if the host's JSON.stringify produced an RTCSessionDescription with
    // a toJSON that lost the type, or if the SDP was corrupted in transit).
    // Without this, setRemoteDescription can throw "Failed to parse
    // SessionDescription" which is hard to debug.
    const offerSdpInit: RTCSessionDescriptionInit = {
      type: (parsed.sdp && parsed.sdp.type) ? parsed.sdp.type : 'offer',
      sdp: (parsed.sdp && typeof parsed.sdp.sdp === 'string') ? parsed.sdp.sdp : '',
    };
    if (!offerSdpInit.sdp) {
      throw new Error('Host offer SDP is empty or missing. Please ask the host to regenerate the invite code.');
    }
    console.log('[GUEST] setRemoteDescription — type:', offerSdpInit.type, 'sdp length:', offerSdpInit.sdp.length);

    // Log the candidates we received from the host. This tells us whether
    // the host provided a manual IP (which we can reach) or only mDNS
    // (which we can't resolve cross-device).
    logSdpCandidates(offerSdpInit.sdp!, '[GUEST] Host offer');

    await this.pc.setRemoteDescription(offerSdpInit);
    if (parsed.extraCandidates && parsed.extraCandidates.length > 0) {
      console.log('[GUEST] Applying', parsed.extraCandidates.length, 'low-priority mDNS extras from host');
      // Apply asynchronously — don't block the answer generation. Any
      // failures are non-fatal (logged inside applyExtraCandidates).
      applyExtraCandidates(this.pc, parsed.extraCandidates).catch((e) => {
        console.warn('[GUEST] applyExtraCandidates threw (non-fatal):', e);
      });
    }

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitForIceComplete(this.pc, 12000, effectiveOffline);

    // Manual-IP fix (symmetric to host side): if the guest provided a manual
    // IP, rewrite the local SDP's mDNS hostnames to use it. We also extract
    // the original mDNS candidates as low-priority extras so same-machine
    // testing still works.
    const localSdp = this.pc.localDescription;
    let sdpToSend: RTCSessionDescriptionInit | undefined;
    let extraCandidates: ExtraIceCandidate[] = [];
    if (manualGuestIp && localSdp && typeof localSdp.sdp === 'string') {
      extraCandidates = extractMdnsCandidatesAsExtra(localSdp.sdp);
      const rewrittenSdp = rewriteSdpWithManualIp(localSdp.sdp, manualGuestIp);
      // Build a PLAIN object with explicit type+sdp (see host-side comment
      // for why we don't spread the RTCSessionDescription directly).
      sdpToSend = { type: 'answer', sdp: rewrittenSdp };
      console.log(`[GUEST] Answer SDP rewritten with manual IP ${manualGuestIp}. ` +
        `${extraCandidates.length} mDNS candidate(s) shipped as low-priority extras.`);
    } else {
      sdpToSend = localSdp
        ? { type: localSdp.type, sdp: localSdp.sdp }
        : undefined;
    }

    const payload = JSON.stringify({
      sdp: sdpToSend,
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
          case 'player-shot':
            this.emit({ type: 'player-shot', data: { id: msg.id, weapon: msg.weapon, direction: msg.direction, origin: msg.origin } });
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
          case 'peer-list':
            this.emit({ type: 'peer-list', data: { players: msg.players } });
            break;
          case 'start-countdown':
            this.emit({ type: 'start-countdown', data: { startTimer: msg.startTimer } });
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
    // Wait 5 seconds before declaring the connection lost — matches the
    // host-side grace period. During this window, ICE restart might recover
    // the connection (e.g. after a transient firewall flap or NAT timeout).
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      // Re-check: maybe the channel reopened during the wait.
      if (this.dc && this.dc.readyState === 'open') return;
      if (this.pc && (this.pc.connectionState === 'connected' || this.pc.connectionState === 'connecting')) return;
      this.emit({ type: 'close' });
    }, 5000);
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
  offMessage(cb: (ev: NetEvent) => void) {
    this.listeners.delete(cb);
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
 * OFFLINE FAST-PATH: When `forceOffline` is true (or navigator.onLine is
 * false), we use NO STUN servers — only mDNS + manual IP candidates. In that
 * case there's nothing to wait for, so we resolve as soon as we get the first
 * host candidate (or after a short 1.5s timeout if no candidates appear at
 * all). This makes "hotspot host + guest" play feel instant instead of making
 * the user wait 6-10 seconds for STUN to time out.
 *
 * The key change: we NO LONGER resolve early just because we got an mDNS
 * candidate. We always give STUN at least 6 seconds to respond — UNLESS
 * we're in offline mode, in which case STUN isn't being attempted.
 */
function waitForIceComplete(pc: RTCPeerConnection, timeoutMs = 12000, forceOffline = false): Promise<void> {
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

    // In offline mode (no STUN servers configured), there's no point waiting
    // 6 seconds for STUN candidates that will never come. We resolve as soon
    // as we have ANY candidate (or after 1.5s if none arrive).
    const offlineFastTimeout = forceOffline ? 1500 : -1;

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
        } else if (forceOffline && gotAnyCandidate) {
          // OFFLINE FAST-PATH: no STUN to wait for. Resolve as soon as we
          // have any host candidate (with a tiny 200ms grace for any
          // additional host candidates on multi-interface devices).
          setTimeout(finish, 200);
        }
        // If we only have host/mDNS candidates so far, keep waiting for STUN
        // (unless we're in offline mode — handled above).
      } else {
        // null candidate = ICE gathering complete.
        finish();
      }
    };
    pc.addEventListener('icegatheringstatechange', stateCheck);
    pc.addEventListener('icecandidate', candidateCheck);

    if (forceOffline) {
      // OFFLINE: short timeout — STUN isn't being attempted, so if no host
      // candidates arrive within 1.5s something is very wrong.
      mdnsOnlyTimer = window.setTimeout(() => {
        if (!done) {
          console.warn('[WebRTC] Offline mode: no candidates after 1.5s — ICE config issue?');
          finish();
        }
      }, offlineFastTimeout);
    } else {
      // ONLINE: if we ONLY have mDNS/host candidates after 6 seconds, assume
      // STUN is blocked on this network and resolve with what we have. The
      // user can use the manual IP field as a workaround. (Previously this
      // was 2.5s, which was too short — STUN often takes 3–5s on real
      // networks.)
      mdnsOnlyTimer = window.setTimeout(() => {
        if (gotAnyCandidate && !gotSrflx && !done) {
          console.warn('[WebRTC] Only mDNS/host candidates after 6s — STUN appears blocked.',
            'Cross-device connection will likely fail. Use the manual LAN IP field as a workaround.');
          finish();
        }
      }, 6000);
    }

    // Hard timeout. In offline mode we use the shorter fast-timeout.
    setTimeout(finish, forceOffline ? Math.min(timeoutMs, 4000) : timeoutMs);
  });
}
