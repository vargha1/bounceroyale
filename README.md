# Bounce Royale

A 3D multiplayer physics-based battle royale game built with Three.js and Rapier physics engine.

## Features

### Core Gameplay
- **Player Elimination**: Players die when falling below -10 Y level
- **Spectating System**: Dead players can spectate remaining players and switch between them using TAB
- **Player Collision**: Players can collide with each other and push each other off platforms
- **Hexagon Breaking**: Players can break hexagons by landing on them multiple times

### Enhanced Features
- **Score System**: Earn points for surviving, breaking hexagons, and eliminating players
- **Health System**: Players have health that decreases when falling fast
- **Power-ups**: Random power-ups including:
  - Speed Boost: Increased movement speed
  - High Jump: Enhanced jumping ability
  - Health Regeneration: Gradual health recovery
  - Invincibility: Temporary protection
- **Particle Effects**: Visual effects for collisions, hexagon breaking, and player elimination
- **Sound System**: Audio feedback for jumping, collisions, and hexagon breaking

### Multiplayer
- **LAN Discovery**: Automatic discovery of games on local network
- **Real-time Physics**: Synchronized physics across all players
- **Game Rooms**: Create or join game rooms with customizable start timers

## Installation

1. Install dependencies:
```bash
npm install
```

2. Build the project:
```bash
npm run build
```

3. Start the server:
```bash
npm run server
```

The game will be available at `http://localhost:5000`

## Development

For development with hot reload:
```bash
npm run dev
```

## Deployment

### Local Network
1. Run `npm run start` on your machine
2. Other players can connect using your IP address and port 5000
3. The game supports automatic LAN discovery

### Cloud Deployment
1. Build the project: `npm run build`
2. Deploy the `dist` folder and `src/server.js` to your hosting service
3. Make sure to install Node.js dependencies on the server
4. Run the server with `node src/server.js`

### Environment Variables
- `PORT`: Server port (default: 5000)

## Controls

### Desktop
- **WASD**: Movement
- **Space**: Jump
- **Mouse**: Camera rotation
- **TAB**: Switch spectating target (when eliminated)
- **Escape**: Pause game

### Mobile
- **Virtual Joystick**: Movement
- **Jump Button**: Jump
- **Touch and Drag**: Camera rotation

## Game Modes

1. **Single Player**: Practice mode against AI
2. **Create Game**: Host a multiplayer game
3. **Join Game**: Connect to an existing game

## Technical Details

- **Frontend**: Three.js, TypeScript, Vite
- **Physics**: Rapier 3D physics engine
- **Backend**: Node.js, Express, Socket.IO
- **Networking**: WebSocket-based real-time communication
- **Audio**: Three.js Audio system with Web Audio API

## Troubleshooting

### Audio Issues
- Make sure to interact with the page (click/touch) to enable audio context
- Check browser audio permissions

### Connection Issues
- Ensure firewall allows port 5000
- Check network connectivity for multiplayer games
- Try manual connection if LAN discovery fails

### Performance Issues
- Lower graphics settings in browser
- Close other browser tabs
- Ensure stable internet connection for multiplayer
