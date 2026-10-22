
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e6
});

const PORT = process.env.PORT || 3000;
const MAP_IDS = ["og", "mini", "house"];
const MAX_CUSTOM_MAP_OBJECTS = 3000;
const MAX_CUSTOM_MAP_BYTES = 750000;
const MAX_PLAYERS_PER_ROOM = 64;

const lobbies = new Map();
const customMapRooms = new Map();

function cleanMap(value) {
  if (MAP_IDS.includes(value)) return value;

  if (
    typeof value === "string" &&
    /^custom-[a-f0-9]{8}$/.test(value)
  ) {
    return value;
  }

  return "og";
}

function newLobby() {
  return {
    players: new Map(),
    createdAt: Date.now()
  };
}

function getLobby(mapName) {
  if (!lobbies.has(mapName)) {
    lobbies.set(mapName, newLobby());
  }

  return lobbies.get(mapName);
}

function cleanName(value) {
  if (typeof value !== "string") return "Player";
  return value.replace(/[<>]/g, "").trim().slice(0, 20) || "Player";
}

function cleanColor(value) {
  const color = Number(value);
  return Number.isFinite(color) ? color >>> 0 : 0x00ffcc;
}

function safeLevel(level) {
  if (
    !level ||
    typeof level !== "object" ||
    !Array.isArray(level.objects) ||
    level.objects.length > MAX_CUSTOM_MAP_OBJECTS
  ) {
    return null;
  }

  const result = {
    name: String(level.name || "Custom Level").slice(0, 80),
    arenaSize: Math.max(
      60,
      Math.min(1200, Number(level.arenaSize) || 300)
    ),
    objects: level.objects.map((object) => ({
      x: Number.isFinite(Number(object?.x)) ? Number(object.x) : 0,
      z: Number.isFinite(Number(object?.z)) ? Number(object.z) : 0,
      type: Math.max(0, Math.min(5, Number(object?.type) || 0)),
      color: Number.isFinite(Number(object?.color))
        ? Number(object.color) >>> 0
        : 0x4488ff,
      vehicle: object?.vehicle == null
        ? null
        : Math.max(0, Math.min(2, Number(object.vehicle) || 0)),
      rotation: Number.isFinite(Number(object?.rotation))
        ? Number(object.rotation)
        : 0
    }))
  };

  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");

  return bytes <= MAX_CUSTOM_MAP_BYTES ? result : null;
}

app.get("/", (req, res) => {
  res.status(200).send("LiteShot multiplayer server is running.");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    game: "LiteShot",
    players: io.engine.clientsCount,
    rooms: lobbies.size,
    hostedCustomMaps: customMapRooms.size
  });
});

io.on("connection", (socket) => {
  const requestedMap = socket.handshake.query?.map;
  const mapName = cleanMap(requestedMap);
  const lobby = getLobby(mapName);

  if (lobby.players.size >= MAX_PLAYERS_PER_ROOM) {
    socket.emit("serverFull", { map: mapName });
    socket.disconnect(true);
    return;
  }

  socket.data.mapName = mapName;
  socket.data.playerName = "Player";
  socket.data.identity = {};
  socket.join(mapName);

  function sendCustomMap() {
    if (!mapName.startsWith("custom-")) return;

    const published = customMapRooms.get(mapName);

    if (published) {
      socket.emit("customMapData", {
        roomId: mapName,
        level: published.level
      });
    } else {
      socket.emit("customMapMissing", { roomId: mapName });
    }
  }

  function sendPlayerList() {
    socket.emit("playerList", Array.from(lobby.players.values()));

    socket.to(mapName).emit("playerJoined", {
      id: socket.id,
      ...lobby.players.get(socket.id)
    });
  }

  sendCustomMap();

  socket.on("requestCustomMap", (data) => {
    const roomId = data?.roomId || mapName;

    if (roomId !== mapName || !roomId.startsWith("custom-")) return;

    sendCustomMap();
  });

  socket.on("hostCustomMap", (data) => {
    if (
      !mapName.startsWith("custom-") ||
      data?.roomId !== mapName
    ) {
      return;
    }

    const level = safeLevel(data.level);

    if (!level) {
      socket.emit("customMapHostError", {
        reason: "Invalid map or map exceeds the size limit."
      });
      return;
    }

    const existing = customMapRooms.get(mapName);

    if (existing && existing.hostSocketId !== socket.id) {
      socket.emit("customMapHostError", {
        reason: "Another player is hosting this map."
      });
      return;
    }

    customMapRooms.set(mapName, {
      hostSocketId: socket.id,
      level,
      publishedAt: Date.now()
    });

    socket.emit("customMapHostAck", { roomId: mapName });

    socket.to(mapName).emit("customMapData", {
      roomId: mapName,
      level
    });

    console.log("Custom map hosted:", mapName);
  });

  socket.on("setIdentity", (data = {}) => {
    const identity = {
      name: cleanName(data.name),
      color: cleanColor(data.color),
      visor: data.visor ?? null,
      helmet: data.helmet ?? null,
      armor: data.armor ?? null,
      emblem: data.emblem ?? null,
      map: mapName
    };

    socket.data.playerName = identity.name;
    socket.data.identity = identity;

    lobby.players.set(socket.id, {
      id: socket.id,
      ...identity
    });

    socket.emit("playerList", Array.from(lobby.players.values()));

    socket.to(mapName).emit("playerJoined", {
      id: socket.id,
      ...identity
    });

    socket.to(mapName).emit("playerUpdate", {
      id: socket.id,
      ...identity
    });
  });

  socket.on("disconnect", () => {
    lobby.players.delete(socket.id);

    socket.to(mapName).emit("playerLeft", {
      id: socket.id
    });

    if (mapName.startsWith("custom-")) {
      const published = customMapRooms.get(mapName);

      if (published?.hostSocketId === socket.id) {
        customMapRooms.delete(mapName);

        socket.to(mapName).emit("customMapMissing", {
          roomId: mapName
        });

        console.log("Custom map host disconnected:", mapName);
      }
    }

    if (lobby.players.size === 0 && !MAP_IDS.includes(mapName)) {
      lobbies.delete(mapName);
    }

    console.log("Player disconnected:", socket.id, "from", mapName);
  });

  // Basic chat relay. Keep messages short and reject empty messages.
  socket.on("chatMessage", (data) => {
    const message = typeof data === "string" ? data : data?.message;

    if (typeof message !== "string") return;

    const text = message.replace(/[<>]/g, "").trim().slice(0, 140);
    if (!text) return;

    io.to(mapName).emit("chatMessage", {
      id: socket.id,
      name: socket.data.playerName,
      message: text,
      time: Date.now()
    });
  });

  // Generic relay for game events. Only relay to players in the same map room.
  // This does not replace server-authoritative combat or match logic.
  const relayEvents = [
    "playerMove",
    "playerUpdate",
    "playerShoot",
    "shoot",
    "playerHit",
    "playerDied",
    "playerRespawn",
    "kill",
    "grenadeThrow",
    "pickupTaken",
    "pickupUpdate",
    "vehicleUpdate",
    "vehicleEnter",
    "vehicleExit",
    "gameState",
    "ctfUpdate",
    "flagUpdate",
    "scoreUpdate"
  ];

  for (const eventName of relayEvents) {
    socket.on(eventName, (data) => {
      if (data == null || typeof data !== "object") return;

      socket.to(mapName).emit(eventName, {
        ...data,
        id: socket.id
      });
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LiteShot server listening on port ${PORT}`);
});
