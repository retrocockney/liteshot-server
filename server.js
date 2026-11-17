"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// ---------- config ----------

const PORT = Number(process.env.PORT) || 3000;
const MAP_IDS = ["og", "mini", "house"];
const CUSTOM_ID_RE = /^custom-[a-f0-9]{8}$/;
const MAX_CUSTOM_MAP_OBJECTS = 3000;
const MAX_CUSTOM_MAP_BYTES = 750000;
const MAX_PLAYERS_PER_ROOM = 64;
const MAX_PICKUP_SPOTS = 300;

const MATCH_MS = 5 * 60 * 1000;
const MATCH_BREAK_MS = 10 * 1000;
const MAX_HP = 100;
const RESPAWN_MS = 2500;
const PICKUP_RESPAWN_MS = 20 * 1000;

// ---------- state ----------

// mapName -> { players, vehicles, pickups, takenPickups, match }
const rooms = new Map();
// customRoomId -> { hostSocketId, level, publishedAt }
const customMapRooms = new Map();

// ---------- app setup ----------

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e6,
  pingTimeout: 30000,
  pingInterval: 25000
});

// ---------- helpers ----------

function obj(value) {
  return value && typeof value === "object" ? value : {};
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanMap(value) {
  if (typeof value === "string") {
    if (MAP_IDS.includes(value)) return value;
    if (CUSTOM_ID_RE.test(value)) return value;
  }
  return "og";
}

function isCustom(mapName) {
  return mapName.startsWith("custom-");
}

function cleanName(value) {
  if (typeof value !== "string") return "Player";
  return value.replace(/[<>]/g, "").trim().slice(0, 20) || "Player";
}

function cleanColor(value) {
  const color = Number(value);
  return Number.isFinite(color) ? color >>> 0 : 0x00ffcc;
}

function getRoom(mapName) {
  let room = rooms.get(mapName);
  if (!room) {
    room = {
      players: new Map(),
      vehicles: new Map(),
      pickups: null,
      takenPickups: new Map(),
      match: null
    };
    rooms.set(mapName, room);
  }
  return room;
}

function newPlayer(id, mapName) {
  return {
    id,
    map: mapName,
    name: "Player",
    color: 0x00ffcc,
    visor: null,
    helmet: null,
    armor: null,
    emblem: null,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    hp: MAX_HP,
    kills: 0,
    deaths: 0,
    alive: true,
    announced: false,
    respawnTimer: null,
    vehicleId: null
  };
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    visor: p.visor,
    helmet: p.helmet,
    armor: p.armor,
    emblem: p.emblem,
    map: p.map,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    hp: p.hp,
    kills: p.kills,
    deaths: p.deaths,
    alive: p.alive
  };
}

// Returns { mapName, room, me } for a connected, registered socket, or null.
function ctxOf(socket) {
  const mapName = socket.data.mapName;
  const room = rooms.get(mapName);
  const me = room && room.players.get(socket.id);
  return room && me ? { mapName, room, me } : null;
}

// Wrap a handler so an exception in one event never takes the server down.
function safe(name, fn) {
  return (...args) => {
    try {
      fn(...args);
    } catch (err) {
      console.error(`Handler "${name}" failed:`, err);
    }
  };
}

function pickupKey(kind, id) {
  return `${String(kind)}|${String(id)}`;
}

function releaseVehicleOf(mapName, room, socketId) {
  for (const v of room.vehicles.values()) {
    if (v.riderId === socketId) {
      v.riderId = null;
      io.to(mapName).emit("vehicleChanged", { ...v });
    }
  }
}

// ---------- match ----------

function startMatch(mapName) {
  const room = rooms.get(mapName);
  if (!room || room.match) return;

  room.match = {
    endsAt: Date.now() + MATCH_MS,
    timer: setTimeout(() => endMatch(mapName), MATCH_MS),
    breakTimer: null
  };
  io.to(mapName).emit("matchStart", { msRemaining: MATCH_MS });
}

function endMatch(mapName) {
  const room = rooms.get(mapName);
  if (!room || !room.match) return;

  clearTimeout(room.match.timer);
  room.match = null;

  const scores = [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, kills: p.kills, deaths: p.deaths }))
    .sort((a, b) => b.kills - a.kills);

  io.to(mapName).emit("matchEnd", { scores });

  for (const p of room.players.values()) {
    p.kills = 0;
    p.deaths = 0;
    p.hp = MAX_HP;
    p.alive = true;
  }

  // Break between matches, then start the next one if anyone is still here.
  const breakTimer = setTimeout(() => {
    const current = rooms.get(mapName);
    if (current && current.players.size > 0 && !current.match) {
      startMatch(mapName);
    }
  }, MATCH_BREAK_MS);
  room.breakTimer = breakTimer;
}

function stopRoomTimers(room) {
  if (room.match) {
    clearTimeout(room.match.timer);
    room.match = null;
  }
  if (room.breakTimer) {
    clearTimeout(room.breakTimer);
    room.breakTimer = null;
  }
}

// ---------- combat ----------

function killPlayer(mapName, room, victim, killer, weapon) {
  victim.alive = false;
  victim.hp = 0;
  victim.deaths += 1;
  killer.kills += 1;

  releaseVehicleOf(mapName, room, victim.id);

  io.to(mapName).emit("playerDown", {
    victimId: victim.id,
    killerId: killer.id,
    victimName: victim.name,
    killerName: killer.name,
    weapon
  });

  clearTimeout(victim.respawnTimer);
  victim.respawnTimer = setTimeout(() => {
    victim.alive = true;
    victim.hp = MAX_HP;
    victim.respawnTimer = null;
  }, RESPAWN_MS);
}

// ---------- custom maps ----------

function safeLevel(level) {
  if (
    !level ||
    typeof level !== "object" ||
    !Array.isArray(level.objects) ||
    level.objects.length > MAX_CUSTOM_MAP_OBJECTS
  ) {
    return null;
  }

  const objects = [];
  for (const o of level.objects) {
    if (!o || typeof o !== "object") continue;
    const vehicle = o.vehicle == null ? null : Math.max(0, Math.min(2, num(o.vehicle)));
    objects.push({
      x: num(o.x),
      z: num(o.z),
      type: Math.max(0, Math.min(5, num(o.type))),
      color: cleanColor(o.color ?? 0x4488ff),
      vehicle,
      rotation: num(o.rotation)
    });
  }

  const result = {
    name: String(level.name || "Custom Level").slice(0, 80),
    arenaSize: Math.max(60, Math.min(1200, num(level.arenaSize, 300))),
    objects
  };

  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  return bytes <= MAX_CUSTOM_MAP_BYTES ? result : null;
}

// ---------- HTTP ----------

app.get("/", (req, res) => {
  res.status(200).send("LiteShot multiplayer server is running.");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    game: "LiteShot",
    players: io.engine.clientsCount,
    rooms: rooms.size,
    hostedCustomMaps: customMapRooms.size
  });
});

// ---------- sockets ----------

io.on("connection", (socket) => {
  const mapName = cleanMap(socket.handshake.query?.map);

  const existing = rooms.get(mapName);
  if (existing && existing.players.size >= MAX_PLAYERS_PER_ROOM) {
    socket.emit("serverFull", { map: mapName });
    socket.disconnect(true);
    return;
  }

  const room = getRoom(mapName);
  socket.data.mapName = mapName;
  socket.data.playerName = "Player";
  socket.join(mapName);
  room.players.set(socket.id, newPlayer(socket.id, mapName));

  function sendCustomMap() {
    if (!isCustom(mapName)) return;
    const published = customMapRooms.get(mapName);
    if (published) {
      socket.emit("customMapData", { roomId: mapName, level: published.level });
    } else {
      socket.emit("customMapMissing", { roomId: mapName });
    }
  }
  sendCustomMap();

  socket.on("requestCustomMap", safe("requestCustomMap", (data) => {
    const roomId = obj(data).roomId || mapName;
    if (roomId !== mapName || !isCustom(roomId)) return;
    sendCustomMap();
  }));

  socket.on("hostCustomMap", safe("hostCustomMap", (data) => {
    const d = obj(data);
    if (!isCustom(mapName) || d.roomId !== mapName) return;

    const level = safeLevel(d.level);
    if (!level) {
      socket.emit("customMapHostError", { reason: "Invalid map or map exceeds the size limit." });
      return;
    }

    const current = customMapRooms.get(mapName);
    if (current && current.hostSocketId !== socket.id) {
      socket.emit("customMapHostError", { reason: "Another player is hosting this map." });
      return;
    }

    customMapRooms.set(mapName, { hostSocketId: socket.id, level, publishedAt: Date.now() });
    socket.emit("customMapHostAck", { roomId: mapName });
    socket.to(mapName).emit("customMapData", { roomId: mapName, level });
  }));

  // First call announces the player to the room; later calls update identity.
  socket.on("setIdentity", safe("setIdentity", (data) => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const { room: r, me } = ctx;
    const d = obj(data);

    Object.assign(me, {
      name: cleanName(d.name),
      color: cleanColor(d.color),
      visor: d.visor ?? null,
      helmet: d.helmet ?? null,
      armor: d.armor ?? null,
      emblem: d.emblem ?? null
    });
    socket.data.playerName = me.name;

    if (!me.announced) {
      me.announced = true;

      const others = {};
      for (const [id, p] of r.players) {
        if (id !== socket.id) others[id] = publicPlayer(p);
      }
      socket.emit("currentPlayers", others);
      socket.to(mapName).emit("newPlayer", publicPlayer(me));

      socket.emit("vehicleStates", [...r.vehicles.values()]);

      if (r.pickups) {
        socket.emit("pickupState", r.pickups);
        for (const t of r.takenPickups.values()) {
          socket.emit("pickupTaken", { kind: t.kind, id: t.id });
        }
      } else {
        socket.emit("requestPickupSpots");
      }

      if (r.match) {
        socket.emit("matchStart", {
          msRemaining: Math.max(0, r.match.endsAt - Date.now())
        });
      } else {
        startMatch(mapName);
      }
    } else {
      io.to(mapName).emit("playerIdentity", publicPlayer(me));
    }
  }));

  socket.on("playerMovement", safe("playerMovement", (data) => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const d = obj(data);
    const { me } = ctx;

    me.x = num(d.x);
    me.y = num(d.y);
    me.z = num(d.z);
    me.yaw = num(d.yaw);

    socket.to(mapName).emit("playerMoved", {
      id: me.id,
      x: me.x,
      y: me.y,
      z: me.z,
      yaw: me.yaw
    });
  }));

  socket.on("hitPlayer", safe("hitPlayer", (data) => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const d = obj(data);
    const { room: r, me } = ctx;

    const target = r.players.get(String(d.targetId));
    if (!target || target.id === me.id || !target.alive || !me.alive) return;

    const damage = Math.max(0, Math.min(MAX_HP, num(d.damage)));
    if (damage <= 0) return;

    const weapon = String(d.weapon || "Unknown").slice(0, 20);

    target.hp = Math.max(0, target.hp - damage);
    io.to(target.id).emit("playerHit", { damage, attackerId: me.id, weapon });

    if (target.hp <= 0) killPlayer(mapName, r, target, me, weapon);
  }));

  // Deaths are decided server-side in hitPlayer; client reports are ignored.
  socket.on("playerDied", () => {});

  socket.on("restartMatch", safe("restartMatch", () => {
    if (!ctxOf(socket)) return;
    startMatch(mapName);
  }));

  socket.on("chat", safe("chat", (data) => {
    const ctx = ctxOf(socket);
    if (!ctx) return;

    const raw = typeof data === "string" ? data : obj(data).text ?? obj(data).message;
    if (typeof raw !== "string") return;

    const text = raw.replace(/[<>]/g, "").trim().slice(0, 140);
    if (!text) return;

    io.to(mapName).emit("chat", {
      id: socket.id,
      name: ctx.me.name,
      text,
      time: Date.now()
    });
  }));

  // First player in a room supplies the pickup spot list.
  socket.on("pickupSpots", safe("pickupSpots", (spots) => {
    const ctx = ctxOf(socket);
    if (!ctx || ctx.room.pickups || !Array.isArray(spots)) return;

    ctx.room.pickups = spots
      .filter((s) => s && typeof s === "object")
      .slice(0, MAX_PICKUP_SPOTS);
    ctx.room.takenPickups.clear();
    io.to(mapName).emit("pickupState", ctx.room.pickups);
  }));

  socket.on("pickupTaken", safe("pickupTaken", (data) => {
    const ctx = ctxOf(socket);
    if (!ctx || !ctx.room.pickups) return;

    const d = obj(data);
    if (d.kind == null || d.id == null) return;

    const exists = ctx.room.pickups.some(
      (p) => p.kind === d.kind && String(p.id) === String(d.id)
    );
    if (!exists) return;

    const key = pickupKey(d.kind, d.id);
    if (ctx.room.takenPickups.has(key)) return;

    const r = ctx.room;
    r.takenPickups.set(key, { kind: d.kind, id: d.id });
    socket.to(mapName).emit("pickupTaken", { kind: d.kind, id: d.id });

    setTimeout(() => {
      if (rooms.get(mapName) !== r) return;
      r.takenPickups.delete(key);
      io.to(mapName).emit("pickupRespawn", { kind: d.kind, id: d.id });
    }, PICKUP_RESPAWN_MS);
  }));

  // One rider per vehicle.
  socket.on("mountVehicle", safe("mountVehicle", (data) => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const { room: r, me } = ctx;

    const rawId = obj(data).id;
    if (rawId == null) return;
    const key = String(rawId);

    let v = r.vehicles.get(key);
    if (!v) {
      v = { id: rawId, riderId: null, x: 0, z: 0 };
      r.vehicles.set(key, v);
    }

    if (v.riderId && v.riderId !== socket.id) {
      socket.emit("mountDenied", { id: rawId });
      return;
    }

    releaseVehicleOf(mapName, r, socket.id);
    v.riderId = socket.id;
    me.vehicleId = key;
    io.to(mapName).emit("vehicleChanged", { ...v });
  }));

  socket.on("dismountVehicle", safe("dismountVehicle", (data) => {
    const ctx = ctxOf(socket);
    if (!ctx) return;
    const { room: r } = ctx;
    const d = obj(data);

    const v = r.vehicles.get(String(d.id));
    if (!v || v.riderId !== socket.id) return;

    v.riderId = null;
    v.x = num(d.x, v.x);
    v.z = num(d.z, v.z);
    ctx.me.vehicleId = null;
    io.to(mapName).emit("vehicleChanged", { ...v });
  }));

  socket.on("disconnect", () => {
    try {
      const r = rooms.get(mapName);

      if (r) {
        const me = r.players.get(socket.id);
        if (me) clearTimeout(me.respawnTimer);

        releaseVehicleOf(mapName, r, socket.id);
        r.players.delete(socket.id);

        socket.to(mapName).emit("playerDisconnected", socket.id);

        if (r.players.size === 0) {
          stopRoomTimers(r);

          if (MAP_IDS.includes(mapName)) {
            // Fixed maps persist, but reset their shared state.
            r.pickups = null;
            r.takenPickups.clear();
            r.vehicles.clear();
          } else {
            rooms.delete(mapName);
          }
        }
      }

      if (isCustom(mapName)) {
        const published = customMapRooms.get(mapName);
        if (published && published.hostSocketId === socket.id) {
          customMapRooms.delete(mapName);
          socket.to(mapName).emit("customMapMissing", { roomId: mapName });
        }
      }

      console.log("Player disconnected:", socket.id, "from", mapName);
    } catch (err) {
      console.error("Disconnect cleanup failed:", err);
    }
  });
});

// ---------- startup and shutdown ----------

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LiteShot server listening on port ${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  for (const room of rooms.values()) stopRoomTimers(room);
  io.close(() => {
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
