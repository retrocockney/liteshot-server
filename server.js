const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});

const players = {};

// ---- MATCH: 5 minutes, then a scoreboard and Play Again ----
const MATCH_MS = 5 * 60 * 1000;
let matchRunning = false;
let matchEndsAt = 0;
let matchTimeout = null;

function scoreList() {
    return Object.values(players)
        .map(p => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths }))
        .sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
}

function startMatch() {
    for (const id in players) {
        players[id].kills = 0;
        players[id].deaths = 0;
    }
    matchRunning = true;
    matchEndsAt = Date.now() + MATCH_MS;
    clearTimeout(matchTimeout);
    matchTimeout = setTimeout(endMatch, MATCH_MS);
    io.emit('matchStart', { msRemaining: MATCH_MS });
}

function endMatch() {
    matchRunning = false;
    clearTimeout(matchTimeout);
    io.emit('matchEnd', { scores: scoreList() });
}

// ---- PICKUPS: the first player's game supplies the spots, the server keeps them for everyone ----
let pickupState = null;
const RESPAWN_MS = { weapon: 20000, kit: 12000, grenade: 15000 };

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    players[socket.id] = {
        id: socket.id,
        x: (Math.random() - 0.5) * 40,
        y: 2.2,
        z: (Math.random() - 0.5) * 40,
        yaw: 0,
        name: 'Operative',
        color: 0x00ffcc,
        visor: 0x00ffcc,
        helmet: 'visor',
        armor: 'heavy',
        kills: 0,
        deaths: 0
    };

    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', players[socket.id]);

    // Match: the first player starts one; later players join the current one
    if (!matchRunning && Object.keys(players).length === 1) {
        startMatch();
    } else if (matchRunning) {
        socket.emit('matchStart', { msRemaining: Math.max(0, matchEndsAt - Date.now()) });
    } else {
        socket.emit('matchEnd', { scores: scoreList() });
    }

    // Pickups: send the current spots, or ask a player to supply them
    if (pickupState) {
        socket.emit('pickupState', pickupState);
    } else {
        socket.emit('requestPickupSpots');
    }

    socket.on('pickupSpots', (spots) => {
        if (pickupState || !spots || !Array.isArray(spots.weapons) || !Array.isArray(spots.kits) || !Array.isArray(spots.grenades)) return;
        const clean = (list, prefix, extra) => list.slice(0, 8).map((s, i) => Object.assign({
            id: prefix + i,
            x: Number(s.x) || 0,
            z: Number(s.z) || 0,
            active: true
        }, extra(s)));
        pickupState = {
            weapons: clean(spots.weapons, 'w', s => ({ type: s.type === 'sniper' ? 'sniper' : 'shotgun' })),
            kits: clean(spots.kits, 'k', () => ({})),
            grenades: clean(spots.grenades, 'g', () => ({}))
        };
        io.emit('pickupState', pickupState);
    });

    socket.on('pickupTaken', (d) => {
        if (!pickupState || !d) return;
        const lists = { weapon: pickupState.weapons, kit: pickupState.kits, grenade: pickupState.grenades };
        const list = lists[d.kind];
        if (!list) return;
        const item = list.find(i => i.id === d.id);
        if (!item || !item.active) return;
        item.active = false;
        io.emit('pickupTaken', { kind: d.kind, id: d.id });
        setTimeout(() => {
            item.active = true;
            io.emit('pickupRespawn', { kind: d.kind, id: d.id });
        }, RESPAWN_MS[d.kind]);
    });

    socket.on('restartMatch', () => {
        if (!matchRunning) startMatch();
        else socket.emit('matchStart', { msRemaining: Math.max(0, matchEndsAt - Date.now()) });
    });

    socket.on('setIdentity', (data) => {
        const p = players[socket.id];
        if (!p || !data) return;
        p.name = String(data.name || 'Operative').slice(0, 12);
        p.color = Number.isFinite(data.color) ? data.color : 0x00ffcc;
        p.visor = Number.isFinite(data.visor) ? data.visor : p.color;
        p.helmet = ['visor', 'full', 'scout'].includes(data.helmet) ? data.helmet : 'visor';
        p.armor = ['heavy', 'light', 'none'].includes(data.armor) ? data.armor : 'heavy';
        io.emit('playerIdentity', {
            id: p.id, name: p.name, color: p.color, visor: p.visor, helmet: p.helmet, armor: p.armor
        });
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

    // A player died: count it during a match and tell everyone who killed them
    socket.on('playerDied', (data) => {
        const victim = players[socket.id];
        if (!victim) return;
        const killer = data && typeof data.killerId === 'string' ? players[data.killerId] : null;
        if (matchRunning) {
            victim.deaths++;
            if (killer && killer !== victim) killer.kills++;
        }
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
