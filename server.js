
const express = require('express');
const app = express();
const path = require('path');
const http = require('http').createServer(app);

// ---- LITESHOT web updater: Version 51 ----
// Keep LITESHOT_latest.html beside this file in the Render deployment.
const GAME_VERSION = 51;
const LATEST_GAME_FILE = path.join(__dirname, 'LITESHOT_latest.html');

function setUpdateHeaders(res, contentType) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate'
    );
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (contentType) {
        res.setHeader('Content-Type', contentType);
    }
}

app.options('/updates/:file', (req, res) => {
    setUpdateHeaders(res);
    res.status(204).end();
});

app.get('/updates/version.json', (req, res) => {
    setUpdateHeaders(res, 'application/json; charset=utf-8');
    res.json({ game: 'LITESHOT', version: GAME_VERSION });
});

app.get('/updates/latest.html', (req, res) => {
    setUpdateHeaders(res, 'text/html; charset=utf-8');

    res.sendFile(LATEST_GAME_FILE, (err) => {
        if (err && !res.headersSent) {
            res.status(503)
                .type('text/plain')
                .send('LITESHOT update file is not installed on the server yet.');
        }
    });
});

const io = require('socket.io')(http, {
    cors: { origin: '*' }
});

const MAX_EMBLEM_CHARS = 40000;
const MAX_NAME_CHARS = 40;
const MATCH_MS = 5 * 60 * 1000;

const RESPAWN_MS = {
    weapon: 20000,
    kit: 12000,
    grenade: 15000
};

const VEHICLE_IDS = ['v0', 'v1', 'v2', 'v3'];

function newLobby() {
    const vehicles = {};

    VEHICLE_IDS.forEach(id => {
        vehicles[id] = {
            riderId: null,
            x: null,
            z: null
        };
    });

    return {
        players: {},
        matchRunning: false,
        matchEndsAt: 0,
        matchTimeout: null,
        pickupState: null,
        vehicles,
        damagePairs: new Set()
    };
}

const lobbies = {
    og: newLobby(),
    mini: newLobby()
};

function scoreList(lobby) {
    return Object.values(lobby.players)
        .map(p => ({
            id: p.id,
            name: p.name,
            kills: p.kills,
            deaths: p.deaths
        }))
        .sort((a, b) =>
            (b.kills - a.kills) || (a.deaths - b.deaths)
        );
}

function startMatch(mapName) {
    const lobby = lobbies[mapName];

    lobby.damagePairs.clear();

    for (const id in lobby.players) {
        lobby.players[id].kills = 0;
        lobby.players[id].deaths = 0;
    }

    lobby.matchRunning = true;
    lobby.matchEndsAt = Date.now() + MATCH_MS;

    clearTimeout(lobby.matchTimeout);

    lobby.matchTimeout = setTimeout(
        () => endMatch(mapName),
        MATCH_MS
    );

    io.to(mapName).emit('matchStart', {
        msRemaining: MATCH_MS
    });
}

function endMatch(mapName) {
    const lobby = lobbies[mapName];

    lobby.matchRunning = false;
    clearTimeout(lobby.matchTimeout);

    io.to(mapName).emit('matchEnd', {
        scores: scoreList(lobby)
    });
}

// ---- Presence / friend codes ----
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const presenceNs = io.of('/presence');
const presenceCodes = Object.create(null);
const knownProfiles = Object.create(null);

function cleanCode(value) {
    return typeof value === 'string'
        ? value.trim().toUpperCase()
        : '';
}

function emitFriendStatuses() {
    presenceNs.emit('presenceChanged', {
        at: Date.now()
    });
}

presenceNs.on('connection', (s) => {
    let myCode = null;

    s.on('hello', (d) => {
        if (!d) return;

        const code = cleanCode(d.code);

        if (!CODE_RE.test(code)) {
            s.emit('helloError', {
                reason: 'Invalid friend code. Codes must be 6 valid characters.'
            });
            return;
        }

        if (
            myCode &&
            presenceCodes[myCode] &&
            presenceCodes[myCode].sid === s.id
        ) {
            delete presenceCodes[myCode];
        }

        myCode = code;

        const previous = knownProfiles[code] || {};

        const name = String(
            d.name || previous.name || 'Operative'
        ).trim().slice(0, MAX_NAME_CHARS) || 'Operative';

        const map = d.map === 'mini' ? 'mini' : 'og';

        knownProfiles[code] = { code, name, map };

        presenceCodes[code] = {
            code,
            name,
            sid: s.id,
            map,
            inOnline:
                d.online === true ||
                d.online === 1 ||
                d.online === 'true',
            lastSeen: Date.now()
        };

        s.emit('helloAck', { code, name });
        emitFriendStatuses();
    });

    s.on('query', (codes) => {
        if (!Array.isArray(codes)) return;

        const list = codes
            .map(cleanCode)
            .filter(code => CODE_RE.test(code))
            .slice(0, 50)
            .map(code => {
                const live = presenceCodes[code];
                const profile = knownProfiles[code];

                return {
                    code,
                    found: !!profile,
                    name: live
                        ? live.name
                        : (profile ? profile.name : null),
                    online: !!live,
                    map: live
                        ? live.map
                        : (profile ? profile.map : null),
                    inOnline: live ? !!live.inOnline : false,
                    lastSeen: live ? live.lastSeen : null
                };
            });

        s.emit('status', list);
    });

    s.on('activity', (d) => {
        if (
            !myCode ||
            !presenceCodes[myCode] ||
            presenceCodes[myCode].sid !== s.id
        ) {
            return;
        }

        presenceCodes[myCode].inOnline = !!(d && d.online);

        if (d && (d.map === 'mini' || d.map === 'og')) {
            presenceCodes[myCode].map = d.map;
        }

        presenceCodes[myCode].lastSeen = Date.now();

        const profile = knownProfiles[myCode];
        if (profile) {
            profile.map = presenceCodes[myCode].map;
        }

        emitFriendStatuses();
    });

    s.on('invite', (d) => {
        const to = cleanCode(d && d.to);
        const me = myCode ? presenceCodes[myCode] : null;
        const target = CODE_RE.test(to) ? presenceCodes[to] : null;

        if (!me || !me.inOnline) {
            s.emit('inviteResult', {
                to,
                ok: false,
                reason: 'Start a PVP game first'
            });
            return;
        }

        if (!target) {
            s.emit('inviteResult', {
                to,
                ok: false,
                reason: 'That friend is offline'
            });
            return;
        }

        presenceNs.to(target.sid).emit('invited', {
            from: myCode,
            name: me.name,
            map: me.map
        });

        s.emit('inviteResult', { to, ok: true });
    });

    s.on('disconnect', () => {
        if (
            myCode &&
            presenceCodes[myCode] &&
            presenceCodes[myCode].sid === s.id
        ) {
            delete presenceCodes[myCode];
            emitFriendStatuses();
        }
    });
});

// ---- Multiplayer ----
io.on('connection', (socket) => {
    const mapName =
        socket.handshake.query &&
        socket.handshake.query.map === 'mini'
            ? 'mini'
            : 'og';

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

    socket.emit(
        'vehicleStates',
        VEHICLE_IDS.map(id =>
            Object.assign({ id }, lobby.vehicles[id])
        )
    );

    socket.to(mapName).emit(
        'newPlayer',
        lobby.players[socket.id]
    );

    if (
        !lobby.matchRunning &&
        Object.keys(lobby.players).length === 1
    ) {
        startMatch(mapName);
    } else if (lobby.matchRunning) {
        socket.emit('matchStart', {
            msRemaining: Math.max(
                0,
                lobby.matchEndsAt - Date.now()
            )
        });
    } else {
        socket.emit('matchEnd', {
            scores: scoreList(lobby)
        });
    }

    if (lobby.pickupState) {
        socket.emit('pickupState', lobby.pickupState);
    } else {
        socket.emit('requestPickupSpots');
    }

    socket.on('pickupSpots', (spots) => {
        if (
            lobby.pickupState ||
            !spots ||
            !Array.isArray(spots.weapons) ||
            !Array.isArray(spots.kits) ||
            !Array.isArray(spots.grenades)
        ) {
            return;
        }

        const clean = (list, prefix, extra) =>
            list.slice(0, 8).map((item, i) =>
                Object.assign({
                    id: prefix + i,
                    x: Number(item.x) || 0,
                    z: Number(item.z) || 0,
                    active: true
                }, extra(item))
            );

        lobby.pickupState = {
            weapons: clean(
                spots.weapons,
                'w',
                item => ({
                    type: item.type === 'sniper'
                        ? 'sniper'
                        : 'shotgun'
                })
            ),
            kits: clean(spots.kits, 'k', () => ({})),
            grenades: clean(spots.grenades, 'g', () => ({}))
        };

        io.to(mapName).emit(
            'pickupState',
            lobby.pickupState
        );
    });

    socket.on('pickupTaken', (d) => {
        if (!lobby.pickupState || !d) return;

        const lists = {
            weapon: lobby.pickupState.weapons,
            kit: lobby.pickupState.kits,
            grenade: lobby.pickupState.grenades
        };

        const list = lists[d.kind];
        if (!list) return;

        const item = list.find(i => i.id === d.id);
        if (!item || !item.active) return;

        item.active = false;

        io.to(mapName).emit('pickupTaken', {
            kind: d.kind,
            id: d.id
        });

        setTimeout(() => {
            item.active = true;

            io.to(mapName).emit('pickupRespawn', {
                kind: d.kind,
                id: d.id
            });
        }, RESPAWN_MS[d.kind]);
    });

    socket.on('mountVehicle', (d) => {
        const vehicle = d && lobby.vehicles[d.id];
        if (!vehicle) return;

        if (vehicle.riderId && vehicle.riderId !== socket.id) {
            socket.emit('mountDenied', { id: d.id });
            return;
        }

        vehicle.riderId = socket.id;

        io.to(mapName).emit('vehicleChanged', {
            id: d.id,
            riderId: socket.id,
            x: null,
            z: null
        });
    });

    socket.on('dismountVehicle', (d) => {
        const vehicle = d && lobby.vehicles[d.id];

        if (!vehicle || vehicle.riderId !== socket.id) return;

        vehicle.riderId = null;
        vehicle.x = Number(d.x) || 0;
        vehicle.z = Number(d.z) || 0;

        io.to(mapName).emit('vehicleChanged', {
            id: d.id,
            riderId: null,
            x: vehicle.x,
            z: vehicle.z
        });
    });

    socket.on('restartMatch', () => {
        if (!lobby.matchRunning) {
            startMatch(mapName);
        } else {
            socket.emit('matchStart', {
                msRemaining: Math.max(
                    0,
                    lobby.matchEndsAt - Date.now()
                )
            });
        }
    });

    socket.on('setIdentity', (data) => {
        const player = lobby.players[socket.id];
        if (!player || !data) return;

        player.name = String(
            data.name || 'Operative'
        ).slice(0, MAX_NAME_CHARS);

        player.color = Number.isFinite(data.color)
            ? data.color
            : 0x00ffcc;

        player.visor = Number.isFinite(data.visor)
            ? data.visor
            : player.color;

        player.helmet = ['visor', 'full', 'scout'].includes(data.helmet)
            ? data.helmet
            : 'visor';

        player.armor = ['heavy', 'light', 'none'].includes(data.armor)
            ? data.armor
            : 'heavy';

        if (
            typeof data.emblem === 'string' &&
            data.emblem.startsWith('data:image/') &&
            data.emblem.length <= MAX_EMBLEM_CHARS
        ) {
            player.emblem = data.emblem;
        } else {
            player.emblem = null;
        }

        io.to(mapName).emit('playerIdentity', {
            id: player.id,
            name: player.name,
            color: player.color,
            visor: player.visor,
            helmet: player.helmet,
            armor: player.armor,
            emblem: player.emblem
        });
    });

    socket.on('playerMovement', (data) => {
        if (!data || !lobby.players[socket.id]) return;

        const player = lobby.players[socket.id];
        player.x = Number(data.x) || 0;
        player.y = Number(data.y) || 0;
        player.z = Number(data.z) || 0;
        player.yaw = Number(data.yaw) || 0;

        socket.to(mapName).emit('playerMoved', {
            id: socket.id,
            x: player.x,
            y: player.y,
            z: player.z,
            yaw: player.yaw
        });
    });

    socket.on('chat', (data) => {
        const player = lobby.players[socket.id];
        if (!player || !data) return;

        const now = Date.now();
        if (now - lastChatAt < 700) return;
        lastChatAt = now;

        const text = String(data.text || '')
            .replace(/[<>]/g, '')
            .trim()
            .slice(0, 140);

        if (!text) return;

        io.to(mapName).emit('chat', {
            id: socket.id,
            name: player.name,
            text
        });
    });

    // ---- Existing stealth-attack rule ----
    socket.on('hitPlayer', (hitData) => {
        if (!hitData || typeof hitData.targetId !== 'string') return;

        if (
            hitData.targetId === socket.id ||
            !lobby.players[hitData.targetId]
        ) {
            return;
        }

        const targetId = hitData.targetId;
        const weapon = String(
            hitData.weapon || 'Unknown'
        ).slice(0, 12);

        const isFirearm = [
            'Rifle',
            'Pistol',
            'Shotgun',
            'Sniper'
        ].includes(weapon);

        const targetHasHitAttacker =
            lobby.damagePairs.has(`${targetId}->${socket.id}`);

        const stealthAttack =
            isFirearm && !targetHasHitAttacker;

        const normalDamage = Math.min(
            100,
            Math.max(0, Number(hitData.damage) || 0)
        );

        const damage = stealthAttack ? 100 : normalDamage;

        lobby.damagePairs.add(`${socket.id}->${targetId}`);

        io.to(targetId).emit('playerHit', {
            damage,
            attackerId: socket.id,
            weapon,
            stealthAttack
        });

        if (stealthAttack) {
            socket.emit('stealthAttackLanded', {
                targetId,
                targetName: lobby.players[targetId].name,
                weapon
            });
        }
    });

    socket.on('playerDied', (data) => {
        const victim = lobby.players[socket.id];
        if (!victim) return;

        const killer =
            data && typeof data.killerId === 'string'
                ? lobby.players[data.killerId]
                : null;

        if (lobby.matchRunning) {
            victim.deaths++;

            if (killer && killer !== victim) {
                killer.kills++;
            }
        }

        io.to(mapName).emit('playerDown', {
            victimId: socket.id,
            victimName: victim.name,
            killerId: killer ? killer.id : null,
            killerName: killer ? killer.name : null,
            weapon:
                data && data.weapon
                    ? String(data.weapon).slice(0, 12)
                    : 'Unknown'
        });
    });

    socket.on('disconnect', () => {
        console.log(
            'Player disconnected from',
            mapName,
            socket.id
        );

        const me = lobby.players[socket.id];

        VEHICLE_IDS.forEach(id => {
            const vehicle = lobby.vehicles[id];
            if (vehicle.riderId !== socket.id) return;

            vehicle.riderId = null;
            vehicle.x = me ? me.x : 0;
            vehicle.z = me ? me.z : 0;

            io.to(mapName).emit('vehicleChanged', {
                id,
                riderId: null,
                x: vehicle.x,
                z: vehicle.z
            });
        });

        delete lobby.players[socket.id];

        for (const pair of lobby.damagePairs) {
            if (
                pair.startsWith(`${socket.id}->`) ||
                pair.endsWith(`->${socket.id}`)
            ) {
                lobby.damagePairs.delete(pair);
            }
        }

        io.to(mapName).emit(
            'playerDisconnected',
            socket.id
        );

        if (Object.keys(lobby.players).length === 0) {
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
