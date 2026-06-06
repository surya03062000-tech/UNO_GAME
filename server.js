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

const DISCONNECT_GRACE_MS = 30_000; // drop a player who doesn't return within 30s

const connectedPlayers = (room) => [...room.players.values()].filter((p) => p.connected);

function roomPlayersList(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, avatar: p.avatar, connected: p.connected,
  }));
}

// Map of id -> {name, avatar} so clients can show avatars during play.
function roomMeta(room) {
  const meta = {};
  for (const p of room.players.values()) meta[p.id] = { name: p.name, avatar: p.avatar };
  return meta;
}

function broadcastScores(room) {
  io.to(room.code).emit("scores", { scores: room.scores || {} });
}

// Record a finished round into the room's running scoreboard.
function recordScores(room) {
  const g = room.game;
  if (!g || !g.gameOver || g._recorded) return;
  g._recorded = true;
  room.scores = room.scores || {};
  const bump = (id, field) => {
    const s = (room.scores[id] = room.scores[id] || { name: id, games: 0, wins: 0, losses: 0, points: 0 });
    s[field] += 1;
  };
  const finished = g.finished || [];
  const eliminated = g.eliminated || [];
  const participants = new Set([...finished, ...eliminated]);
  if (g.loserId) participants.add(g.loserId);
  for (const id of participants) bump(id, "games");
  finished.forEach((id, i) => {
    if (i === 0) bump(id, "wins");
    // points: 1st gets most; scaled by placement
    const s = room.scores[id];
    s.points += Math.max(1, finished.length - i);
  });
  if (g.loserId) bump(g.loserId, "losses");
  for (const id of eliminated) bump(id, "losses");
  broadcastScores(room);
}

// Call after any state-broadcasting action to capture a just-finished round.
function afterAction(room) {
  broadcastState(room);
  if (room.game && room.game.gameOver) recordScores(room);
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
    meta: roomMeta(room),
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
    const room = { code, players: new Map(), adminSockets: new Set(), game: null, scores: {} };
    rooms.set(code, room);
    room.adminSockets.add(socket.id);
    socket.join(code);
    joined = { code, role: "admin" };
    cb?.({ ok: true, code });
    broadcastLobby(room);
    broadcastScores(room);
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
    broadcastScores(room);
    if (room.game) socket.emit("state", room.game.stateFor(null, true));
  });

  // Player joins OR reconnects by name.
  socket.on("player:join", ({ code, name, avatar } = {}, cb) => {
    code = (code || "").toUpperCase().trim();
    name = (name || "").trim().slice(0, 20);
    avatar = (avatar || "🙂").slice(0, 4);
    if (!name) return cb?.({ ok: false, error: "Enter a name." });
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Invalid access code." });

    const existing = room.players.get(name);
    if (existing) {
      // Reconnect / takeover. Claim the seat with the new socket FIRST, then
      // kick any stale socket — so its late disconnect can't clobber us
      // (the disconnect guard checks socketId, which now points to us).
      const staleId = existing.socketId && existing.socketId !== socket.id ? existing.socketId : null;
      if (existing.removalTimer) { clearTimeout(existing.removalTimer); existing.removalTimer = null; }
      existing.connected = true;
      existing.socketId = socket.id;
      if (staleId) { const old = io.sockets.sockets.get(staleId); if (old) old.disconnect(true); }
      if (avatar) existing.avatar = avatar;
      socket.join(code);
      joined = { code, role: "player", id: name };
      cb?.({ ok: true, code, id: name, reconnected: true });
      broadcastLobby(room);
      broadcastScores(room);
      if (room.game) socket.emit("state", room.game.stateFor(name, false));
      return;
    }

    // New player — only allowed before the game starts.
    if (room.game && room.game.started && !room.game.gameOver) {
      return cb?.({ ok: false, error: "Game already running — wait for the next round." });
    }
    if (room.players.size >= 8) return cb?.({ ok: false, error: "Room is full (max 8)." });
    room.players.set(name, { id: name, name, avatar, socketId: socket.id, connected: true, removalTimer: null });
    socket.join(code);
    joined = { code, role: "player", id: name };
    cb?.({ ok: true, code, id: name });
    broadcastLobby(room);
    broadcastScores(room);
  });

  // ---- Text chat ----
  socket.on("chat:send", ({ text } = {}) => {
    if (!joined) return;
    const room = rooms.get(joined.code);
    if (!room) return;
    text = String(text || "").trim().slice(0, 300);
    if (!text) return;
    let name = "Admin", avatar = "👑";
    if (joined.role === "player") {
      const p = room.players.get(joined.id);
      name = p?.name || joined.id;
      avatar = p?.avatar || "🙂";
    }
    io.to(room.code).emit("chat:msg", { name, avatar, text, ts: Date.now() });
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
    cb?.(r); if (r.ok) afterAction(room);
  });
  socket.on("game:draw", (_, cb) => {
    const room = withGame(cb); if (!room) return;
    const r = room.game.drawCard(joined.id);
    cb?.(r); if (r.ok) afterAction(room);
  });
  socket.on("game:challenge", (_, cb) => {
    const room = withGame(cb); if (!room) return;
    const r = room.game.challenge(joined.id);
    cb?.(r); if (r.ok) afterAction(room);
  });
  socket.on("game:pass", (_, cb) => {
    const room = withGame(cb); if (!room) return;
    const r = room.game.pass(joined.id);
    cb?.(r); if (r.ok) afterAction(room);
  });
  socket.on("game:uno", (_, cb) => {
    const room = withGame(cb); if (!room) return;
    const r = room.game.callUno(joined.id);
    cb?.(r); if (r.ok) afterAction(room);
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
    cb?.(r); if (r.ok) afterAction(room);
  });
  socket.on("admin:giveCard", ({ playerId, card } = {}, cb) => {
    const room = requireAdminGame(cb); if (!room) return;
    const r = room.game.adminGiveCard(playerId, card || {});
    cb?.(r); if (r.ok) afterAction(room);
  });
  socket.on("admin:removeCard", ({ playerId, cardId } = {}, cb) => {
    const room = requireAdminGame(cb); if (!room) return;
    const r = room.game.adminRemoveCard(playerId, cardId);
    cb?.(r); if (r.ok) afterAction(room);
  });
  socket.on("admin:changeCard", ({ playerId, cardId, card } = {}, cb) => {
    const room = requireAdminGame(cb); if (!room) return;
    const r = room.game.adminChangeCard(playerId, cardId, card || {});
    cb?.(r); if (r.ok) afterAction(room);
  });

  // ---- Voice chat signaling (WebRTC mesh) ----
  // room.voice = Map(socketId -> name). The joining peer initiates offers to
  // everyone already in the channel; we just relay SDP/ICE between peers.
  socket.on("voice:join", ({ name } = {}, cb) => {
    if (!joined) return cb?.({ ok: false, error: "Join a room first." });
    const room = rooms.get(joined.code);
    if (!room) return cb?.({ ok: false, error: "Room gone." });
    room.voice = room.voice || new Map();
    const peers = [...room.voice.entries()].map(([id, n]) => ({ id, name: n }));
    room.voice.set(socket.id, name || "Someone");
    // Tell the newcomer who's already here (they will initiate offers).
    cb?.({ ok: true, peers });
    // Tell existing peers a newcomer arrived (they wait for an offer).
    socket.to(joined.code).emit("voice:peer-joined", { id: socket.id, name: name || "Someone" });
  });

  socket.on("voice:signal", ({ to, data } = {}) => {
    if (!to) return;
    io.to(to).emit("voice:signal", { from: socket.id, data });
  });

  socket.on("voice:leave", () => {
    if (!joined) return;
    const room = rooms.get(joined.code);
    if (!room || !room.voice) return;
    room.voice.delete(socket.id);
    socket.to(joined.code).emit("voice:peer-left", { id: socket.id });
  });

  socket.on("disconnect", () => {
    if (!joined) return;
    const room = rooms.get(joined.code);
    if (!room) return;
    if (room.voice && room.voice.has(socket.id)) {
      room.voice.delete(socket.id);
      socket.to(joined.code).emit("voice:peer-left", { id: socket.id });
    }
    if (joined.role === "admin") {
      room.adminSockets.delete(socket.id);
    } else {
      const p = room.players.get(joined.id);
      // Guard against a reconnect race: if a newer socket already took this
      // seat, p.socketId won't match — ignore this stale disconnect.
      if (p && p.socketId === socket.id) {
        if (room.game && room.game.started && !room.game.gameOver) {
          // Keep their seat briefly so they can reconnect with the same name.
          p.connected = false;
          p.socketId = null;
          if (p.removalTimer) clearTimeout(p.removalTimer);
          p.removalTimer = setTimeout(() => {
            const cur = room.players.get(joined.id);
            if (!cur || cur.connected) return; // came back — nothing to do
            room.players.delete(joined.id);
            if (room.game && room.game.started && !room.game.gameOver) {
              room.game.removePlayer(joined.id);
              afterAction(room);
            }
            broadcastLobby(room);
            maybeCleanup(room);
          }, DISCONNECT_GRACE_MS);
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
