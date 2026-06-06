const socket = io();

// ---- Local session state ----
let me = { role: null, id: null, code: null, adminPass: null };
let lastState = null;
let pendingWildCardId = null; // card waiting for color choice

// ---- DOM helpers ----
const $ = (id) => document.getElementById(id);
const show = (screenId) => {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(screenId).classList.add("active");
};
const colorClass = (c) => ({ red: "c-red", yellow: "c-yellow", green: "c-green", blue: "c-blue", wild: "c-wild" }[c] || "c-wild");

function cardText(card) {
  if (card.kind === "number") return String(card.value);
  return { skip: "⊘", reverse: "⇄", draw2: "+2", wild: "W", wild4: "+4" }[card.kind] || "?";
}

// ================= HOME =================
$("joinBtn").onclick = () => {
  const name = $("joinName").value.trim();
  const code = $("joinCode").value.trim().toUpperCase();
  if (!name || !code) return setErr("Enter your name and the access code.");
  socket.emit("player:join", { code, name }, (res) => {
    if (!res.ok) return setErr(res.error);
    me = { role: "player", id: res.id, code: res.code };
    enterLobby();
  });
};

$("createBtn").onclick = () => {
  const password = $("adminPass").value;
  if (!password) return setErr("Enter admin password.");
  socket.emit("admin:create", { password }, (res) => {
    if (!res.ok) return setErr(res.error);
    me = { role: "admin", code: res.code, adminPass: password };
    enterLobby();
  });
};

$("watchBtn").onclick = () => {
  const password = $("adminPass").value;
  const code = $("watchCode").value.trim().toUpperCase();
  if (!password || !code) return setErr("Enter admin password and room code.");
  socket.emit("admin:watch", { password, code }, (res) => {
    if (!res.ok) return setErr(res.error);
    me = { role: "admin", code: res.code, adminPass: password };
    enterLobby();
  });
};

function setErr(msg) { $("homeError").textContent = msg || ""; }

// ================= LOBBY =================
function enterLobby() {
  show("lobby");
  $("lobbyCode").textContent = me.code;
  // Admin sees Start button
  document.querySelectorAll(".admin-only").forEach((el) => {
    el.style.display = me.role === "admin" ? "" : "none";
  });
  $("startBtn").style.display = me.role === "admin" ? "block" : "none";
}

$("copyCode").onclick = () => {
  navigator.clipboard?.writeText(me.code);
  $("copyCode").textContent = "Copied!";
  setTimeout(() => ($("copyCode").textContent = "Copy"), 1200);
};

$("startBtn").onclick = () => {
  socket.emit("game:start", {}, (res) => {
    if (!res.ok) $("lobbyMsg").textContent = res.error;
  });
};

socket.on("lobby", (data) => {
  if (data.code !== me.code) return;
  const ul = $("playerList");
  ul.innerHTML = "";
  data.players.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = p.name;
    ul.appendChild(li);
  });
  $("lobbyMsg").textContent =
    me.role === "admin"
      ? data.players.length < 2
        ? "Waiting for at least 2 players…"
        : "Ready! Press Start when everyone's in."
      : "Waiting for admin to start…";
});

// ================= GAME =================
socket.on("state", (state) => {
  lastState = state;
  show("game");
  renderGame(state);
});

function renderGame(s) {
  const isAdmin = me.role === "admin";
  $("roleBadge").textContent = isAdmin ? "👑 Admin" : "Player";

  // Turn banner
  const myTurn = !isAdmin && s.currentPlayerId === me.id && !s.winnerId;
  const banner = $("turnBanner");
  if (s.winnerId) {
    banner.textContent = `🏆 ${shortName(s.winnerId)} won!`;
    banner.classList.remove("my-turn");
  } else if (isAdmin) {
    banner.textContent = `Turn: ${shortName(s.currentPlayerId)}`;
    banner.classList.remove("my-turn");
  } else {
    banner.textContent = myTurn ? "🎯 Your turn!" : `Turn: ${shortName(s.currentPlayerId)}`;
    banner.classList.toggle("my-turn", myTurn);
  }

  // Opponents row (everyone except me, or everyone for admin)
  const opp = $("opponents");
  opp.innerHTML = "";
  s.players.forEach((p) => {
    if (!isAdmin && p.id === me.id) return;
    const d = document.createElement("div");
    d.className = "opp" + (p.isCurrent ? " current" : "");
    d.innerHTML = `<div class="name">${shortName(p.id)}</div>
      <div class="count">${p.handCount}</div>
      ${p.saidUno ? '<div class="uno-tag">UNO</div>' : ""}`;
    opp.appendChild(d);
  });

  // Center table
  const top = s.topCard;
  const disc = $("discard");
  disc.className = "big-card " + colorClass(top ? top.color : "wild");
  disc.textContent = top ? cardText(top) : "";
  $("activeColor").style.background = `var(--${s.activeColor})`;
  $("dirArrow").textContent = s.direction === 1 ? "↻" : "↺";
  $("deckCount").textContent = `Deck: ${s.deckCount}`;

  $("actionLog").textContent = s.lastAction + (s.pendingDraw ? ` (pending draw: ${s.pendingDraw})` : "");

  // Draw button enabled only on my turn
  $("drawBtn").disabled = !myTurn;
  $("drawBtn").style.opacity = myTurn ? "1" : ".5";

  // My hand
  const myHandWrap = $("myHandWrap");
  if (isAdmin) {
    myHandWrap.style.display = "none";
  } else {
    myHandWrap.style.display = "block";
    const meP = s.players.find((p) => p.id === me.id);
    renderHand($("myHand"), meP ? meP.hand : [], myTurn && s.pendingDraw === 0, s);
  }

  // UNO button: show if I have exactly 1 card... actually allow at 2 about to play. Keep simple: show when 1 or 2 cards.
  const meP = s.players.find((p) => p.id === me.id);
  $("unoBtn").style.display = !isAdmin && meP && meP.handCount <= 2 ? "" : "none";

  // God view (admin)
  const god = $("godView");
  if (isAdmin) {
    god.style.display = "block";
    const wrap = $("godHands");
    wrap.innerHTML = "";
    s.players.forEach((p) => {
      const row = document.createElement("div");
      row.className = "god-hand-row";
      const cards = (p.hand || [])
        .map((c) => `<div class="uno-card mini ${colorClass(c.color)}">${cardText(c)}</div>`)
        .join("");
      row.innerHTML = `<div class="gh-name">${shortName(p.id)} (${p.handCount})${p.isCurrent ? " ⬅ turn" : ""}</div>
        <div class="gh-cards">${cards}</div>`;
      wrap.appendChild(row);
    });
  } else {
    god.style.display = "none";
  }

  // Admin restart button
  $("restartBtn").style.display = isAdmin ? "block" : "none";
}

function renderHand(container, cards, canAct, s) {
  container.innerHTML = "";
  cards.forEach((c) => {
    const el = document.createElement("div");
    const playable = canAct && playableNow(c, s);
    el.className = `uno-card ${colorClass(c.color)} ${playable ? "playable" : "disabled"}`;
    el.textContent = cardText(c);
    if (playable) el.onclick = () => attemptPlay(c);
    container.appendChild(el);
  });
}

function playableNow(card, s) {
  if (!s.topCard) return false;
  if (card.color === "wild") return true;
  if (card.color === s.activeColor) return true;
  if (s.topCard.kind === "number" && card.kind === "number") return card.value === s.topCard.value;
  return card.kind === s.topCard.kind && card.kind !== "number";
}

function attemptPlay(card) {
  if (card.color === "wild") {
    pendingWildCardId = card.id;
    $("colorModal").style.display = "flex";
    return;
  }
  playCard(card.id, null);
}

function playCard(cardId, color) {
  socket.emit("game:play", { cardId, color }, (res) => {
    if (!res.ok) flash(res.error);
  });
}

// Color modal
document.querySelectorAll(".color-pick").forEach((btn) => {
  btn.onclick = () => {
    const color = btn.dataset.color;
    $("colorModal").style.display = "none";
    if (pendingWildCardId != null) {
      playCard(pendingWildCardId, color);
      pendingWildCardId = null;
    }
  };
});

$("drawBtn").onclick = () => {
  socket.emit("game:draw", {}, (res) => {
    if (!res.ok) flash(res.error);
    else if (res.canPlayDrawn) {
      // Offer to play drawn card or pass.
      if (confirm("You drew a playable card. Play it now? (Cancel = keep & pass)")) {
        const card = lastState.players.find((p) => p.id === me.id)?.hand.find((c) => c.id === res.drawnCardId);
        if (card) attemptPlay(card);
      } else {
        socket.emit("game:pass", {});
      }
    }
  });
};

$("unoBtn").onclick = () => socket.emit("game:uno", {}, (res) => { if (!res.ok) flash(res.error); });
$("restartBtn").onclick = () => socket.emit("game:restart", {}, (res) => { if (!res.ok) flash(res.error); });

function shortName(id) { return id ? id.split("#")[0] : "?"; }
function flash(msg) {
  $("actionLog").textContent = "⚠ " + msg;
  setTimeout(() => { if (lastState) $("actionLog").textContent = lastState.lastAction; }, 1800);
}
