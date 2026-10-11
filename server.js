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
        name: 'Operative',
        color: 0x00ffcc
    };

    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', players[socket.id]);

    // Player chose a callsign and armor color
    socket.on('setIdentity', (data) => {
        const p = players[socket.id];
        if (!p || !data) return;
        p.name = String(data.name || 'Operative').slice(0, 12);
        p.color = Number.isFinite(data.color) ? data.color : 0x00ffcc;
        io.emit('playerIdentity', { id: socket.id, name: p.name, color: p.color });
    });

    socket.on('playerMovement', (data) => {
        if (!data || !players[socket.id]) return;
        players[socket.id].x = data.x;
        players[socket.id].y = data.y;
        players[socket.id].z = data.z;
        players[socket.id].yaw = data.yaw;
        socket.broadcast.emit('playerMoved', players[socket.id]);
    });

    // Shooter hit another player: tell the target
    socket.on('hitPlayer', (hitData) => {
        if (!hitData || typeof hitData.targetId !== 'string') return;
        if (hitData.targetId === socket.id || !players[hitData.targetId]) return;
        const damage = Math.min(100, Math.max(0, Number(hitData.damage) || 0));
        io.to(hitData.targetId).emit('playerHit', {
            damage: damage,
            attackerId: socket.id,
            weapon: String(hitData.weapon || 'Unknown').slice(0, 12)
        });
    });

    // A player died: tell everyone who killed them
    socket.on('playerDied', (data) => {
        const victim = players[socket.id];
        if (!victim) return;
        const killer = data && typeof data.killerId === 'string' ? players[data.killerId] : null;
        io.emit('playerDown', {
            victimId: socket.id,
            victimName: victim.name,
            killerId: killer ? killer.id : null,
            killerName: killer ? killer.name : null,
            weapon: data && data.weapon ? String(data.weapon).slice(0, 12) : 'Unknown'
        });
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
