import express from "express";
import http from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";
import { UnoGame } from "./game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Admin password — change via env var ADMIN_PASSWORD before deploying!
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "uno-admin-123";
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ---- In-memory room store -------------------------------------------------
// rooms[code] = {
//   code, hostSocketId, players: Map(socketId -> {name, id}),
//   game: UnoGame | null, adminSockets: Set, started: bool
// }
const rooms = new Map();

function genCode() {
  // 5-char easy-to-read access code (no confusing chars)
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () =>
      alphabet[crypto.randomInt(alphabet.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function roomPlayersList(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, name: p.name }));
}

// Send each connected player their personalized game state.
function broadcastState(room) {
  if (!room.game) return;
  for (const [sockId, p] of room.players) {
    io.to(sockId).emit("state", room.game.stateFor(p.id, false));
  }
  // Admins / spectators get the god view (all hands revealed).
  for (const sockId of room.adminSockets) {
    io.to(sockId).emit("state", room.game.stateFor(null, true));
  }
}

function broadcastLobby(room) {
  const payload = {
    code: room.code,
    players: roomPlayersList(room),
    started: !!(room.game && room.game.started),
  };
  io.to(room.code).emit("lobby", payload);
}

io.on("connection", (socket) => {
  let joined = null; // { code, role: 'player'|'admin', id }

  // ---- Admin creates a room ----
  socket.on("admin:create", ({ password }, cb) => {
    if (password !== ADMIN_PASSWORD) {
      return cb?.({ ok: false, error: "Wrong admin password." });
    }
    const code = genCode();
    const room = {
      code,
      players: new Map(),
      adminSockets: new Set(),
      game: null,
    };
    rooms.set(code, room);
    room.adminSockets.add(socket.id);
    socket.join(code);
    joined = { code, role: "admin" };
    cb?.({ ok: true, code });
    broadcastLobby(room);
  });

  // ---- Admin re-attaches to an existing room (e.g. refresh) ----
  socket.on("admin:watch", ({ password, code }, cb) => {
    if (password !== ADMIN_PASSWORD) {
      return cb?.({ ok: false, error: "Wrong admin password." });
    }
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Room not found." });
    room.adminSockets.add(socket.id);
    socket.join(code);
    joined = { code, role: "admin" };
    cb?.({ ok: true, code });
    broadcastLobby(room);
    if (room.game) socket.emit("state", room.game.stateFor(null, true));
  });

  // ---- Player joins with an access code ----
  socket.on("player:join", ({ code, name }, cb) => {
    code = (code || "").toUpperCase().trim();
    name = (name || "").trim().slice(0, 20) || "Player";
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Invalid access code." });
    if (room.game && room.game.started) {
      return cb?.({ ok: false, error: "Game already started — ask admin for a new room." });
    }
    if (room.players.size >= 8) {
      return cb?.({ ok: false, error: "Room is full (max 8)." });
    }
    const id = name + "#" + socket.id.slice(0, 4);
    room.players.set(socket.id, { name, id });
    socket.join(code);
    joined = { code, role: "player", id };
    cb?.({ ok: true, code, id });
    broadcastLobby(room);
  });

  // ---- Anyone (admin or player) can start the game ----
  socket.on("game:start", (_, cb) => {
    if (!joined) return cb?.({ ok: false, error: "Join a room first." });
    const room = rooms.get(joined.code);
    if (!room) return cb?.({ ok: false, error: "Room gone." });
    if (room.game && room.game.started && !room.game.gameOver) {
      return cb?.({ ok: false, error: "Game already running." });
    }
    if (room.players.size < 2) {
      return cb?.({ ok: false, error: "Need at least 2 players." });
    }
    const ids = [...room.players.values()].map((p) => p.id);
    room.game = new UnoGame(ids).start();
    cb?.({ ok: true });
    broadcastLobby(room);
    broadcastState(room);
  });

  // ---- Gameplay actions ----
  const withGame = (cb) => {
    if (!joined) return null;
    const room = rooms.get(joined.code);
    if (!room || !room.game) {
      cb?.({ ok: false, error: "No active game." });
      return null;
    }
    return room;
  };

  socket.on("game:play", ({ cardId, color }, cb) => {
    const room = withGame(cb);
    if (!room) return;
    const r = room.game.playCard(joined.id, cardId, color);
    cb?.(r);
    if (r.ok) broadcastState(room);
  });

  socket.on("game:draw", (_, cb) => {
    const room = withGame(cb);
    if (!room) return;
    const r = room.game.drawCard(joined.id);
    cb?.(r);
    if (r.ok) broadcastState(room);
  });

  socket.on("game:pass", (_, cb) => {
    const room = withGame(cb);
    if (!room) return;
    const r = room.game.pass(joined.id);
    cb?.(r);
    if (r.ok) broadcastState(room);
  });

  socket.on("game:uno", (_, cb) => {
    const room = withGame(cb);
    if (!room) return;
    const r = room.game.callUno(joined.id);
    cb?.(r);
    if (r.ok) broadcastState(room);
  });

  // ---- Anyone can restart (new deal, same players) ----
  socket.on("game:restart", (_, cb) => {
    if (!joined) return cb?.({ ok: false, error: "Join a room first." });
    const room = rooms.get(joined.code);
    if (!room || room.players.size < 2) {
      return cb?.({ ok: false, error: "Need at least 2 players." });
    }
    const ids = [...room.players.values()].map((p) => p.id);
    room.game = new UnoGame(ids).start();
    cb?.({ ok: true });
    broadcastLobby(room);
    broadcastState(room);
  });

  // ---- Admin god-powers: edit the board / players' hands ----
  const requireAdminGame = (cb) => {
    if (!joined || joined.role !== "admin") {
      cb?.({ ok: false, error: "Admin only." });
      return null;
    }
    const room = rooms.get(joined.code);
    if (!room || !room.game) {
      cb?.({ ok: false, error: "No active game." });
      return null;
    }
    return room;
  };

  socket.on("admin:setTop", (spec, cb) => {
    const room = requireAdminGame(cb);
    if (!room) return;
    const r = room.game.adminSetTopCard(spec || {});
    cb?.(r);
    if (r.ok) broadcastState(room);
  });

  socket.on("admin:giveCard", ({ playerId, card } = {}, cb) => {
    const room = requireAdminGame(cb);
    if (!room) return;
    const r = room.game.adminGiveCard(playerId, card || {});
    cb?.(r);
    if (r.ok) broadcastState(room);
  });

  socket.on("admin:removeCard", ({ playerId, cardId } = {}, cb) => {
    const room = requireAdminGame(cb);
    if (!room) return;
    const r = room.game.adminRemoveCard(playerId, cardId);
    cb?.(r);
    if (r.ok) broadcastState(room);
  });

  socket.on("disconnect", () => {
    if (!joined) return;
    const room = rooms.get(joined.code);
    if (!room) return;
    if (joined.role === "admin") {
      room.adminSockets.delete(socket.id);
    } else {
      room.players.delete(socket.id);
      broadcastLobby(room);
    }
    // Clean up empty rooms (no players and no admins watching).
    if (room.players.size === 0 && room.adminSockets.size === 0) {
      rooms.delete(room.code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`UNO game running on http://localhost:${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD === "uno-admin-123" ? "uno-admin-123 (CHANGE THIS via ADMIN_PASSWORD env var!)" : "(set via env)"}`);
});
