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

// Armour emblems are small pictures sent as text; keep them to a sensible size
const MAX_EMBLEM_CHARS = 40000;
const MAX_NAME_CHARS = 40;

// ---- MAP: everyone in an online game plays the same map (the first player's choice) ----
let serverMap = null;

// ---- PRESENCE: friend codes and who is online (a separate connection that doesn't join a game) ----
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const presenceNs = io.of('/presence');
const presenceCodes = {};   // code -> { name, sid }

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
    console.log('Player connected:', socket.id);
    let lastChatAt = 0;

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
        emblem: null,
        kills: 0,
        deaths: 0
    };

    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', players[socket.id]);
    if (serverMap) socket.emit('mapInfo', { map: serverMap });

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

    // Callsign, looks, armour emblem and map chosen on the start screen
    socket.on('setIdentity', (data) => {
        const p = players[socket.id];
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
        if (!serverMap && (data.map === 'og' || data.map === 'world')) {
            serverMap = data.map;
            io.emit('mapInfo', { map: serverMap });
        }
        io.emit('playerIdentity', {
            id: p.id, name: p.name, color: p.color, visor: p.visor, helmet: p.helmet, armor: p.armor, emblem: p.emblem
        });
    });

    // Position only: sending the whole player record (including emblems) would flood everyone's connection
    socket.on('playerMovement', (data) => {
        if (!data || !players[socket.id]) return;
        const p = players[socket.id];
        p.x = Number(data.x) || 0;
        p.y = Number(data.y) || 0;
        p.z = Number(data.z) || 0;
        p.yaw = Number(data.yaw) || 0;
        socket.broadcast.emit('playerMoved', { id: socket.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw });
    });

    // Text chat: everyone sees it. Short messages, and a short gap between them.
    socket.on('chat', (data) => {
        const p = players[socket.id];
        if (!p || !data) return;
        const now = Date.now();
        if (now - lastChatAt < 700) return;
        lastChatAt = now;
        const text = String(data.text || '').replace(/[<>]/g, '').trim().slice(0, 140);
        if (!text) return;
        io.emit('chat', { id: socket.id, name: p.name, text: text });
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
        if (Object.keys(players).length === 0) serverMap = null;   // an empty server can pick a new map
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
