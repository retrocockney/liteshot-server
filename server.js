const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});

const players = {};

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    players[socket.id] = {
        id: socket.id,
        x: (Math.random() - 0.5) * 40,
        y: 2.2,
        z: (Math.random() - 0.5) * 40,
        yaw: 0,
        health: 100
    };

    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', players[socket.id]);

    socket.on('playerMovement', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].z = data.z;
            players[socket.id].yaw = data.yaw;
            socket.broadcast.emit('playerMoved', players[socket.id]);
        }
    });

    // Relay damage from shooter to target player
    socket.on('hitPlayer', (hitData) => {
    if (!hitData || typeof hitData.targetId !== 'string') return;
    if (hitData.targetId === socket.id || !players[hitData.targetId]) return;
    const damage = Math.min(100, Math.max(0, Number(hitData.damage) || 0));
    io.to(hitData.targetId).emit('playerHit', {
        damage: damage,
        attackerId: socket.id
    });
});

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
