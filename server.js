import express from "express";
import http from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";
import { UnoGame } from "./game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "uno-admin-123";
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, "public")));

// rooms[code] = {
//   code, players: Map(id -> {id,name,socketId,connected}),
//   adminSockets: Set, game: UnoGame|null
// }
const rooms = new Map();

function genCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

const connectedPlayers = (room) => [...room.players.values()].filter((p) => p.connected);

function roomPlayersList(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, connected: p.connected }));
}

// Send each connected player their personalized state; admins get the god view.
function broadcastState(room) {
  if (!room.game) return;
  for (const p of room.players.values()) {
    if (p.connected && p.socketId) io.to(p.socketId).emit("state", room.game.stateFor(p.id, false));
  }
  for (const sockId of room.adminSockets) {
    io.to(sockId).emit("state", room.game.stateFor(null, true));
  }
}

function broadcastLobby(room) {
  io.to(room.code).emit("lobby", {
    code: room.code,
    players: roomPlayersList(room),
    started: !!(room.game && room.game.started),
  });
}

function maybeCleanup(room) {
  if (connectedPlayers(room).length === 0 && room.adminSockets.size === 0) {
    rooms.delete(room.code);
  }
}

io.on("connection", (socket) => {
  let joined = null; // { code, role, id }

  socket.on("admin:create", ({ password }, cb) => {
    if (password !== ADMIN_PASSWORD) return cb?.({ ok: false, error: "Wrong admin password." });
    const code = genCode();
    const room = { code, players: new Map(), adminSockets: new Set(), game: null };
    rooms.set(code, room);
    room.adminSockets.add(socket.id);
    socket.join(code);
    joined = { code, role: "admin" };
    cb?.({ ok: true, code });
    broadcastLobby(room);
  });

  socket.on("admin:watch", ({ password, code }, cb) => {
    if (password !== ADMIN_PASSWORD) return cb?.({ ok: false, error: "Wrong admin password." });
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Room not found." });
    room.adminSockets.add(socket.id);
    socket.join(code);
    joined = { code, role: "admin" };
    cb?.({ ok: true, code });
    broadcastLobby(room);
    if (room.game) socket.emit("state", room.game.stateFor(null, true));
  });

  // Player joins OR reconnects by name.
  socket.on("player:join", ({ code, name }, cb) => {
    code = (code || "").toUpperCase().trim();
    name = (name || "").trim().slice(0, 20);
    if (!name) return cb?.({ ok: false, error: "Enter a name." });
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Invalid access code." });

    const existing = room.players.get(name);
    if (existing) {
      if (existing.connected) {
        return cb?.({ ok: false, error: "That name is already in use in this room." });
      }
      // Reconnect: reattach this socket to the existing seat.
      existing.connected = true;
      existing.socketId = socket.id;
      socket.join(code);
      joined = { code, role: "player", id: name };
      cb?.({ ok: true, code, id: name, reconnected: true });
      broadcastLobby(room);
      if (room.game) socket.emit("state", room.game.stateFor(name, false));
      return;
    }

    // New player — only allowed before the game starts.
    if (room.game && room.game.started && !room.game.gameOver) {
      return cb?.({ ok: false, error: "Game already running — wait for the next round." });
    }
    if (room.players.size >= 8) return cb?.({ ok: false, error: "Room is full (max 8)." });
    room.players.set(name, { id: name, name, socketId: socket.id, connected: true });
    socket.join(code);
    joined = { code, role: "player", id: name };
    cb?.({ ok: true, code, id: name });
    broadcastLobby(room);
  });

  // Anyone (admin or player) can start / restart.
  const startRound = (cb) => {
    if (!joined) return cb?.({ ok: false, error: "Join a room first." });
    const room = rooms.get(joined.code);
    if (!room) return cb?.({ ok: false, error: "Room gone." });
    const ids = connectedPlayers(room).map((p) => p.id);
    if (ids.length < 2) return cb?.({ ok: false, error: "Need at least 2 connected players." });
    room.game = new UnoGame(ids).start();
    cb?.({ ok: true });
    broadcastLobby(room);
    broadcastState(room);
  };
  socket.on("game:start", (_, cb) => {
    const room = joined && rooms.get(joined.code);
    if (room && room.game && room.game.started && !room.game.gameOver) {
      return cb?.({ ok: false, error: "Game already running." });
    }
    startRound(cb);
  });
  socket.on("game:restart", (_, cb) => startRound(cb));

  const withGame = (cb) => {
    if (!joined) return null;
    const room = rooms.get(joined.code);
    if (!room || !room.game) { cb?.({ ok: false, error: "No active game." }); return null; }
    return room;
  };

  socket.on("game:play", ({ cardId, color }, cb) => {
    const room = withGame(cb); if (!room) return;
    const r = room.game.playCard(joined.id, cardId, color);
    cb?.(r); if (r.ok) broadcastState(room);
  });
  socket.on("game:draw", (_, cb) => {
    const room = withGame(cb); if (!room) return;
    const r = room.game.drawCard(joined.id);
    cb?.(r); if (r.ok) broadcastState(room);
  });
  socket.on("game:challenge", (_, cb) => {
    const room = withGame(cb); if (!room) return;
    const r = room.game.challenge(joined.id);
    cb?.(r); if (r.ok) broadcastState(room);
  });
  socket.on("game:pass", (_, cb) => {
    const room = withGame(cb); if (!room) return;
    const r = room.game.pass(joined.id);
    cb?.(r); if (r.ok) broadcastState(room);
  });
  socket.on("game:uno", (_, cb) => {
    const room = withGame(cb); if (!room) return;
    const r = room.game.callUno(joined.id);
    cb?.(r); if (r.ok) broadcastState(room);
  });

  // ---- Admin god-powers ----
  const requireAdminGame = (cb) => {
    if (!joined || joined.role !== "admin") { cb?.({ ok: false, error: "Admin only." }); return null; }
    const room = rooms.get(joined.code);
    if (!room || !room.game) { cb?.({ ok: false, error: "No active game." }); return null; }
    return room;
  };
  socket.on("admin:setTop", (spec, cb) => {
    const room = requireAdminGame(cb); if (!room) return;
    const r = room.game.adminSetTopCard(spec || {});
    cb?.(r); if (r.ok) broadcastState(room);
  });
  socket.on("admin:giveCard", ({ playerId, card } = {}, cb) => {
    const room = requireAdminGame(cb); if (!room) return;
    const r = room.game.adminGiveCard(playerId, card || {});
    cb?.(r); if (r.ok) broadcastState(room);
  });
  socket.on("admin:removeCard", ({ playerId, cardId } = {}, cb) => {
    const room = requireAdminGame(cb); if (!room) return;
    const r = room.game.adminRemoveCard(playerId, cardId);
    cb?.(r); if (r.ok) broadcastState(room);
  });
  socket.on("admin:changeCard", ({ playerId, cardId, card } = {}, cb) => {
    const room = requireAdminGame(cb); if (!room) return;
    const r = room.game.adminChangeCard(playerId, cardId, card || {});
    cb?.(r); if (r.ok) broadcastState(room);
  });

  socket.on("disconnect", () => {
    if (!joined) return;
    const room = rooms.get(joined.code);
    if (!room) return;
    if (joined.role === "admin") {
      room.adminSockets.delete(socket.id);
    } else {
      const p = room.players.get(joined.id);
      if (p) {
        if (room.game && room.game.started && !room.game.gameOver) {
          // Keep their seat so they can reconnect with the same name.
          p.connected = false;
          p.socketId = null;
        } else {
          room.players.delete(joined.id); // lobby: free the slot
        }
      }
      broadcastLobby(room);
    }
    maybeCleanup(room);
  });
});

server.listen(PORT, () => {
  console.log(`UNO game running on http://localhost:${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD === "uno-admin-123" ? "uno-admin-123 (CHANGE via ADMIN_PASSWORD env var!)" : "(set via env)"}`);
});
