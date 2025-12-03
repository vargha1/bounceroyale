const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const cors = require('cors');
const { Server } = require('socket.io');
const MulticastDNS = require('multicast-dns');

const app = express();
app.use(cors())

// Configuration
const PORT = process.env.PORT || 8443;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || '/etc/letsencrypt/live/game.safahanbattery.ir/privkey.pem';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || '/etc/letsencrypt/live/game.safahanbattery.ir/fullchain.pem';

let server;
let protocol = 'http';

if (fs.existsSync(SSL_KEY_PATH) && fs.existsSync(SSL_CERT_PATH)) {
    const options = {
        key: fs.readFileSync(SSL_KEY_PATH),
        cert: fs.readFileSync(SSL_CERT_PATH),
    };
    server = https.createServer(options, app);
    protocol = 'https';
    console.log('Starting HTTPS server...');
} else {
    server = http.createServer(app);
    console.log('SSL certificates not found. Starting HTTP server...');
}

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Game state: Map of game rooms
const games = {};

// Default hexagon positions
const defaultHexagons = [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: -4, y: 0, z: 0 },
    { x: 2, y: 0, z: 4 * Math.sqrt(3) / 2 },
    { x: -2, y: 0, z: 4 * Math.sqrt(3) / 2 },
    { x: 6, y: 0, z: 4 * Math.sqrt(3) / 2 },
    { x: -6, y: 0, z: 4 * Math.sqrt(3) / 2 },
    { x: 0, y: 0, z: 4 * Math.sqrt(3) },
    { x: 4, y: 0, z: 4 * Math.sqrt(3) }
];

// Multicast DNS for LAN discovery
const mdns = MulticastDNS();
const servers = [];

// Respond to mDNS queries
mdns.on('query', (query) => {
    query.questions.forEach((question) => {
        if (question.name === '_bounceroyale._tcp.local' && question.type === 'PTR') {
            const gameIds = Object.keys(games);
            gameIds.forEach((gameId) => {
                mdns.respond({
                    answers: [
                        {
                            name: '_bounceroyale._tcp.local',
                            type: 'PTR',
                            data: `BounceRoyale-${gameId}._bounceroyale._tcp.local`
                        },
                        {
                            name: `BounceRoyale-${gameId}._bounceroyale._tcp.local`,
                            type: 'SRV',
                            data: {
                                port: PORT,
                                target: 'localhost.localdomain' // Updated dynamically below
                            }
                        },
                        {
                            name: `BounceRoyale-${gameId}._bounceroyale._tcp.local`,
                            type: 'TXT',
                            data: [`game=bounceroyale`, `gameId=${gameId}`]
                        }
                    ]
                });
            });
        }
    });
});

// Discover other servers
mdns.on('response', (response) => {
    response.answers.forEach((answer) => {
        if (answer.type === 'PTR' && answer.name === '_bounceroyale._tcp.local') {
            const serviceName = answer.data;
            response.additionals.forEach((additional) => {
                if (additional.name === serviceName && additional.type === 'SRV') {
                    const address = additional.data.target;
                    const port = additional.data.port;
                    response.additionals.forEach((txt) => {
                        if (txt.name === serviceName && txt.type === 'TXT') {
                            const txtData = txt.data.map((buf) => buf.toString()).reduce((obj, str) => {
                                const [key, value] = str.split('=');
                                obj[key] = value;
                                return obj;
                            }, {});
                            if (txtData.game === 'bounceroyale') {
                                const existing = servers.find((s) => s.gameId === txtData.gameId && s.address === `${address}:${port}`);
                                if (!existing) {
                                    servers.push({
                                        name: `Bounce Royale Game ${txtData.gameId}`,
                                        address: `${address}:${port}`,
                                        gameId: txtData.gameId
                                    });
                                    console.log('mDNS discovered:', { name: `Bounce Royale Game ${txtData.gameId}`, address, gameId: txtData.gameId });
                                }
                            }
                        }
                    });
                }
            });
        }
    });
});

// Periodically query for services
setInterval(() => {
    mdns.query({
        questions: [{ name: '_bounceroyale._tcp.local', type: 'PTR' }]
    });
}, 5000);

// Advertise the server
function advertiseGame(gameId) {
    mdns.respond({
        answers: [
            {
                name: '_bounceroyale._tcp.local',
                type: 'PTR',
                data: `BounceRoyale-${gameId}._bounceroyale._tcp.local`
            },
            {
                name: `BounceRoyale-${gameId}._bounceroyale._tcp.local`,
                type: 'SRV',
                data: {
                    port: PORT,
                    target: 'localhost.localdomain' // Update with actual hostname if needed
                }
            },
            {
                name: `BounceRoyale-${gameId}._bounceroyale._tcp.local`,
                type: 'TXT',
                data: [`game=bounceroyale`, `gameId=${gameId}`]
            }
        ]
    });
}

// HTTP endpoint for LAN discovery
app.get('/discover-lan', (req, res) => {
    const availableGames = Object.keys(games).map(gameId => ({
        name: `Bounce Royale Game ${gameId}`,
        address: `${req.headers.host || 'localhost'}`,
        gameId
    }));
    res.json(availableGames.length ? availableGames : servers);
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('create-game', (data) => {
        const gameId = Date.now().toString(); // Unique game ID
        const startTimer = data && data.startTimer ? parseInt(data.startTimer) : 30;
        if (startTimer < 5 || startTimer > 60 || isNaN(startTimer)) {
            startTimer = 30;
        }

        games[gameId] = {
            creatorId: socket.id,
            players: {
                [socket.id]: { position: { x: 0, y: 5, z: 0 } }
            },
            hexagons: [...defaultHexagons],
            startTimer
        };

        socket.join(gameId);
        socket.emit('init', {
            gameId,
            creatorId: socket.id,
            players: Object.keys(games[gameId].players).map(id => ({
                id,
                position: games[gameId].players[id].position
            })),
            hexagons: games[gameId].hexagons,
            startTimer
        });
        console.log('Game created:', { gameId, creatorId: socket.id, startTimer });

        // Advertise new game
        advertiseGame(gameId);
    });

    socket.on('join-game', (data) => {
        const gameId = data.gameId;
        if (!games[gameId]) {
            socket.emit('error', { message: 'No such game exists' });
            return;
        }

        games[gameId].players[socket.id] = {
            position: {
                x: Math.random() * 8 - 4,
                y: 5,
                z: Math.random() * 8 - 4
            }
        };

        socket.join(gameId);
        socket.emit('init', {
            gameId,
            creatorId: games[gameId].creatorId,
            players: Object.keys(games[gameId].players).map(id => ({
                id,
                position: games[gameId].players[id].position
            })),
            hexagons: games[gameId].hexagons,
            startTimer: games[gameId].startTimer,
            remainingTime: Math.max(0, Math.ceil((games[gameId].serverStartTime - Date.now()) / 1000))
        });
        socket.to(gameId).emit('new-player', {
            id: socket.id,
            position: games[gameId].players[socket.id].position
        });
        console.log('Player joined:', { gameId, playerId: socket.id });
    });

    socket.on('move', (data) => {
        const gameId = data.gameId;
        if (games[gameId] && games[gameId].players[data.id]) {
            games[gameId].players[data.id].position = data.position;
            socket.to(gameId).emit('player-moved', data);
        }
    });

    socket.on('jump', (data) => {
        const gameId = data.gameId;
        if (games[gameId]) {
            socket.to(gameId).emit('player-jumped', data);
            // Send ack to sender
            if (data.eventId) {
                socket.emit('player-jumped', { id: socket.id, eventId: data.eventId });
            }
        }
    });

    socket.on('rotate', (data) => {
        const gameId = data.gameId;
        if (games[gameId]) {
            socket.to(gameId).emit('player-rotated', data);
        }
    });

    socket.on('hexagon-collided', (data) => {
        const gameId = data.gameId;
        if (games[gameId]) {
            // Acknowledge the event to the sender
            if (data.eventId) {
                socket.emit('hexagon-collided-ack', { eventId: data.eventId });
            }

            // Forward collision to all players (especially the creator who manages state)
            socket.to(gameId).emit('hexagon-collided', data);
            // Also emit to sender if they need to update their local state (though usually they predict)
            // But here we rely on the creator to decide when it breaks.
        }
    });

    socket.on('player-hit', (data) => {
        const gameId = data.gameId;
        if (games[gameId]) {
            // Forward hit to the target player
            io.to(data.targetId).emit('player-hit', data);
        }
    });

    socket.on('break-hexagon', (data) => {
        const gameId = data.gameId;
        // Verify it's the creator
        if (games[gameId] && socket.id === games[gameId].creatorId && games[gameId].hexagons[data.index]) {
            games[gameId].hexagons.splice(data.index, 1);
            io.to(gameId).emit('hexagon-broken', data); // Use io.to to include sender (creator)
            console.log('Hexagon broken:', { gameId, index: data.index });
        }
    });

    socket.on('player-eliminated', (data) => {
        const gameId = data.gameId;
        if (games[gameId] && games[gameId].players[data.playerId]) {
            // Mark player as eliminated
            games[gameId].players[data.playerId].eliminated = true;
            games[gameId].players[data.playerId].rank = data.rank;

            // Notify all players in the game
            io.to(gameId).emit('player-eliminated', {
                id: data.playerId,
                rank: data.rank
            });

            console.log('Player eliminated:', { gameId, playerId: data.playerId, rank: data.rank });

            // Check if game should end
            const alivePlayers = Object.values(games[gameId].players).filter(p => !p.eliminated);
            if (alivePlayers.length <= 1) {
                // Game ended
                const winner = alivePlayers.length === 1 ? Object.keys(games[gameId].players).find(id => !games[gameId].players[id].eliminated) : null;
                io.to(gameId).emit('game-ended', { winner });
                delete games[gameId];
                console.log('Game ended:', { gameId, winner });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        for (const gameId in games) {
            if (games[gameId].players[socket.id]) {
                if (socket.id === games[gameId].creatorId) {
                    // End game if creator disconnects
                    delete games[gameId];
                    io.to(gameId).emit('game-ended');
                    console.log('Game ended:', { gameId });
                } else {
                    // Remove player from game
                    delete games[gameId].players[socket.id];
                    socket.to(gameId).emit('player-disconnected', { id: socket.id });
                }
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
