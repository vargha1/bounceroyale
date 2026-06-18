# Bounce Royale (React + Three.js + Rapier)

A 3D physics-based battle royale game. Rewrite of the original vanilla-TS version
with **React**, a **truly FPS-independent game loop**, a **fully functional
settings modal**, and **two multiplayer options**:

1. **LAN Multiplayer (P2P)** — pure WebRTC, **no server required**. Peers
   exchange an SDP offer/answer via copy-paste or QR code; all game traffic then
   flows directly between browsers on the same local network.
2. **Online Server** — the original Node.js + Socket.io server, kept as a
   separate menu option for clients who want to play over the internet via a
   central server.

## What changed from the original

### Bug fixes

| Original bug | Fix |
| --- | --- |
| `lastFrameTime = time` was set at the **start** of `animate()`, so `deltaTime` always equalled 0 → particles never moved and the per-second score check never fired | Engine measures `realDt = now - lastFrameTime` correctly and only updates `lastFrameTime` afterwards |
| Physics was FPS-dependent (one `world.step()` per frame) | Fixed-timestep accumulator at 60 Hz with a max-steps-per-frame cap — physics is identical at 30 / 60 / 144 Hz |
| `playerRank == null;` and `lastFrameTime == 0;` were no-op comparisons, not assignments | Removed |
| `gameModeModal.style.displayH` — incomplete statement, single-player modal never closed | React-driven modal flow, no manual DOM mutation |
| Settings nav item had **no modal** behind it | Full settings modal: language, master volume, game speed, camera sensitivity, graphics quality, pointer lock, FPS overlay, reset |
| "LAN discovery" actually did `fetch('https://game.safahanbattery.ir:8443/discover-lan')` — defeated the point of LAN | True P2P: WebRTC data channels, no server in the path |

### New features

- **React UI** — component-based menus, modals, HUD, mobile controls.
- **Game-speed setting** — 0.25× to 2× slider in Settings; scales the entire
  simulation (physics, animations, particles) without breaking determinism.
- **Settings modal** — every option actually works and is persisted to
  localStorage.
- **LAN P2P multiplayer** — WebRTC with manual signaling (text + QR code).
- **Server multiplayer** — original Node + Socket.io server kept as a menu option.
- **Polished UI** — modern dark theme, gradients, glassmorphism, responsive
  layout, smooth animations, full RTL support for Persian.
- **HUD** — score, health bar, power-up chips, alive/total players, FPS overlay
  (optional), connection mode indicator.
- **End-game rankings** with gold/silver/bronze styling.

## Project structure

```
bounceroyale-react/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── public/
│   ├── images/logo.png
│   └── sounds/{jump,collision,break}.mp3
└── src/
    ├── main.tsx              # React entry
    ├── App.tsx               # Top-level screen state machine
    ├── components/           # All React UI components
    │   ├── MainMenu.tsx
    │   ├── GameModeModal.tsx
    │   ├── SettingsModal.tsx
    │   ├── AboutModal.tsx
    │   ├── CreateGameModal.tsx     # server-mode "Create Game"
    │   ├── JoinServerModal.tsx     # server-mode "Join Game"
    │   ├── LanHostModal.tsx        # LAN P2P host UI
    │   ├── LanJoinModal.tsx        # LAN P2P guest UI
    │   ├── Game.tsx                # in-game React wrapper
    │   ├── Hud.tsx
    │   ├── MobileControls.tsx
    │   ├── PauseModal.tsx
    │   ├── EndGameModal.tsx
    │   └── Toast.tsx
    ├── game/
    │   └── engine.ts         # Fixed-timestep Three.js + Rapier engine
    ├── networking/
    │   ├── types.ts          # NetMessage / NetEvent protocol
    │   ├── socket.ts         # socket.io client (server-mode)
    │   └── webrtc.ts         # WebRTC host & guest clients (LAN-mode)
    ├── store/
    │   └── settings.ts       # Zustand settings store (persisted)
    ├── i18n/
    │   └── translations.ts   # en + fa strings
    ├── styles/
    │   └── global.css
    └── server/
        └── server.cjs        # Original Node + Socket.io server (kept as option)
```

## How the FPS-independent loop works

The render loop runs at the display refresh rate. Each frame:

1. Compute real delta time `realDt` (capped at 0.25 s).
2. Multiply by `gameSpeed` to get `scaledDt`.
3. Feed `scaledDt` into a fixed-timestep accumulator. Step physics at 1/60 s
   until the accumulator drains, capped at 5 steps to avoid the spiral of death.
4. Use `scaledDt` for animations, particles, power-ups and the per-second
   score tick.
5. Movement input is applied per physics step using `PHYSICS_DT`, so movement
   is identical at any FPS.

A 2× game speed simply feeds `2 × realDt` into the accumulator, which produces
twice as many physics steps per real second — physics stays numerically stable.

## How LAN multiplayer works

The LAN menu offers **four options** so you can pick the easiest one for your setup:

### 1. Quick Host / Quick Join (same browser) — easiest

For testing on a single device with two browser tabs/windows. Uses the
`BroadcastChannel` API — no codes, no QR, no setup.

- Tab A: click **Start Game → LAN Multiplayer → Quick Host → Start Game**.
- Tab B: open the game in a new tab, click **Start Game → LAN Multiplayer → Quick Join → Connect**.

They connect instantly. This is the recommended way to test the game locally.

### 2. Host on network / Join with code (cross-device) — WebRTC

For playing between two devices on the same Wi-Fi (or two browser profiles
that can't share a BroadcastChannel). Uses WebRTC with manual signaling —
**no server required**.

- Device A: click **Host on network → Start Hosting**.
- Device B: click **Join with code**, paste the host's invite token (optional),
  click **Generate Answer** → an SDP offer appears.
- Device A: paste the guest's offer, click **Generate Answer** → an SDP answer appears.
- Device B: paste the host's answer, click **Connect** → connected.

The codes are shown as both text and QR codes for easy sharing. ICE candidates
include mDNS (for same-LAN) and a public Google STUN fallback (so the
connection survives NAT'd networks and Chrome's mDNS anti-fingerprinting).

### Robustness

- WebRTC connections **do not** tear down on transient `disconnected` states —
  only on `failed` or `closed`. This fixes the "connects for a split second
  then disconnects" symptom that flaky Wi-Fi and ICE consent freshness checks
  can cause.
- ICE gathering resolves as soon as the first candidate is ready (with a small
  grace period) instead of waiting for the full STUN timeout — much faster
  connection on LAN.
- The net client is owned by the `Game` component (not the engine) and is
  reused across React StrictMode dev remounts, so HMR doesn't kill your
  connection.

## Running

### Development

```bash
npm install
npm run dev
# → http://localhost:5173
```

### Production build + preview

```bash
npm run build
npm run preview
```

### Server-mode multiplayer (optional)

```bash
npm run server
# → http://localhost:8443 (or your own SSL certs via env vars)
```

### Build + serve together

```bash
npm start
```

## Controls

| Desktop | Mobile |
| --- | --- |
| WASD — move | Left half of screen = floating joystick (touch anywhere on the left, drag) |
| Space — jump | Right "Jump" button — jump |
| Mouse — camera | Right half of screen = drag to rotate camera |
| Esc — pause | (use the on-screen pause via the HUD) |
| Tab — switch spectating target (when dead) | — |

### Mobile improvements in this version

- **Floating joystick** — touch anywhere on the left ~45% of the screen and the
  joystick base appears under your finger. No more hunting for a fixed 130 px
  circle.
- **Lower deadzone (0.15 vs 0.5)** — small nudges now register, so the ball
  actually moves when you push the stick gently.
- **Analog magnitude** — partial stick deflection moves the ball slower, like
  a real gamepad.
- **Jump buffering + coyote time** — if you tap jump a hair too early (while
  airborne), the jump fires as soon as you land. If you tap a hair too late
  (just after walking off an edge), you still get a 200 ms grace window to
  jump. No more "stuck after falling" feeling.
- **`touch-action: none` on canvas + body** — the browser no longer pans,
  zooms, or pull-to-refreshes the page while you're playing.
- **All touch handlers call `preventDefault()`** — no synthetic mouse events
  confuse the engine.

## Settings

Open the Settings modal from the main menu sidebar (or the top-right "⚙️
Settings" button) to tune:

- **Language** — English / فارسی (persisted, RTL-aware).
- **Game speed** — 0.25× … 2× (also affects single-player AI pace).
- **Island damage** — 0.1× … 3× multiplier on how much each landing damages
  the island. At 0.1× the island is nearly indestructible; at 3× a single
  hard landing can crater a large hole.
- **Island size** — Small / Medium / Large. Controls the procedural island's
  radius and tile count. In multiplayer, the host's setting is used.
- **Master volume** — 0% … 100%.
- **Camera sensitivity** — 0.1× … 3×.
- **Graphics quality** — Low / Medium / High (shadows, antialiasing, pixel
  ratio).
- **Pointer lock** — toggle mouse capture on desktop.
- **Show FPS / Ping** — HUD overlay.
- **Reset to defaults**.

## The destructible island

Instead of the old fixed 9-hexagon grid, the game now generates a procedural
island on every match:

- **Shape** — a hex grid of small tiles (radius 0.6) filtered by value-noise ×
  radial falloff, producing an irregular, organic coastline. A seeded PRNG
  makes the layout deterministic — the host generates it and sends the seed to
  guests so everyone has the exact same island.
- **Height** — a second noise channel + radial lift gives the island a gentle
  hill in the centre. Tiles are coloured by height: sandy beaches at the
  edges, grass in the middle, rocky grey at the peaks.
- **Health** — each tile starts with 100 HP. Landing on the island damages
  tiles in a radius around the impact point. Damage falls off linearly from
  the centre to the edge of the blast.
- **Fall-speed scaling** — while the ball is airborne, the engine tracks the
  peak downward velocity. On landing, `speedFactor = clamp(maxFallSpeed / 10,
  0.1, 3)`. The damage dealt is `BASE_DAMAGE × islandDamageMultiplier ×
  speedFactor`, and the blast radius grows with the same factor. So a soft
  5 m/s landing barely dents the surface, while a 25 m/s plummet can shatter
  half a dozen tiles.
- **Visual feedback** — tiles shift from green (healthy) → yellow → red as
  they take damage. When a tile's HP hits 0 it crumbles away with a particle
  burst and its collider is removed, opening a hole in the island.
- **Multiplayer sync** — each peer detects its own landings and broadcasts
  `damage-tile` events (tileId + damage amount) to all other peers. Everyone
  applies the same damage to their local copy of the island, so holes appear
  simultaneously on all screens. The host's seed ensures everyone starts with
  the same layout.

## Tech stack

- React 18 + TypeScript 5
- Vite 5 + vite-plugin-wasm
- Three.js 0.178 + @dimforge/rapier3d
- @tweenjs/tween.js
- Zustand (settings store)
- qrcode (QR codes for LAN signaling)
- socket.io / socket.io-client (server-mode multiplayer)
- Node + Express (server-mode backend, kept as a menu option)
