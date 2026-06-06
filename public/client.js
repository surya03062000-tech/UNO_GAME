const socket = io();

let me = { role: null, id: null, code: null, avatar: "🙂" };
let lastState = null;
let pendingWildCardId = null;
let cardEdit = null; // {pid, cid} card being edited in the admin modal
let prevTopId = null, prevMyTurn = false, prevOver = false; // for sound cues
let playerMeta = {}; // id -> {name, avatar}
const avatarFor = (id) => (playerMeta[id] && playerMeta[id].avatar) || "🙂";

const $ = (id) => document.getElementById(id);
const show = (screenId) => {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(screenId).classList.add("active");
};
const colorClass = (c) => ({ red: "c-red", yellow: "c-yellow", green: "c-green", blue: "c-blue", wild: "c-wild" }[c] || "c-wild");

const DRAW_AMOUNT = { draw2: 2, draw6: 6, draw8: 8, draw10: 10, wild4: 4 };
const drawAmount = (card) => (card ? DRAW_AMOUNT[card.kind] || 0 : 0);

const KIND_LABELS = {
  number: (c) => String(c.value), skip: () => "⊘", reverse: () => "⇄",
  draw2: () => "+2", draw6: () => "+6", draw8: () => "+8", draw10: () => "+10",
  wild: () => "W", wild4: () => "+4", skipAll: () => "Ø",
};
const cardSymbol = (card) => (KIND_LABELS[card.kind] || (() => "?"))(card);
function cardInner(card) {
  const s = cardSymbol(card);
  return `<span class="corner tl">${s}</span><span class="oval"><span>${s}</span></span><span class="corner br">${s}</span>`;
}

// ---- Avatar picker ----
const AVATARS = ["🙂", "😎", "🤠", "🐱", "🐶", "🦊", "🐵", "🐼", "🦁", "🐸", "🐙", "🦄", "👻", "🤖", "🐲", "⭐"];
let chosenAvatar = localStorage.getItem("uno_avatar") || AVATARS[Math.floor(Math.random() * AVATARS.length)];
function buildAvatarPicker() {
  const wrap = $("avatarPick");
  wrap.innerHTML = "";
  AVATARS.forEach((a) => {
    const b = document.createElement("div");
    b.className = "avatar-opt" + (a === chosenAvatar ? " sel" : "");
    b.textContent = a;
    b.onclick = () => {
      chosenAvatar = a;
      localStorage.setItem("uno_avatar", a);
      wrap.querySelectorAll(".avatar-opt").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
    };
    wrap.appendChild(b);
  });
}
buildAvatarPicker();

// ---- Remember session for refresh / reconnect -------------------------------
const SAVE_KEY = "uno_session";
function saveSession() {
  if (me.role === "player" && me.code && me.id) {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ code: me.code, name: me.id, avatar: me.avatar }));
  }
}
function clearSession() { localStorage.removeItem(SAVE_KEY); }
function tryAutoReconnect() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return;
  try {
    const { code, name, avatar } = JSON.parse(raw);
    if (!code || !name) return;
    $("joinName").value = name;
    $("joinCode").value = code;
    socket.emit("player:join", { code, name, avatar: avatar || chosenAvatar }, (res) => {
      if (res.ok) { me = { role: "player", id: res.id, code: res.code, avatar: avatar || chosenAvatar }; showChat(); enterLobby(); }
      else clearSession();
    });
  } catch { clearSession(); }
}

// ================= HOME =================
$("joinBtn").onclick = () => {
  SFX.unlock();
  const name = $("joinName").value.trim();
  const code = $("joinCode").value.trim().toUpperCase();
  if (!name || !code) return setErr("Enter your name and the access code.");
  socket.emit("player:join", { code, name, avatar: chosenAvatar }, (res) => {
    if (!res.ok) return setErr(res.error);
    me = { role: "player", id: res.id, code: res.code, avatar: chosenAvatar };
    saveSession();
    showChat();
    enterLobby();
  });
};
$("createBtn").onclick = () => {
  SFX.unlock();
  const password = $("adminPass").value;
  if (!password) return setErr("Enter admin password.");
  socket.emit("admin:create", { password }, (res) => {
    if (!res.ok) return setErr(res.error);
    me = { role: "admin", code: res.code, avatar: "👑" }; showChat(); enterLobby();
  });
};
$("watchBtn").onclick = () => {
  const password = $("adminPass").value;
  const code = $("watchCode").value.trim().toUpperCase();
  if (!password || !code) return setErr("Enter admin password and room code.");
  socket.emit("admin:watch", { password, code }, (res) => {
    if (!res.ok) return setErr(res.error);
    me = { role: "admin", code: res.code, avatar: "👑" }; showChat(); enterLobby();
  });
};
function setErr(msg) { $("homeError").textContent = msg || ""; }

// ================= LOBBY =================
function enterLobby() { show("lobby"); $("lobbyCode").textContent = me.code; }
$("copyCode").onclick = () => {
  navigator.clipboard?.writeText(me.code);
  $("copyCode").textContent = "Copied!";
  setTimeout(() => ($("copyCode").textContent = "Copy"), 1200);
};
$("startBtn").onclick = () => socket.emit("game:start", {}, (res) => { if (!res.ok) $("lobbyMsg").textContent = res.error; });

socket.on("lobby", (data) => {
  if (data.code !== me.code) return;
  if (data.meta) playerMeta = data.meta;
  const ul = $("playerList");
  ul.innerHTML = "";
  data.players.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="avatar">${p.avatar || "🙂"}</span> ${p.name}${p.connected ? "" : " <em>(offline)</em>"}`;
    if (!p.connected) li.style.opacity = ".5";
    ul.appendChild(li);
  });
  const online = data.players.filter((p) => p.connected).length;
  const ready = online >= 2;
  $("startBtn").disabled = !ready;
  $("startBtn").style.opacity = ready ? "1" : ".5";
  $("lobbyMsg").textContent = ready ? "Ready! Anyone can press Start." : "Waiting for at least 2 players…";
});

// ---- Scoreboard ----
let latestScores = {};
socket.on("scores", ({ scores }) => { latestScores = scores || {}; renderScores(); });
function renderScores() {
  const rows = Object.values(latestScores).sort((a, b) => b.points - a.points || b.wins - a.wins);
  const html = rows.length
    ? `<tr><th>Player</th><th>W</th><th>L</th><th>Games</th><th>Pts</th></tr>` +
      rows.map((s) => `<tr><td>${avatarFor(s.name)} ${s.name}</td><td>${s.wins}</td><td>${s.losses}</td><td>${s.games}</td><td>${s.points}</td></tr>`).join("")
    : `<tr><td class="score-empty" colspan="5">No games finished yet.</td></tr>`;
  ["lobbyScores", "gameScores"].forEach((id) => { const el = $(id); if (el) el.innerHTML = html; });
}

// ================= GAME =================
socket.on("state", (state) => { lastState = state; show("game"); renderGame(state); });

function renderGame(s) {
  const isAdmin = me.role === "admin";
  $("roleBadge").textContent = isAdmin ? "👑 Admin" : "Player";
  const meP = s.players.find((p) => p.id === me.id);
  const iAmFinished = meP && (meP.finished || meP.eliminated);
  const myTurn = !isAdmin && !iAmFinished && s.currentPlayerId === me.id && !s.gameOver;

  const banner = $("turnBanner");
  banner.classList.toggle("my-turn", myTurn);
  if (s.gameOver) banner.textContent = "🏁 Game over";
  else if (isAdmin) banner.textContent = `Turn: ${shortName(s.currentPlayerId)}`;
  else if (meP && meP.eliminated) banner.textContent = "💀 Eliminated — watching…";
  else if (meP && meP.finished) banner.textContent = `✅ You finished #${meP.place}! Watching…`;
  else banner.textContent = myTurn ? "🎯 Your turn!" : `Turn: ${shortName(s.currentPlayerId)}`;

  // Next player + pending draw pill
  let nextTxt = s.gameOver ? "" : `Next: ${shortName(s.nextPlayerId)}`;
  $("nextBanner").innerHTML = nextTxt + (s.pendingDraw ? `<span class="pending-pill">Stacked +${s.pendingDraw}</span>` : "");

  // Opponents
  const opp = $("opponents");
  opp.innerHTML = "";
  s.players.forEach((p) => {
    if (!isAdmin && p.id === me.id) return;
    const d = document.createElement("div");
    d.className = "opp" + (p.isCurrent ? " current" : "") + (p.finished || p.eliminated ? " finished" : "") + (p.isLoser ? " loser" : "");
    d.innerHTML = `<div class="avatar">${avatarFor(p.id)}</div>
      <div class="name">${shortName(p.id)}</div>
      <div class="count">${p.handCount}</div>
      ${p.eliminated ? `<div class="uno-tag">💀 OUT</div>` : p.finished ? `<div class="place-tag">#${p.place} done</div>` : ""}
      ${p.isLoser ? `<div class="uno-tag">LAST</div>` : ""}
      ${p.saidUno && !p.finished ? '<div class="uno-tag">UNO</div>' : ""}`;
    opp.appendChild(d);
  });

  // Center
  const top = s.topCard;
  const disc = $("discard");
  disc.className = "big-card " + colorClass(top ? top.color : "wild");
  disc.innerHTML = top ? cardInner(top) : "";
  $("activeColor").style.background = `var(--${s.activeColor})`;
  $("dirArrow").textContent = s.direction === 1 ? "↻" : "↺";
  $("deckCount").textContent = `Deck: ${s.deckCount}`;
  $("actionLog").textContent = s.lastAction;

  $("drawBtn").disabled = !myTurn;
  $("drawBtn").style.opacity = myTurn ? "1" : ".5";
  $("drawBtn").textContent = myTurn && s.pendingDraw ? `Draw ${s.pendingDraw}` : "Draw";

  // Challenge button (only on my turn, when there's a challengeable pending draw)
  $("challengeBtn").style.display = myTurn && s.canChallenge ? "" : "none";

  const myHandWrap = $("myHandWrap");
  if (isAdmin) {
    myHandWrap.style.display = "none";
  } else {
    myHandWrap.style.display = "block";
    renderHand($("myHand"), meP ? meP.hand : [], myTurn, s);
  }
  $("unoBtn").style.display = !isAdmin && meP && !iAmFinished && meP.handCount <= 2 ? "" : "none";

  const over = $("overPanel");
  if (s.gameOver) { over.style.display = "block"; renderRanking(s); } else over.style.display = "none";
  $("restartBtn").style.display = !s.gameOver && isAdmin ? "block" : "none";

  const god = $("godView");
  if (isAdmin) {
    god.style.display = "block";
    ensureAdminSelectors();
    $("adminNote").textContent = s.adminNote ? "📝 " + s.adminNote : "";
    renderGodHands(s);
  } else god.style.display = "none";

  // ---- Sound cues ----
  if (s.topCard && s.topCard.id !== prevTopId) {
    if (prevTopId !== null) SFX.forCard(s.topCard);
    prevTopId = s.topCard.id;
  }
  if (myTurn && !prevMyTurn) SFX.play("turn");
  prevMyTurn = myTurn;
  if (s.gameOver && !prevOver) SFX.play(meP && meP.isLoser ? "lose" : meP && meP.eliminated ? "eliminate" : "win");
  prevOver = s.gameOver;
}

function renderRanking(s) {
  $("overTitle").textContent = s.loserId ? `🏁 Game Over — ${shortName(s.loserId)} came last!` : "🏁 Game Over";
  const ol = $("rankList");
  ol.innerHTML = "";
  const medals = ["🥇", "🥈", "🥉"];
  s.finishOrder.forEach((id, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span><span class="medal">${medals[i] || "🏅"}</span>${avatarFor(id)} ${shortName(id)}</span><span>#${i + 1}</span>`;
    ol.appendChild(li);
  });
  (s.eliminatedOrder || []).forEach((id) => {
    const li = document.createElement("li");
    li.className = "loser";
    li.innerHTML = `<span><span class="medal">💀</span>${avatarFor(id)} ${shortName(id)}</span><span>Eliminated</span>`;
    ol.appendChild(li);
  });
  if (s.loserId && !(s.eliminatedOrder || []).includes(s.loserId)) {
    const li = document.createElement("li");
    li.className = "loser";
    li.innerHTML = `<span><span class="medal">💀</span>${avatarFor(s.loserId)} ${shortName(s.loserId)}</span><span>Last</span>`;
    ol.appendChild(li);
  }
}

function renderHand(container, cards, canAct, s) {
  container.innerHTML = "";
  (cards || []).forEach((c) => {
    const el = document.createElement("div");
    const playable = canAct && playableNow(c, s);
    el.className = `uno-card ${colorClass(c.color)} ${playable ? "playable" : "disabled"}`;
    el.innerHTML = cardInner(c);
    if (playable) el.onclick = () => attemptPlay(c);
    container.appendChild(el);
  });
}

// Playable check — handles stacking during a pending draw.
function playableNow(card, s) {
  if (!s.topCard) return false;
  if (s.pendingDraw > 0) {
    const topAmt = drawAmount(s.topCard);
    const amt = drawAmount(card);
    return amt > 0 && amt >= topAmt; // stack same-or-higher draw card
  }
  if (card.color === "wild") return true;
  if (card.color === s.activeColor) return true;
  if (s.topCard.kind === "number" && card.kind === "number") return card.value === s.topCard.value;
  return card.kind === s.topCard.kind && card.kind !== "number";
}

function attemptPlay(card) {
  if (card.color === "wild") { pendingWildCardId = card.id; $("colorModal").style.display = "flex"; return; }
  playCard(card.id, null);
}
function playCard(cardId, color) {
  socket.emit("game:play", { cardId, color }, (res) => { if (!res.ok) flash(res.error); });
}
document.querySelectorAll(".color-pick").forEach((btn) => {
  btn.onclick = () => {
    const color = btn.dataset.color;
    $("colorModal").style.display = "none";
    if (pendingWildCardId != null) { playCard(pendingWildCardId, color); pendingWildCardId = null; }
  };
});

$("drawBtn").onclick = () => {
  socket.emit("game:draw", {}, (res) => {
    if (!res.ok) flash(res.error);
    else if (res.canPlayDrawn) {
      if (confirm("You drew a playable card. Play it now? (Cancel = keep & pass)")) {
        const card = lastState.players.find((p) => p.id === me.id)?.hand.find((c) => c.id === res.drawnCardId);
        if (card) attemptPlay(card);
      } else socket.emit("game:pass", {});
    }
  });
};
$("challengeBtn").onclick = () => socket.emit("game:challenge", {}, (res) => { if (!res.ok) flash(res.error); });
$("unoBtn").onclick = () => socket.emit("game:uno", {}, (res) => { if (res.ok) SFX.play("uno"); else flash(res.error); });
$("restartBtn").onclick = () => socket.emit("game:restart", {}, (res) => { if (!res.ok) flash(res.error); });
$("playAgainBtn").onclick = () => socket.emit("game:restart", {}, (res) => { if (!res.ok) flash(res.error); });

// ---------- Admin tools ----------
const ALL_COLORS = ["red", "yellow", "green", "blue"];
const ALL_KINDS = [
  ["number", "Number"], ["skip", "Skip"], ["reverse", "Reverse"], ["draw2", "Draw 2"],
  ["draw6", "Draw 6"], ["draw8", "Draw 8"], ["draw10", "Draw 10"], ["wild", "Wild"], ["wild4", "Wild +4"], ["skipAll", "Skip All"],
];
let adminSelectorsReady = false;
function fillSelect(sel, items) { sel.innerHTML = items.map(([v, l]) => `<option value="${v}">${l ?? v}</option>`).join(""); }
function ensureAdminSelectors() {
  if (adminSelectorsReady) return;
  fillSelect($("topColor"), ALL_COLORS.map((c) => [c, c]));
  fillSelect($("topKind"), ALL_KINDS);
  fillSelect($("topValue"), Array.from({ length: 10 }, (_, i) => [i, i]));
  const sync = () => { $("topValue").style.display = $("topKind").value === "number" ? "" : "none"; };
  $("topKind").onchange = sync; sync();
  adminSelectorsReady = true;
}
$("setTopBtn").onclick = () => {
  socket.emit("admin:setTop", { color: $("topColor").value, kind: $("topKind").value, value: Number($("topValue").value) },
    (res) => { if (!res.ok) flash(res.error); });
};

function renderGodHands(s) {
  const wrap = $("godHands");
  wrap.innerHTML = "";
  s.players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "god-hand-row" + (p.finished || p.eliminated ? " finished" : "");
    const cards = (p.hand || []).map((c) =>
      `<div class="uno-card mini ${colorClass(c.color)}" data-pid="${p.id}" data-cid="${c.id}" title="Click to edit">${cardInner(c)}</div>`
    ).join("");
    const tag = p.eliminated ? " 💀 out" : p.finished ? ` ✅ #${p.place}` : "";
    row.innerHTML = `
      <div class="gh-name">${avatarFor(p.id)} ${shortName(p.id)} (${p.handCount})${p.isCurrent ? " ⬅ turn" : ""}${tag}</div>
      <div class="gh-cards">${cards}</div>
      <div class="gh-hint">Click a card to change or remove it. Or give a new card:</div>
      <div class="gh-give">
        <select class="give-color">${ALL_COLORS.map((c) => `<option>${c}</option>`).join("")}</select>
        <select class="give-kind">${ALL_KINDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        <select class="give-value">${Array.from({ length: 10 }, (_, i) => `<option>${i}</option>`).join("")}</select>
        <button class="btn tiny dark gh-give-btn" data-pid="${p.id}">Give</button>
      </div>`;
    wrap.appendChild(row);
  });

  // Click a card → open the edit modal (change or remove). This is the reliable path.
  wrap.querySelectorAll(".gh-cards .uno-card").forEach((el) => {
    el.onclick = () => openCardEdit(el.dataset.pid, Number(el.dataset.cid));
  });
  wrap.querySelectorAll(".gh-give-btn").forEach((btn) => {
    btn.onclick = () => {
      const row = btn.closest(".god-hand-row");
      const card = {
        color: row.querySelector(".give-color").value,
        kind: row.querySelector(".give-kind").value,
        value: Number(row.querySelector(".give-value").value),
      };
      socket.emit("admin:giveCard", { playerId: btn.dataset.pid, card }, (res) => { if (!res.ok) flash(res.error); });
    };
  });
}

// ---- Admin card edit modal ----
let editSelectorsReady = false;
function openCardEdit(pid, cid) {
  cardEdit = { pid, cid };
  if (!editSelectorsReady) {
    fillSelect($("editColor"), ALL_COLORS.map((c) => [c, c]));
    fillSelect($("editKind"), ALL_KINDS);
    fillSelect($("editValue"), Array.from({ length: 10 }, (_, i) => [i, i]));
    $("editKind").onchange = () => { $("editValue").style.display = $("editKind").value === "number" ? "" : "none"; };
    editSelectorsReady = true;
  }
  // Pre-fill with the card's current values if we can find it.
  const p = lastState && lastState.players.find((x) => x.id === pid);
  const c = p && p.hand && p.hand.find((x) => x.id === cid);
  if (c) {
    $("editColor").value = ALL_COLORS.includes(c.color) ? c.color : "red";
    $("editKind").value = c.kind;
    $("editValue").value = c.kind === "number" ? c.value : 0;
  }
  $("editValue").style.display = $("editKind").value === "number" ? "" : "none";
  $("cardEditTitle").textContent = `Edit ${shortName(pid)}'s card`;
  $("cardEditModal").style.display = "flex";
}
function closeCardEdit() { $("cardEditModal").style.display = "none"; cardEdit = null; }
$("editCancelBtn").onclick = closeCardEdit;
$("editChangeBtn").onclick = () => {
  if (!cardEdit) return;
  const card = { color: $("editColor").value, kind: $("editKind").value, value: Number($("editValue").value) };
  socket.emit("admin:changeCard", { playerId: cardEdit.pid, cardId: cardEdit.cid, card }, (res) => {
    if (res.ok) closeCardEdit(); else flash(res.error);
  });
};
$("editRemoveBtn").onclick = () => {
  if (!cardEdit) return;
  socket.emit("admin:removeCard", { playerId: cardEdit.pid, cardId: cardEdit.cid }, (res) => {
    if (res.ok) closeCardEdit(); else flash(res.error);
  });
};

function shortName(id) { return id ? String(id).split("#")[0] : "?"; }
function flash(msg) {
  $("actionLog").textContent = "⚠ " + msg;
  setTimeout(() => { if (lastState) $("actionLog").textContent = lastState.lastAction; }, 1800);
}

// ---------- Sound toggle ----------
function refreshSoundBtn() {
  const on = SFX.isOn();
  $("soundBtn").textContent = on ? "🔊" : "🔈";
  $("soundBtn").classList.toggle("on", on);
}
$("soundBtn").onclick = () => { SFX.toggle(); refreshSoundBtn(); };
refreshSoundBtn();

// ---------- Voice chat ----------
const voice = createVoice(socket);
voice.setStatus((st) => {
  $("micBtn").textContent = st.active ? "📞 Leave" : "🎤 Mic";
  $("micBtn").classList.toggle("active", st.active);
  $("muteBtn").style.display = st.active ? "" : "none";
  $("deafenBtn").style.display = st.active ? "" : "none";
  $("muteBtn").textContent = st.muted ? "🔇 Muted" : "🎙️ Talking";
  $("muteBtn").classList.toggle("danger", st.muted);
  $("deafenBtn").textContent = st.deafened ? "🔇 Audio off" : "🔊 Audio on";
  $("deafenBtn").classList.toggle("danger", st.deafened);
  $("voiceStatus").textContent = st.active ? `Voice on · ${st.count} connected` : "";
});

$("micBtn").onclick = async () => {
  SFX.unlock();
  if (voice.isActive()) { voice.stop(); return; }
  try {
    await voice.start(me.id || (me.role === "admin" ? "Admin" : "Player"));
  } catch (e) {
    flash("Mic permission denied or unavailable.");
  }
};
$("muteBtn").onclick = () => voice.toggleMute();
$("deafenBtn").onclick = () => voice.toggleDeafen();
// Leave voice cleanly on tab close.
window.addEventListener("beforeunload", () => { if (voice.isActive()) voice.stop(); });

// ---------- Text chat ----------
let chatCollapsed = false, chatUnread = 0;
function showChat() { $("chatWidget").style.display = "flex"; }
function setChatHead() {
  $("chatToggle").textContent = chatCollapsed ? "+" : "–";
  const head = $("chatWidget").querySelector(".chat-head span");
  head.innerHTML = "💬 Chat" + (chatCollapsed && chatUnread ? ` <span class="chat-unread">${chatUnread}</span>` : "");
}
function toggleChat() {
  chatCollapsed = !chatCollapsed;
  $("chatWidget").classList.toggle("collapsed", chatCollapsed);
  if (!chatCollapsed) chatUnread = 0;
  setChatHead();
}
$("chatToggle").onclick = toggleChat;
$("chatWidget").querySelector(".chat-head").onclick = (e) => { if (e.target.id !== "chatToggle") toggleChat(); };
$("chatForm").onsubmit = (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  socket.emit("chat:send", { text });
  $("chatInput").value = "";
};
socket.on("chat:msg", ({ name, avatar, text }) => {
  const box = $("chatMessages");
  const div = document.createElement("div");
  div.className = "chat-msg";
  const mine = name === (me.id || (me.role === "admin" ? "Admin" : ""));
  div.innerHTML = `<span class="who">${avatar || "🙂"} ${escapeHtml(name)}${mine ? " (you)" : ""}:</span> ${escapeHtml(text)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  SFX.play("number");
  if (chatCollapsed && !mine) { chatUnread++; setChatHead(); }
});
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// ---------- PWA install ----------
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  $("installBtn").style.display = "block";
});
$("installBtn").onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  $("installBtn").style.display = "none";
};
window.addEventListener("appinstalled", () => { $("installBtn").style.display = "none"; });

// Attempt to rejoin a previous session after a refresh.
tryAutoReconnect();
