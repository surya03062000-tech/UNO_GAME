const socket = io();

let me = { role: null, id: null, code: null };
let lastState = null;
let pendingWildCardId = null;
let godSelected = null; // {pid, cid} currently selected card in god view
let prevTopId = null, prevMyTurn = false, prevOver = false; // for sound cues

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

// ---- Remember session for refresh / reconnect -------------------------------
const SAVE_KEY = "uno_session";
function saveSession() {
  if (me.role === "player" && me.code && me.id) {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ code: me.code, name: me.id }));
  }
}
function clearSession() { localStorage.removeItem(SAVE_KEY); }
function tryAutoReconnect() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return;
  try {
    const { code, name } = JSON.parse(raw);
    if (!code || !name) return;
    $("joinName").value = name;
    $("joinCode").value = code;
    socket.emit("player:join", { code, name }, (res) => {
      if (res.ok) { me = { role: "player", id: res.id, code: res.code }; enterLobby(); }
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
  socket.emit("player:join", { code, name }, (res) => {
    if (!res.ok) return setErr(res.error);
    me = { role: "player", id: res.id, code: res.code };
    saveSession();
    enterLobby();
  });
};
$("createBtn").onclick = () => {
  SFX.unlock();
  const password = $("adminPass").value;
  if (!password) return setErr("Enter admin password.");
  socket.emit("admin:create", { password }, (res) => {
    if (!res.ok) return setErr(res.error);
    me = { role: "admin", code: res.code }; enterLobby();
  });
};
$("watchBtn").onclick = () => {
  const password = $("adminPass").value;
  const code = $("watchCode").value.trim().toUpperCase();
  if (!password || !code) return setErr("Enter admin password and room code.");
  socket.emit("admin:watch", { password, code }, (res) => {
    if (!res.ok) return setErr(res.error);
    me = { role: "admin", code: res.code }; enterLobby();
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
  const ul = $("playerList");
  ul.innerHTML = "";
  data.players.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = p.name + (p.connected ? "" : " (offline)");
    if (!p.connected) li.style.opacity = ".5";
    ul.appendChild(li);
  });
  const online = data.players.filter((p) => p.connected).length;
  const ready = online >= 2;
  $("startBtn").disabled = !ready;
  $("startBtn").style.opacity = ready ? "1" : ".5";
  $("lobbyMsg").textContent = ready ? "Ready! Anyone can press Start." : "Waiting for at least 2 players…";
});

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
    d.innerHTML = `<div class="name">${shortName(p.id)}</div>
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
    li.innerHTML = `<span><span class="medal">${medals[i] || "🏅"}</span>${shortName(id)}</span><span>#${i + 1}</span>`;
    ol.appendChild(li);
  });
  (s.eliminatedOrder || []).forEach((id) => {
    const li = document.createElement("li");
    li.className = "loser";
    li.innerHTML = `<span><span class="medal">💀</span>${shortName(id)}</span><span>Eliminated</span>`;
    ol.appendChild(li);
  });
  if (s.loserId && !(s.eliminatedOrder || []).includes(s.loserId)) {
    const li = document.createElement("li");
    li.className = "loser";
    li.innerHTML = `<span><span class="medal">💀</span>${shortName(s.loserId)}</span><span>Last</span>`;
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
    const cards = (p.hand || []).map((c) => {
      const sel = godSelected && godSelected.pid === p.id && godSelected.cid === c.id ? " sel" : "";
      return `<div class="uno-card mini ${colorClass(c.color)}${sel}" data-pid="${p.id}" data-cid="${c.id}">${cardInner(c)}</div>`;
    }).join("");
    const tag = p.eliminated ? " 💀 out" : p.finished ? ` ✅ #${p.place}` : "";
    row.innerHTML = `
      <div class="gh-name">${shortName(p.id)} (${p.handCount})${p.isCurrent ? " ⬅ turn" : ""}${tag}</div>
      <div class="gh-cards">${cards}</div>
      <div class="gh-hint">Click a card to select it → Change/Remove. Or Give a new one.</div>
      <div class="gh-give">
        <select class="give-color">${ALL_COLORS.map((c) => `<option>${c}</option>`).join("")}</select>
        <select class="give-kind">${ALL_KINDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        <select class="give-value">${Array.from({ length: 10 }, (_, i) => `<option>${i}</option>`).join("")}</select>
        <button class="btn tiny dark gh-give-btn" data-pid="${p.id}">Give</button>
        <button class="btn tiny dark gh-change-btn" data-pid="${p.id}">Change selected</button>
        <button class="btn tiny warn gh-remove-btn" data-pid="${p.id}">Remove selected</button>
      </div>`;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll(".gh-cards .uno-card").forEach((el) => {
    el.onclick = () => {
      godSelected = { pid: el.dataset.pid, cid: Number(el.dataset.cid) };
      wrap.querySelectorAll(".gh-cards .uno-card").forEach((x) => x.classList.remove("sel"));
      el.classList.add("sel");
    };
  });
  const specFromRow = (row) => ({
    color: row.querySelector(".give-color").value,
    kind: row.querySelector(".give-kind").value,
    value: Number(row.querySelector(".give-value").value),
  });
  wrap.querySelectorAll(".gh-give-btn").forEach((btn) => {
    btn.onclick = () => socket.emit("admin:giveCard", { playerId: btn.dataset.pid, card: specFromRow(btn.closest(".god-hand-row")) },
      (res) => { if (!res.ok) flash(res.error); });
  });
  wrap.querySelectorAll(".gh-change-btn").forEach((btn) => {
    btn.onclick = () => {
      if (!godSelected || godSelected.pid !== btn.dataset.pid) return flash("Select one of this player's cards first.");
      socket.emit("admin:changeCard", { playerId: godSelected.pid, cardId: godSelected.cid, card: specFromRow(btn.closest(".god-hand-row")) },
        (res) => { if (res.ok) godSelected = null; else flash(res.error); });
    };
  });
  wrap.querySelectorAll(".gh-remove-btn").forEach((btn) => {
    btn.onclick = () => {
      if (!godSelected || godSelected.pid !== btn.dataset.pid) return flash("Select one of this player's cards first.");
      socket.emit("admin:removeCard", { playerId: godSelected.pid, cardId: godSelected.cid },
        (res) => { if (res.ok) godSelected = null; else flash(res.error); });
    };
  });
}

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

// Attempt to rejoin a previous session after a refresh.
tryAutoReconnect();
