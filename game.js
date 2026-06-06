// UNO game engine — pure logic, no networking.
// A "game" lives inside a room. The room layer (server.js) handles players/sockets.
//
// Supports: standard UNO + Mercy-style +6/+8/+10, draw-card STACKING, wild-draw
// CHALLENGE, elimination play, 35-card overflow elimination, deck auto-refill,
// and admin god-powers (set top card, give/remove/change any player's cards).

const COLORS = ["red", "yellow", "green", "blue"];

const WILD_KINDS = new Set(["wild", "wild4", "draw6", "draw8", "draw10", "skipAll"]);
const DRAW_AMOUNT = { draw2: 2, draw6: 6, draw8: 8, draw10: 10, wild4: 4 };
const HAND_LIMIT = 35; // more than this and you're eliminated

let GLOBAL_ID = 1;
const newId = () => GLOBAL_ID++;

export function buildDeck() {
  const deck = [];
  const card = (props) => ({ id: newId(), ...props });
  for (const color of COLORS) {
    deck.push(card({ color, kind: "number", value: 0 }));
    for (let v = 1; v <= 9; v++) {
      deck.push(card({ color, kind: "number", value: v }));
      deck.push(card({ color, kind: "number", value: v }));
    }
    for (const kind of ["skip", "reverse", "draw2"]) {
      deck.push(card({ color, kind }));
      deck.push(card({ color, kind }));
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push(card({ color: "wild", kind: "wild" }));
    deck.push(card({ color: "wild", kind: "wild4" }));
  }
  for (let i = 0; i < 4; i++) deck.push(card({ color: "wild", kind: "draw6" }));
  for (let i = 0; i < 3; i++) deck.push(card({ color: "wild", kind: "draw8" }));
  for (let i = 0; i < 2; i++) deck.push(card({ color: "wild", kind: "draw10" }));
  for (let i = 0; i < 2; i++) deck.push(card({ color: "wild", kind: "skipAll" }));
  return deck;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const isWild = (card) => card.color === "wild" || WILD_KINDS.has(card.kind);
const drawAmt = (card) => DRAW_AMOUNT[card?.kind] || 0;

export function canPlay(card, topCard, activeColor) {
  if (isWild(card)) return true;
  if (card.color === activeColor) return true;
  if (topCard.kind === "number" && card.kind === "number") return card.value === topCard.value;
  return card.kind === topCard.kind && card.kind !== "number";
}

export class UnoGame {
  constructor(playerIds) {
    this.playerOrder = [...playerIds];
    this.hands = {};
    this.deck = [];
    this.discard = [];
    this.activeColor = null;
    this.currentIndex = 0;
    this.direction = 1;
    this.pendingDraw = 0;
    this.started = false;
    this.finished = [];       // emptied-hand finishers (good), in order
    this.eliminated = [];     // overflowed (35+) — out, bad
    this.gameOver = false;
    this.loserId = null;
    this.lastAction = "Game starting…";
    this.adminNote = "";      // only shown in god view
    this.unoCalled = {};
    this.challengeInfo = null; // { player, illegal } for the current pending wild-draw
  }

  start() {
    this.deck = shuffle(buildDeck());
    this.hands = {};
    this.finished = [];
    this.eliminated = [];
    this.gameOver = false;
    this.loserId = null;
    this.pendingDraw = 0;
    this.direction = 1;
    this.currentIndex = 0;
    this.challengeInfo = null;
    this.adminNote = "";
    for (const id of this.playerOrder) {
      this.hands[id] = this.deck.splice(0, 7);
      this.unoCalled[id] = false;
    }
    let first = this.deck.shift();
    while (isWild(first)) {
      this.deck.push(first);
      this.deck = shuffle(this.deck);
      first = this.deck.shift();
    }
    this.discard = [first];
    this.activeColor = first.color;
    this.started = true;
    if (first.kind === "reverse") this.direction = -1;
    if (first.kind === "skip") this.currentIndex = this._nextActiveIndex(1);
    if (drawAmt(first)) this.pendingDraw = drawAmt(first);
    this.lastAction = "Game started! First card flipped.";
    return this;
  }

  get topCard() { return this.discard[this.discard.length - 1]; }
  get currentPlayerId() { return this.playerOrder[this.currentIndex]; }

  _isActive(id) { return !this.finished.includes(id) && !this.eliminated.includes(id); }
  _activeIds() { return this.playerOrder.filter((id) => this._isActive(id)); }
  _activeCount() { return this._activeIds().length; }

  _nextActiveIndex(steps = 1) {
    const n = this.playerOrder.length;
    if (this._activeCount() === 0) return this.currentIndex;
    let idx = this.currentIndex, made = 0, guard = 0;
    while (made < steps && guard++ < n * 4) {
      idx = ((idx + this.direction) % n + n) % n;
      if (this._isActive(this.playerOrder[idx])) made++;
    }
    return idx;
  }
  _advance(steps = 1) { this.currentIndex = this._nextActiveIndex(steps); }
  get nextPlayerId() { return this.gameOver ? null : this.playerOrder[this._nextActiveIndex(1)]; }

  _refillDeckIfNeeded() {
    if (this.deck.length > 0) return;
    if (this.discard.length > 1) {
      const top = this.discard.pop();
      this.deck = shuffle(this.discard);
      this.discard = [top];
    } else {
      // Totally out of cards — auto-fill a fresh deck.
      this.deck = shuffle(buildDeck());
    }
  }

  _drawCards(playerId, count) {
    const drawn = [];
    for (let i = 0; i < count; i++) {
      this._refillDeckIfNeeded();
      if (this.deck.length === 0) break;
      const c = this.deck.shift();
      this.hands[playerId].push(c);
      drawn.push(c);
    }
    this.unoCalled[playerId] = false;
    return drawn;
  }

  // Eliminate a player who exceeded the hand limit. Returns true if game ended.
  _enforceHandLimit(playerId) {
    if (!this._isActive(playerId)) return false;
    if (this.hands[playerId].length <= HAND_LIMIT) return false;
    this.eliminated.push(playerId);
    if (this._activeCount() <= 1) {
      this.gameOver = true;
      this.loserId = this._activeIds()[0] || null;
      this.lastAction = `${shortName(playerId)} blew past ${HAND_LIMIT} cards — eliminated! Game over.`;
      return true;
    }
    this.lastAction = `${shortName(playerId)} blew past ${HAND_LIMIT} cards — eliminated!`;
    return true; // ended for this player's turn flow; caller already advanced
  }

  _registerFinish(playerId) {
    this.finished.push(playerId);
    const place = this.finished.length;
    if (this._activeCount() <= 1) {
      this.gameOver = true;
      this.loserId = this._activeIds()[0] || null;
      const loserName = this.loserId ? shortName(this.loserId) : "nobody";
      this.lastAction = `${shortName(playerId)} finished #${place}! Game over — ${loserName} is last. 🏁`;
      return true;
    }
    this.lastAction = `${shortName(playerId)} emptied their hand — finished #${place}! Others play on.`;
    return false;
  }

  playCard(playerId, cardId, chosenColor) {
    if (!this.started) return { ok: false, error: "Game not started." };
    if (this.gameOver) return { ok: false, error: "Game already over." };
    if (!this._isActive(playerId)) return { ok: false, error: "You're out of this round." };
    if (playerId !== this.currentPlayerId) return { ok: false, error: "Not your turn." };

    const hand = this.hands[playerId];
    const idx = hand.findIndex((c) => c.id === cardId);
    if (idx === -1) return { ok: false, error: "Card not in your hand." };
    const card = hand[idx];

    // When a draw is pending, the only legal play is STACKING a draw card of
    // equal-or-higher value. Otherwise the player must draw (or challenge).
    if (this.pendingDraw > 0) {
      const topAmt = drawAmt(this.topCard);
      const cardAmt = drawAmt(card);
      if (!cardAmt || cardAmt < topAmt) {
        return { ok: false, error: `Stack +${topAmt} or higher, draw ${this.pendingDraw}, or challenge.` };
      }
      if (isWild(card) && !COLORS.includes(chosenColor)) {
        return { ok: false, error: "Pick a color for that card." };
      }
      return this._applyPlay(playerId, idx, card, chosenColor);
    }

    if (!canPlay(card, this.topCard, this.activeColor)) {
      return { ok: false, error: "That card can't be played right now." };
    }
    if (isWild(card) && !COLORS.includes(chosenColor)) {
      return { ok: false, error: "Pick a color for that card." };
    }
    return this._applyPlay(playerId, idx, card, chosenColor);
  }

  _applyPlay(playerId, idx, card, chosenColor) {
    const hand = this.hands[playerId];
    const prevColor = this.activeColor;
    hand.splice(idx, 1);
    this.discard.push(card);

    // Track challenge eligibility for wild-draw cards (was a color play hidden?).
    if (isWild(card) && drawAmt(card) > 0) {
      const hadColor = hand.some((c) => !isWild(c) && c.color === prevColor);
      this.challengeInfo = { player: playerId, illegal: hadColor };
    } else {
      this.challengeInfo = null;
    }

    this.activeColor = isWild(card) ? chosenColor : card.color;
    this.lastAction = `${shortName(playerId)} played ${cardLabel(card, chosenColor)}.`;

    let skipNext = false;
    if (card.kind === "skip") skipNext = true;
    if (card.kind === "reverse") {
      if (this._activeCount() === 2) skipNext = true;
      else this.direction *= -1;
    }
    if (drawAmt(card)) this.pendingDraw += drawAmt(card);

    // How far the turn moves. "Skip All" loops past everyone back to the player.
    let steps = skipNext ? 2 : 1;
    if (card.kind === "skipAll") steps = Math.max(1, this._activeCount());

    if (hand.length === 0) {
      // House rule: you cannot go out on an action/power card. Play it (the
      // effect still resolves), but draw a card so you stay in the game.
      if (card.kind !== "number") {
        this._drawCards(playerId, 1);
        this.lastAction = `${shortName(playerId)} can't finish on ${cardLabel(card, chosenColor)} — drew a card!`;
        this._advance(steps);
        this._enforceHandLimit(playerId);
        return { ok: true, blockedFinish: true };
      }
      const ended = this._registerFinish(playerId);
      if (ended) return { ok: true, finished: true, gameOver: true };
      this._advance(steps);
      return { ok: true, finished: true };
    }
    this._advance(steps);
    return { ok: true };
  }

  drawCard(playerId) {
    if (!this.started) return { ok: false, error: "Game not started." };
    if (this.gameOver) return { ok: false, error: "Game already over." };
    if (!this._isActive(playerId)) return { ok: false, error: "You're out of this round." };
    if (playerId !== this.currentPlayerId) return { ok: false, error: "Not your turn." };

    if (this.pendingDraw > 0) {
      const n = this.pendingDraw;
      this._drawCards(playerId, n);
      this.pendingDraw = 0;
      this.challengeInfo = null;
      this.lastAction = `${shortName(playerId)} drew ${n} penalty card(s) and lost the turn.`;
      this._advance(1);
      this._enforceHandLimit(playerId);
      return { ok: true, drew: n, penalty: true };
    }

    const [c] = this._drawCards(playerId, 1);
    if (this._enforceHandLimit(playerId)) return { ok: true, drew: 1 };
    if (c && canPlay(c, this.topCard, this.activeColor)) {
      this.lastAction = `${shortName(playerId)} drew a card (playable).`;
      return { ok: true, drew: 1, canPlayDrawn: true, drawnCardId: c.id };
    }
    this.lastAction = `${shortName(playerId)} drew a card and passed.`;
    this._advance(1);
    return { ok: true, drew: 1 };
  }

  // The current player challenges the pending wild-draw card.
  challenge(challengerId) {
    if (this.gameOver) return { ok: false, error: "Game already over." };
    if (challengerId !== this.currentPlayerId) return { ok: false, error: "Not your turn." };
    if (this.pendingDraw <= 0 || !this.challengeInfo) {
      return { ok: false, error: "Nothing to challenge." };
    }
    const amount = this.pendingDraw;
    const info = this.challengeInfo;
    this.pendingDraw = 0;
    this.challengeInfo = null;

    if (info.illegal) {
      // The player bluffed (had a matching color) — THEY draw the penalty.
      this._drawCards(info.player, amount);
      this.lastAction = `${shortName(challengerId)} challenged — ${shortName(info.player)} bluffed and draws ${amount}! Turn stays with ${shortName(challengerId)}.`;
      this._enforceHandLimit(info.player);
      // Turn stays with challenger (they did not advance).
      return { ok: true, won: true };
    }
    // Legal play — challenger pays the penalty + 2 extra.
    const total = amount + 2;
    this._drawCards(challengerId, total);
    this.lastAction = `${shortName(challengerId)} challenged and lost — draws ${total} (extra 2)!`;
    this._advance(1);
    this._enforceHandLimit(challengerId);
    return { ok: true, won: false, drew: total };
  }

  pass(playerId) {
    if (playerId !== this.currentPlayerId) return { ok: false, error: "Not your turn." };
    if (this.gameOver) return { ok: false, error: "Game already over." };
    this._advance(1);
    this.lastAction = `${shortName(playerId)} passed.`;
    return { ok: true };
  }

  callUno(playerId) {
    if (this.hands[playerId]?.length === 1) {
      this.unoCalled[playerId] = true;
      this.lastAction = `${shortName(playerId)} called UNO!`;
      return { ok: true };
    }
    return { ok: false, error: "You can only call UNO with one card left." };
  }

  // ---- Admin god-powers (silent: they set adminNote, not lastAction) ------
  _makeCard({ color, kind, value }) {
    if (isWildCard(kind)) return { id: newId(), color: "wild", kind };
    const realColor = COLORS.includes(color) ? color : "red";
    return { id: newId(), color: realColor, kind, ...(kind === "number" ? { value: Number(value) || 0 } : {}) };
  }

  adminSetTopCard(spec) {
    if (!this.started) return { ok: false, error: "Game not started." };
    const card = this._makeCard(spec);
    this.discard.push(card);
    this.activeColor = isWild(card) ? (COLORS.includes(spec.color) ? spec.color : "red") : card.color;
    this.pendingDraw = 0;       // editing the board clears any pending draw
    this.challengeInfo = null;
    this.adminNote = `Set top → ${cardLabel(card, this.activeColor)}`;
    return { ok: true };
  }

  adminGiveCard(playerId, spec) {
    if (!this.hands[playerId]) return { ok: false, error: "No such player." };
    const card = this._makeCard(spec);
    this.hands[playerId].push(card);
    this.adminNote = `Gave ${shortName(playerId)} a ${cardLabel(card)}`;
    return { ok: true };
  }

  adminRemoveCard(playerId, cardId) {
    const hand = this.hands[playerId];
    if (!hand) return { ok: false, error: "No such player." };
    const i = hand.findIndex((c) => c.id === Number(cardId));
    if (i === -1) return { ok: false, error: "Card not found." };
    const [removed] = hand.splice(i, 1);
    this.adminNote = `Removed a ${cardLabel(removed)} from ${shortName(playerId)}`;
    return { ok: true };
  }

  // Change a specific card a player holds into a new card (kept in place).
  adminChangeCard(playerId, cardId, spec) {
    const hand = this.hands[playerId];
    if (!hand) return { ok: false, error: "No such player." };
    const i = hand.findIndex((c) => c.id === Number(cardId));
    if (i === -1) return { ok: false, error: "Card not found." };
    const before = cardLabel(hand[i]);
    hand[i] = this._makeCard(spec);
    this.adminNote = `Changed ${shortName(playerId)}'s ${before} → ${cardLabel(hand[i])}`;
    return { ok: true };
  }

  stateFor(playerId, godView = false) {
    const players = this.playerOrder.map((id) => {
      const place = this.finished.indexOf(id);
      return {
        id,
        handCount: this.hands[id].length,
        hand: id === playerId || godView ? this.hands[id] : null,
        isCurrent: !this.gameOver && id === this.currentPlayerId && this._isActive(id),
        saidUno: this.unoCalled[id],
        finished: place !== -1,
        place: place === -1 ? null : place + 1,
        eliminated: this.eliminated.includes(id),
        isLoser: this.gameOver && id === this.loserId,
      };
    });
    return {
      started: this.started,
      topCard: this.topCard || null,
      activeColor: this.activeColor,
      direction: this.direction,
      currentPlayerId: this.gameOver ? null : this.currentPlayerId,
      nextPlayerId: this.nextPlayerId,
      pendingDraw: this.pendingDraw,
      canChallenge: this.pendingDraw > 0 && !!this.challengeInfo,
      gameOver: this.gameOver,
      loserId: this.loserId,
      finishOrder: this.finished.slice(),
      eliminatedOrder: this.eliminated.slice(),
      lastAction: this.lastAction,
      adminNote: godView ? this.adminNote : "",
      players,
      deckCount: this.deck.length,
    };
  }
}

function isWildCard(kind) { return WILD_KINDS.has(kind); }
function shortName(id) { return id ? String(id).split("#")[0] : "?"; }
function cardLabel(card, chosenColor) {
  if (card.kind === "number") return `${card.color} ${card.value}`;
  const names = {
    skip: "Skip", reverse: "Reverse", draw2: "Draw 2",
    draw6: "Draw 6", draw8: "Draw 8", draw10: "Draw 10",
    wild: "Wild", wild4: "Wild Draw 4", skipAll: "Skip All",
  };
  if (isWild(card)) return `${names[card.kind]}${chosenColor ? ` (→ ${chosenColor})` : ""}`;
  return `${card.color} ${names[card.kind]}`;
}
