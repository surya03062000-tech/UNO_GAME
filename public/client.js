const socket = io();

let me = { role: null, id: null, code: null, adminPass: null };
let lastState = null;
let pendingWildCardId = null;

const $ = (id) => document.getElementById(id);
const show = (screenId) => {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(screenId).classList.add("active");
};
const colorClass = (c) => ({ red: "c-red", yellow: "c-yellow", green: "c-green", blue: "c-blue", wild: "c-wild" }[c] || "c-wild");

const KIND_LABELS = {
  number: (c) => String(c.value),
  skip: () => "⊘", reverse: () => "⇄", draw2: () => "+2",
  draw6: () => "+6", draw8: () => "+8", draw10: () => "+10",
  wild: () => "W", wild4: () => "+4",
};
function cardSymbol(card) { return (KIND_LABELS[card.kind] || (() => "?"))(card); }

// Build the inner HTML for a card (oval + corner pips).
function cardInner(card) {
  const s = cardSymbol(card);
  return `<span class="corner tl">${s}</span><span class="oval"><span>${s}</span></span><span class="corner br">${s}</span>`;
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
  const ready = data.players.length >= 2;
  $("startBtn").disabled = !ready;
  $("startBtn").style.opacity = ready ? "1" : ".5";
  $("lobbyMsg").textContent = ready
    ? "Ready! Anyone can press Start."
    : "Waiting for at least 2 players…";
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
  const meP = s.players.find((p) => p.id === me.id);
  const iAmFinished = meP && meP.finished;
  const myTurn = !isAdmin && !iAmFinished && s.currentPlayerId === me.id && !s.gameOver;

  // Turn banner
  const banner = $("turnBanner");
  banner.classList.toggle("my-turn", myTurn);
  if (s.gameOver) banner.textContent = "🏁 Game over";
  else if (isAdmin) banner.textContent = `Turn: ${shortName(s.currentPlayerId)}`;
  else if (iAmFinished) banner.textContent = `✅ You finished #${meP.place}! Watching…`;
  else banner.textContent = myTurn ? "🎯 Your turn!" : `Turn: ${shortName(s.currentPlayerId)}`;

  // Opponents
  const opp = $("opponents");
  opp.innerHTML = "";
  s.players.forEach((p) => {
    if (!isAdmin && p.id === me.id) return;
    const d = document.createElement("div");
    d.className = "opp" + (p.isCurrent ? " current" : "") + (p.finished ? " finished" : "") + (p.isLoser ? " loser" : "");
    d.innerHTML = `<div class="name">${shortName(p.id)}</div>
      <div class="count">${p.handCount}</div>
      ${p.finished ? `<div class="place-tag">#${p.place} done</div>` : ""}
      ${p.isLoser ? `<div class="uno-tag">LAST</div>` : ""}
      ${p.saidUno && !p.finished ? '<div class="uno-tag">UNO</div>' : ""}`;
    opp.appendChild(d);
  });

  // Center table
  const top = s.topCard;
  const disc = $("discard");
  disc.className = "big-card " + colorClass(top ? top.color : "wild");
  disc.innerHTML = top ? cardInner(top) : "";
  $("activeColor").style.background = `var(--${s.activeColor})`;
  $("dirArrow").textContent = s.direction === 1 ? "↻" : "↺";
  $("deckCount").textContent = `Deck: ${s.deckCount}`;
  $("actionLog").textContent = s.lastAction + (s.pendingDraw ? ` (pending draw: ${s.pendingDraw})` : "");

  $("drawBtn").disabled = !myTurn;
  $("drawBtn").style.opacity = myTurn ? "1" : ".5";

  // My hand
  const myHandWrap = $("myHandWrap");
  if (isAdmin) {
    myHandWrap.style.display = "none";
  } else {
    myHandWrap.style.display = "block";
    renderHand($("myHand"), meP ? meP.hand : [], myTurn && s.pendingDraw === 0, s);
  }

  $("unoBtn").style.display = !isAdmin && meP && !meP.finished && meP.handCount <= 2 ? "" : "none";

  // Game over panel
  const over = $("overPanel");
  if (s.gameOver) {
    over.style.display = "block";
    renderRanking(s);
  } else {
    over.style.display = "none";
  }
  $("restartBtn").style.display = s.gameOver ? "none" : (isAdmin ? "block" : "none");

  // Admin god view + tools
  const god = $("godView");
  if (isAdmin) {
    god.style.display = "block";
    ensureAdminSelectors();
    renderGodHands(s);
  } else {
    god.style.display = "none";
  }
}

function renderRanking(s) {
  $("overTitle").textContent = s.loserId
    ? `🏁 Game Over — ${shortName(s.loserId)} came last!`
    : "🏁 Game Over";
  const ol = $("rankList");
  ol.innerHTML = "";
  const medals = ["🥇", "🥈", "🥉"];
  s.finishOrder.forEach((id, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span><span class="medal">${medals[i] || "🏅"}</span>${shortName(id)}</span><span>#${i + 1}</span>`;
    ol.appendChild(li);
  });
  if (s.loserId) {
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
      } else {
        socket.emit("game:pass", {});
      }
    }
  });
};

$("unoBtn").onclick = () => socket.emit("game:uno", {}, (res) => { if (!res.ok) flash(res.error); });
$("restartBtn").onclick = () => socket.emit("game:restart", {}, (res) => { if (!res.ok) flash(res.error); });
$("playAgainBtn").onclick = () => socket.emit("game:restart", {}, (res) => { if (!res.ok) flash(res.error); });

// ---------- Admin tools ----------
const ALL_COLORS = ["red", "yellow", "green", "blue"];
const ALL_KINDS = [
  ["number", "Number"], ["skip", "Skip"], ["reverse", "Reverse"], ["draw2", "Draw 2"],
  ["draw6", "Draw 6"], ["draw8", "Draw 8"], ["draw10", "Draw 10"], ["wild", "Wild"], ["wild4", "Wild +4"],
];
let adminSelectorsReady = false;
function fillSelect(sel, items) {
  sel.innerHTML = items.map(([v, l]) => `<option value="${v}">${l ?? v}</option>`).join("");
}
function ensureAdminSelectors() {
  if (adminSelectorsReady) return;
  fillSelect($("topColor"), ALL_COLORS.map((c) => [c, c]));
  fillSelect($("topKind"), ALL_KINDS);
  fillSelect($("topValue"), Array.from({ length: 10 }, (_, i) => [i, i]));
  const syncTopValue = () => { $("topValue").style.display = $("topKind").value === "number" ? "" : "none"; };
  $("topKind").onchange = syncTopValue; syncTopValue();
  adminSelectorsReady = true;
}

$("setTopBtn").onclick = () => {
  const spec = { color: $("topColor").value, kind: $("topKind").value, value: Number($("topValue").value) };
  socket.emit("admin:setTop", spec, (res) => { if (!res.ok) flash(res.error); });
};

function renderGodHands(s) {
  const wrap = $("godHands");
  wrap.innerHTML = "";
  s.players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "god-hand-row" + (p.finished ? " finished" : "");
    const cards = (p.hand || [])
      .map((c) => `<div class="uno-card mini ${colorClass(c.color)}" data-pid="${p.id}" data-cid="${c.id}" title="Click to remove">${cardInner(c)}</div>`)
      .join("");
    row.innerHTML = `
      <div class="gh-name">${shortName(p.id)} (${p.handCount})${p.isCurrent ? " ⬅ turn" : ""}${p.finished ? ` ✅ #${p.place}` : ""}</div>
      <div class="gh-cards">${cards}</div>
      <div class="gh-give">
        <select class="give-color">${ALL_COLORS.map((c) => `<option>${c}</option>`).join("")}</select>
        <select class="give-kind">${ALL_KINDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        <select class="give-value">${Array.from({ length: 10 }, (_, i) => `<option>${i}</option>`).join("")}</select>
        <button class="btn tiny dark gh-give-btn" data-pid="${p.id}">Give card</button>
      </div>`;
    wrap.appendChild(row);
  });

  // remove-on-click for each card
  wrap.querySelectorAll(".gh-cards .uno-card").forEach((el) => {
    el.onclick = () => {
      socket.emit("admin:removeCard", { playerId: el.dataset.pid, cardId: Number(el.dataset.cid) },
        (res) => { if (!res.ok) flash(res.error); });
    };
  });
  // give-card buttons
  wrap.querySelectorAll(".gh-give-btn").forEach((btn) => {
    btn.onclick = () => {
      const row = btn.closest(".god-hand-row");
      const card = {
        color: row.querySelector(".give-color").value,
        kind: row.querySelector(".give-kind").value,
        value: Number(row.querySelector(".give-value").value),
      };
      socket.emit("admin:giveCard", { playerId: btn.dataset.pid, card },
        (res) => { if (!res.ok) flash(res.error); });
    };
  });
}

function shortName(id) { return id ? String(id).split("#")[0] : "?"; }
function flash(msg) {
  $("actionLog").textContent = "⚠ " + msg;
  setTimeout(() => { if (lastState) $("actionLog").textContent = lastState.lastAction; }, 1800);
}
