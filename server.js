import express from "express";
import http from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { UnoGame } from "./game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "uno-admin-123";
const PORT = process.env.PORT || 3000;

const DEFAULT_SETTINGS = {
  turnSeconds: 0,      // 0 = no turn timer
  startingHand: 7,
  stacking: true,
  drawToMatch: false,
  mercy: true,
  skipAll: true,
  unoCatch: true,
};

function sanitizeSettings(patch = {}) {
  const s = {};
  if (patch.turnSeconds !== undefined) s.turnSeconds = Math.max(0, Math.min(120, Number(patch.turnSeconds) || 0));
  if (patch.startingHand !== undefined) s.startingHand = Math.max(1, Math.min(15, Number(patch.startingHand) || 7));
  for (const k of ["stacking", "drawToMatch", "mercy", "skipAll", "unoCatch"]) {
    if (patch[k] !== undefined) s[k] = !!patch[k];
  }
  return s;
}

// ---- Simple JSON persistence (scores + meta + settings, keyed by room code) ----
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
let persistTimer = null;
function persist() {
  if (persistTimer) return; // debounce
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const out = {};
      for (const [code, room] of rooms) {
        if (Object.keys(room.scores || {}).length === 0 && (room.history || []).length === 0) continue;
        out[code] = { scores: room.scores, meta: room.meta || {}, settings: room.settings, history: room.history || [] };
      }
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(out));
    } catch (e) { console.error("persist failed:", e.message); }
  }, 800);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, "public")));

// rooms[code] = {
//   code, players: Map(id -> {id,name,socketId,connected}),
//   adminSockets: Set, game: UnoGame|null
// }
const rooms = new Map();

// Load any persisted rooms as dormant (no game/sockets, scores intact).
function loadStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const [code, r] of Object.entries(data)) {
      rooms.set(code, {
        code, players: new Map(), adminSockets: new Set(), game: null,
        scores: r.scores || {}, meta: r.meta || {}, history: r.history || [],
        settings: { ...DEFAULT_SETTINGS, ...(r.settings || {}) },
        turnTimer: null, turnDeadline: null, botTimer: null, lastActive: Date.now(), spectators: new Set(),
      });
    }
    console.log(`Loaded ${rooms.size} persisted room(s) from disk.`);
  } catch (e) { console.error("loadStore failed:", e.message); }
}
loadStore();

function genCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

const DISCONNECT_GRACE_MS = 30_000; // drop a player who doesn't return within 30s
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // dormant rooms expire after 24h
const BOT_DELAY_MS = 1100; // how long a bot "thinks" before acting

const connectedPlayers = (room) => [...room.players.values()].filter((p) => p.connected);
const humanConnected = (room) => [...room.players.values()].filter((p) => p.connected && !p.isBot);
const touch = (room) => { room.lastActive = Date.now(); };

let botSeq = 0;
function makeBot(room) {
  const names = ["Robo", "Chip", "Byte", "Ada", "Neo", "Pixel", "Echo", "Dot"];
  let name;
  do { name = "🤖 " + names[botSeq % names.length] + (botSeq >= names.length ? botSeq : ""); botSeq++; }
  while (room.players.has(name));
  return { id: name, name, avatar: "🤖", isBot: true, socketId: null, connected: true, removalTimer: null };
}

// If it's a bot's turn, schedule its move. Re-armed on every state broadcast.
function scheduleBots(room) {
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
  const g = room.game;
  if (!g || !g.started || g.gameOver) return;
  const cur = room.players.get(g.currentPlayerId);
  if (!cur || !cur.isBot) return;
  room.botTimer = setTimeout(() => {
    const game = room.game;
    if (!game || game.gameOver) return;
    const id = game.currentPlayerId;
    const p = room.players.get(id);
    if (!p || !p.isBot) return;
    game.autoMove(id);
    afterAction(room);
  }, BOT_DELAY_MS);
}

function roomPlayersList(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, avatar: p.avatar, connected: p.connected,
  }));
}

// Persistent id -> {name, avatar} map (kept even after a player leaves).
function updateMeta(room, p) {
  room.meta = room.meta || {};
  room.meta[p.id] = { name: p.name, avatar: p.avatar };
}
function roomMeta(room) { return room.meta || {}; }

// Arm/refresh the per-turn auto-play timer. On timeout the current player draws
// (and passes if needed) so a slow/away player can't stall the game.
function armTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  room.turnDeadline = null;
  const g = room.game;
  const secs = room.settings?.turnSeconds || 0;
  if (!g || !g.started || g.gameOver || secs <= 0) return;
  room.turnDeadline = Date.now() + secs * 1000;
  room.turnTimer = setTimeout(() => {
    const game = room.game;
    if (!game || game.gameOver) return;
    const cur = game.currentPlayerId;
    const r = game.drawCard(cur);
    if (r && r.canPlayDrawn) game.pass(cur);
    afterAction(room);
  }, secs * 1000 + 50);
}

function broadcastScores(room) {
  io.to(room.code).emit("scores", { scores: room.scores || {}, history: room.history || [] });
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
  // Round history (most recent first, capped).
  room.history = room.history || [];
  room.history.unshift({ ts: Date.now(), ranking: finished.slice(), eliminated: eliminated.slice(), loser: g.loserId });
  room.history = room.history.slice(0, 25);
  broadcastScores(room);
  persist();
}

// Call after any state-broadcasting action to capture a just-finished round.
function afterAction(room) {
  broadcastState(room);
  if (room.game && room.game.gameOver) recordScores(room);
}

// Send each connected player their personalized state; admins get the god view.
function broadcastState(room) {
  if (!room.game) return;
  touch(room);
  armTurnTimer(room);
  scheduleBots(room);
  const extra = { turnDeadline: room.turnDeadline, turnSeconds: room.settings?.turnSeconds || 0 };
  for (const p of room.players.values()) {
    if (p.connected && p.socketId) io.to(p.socketId).emit("state", { ...room.game.stateFor(p.id, false, p.peekId), ...extra });
  }
  for (const sockId of room.adminSockets) {
    io.to(sockId).emit("state", { ...room.game.stateFor(null, true), ...extra });
  }
  // Spectators get the public view (counts only, no hands).
  for (const sockId of (room.spectators || [])) {
    io.to(sockId).emit("state", { ...room.game.stateFor(null, false), spectator: true, ...extra });
  }
}

function broadcastLobby(room) {
  touch(room);
  io.to(room.code).emit("lobby", {
    code: room.code,
    players: roomPlayersList(room),
    meta: roomMeta(room),
    settings: room.settings,
    started: !!(room.game && room.game.started),
  });
}

function maybeCleanup(room) {
  // A room is dormant when no humans and no admins are connected (bots don't count).
  if (humanConnected(room).length === 0 && room.adminSockets.size === 0) {
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
    // Drop the live game + bots; keep scores/history for the code if any.
    room.game = null;
    for (const [id, p] of [...room.players]) if (p.isBot) room.players.delete(id);
    if (Object.keys(room.scores || {}).length === 0 && (room.history || []).length === 0) {
      rooms.delete(room.code);
    }
    persist();
  }
}

// Periodically expire dormant rooms that haven't been touched in a long time.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of [...rooms]) {
    if (humanConnected(room).length === 0 && room.adminSockets.size === 0 &&
        now - (room.lastActive || 0) > ROOM_TTL_MS) {
      if (room.turnTimer) clearTimeout(room.turnTimer);
      if (room.botTimer) clearTimeout(room.botTimer);
      rooms.delete(code);
    }
  }
  persist();
}, 30 * 60 * 1000);

// Mild profanity filter (replace with asterisks). Extend the list as needed.
const BAD_WORDS = ["fuck", "shit", "bitch", "asshole", "bastard", "dick", "cunt", "pussy"];
const BAD_RE = new RegExp(`\\b(${BAD_WORDS.join("|")})\\b`, "gi");
const cleanText = (t) => String(t || "").replace(BAD_RE, (m) => "*".repeat(m.length));

io.on("connection", (socket) => {
  // Simple per-socket rate limiter: returns true if the action is allowed.
  const rl = {};
  function allow(key, perSec) {
    const now = Date.now();
    const win = rl[key] || (rl[key] = []);
    while (win.length && now - win[0] > 1000) win.shift();
    if (win.length >= perSec) return false;
    win.push(now);
    return true;
  }

  let joined = null; // { code, role, id }

  socket.on("admin:create", ({ password }, cb) => {
    if (password !== ADMIN_PASSWORD) return cb?.({ ok: false, error: "Wrong admin password." });
    const code = genCode();
    const room = {
      code, players: new Map(), adminSockets: new Set(), game: null,
      scores: {}, meta: {}, history: [], settings: { ...DEFAULT_SETTINGS },
      turnTimer: null, turnDeadline: null, botTimer: null, lastActive: Date.now(), spectators: new Set(),
    };
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
      updateMeta(room, existing);
      socket.join(code);
      joined = { code, role: "player", id: name };
      cb?.({ ok: true, code, id: name, reconnected: true });
      broadcastLobby(room);
      broadcastScores(room);
      persist();
      if (room.game) socket.emit("state", room.game.stateFor(name, false));
      return;
    }

    // New player — only allowed before the game starts.
    if (room.game && room.game.started && !room.game.gameOver) {
      return cb?.({ ok: false, error: "Game already running — wait for the next round." });
    }
    if (room.players.size >= 8) return cb?.({ ok: false, error: "Room is full (max 8)." });
    const entry = { id: name, name, avatar, socketId: socket.id, connected: true, removalTimer: null };
    room.players.set(name, entry);
    updateMeta(room, entry);
    socket.join(code);
    joined = { code, role: "player", id: name };
    cb?.({ ok: true, code, id: name });
    broadcastLobby(room);
    broadcastScores(room);
    persist();
  });

  // Resolve the display name/avatar for the current connection.
  const identify = (room) => {
    if (joined?.role === "player") {
      const p = room.players.get(joined.id);
      return { name: p?.name || joined.id, avatar: p?.avatar || "🙂" };
    }
    if (joined?.role === "spectator") return { name: joined.name || "Spectator", avatar: "👁️" };
    return { name: "Admin", avatar: "👑" };
  };

  // ---- Text chat ----
  socket.on("chat:send", ({ text } = {}) => {
    if (!joined) return;
    if (!allow("chat", 2)) return; // max 2 messages/sec
    const room = rooms.get(joined.code);
    if (!room) return;
    text = cleanText(String(text || "").trim().slice(0, 300));
    if (!text) return;
    const { name, avatar } = identify(room);
    io.to(room.code).emit("chat:msg", { name, avatar, text, ts: Date.now() });
  });

  // ---- Emoji reactions ----
  socket.on("react", ({ emoji } = {}) => {
    if (!joined) return;
    if (!allow("react", 3)) return;
    const room = rooms.get(joined.code);
    if (!room) return;
    const allowed = ["👍", "😂", "🔥", "😮", "👏", "❤️", "😎", "😭"];
    if (!allowed.includes(emoji)) return;
    const { name } = identify(room);
    io.to(room.code).emit("reaction", { name, emoji });
  });

  // ---- Eliminated/finished player peeks at one player's hand ----
  socket.on("game:peek", ({ targetId } = {}, cb) => {
    if (!joined || joined.role !== "player") return cb?.({ ok: false });
    const room = rooms.get(joined.code);
    if (!room || !room.game) return cb?.({ ok: false });
    const me = room.players.get(joined.id);
    if (me) { me.peekId = targetId || null; broadcastState(room); }
    cb?.({ ok: true });
  });

  // Anyone (admin or player) can start / restart.
  const startRound = (cb) => {
    if (!joined) return cb?.({ ok: false, error: "Join a room first." });
    const room = rooms.get(joined.code);
    if (!room) return cb?.({ ok: false, error: "Room gone." });
    const ids = connectedPlayers(room).map((p) => p.id);
    if (ids.length < 2) return cb?.({ ok: false, error: "Need at least 2 connected players." });
    room.game = new UnoGame(ids, room.settings || DEFAULT_SETTINGS).start();
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

  // Admin updates the room's rule settings (only when no game is running).
  socket.on("admin:settings", (patch, cb) => {
    if (!joined || joined.role !== "admin") return cb?.({ ok: false, error: "Admin only." });
    const room = rooms.get(joined.code);
    if (!room) return cb?.({ ok: false, error: "Room gone." });
    if (room.game && room.game.started && !room.game.gameOver) {
      return cb?.({ ok: false, error: "Finish the current round before changing rules." });
    }
    room.settings = { ...DEFAULT_SETTINGS, ...room.settings, ...sanitizeSettings(patch || {}) };
    cb?.({ ok: true, settings: room.settings });
    broadcastLobby(room);
    persist();
  });

  // Admin adds/removes AI bot players (only before a game is running).
  socket.on("admin:addBot", (_, cb) => {
    if (!joined || joined.role !== "admin") return cb?.({ ok: false, error: "Admin only." });
    const room = rooms.get(joined.code);
    if (!room) return cb?.({ ok: false, error: "Room gone." });
    if (room.game && room.game.started && !room.game.gameOver) return cb?.({ ok: false, error: "Can't add bots mid-game." });
    if (room.players.size >= 8) return cb?.({ ok: false, error: "Room is full (max 8)." });
    const bot = makeBot(room);
    room.players.set(bot.id, bot);
    updateMeta(room, bot);
    cb?.({ ok: true });
    broadcastLobby(room);
  });
  socket.on("admin:removeBot", ({ playerId } = {}, cb) => {
    if (!joined || joined.role !== "admin") return cb?.({ ok: false, error: "Admin only." });
    const room = rooms.get(joined.code);
    if (!room) return cb?.({ ok: false, error: "Room gone." });
    const p = room.players.get(playerId);
    if (!p || !p.isBot) return cb?.({ ok: false, error: "Not a bot." });
    room.players.delete(playerId);
    if (room.game && room.game.started && !room.game.gameOver) { room.game.removePlayer(playerId); afterAction(room); }
    cb?.({ ok: true });
    broadcastLobby(room);
  });

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
  socket.on("game:catch", ({ targetId } = {}, cb) => {
    const room = withGame(cb); if (!room) return;
    const by = joined.role === "player" ? joined.id : "Admin";
    const r = room.game.catchUno(targetId, by);
    cb?.(r); if (r.ok) afterAction(room);
  });

  // Remove a player from a room (out of any running game too).
  function dropPlayer(room, playerId) {
    const p = room.players.get(playerId);
    if (p && p.removalTimer) { clearTimeout(p.removalTimer); p.removalTimer = null; }
    room.players.delete(playerId);
    if (room.game && room.game.started && !room.game.gameOver) {
      room.game.removePlayer(playerId);
      afterAction(room);
    }
    broadcastLobby(room);
    maybeCleanup(room);
  }

  // Join a room as a watch-only spectator (sees the table, not the hands).
  socket.on("player:spectate", ({ code, name } = {}, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Invalid access code." });
    room.spectators = room.spectators || new Set();
    room.spectators.add(socket.id);
    socket.join(code);
    joined = { code, role: "spectator", name: (name || "Spectator").slice(0, 20) };
    cb?.({ ok: true, code });
    broadcastLobby(room);
    broadcastScores(room);
    if (room.game) socket.emit("state", {
      ...room.game.stateFor(null, false), spectator: true,
      turnDeadline: room.turnDeadline, turnSeconds: room.settings?.turnSeconds || 0,
    });
  });

  // A player / admin / spectator leaves the room voluntarily.
  socket.on("room:leave", (_, cb) => {
    if (!joined) return cb?.({ ok: false });
    const room = rooms.get(joined.code);
    if (!room) { joined = null; return cb?.({ ok: true }); }
    if (joined.role === "admin") {
      room.adminSockets.delete(socket.id);
      socket.leave(room.code);
      maybeCleanup(room);
    } else if (joined.role === "spectator") {
      room.spectators?.delete(socket.id);
      socket.leave(room.code);
      maybeCleanup(room);
    } else {
      socket.leave(room.code);
      dropPlayer(room, joined.id);
    }
    joined = null;
    cb?.({ ok: true });
  });

  // Admin kicks a player out of the room.
  socket.on("admin:kick", ({ playerId } = {}, cb) => {
    if (!joined || joined.role !== "admin") return cb?.({ ok: false, error: "Admin only." });
    const room = rooms.get(joined.code);
    if (!room) return cb?.({ ok: false, error: "Room gone." });
    const p = room.players.get(playerId);
    if (!p) return cb?.({ ok: false, error: "No such player." });
    if (p.socketId) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) { s.emit("kicked"); s.leave(room.code); }
    }
    dropPlayer(room, playerId);
    cb?.({ ok: true });
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
    } else if (joined.role === "spectator") {
      room.spectators?.delete(socket.id);
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
