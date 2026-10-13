const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});

// ---- LOBBIES: one per map. Players on different maps never see each other. ----
const MAX_EMBLEM_CHARS = 40000;
const MAX_NAME_CHARS = 40;
const MATCH_MS = 5 * 60 * 1000;
const RESPAWN_MS = { weapon: 20000, kit: 12000, grenade: 15000 };

// Four vehicles per lobby (two scooters, two pigs). The map places them; the server only tracks who rides them.
const VEHICLE_IDS = ['v0', 'v1', 'v2', 'v3'];
function newLobby() {
    const vehicles = {};
    VEHICLE_IDS.forEach(id => { vehicles[id] = { riderId: null, x: null, z: null }; });
    return { players: {}, matchRunning: false, matchEndsAt: 0, matchTimeout: null, pickupState: null, vehicles: vehicles };
}
const lobbies = { og: newLobby(), world: newLobby() };

function scoreList(lobby) {
    return Object.values(lobby.players)
        .map(p => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths }))
        .sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
}

function startMatch(mapName) {
    const lobby = lobbies[mapName];
    for (const id in lobby.players) {
        lobby.players[id].kills = 0;
        lobby.players[id].deaths = 0;
    }
    lobby.matchRunning = true;
    lobby.matchEndsAt = Date.now() + MATCH_MS;
    clearTimeout(lobby.matchTimeout);
    lobby.matchTimeout = setTimeout(() => endMatch(mapName), MATCH_MS);
    io.to(mapName).emit('matchStart', { msRemaining: MATCH_MS });
}

function endMatch(mapName) {
    const lobby = lobbies[mapName];
    lobby.matchRunning = false;
    clearTimeout(lobby.matchTimeout);
    io.to(mapName).emit('matchEnd', { scores: scoreList(lobby) });
}

// ---- PRESENCE: friend codes and who is online (separate from lobbies) ----
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const presenceNs = io.of('/presence');
const presenceCodes = {};

presenceNs.on('connection', (s) => {
    let myCode = null;
    s.on('hello', (d) => {
        if (!d || !CODE_RE.test(d.code)) return;
        if (myCode && presenceCodes[myCode] && presenceCodes[myCode].sid === s.id) delete presenceCodes[myCode];
        myCode = d.code;
        presenceCodes[myCode] = { name: String(d.name || 'Operative').slice(0, MAX_NAME_CHARS), sid: s.id };
    });
    s.on('query', (codes) => {
        if (!Array.isArray(codes)) return;
        const list = codes
            .filter(c => typeof c === 'string' && CODE_RE.test(c))
            .slice(0, 50)
            .map(c => ({
                code: c,
                name: presenceCodes[c] ? presenceCodes[c].name : null,
                online: !!presenceCodes[c]
            }));
        s.emit('status', list);
    });
    s.on('disconnect', () => {
        if (myCode && presenceCodes[myCode] && presenceCodes[myCode].sid === s.id) delete presenceCodes[myCode];
    });
});

io.on('connection', (socket) => {
    // The map this player's game was built with decides which lobby they join
    const mapName = socket.handshake.query && socket.handshake.query.map === 'world' ? 'world' : 'og';
    const lobby = lobbies[mapName];
    console.log('Player connected to', mapName, socket.id);
    let lastChatAt = 0;
    socket.join(mapName);

    lobby.players[socket.id] = {
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
        emblem: null,
        kills: 0,
        deaths: 0
    };

    socket.emit('currentPlayers', lobby.players);
    socket.emit('vehicleStates', VEHICLE_IDS.map(id => Object.assign({ id: id }, lobby.vehicles[id])));
    socket.to(mapName).emit('newPlayer', lobby.players[socket.id]);

    if (!lobby.matchRunning && Object.keys(lobby.players).length === 1) {
        startMatch(mapName);
    } else if (lobby.matchRunning) {
        socket.emit('matchStart', { msRemaining: Math.max(0, lobby.matchEndsAt - Date.now()) });
    } else {
        socket.emit('matchEnd', { scores: scoreList(lobby) });
    }

    if (lobby.pickupState) {
        socket.emit('pickupState', lobby.pickupState);
    } else {
        socket.emit('requestPickupSpots');
    }

    socket.on('pickupSpots', (spots) => {
        if (lobby.pickupState || !spots || !Array.isArray(spots.weapons) || !Array.isArray(spots.kits) || !Array.isArray(spots.grenades)) return;
        const clean = (list, prefix, extra) => list.slice(0, 8).map((s, i) => Object.assign({
            id: prefix + i,
            x: Number(s.x) || 0,
            z: Number(s.z) || 0,
            active: true
        }, extra(s)));
        lobby.pickupState = {
            weapons: clean(spots.weapons, 'w', s => ({ type: s.type === 'sniper' ? 'sniper' : 'shotgun' })),
            kits: clean(spots.kits, 'k', () => ({})),
            grenades: clean(spots.grenades, 'g', () => ({}))
        };
        io.to(mapName).emit('pickupState', lobby.pickupState);
    });

    socket.on('pickupTaken', (d) => {
        if (!lobby.pickupState || !d) return;
        const lists = { weapon: lobby.pickupState.weapons, kit: lobby.pickupState.kits, grenade: lobby.pickupState.grenades };
        const list = lists[d.kind];
        if (!list) return;
        const item = list.find(i => i.id === d.id);
        if (!item || !item.active) return;
        item.active = false;
        io.to(mapName).emit('pickupTaken', { kind: d.kind, id: d.id });
        setTimeout(() => {
            item.active = true;
            io.to(mapName).emit('pickupRespawn', { kind: d.kind, id: d.id });
        }, RESPAWN_MS[d.kind]);
    });

    socket.on('mountVehicle', (d) => {
        const v = d && lobby.vehicles[d.id];
        if (!v) return;
        if (v.riderId && v.riderId !== socket.id) { socket.emit('mountDenied', { id: d.id }); return; }
        v.riderId = socket.id;
        io.to(mapName).emit('vehicleChanged', { id: d.id, riderId: socket.id, x: null, z: null });
    });

    socket.on('dismountVehicle', (d) => {
        const v = d && lobby.vehicles[d.id];
        if (!v || v.riderId !== socket.id) return;
        v.riderId = null;
        v.x = Number(d.x) || 0;
        v.z = Number(d.z) || 0;
        io.to(mapName).emit('vehicleChanged', { id: d.id, riderId: null, x: v.x, z: v.z });
    });

    socket.on('restartMatch', () => {
        if (!lobby.matchRunning) startMatch(mapName);
        else socket.emit('matchStart', { msRemaining: Math.max(0, lobby.matchEndsAt - Date.now()) });
    });

    socket.on('setIdentity', (data) => {
        const p = lobby.players[socket.id];
        if (!p || !data) return;
        p.name = String(data.name || 'Operative').slice(0, MAX_NAME_CHARS);
        p.color = Number.isFinite(data.color) ? data.color : 0x00ffcc;
        p.visor = Number.isFinite(data.visor) ? data.visor : p.color;
        p.helmet = ['visor', 'full', 'scout'].includes(data.helmet) ? data.helmet : 'visor';
        p.armor = ['heavy', 'light', 'none'].includes(data.armor) ? data.armor : 'heavy';
        if (typeof data.emblem === 'string' && data.emblem.startsWith('data:image/') && data.emblem.length <= MAX_EMBLEM_CHARS) {
            p.emblem = data.emblem;
        } else {
            p.emblem = null;
        }
        io.to(mapName).emit('playerIdentity', {
            id: p.id, name: p.name, color: p.color, visor: p.visor, helmet: p.helmet, armor: p.armor, emblem: p.emblem
        });
    });

    socket.on('playerMovement', (data) => {
        if (!data || !lobby.players[socket.id]) return;
        const p = lobby.players[socket.id];
        p.x = Number(data.x) || 0;
        p.y = Number(data.y) || 0;
        p.z = Number(data.z) || 0;
        p.yaw = Number(data.yaw) || 0;
        socket.to(mapName).emit('playerMoved', { id: socket.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw });
    });

    socket.on('chat', (data) => {
        const p = lobby.players[socket.id];
        if (!p || !data) return;
        const now = Date.now();
        if (now - lastChatAt < 700) return;
        lastChatAt = now;
        const text = String(data.text || '').replace(/[<>]/g, '').trim().slice(0, 140);
        if (!text) return;
        io.to(mapName).emit('chat', { id: socket.id, name: p.name, text: text });
    });

    socket.on('hitPlayer', (hitData) => {
        if (!hitData || typeof hitData.targetId !== 'string') return;
        if (hitData.targetId === socket.id || !lobby.players[hitData.targetId]) return;
        const damage = Math.min(100, Math.max(0, Number(hitData.damage) || 0));
        io.to(hitData.targetId).emit('playerHit', {
            damage: damage,
            attackerId: socket.id,
            weapon: String(hitData.weapon || 'Unknown').slice(0, 12)
        });
    });

    socket.on('playerDied', (data) => {
        const victim = lobby.players[socket.id];
        if (!victim) return;
        const killer = data && typeof data.killerId === 'string' ? lobby.players[data.killerId] : null;
        if (lobby.matchRunning) {
            victim.deaths++;
            if (killer && killer !== victim) killer.kills++;
        }
        io.to(mapName).emit('playerDown', {
            victimId: socket.id,
            victimName: victim.name,
            killerId: killer ? killer.id : null,
            killerName: killer ? killer.name : null,
            weapon: data && data.weapon ? String(data.weapon).slice(0, 12) : 'Unknown'
        });
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected from', mapName, socket.id);
        // Anyone riding a vehicle gets off where they were
        const me = lobby.players[socket.id];
        VEHICLE_IDS.forEach(id => {
            const v = lobby.vehicles[id];
            if (v.riderId !== socket.id) return;
            v.riderId = null;
            v.x = me ? me.x : 0;
            v.z = me ? me.z : 0;
            io.to(mapName).emit('vehicleChanged', { id: id, riderId: null, x: v.x, z: v.z });
        });
        delete lobby.players[socket.id];
        io.to(mapName).emit('playerDisconnected', socket.id);
        if (Object.keys(lobby.players).length === 0) {
            // An empty lobby starts fresh: new pickup spots and no running match
            lobby.pickupState = null;
            lobby.matchRunning = false;
            clearTimeout(lobby.matchTimeout);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
