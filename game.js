// UNO game engine — pure logic, no networking.
// A "game" lives inside a room. The room layer (server.js) handles players/sockets.
//
// Modes & extras supported:
//  - Standard UNO cards + extra "Mercy"-style draw cards: +6, +8, +10 (wild colored)
//  - Elimination play: when you empty your hand you FINISH (ranked); the rest keep
//    playing until only ONE player is left — that last player loses and the game ends.
//  - Admin god-powers: set the discard top card, give/remove cards from any player.

const COLORS = ["red", "yellow", "green", "blue"];

// Cards whose color is chosen by the player (always playable).
const WILD_KINDS = new Set(["wild", "wild4", "draw6", "draw8", "draw10"]);
const DRAW_AMOUNT = { draw2: 2, draw6: 6, draw8: 8, draw10: 10, wild4: 4 };

let GLOBAL_ID = 1; // unique id source for every card ever created (incl. admin-made)
const newId = () => GLOBAL_ID++;

// Build the deck: standard 108 cards + Mercy-style big draw cards.
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
  // Mercy-style extra cards (wild colored — pick a color, next player draws N).
  for (let i = 0; i < 4; i++) deck.push(card({ color: "wild", kind: "draw6" }));
  for (let i = 0; i < 3; i++) deck.push(card({ color: "wild", kind: "draw8" }));
  for (let i = 0; i < 2; i++) deck.push(card({ color: "wild", kind: "draw10" }));
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

export function canPlay(card, topCard, activeColor) {
  if (isWild(card)) return true;
  if (card.color === activeColor) return true;
  if (topCard.kind === "number" && card.kind === "number") {
    return card.value === topCard.value;
  }
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
    this.finished = [];     // player ids in the order they emptied their hand
    this.gameOver = false;
    this.loserId = null;    // the last player left standing
    this.lastAction = "Game starting…";
    this.unoCalled = {};
  }

  start() {
    this.deck = shuffle(buildDeck());
    this.hands = {};
    this.finished = [];
    this.gameOver = false;
    this.loserId = null;
    this.pendingDraw = 0;
    this.direction = 1;
    this.currentIndex = 0;
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
    this._applyStartCard(first);
    this.lastAction = "Game started! First card flipped.";
    return this;
  }

  _applyStartCard(first) {
    if (first.kind === "reverse") this.direction = -1;
    if (first.kind === "skip") this.currentIndex = this._nextActiveIndex(1);
    if (DRAW_AMOUNT[first.kind]) this.pendingDraw = DRAW_AMOUNT[first.kind];
  }

  get topCard() { return this.discard[this.discard.length - 1]; }
  get currentPlayerId() { return this.playerOrder[this.currentIndex]; }

  _isActive(id) { return !this.finished.includes(id); }
  _activeIds() { return this.playerOrder.filter((id) => this._isActive(id)); }
  _activeCount() { return this._activeIds().length; }

  // Step `steps` ACTIVE players forward from currentIndex in the current direction.
  _nextActiveIndex(steps = 1) {
    const n = this.playerOrder.length;
    if (this._activeCount() === 0) return this.currentIndex;
    let idx = this.currentIndex;
    let made = 0;
    let guard = 0;
    while (made < steps && guard++ < n * 4) {
      idx = ((idx + this.direction) % n + n) % n;
      if (this._isActive(this.playerOrder[idx])) made++;
    }
    return idx;
  }

  _advance(steps = 1) { this.currentIndex = this._nextActiveIndex(steps); }

  _refillDeckIfNeeded() {
    if (this.deck.length === 0 && this.discard.length > 1) {
      const top = this.discard.pop();
      this.deck = shuffle(this.discard);
      this.discard = [top];
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

  // Called when a player empties their hand. Returns true if the game just ended.
  _registerFinish(playerId) {
    this.finished.push(playerId);
    const place = this.finished.length;
    if (this._activeCount() <= 1) {
      this.gameOver = true;
      this.loserId = this._activeIds()[0] || null;
      const loserName = this.loserId ? shortName(this.loserId) : "nobody";
      this.lastAction = `${shortName(playerId)} finished #${place}! Game over — ${loserName} is the last one left. 🏁`;
      return true;
    }
    this.lastAction = `${shortName(playerId)} emptied their hand — finished #${place}! Others play on.`;
    return false;
  }

  playCard(playerId, cardId, chosenColor) {
    if (!this.started) return { ok: false, error: "Game not started." };
    if (this.gameOver) return { ok: false, error: "Game already over." };
    if (!this._isActive(playerId)) return { ok: false, error: "You've already finished." };
    if (playerId !== this.currentPlayerId) return { ok: false, error: "Not your turn." };

    const hand = this.hands[playerId];
    const idx = hand.findIndex((c) => c.id === cardId);
    if (idx === -1) return { ok: false, error: "Card not in your hand." };
    const card = hand[idx];

    if (this.pendingDraw > 0) {
      return { ok: false, error: `You must draw ${this.pendingDraw} card(s) first.` };
    }
    if (!canPlay(card, this.topCard, this.activeColor)) {
      return { ok: false, error: "That card can't be played right now." };
    }
    if (isWild(card) && !COLORS.includes(chosenColor)) {
      return { ok: false, error: "Pick a color for that card." };
    }

    hand.splice(idx, 1);
    this.discard.push(card);
    this.activeColor = isWild(card) ? chosenColor : card.color;
    this.lastAction = `${shortName(playerId)} played ${this._cardLabel(card, chosenColor)}.`;

    // Card effects.
    let skipNext = false;
    if (card.kind === "skip") skipNext = true;
    if (card.kind === "reverse") {
      if (this._activeCount() === 2) skipNext = true;
      else this.direction *= -1;
    }
    if (DRAW_AMOUNT[card.kind]) this.pendingDraw += DRAW_AMOUNT[card.kind];

    // Finish check.
    if (hand.length === 0) {
      const ended = this._registerFinish(playerId);
      if (ended) return { ok: true, finished: true, gameOver: true };
      this._advance(skipNext ? 2 : 1);
      return { ok: true, finished: true };
    }

    this._advance(skipNext ? 2 : 1);
    return { ok: true };
  }

  drawCard(playerId) {
    if (!this.started) return { ok: false, error: "Game not started." };
    if (this.gameOver) return { ok: false, error: "Game already over." };
    if (!this._isActive(playerId)) return { ok: false, error: "You've already finished." };
    if (playerId !== this.currentPlayerId) return { ok: false, error: "Not your turn." };

    if (this.pendingDraw > 0) {
      const n = this.pendingDraw;
      this._drawCards(playerId, n);
      this.pendingDraw = 0;
      this.lastAction = `${shortName(playerId)} drew ${n} penalty card(s) and lost the turn.`;
      this._advance(1);
      return { ok: true, drew: n, penalty: true };
    }

    const [c] = this._drawCards(playerId, 1);
    if (c && canPlay(c, this.topCard, this.activeColor)) {
      this.lastAction = `${shortName(playerId)} drew a card (playable).`;
      return { ok: true, drew: 1, canPlayDrawn: true, drawnCardId: c.id };
    }
    this.lastAction = `${shortName(playerId)} drew a card and passed.`;
    this._advance(1);
    return { ok: true, drew: 1 };
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

  // ---- Admin god-powers --------------------------------------------------
  adminSetTopCard({ color, kind, value }) {
    if (!this.started) return { ok: false, error: "Game not started." };
    const realColor = COLORS.includes(color) ? color : "red";
    const card = isWildCard(kind)
      ? { id: newId(), color: "wild", kind }
      : { id: newId(), color: realColor, kind, ...(kind === "number" ? { value: Number(value) || 0 } : {}) };
    this.discard.push(card);
    this.activeColor = realColor;
    this.lastAction = `👑 Admin changed the top card to ${this._cardLabel(card, realColor)}.`;
    return { ok: true };
  }

  adminGiveCard(playerId, { color, kind, value }) {
    if (!this.hands[playerId]) return { ok: false, error: "No such player." };
    const realColor = COLORS.includes(color) ? color : "red";
    const card = isWildCard(kind)
      ? { id: newId(), color: "wild", kind }
      : { id: newId(), color: realColor, kind, ...(kind === "number" ? { value: Number(value) || 0 } : {}) };
    this.hands[playerId].push(card);
    this.lastAction = `👑 Admin gave ${shortName(playerId)} a ${this._cardLabel(card, realColor)}.`;
    return { ok: true };
  }

  adminRemoveCard(playerId, cardId) {
    const hand = this.hands[playerId];
    if (!hand) return { ok: false, error: "No such player." };
    const i = hand.findIndex((c) => c.id === Number(cardId));
    if (i === -1) return { ok: false, error: "Card not found." };
    const [removed] = hand.splice(i, 1);
    this.lastAction = `👑 Admin removed a ${this._cardLabel(removed)} from ${shortName(playerId)}.`;
    // Admin emptying a hand should NOT auto-win; leave it to actual play.
    return { ok: true };
  }

  _cardLabel(card, chosenColor) {
    if (card.kind === "number") return `${card.color} ${card.value}`;
    const names = {
      skip: "Skip", reverse: "Reverse", draw2: "Draw 2",
      draw6: "Draw 6", draw8: "Draw 8", draw10: "Draw 10",
      wild: "Wild", wild4: "Wild Draw 4",
    };
    if (isWild(card)) return `${names[card.kind]}${chosenColor ? ` (→ ${chosenColor})` : ""}`;
    return `${card.color} ${names[card.kind]}`;
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
        isLoser: this.gameOver && id === this.loserId,
      };
    });
    return {
      started: this.started,
      topCard: this.topCard || null,
      activeColor: this.activeColor,
      direction: this.direction,
      currentPlayerId: this.gameOver ? null : this.currentPlayerId,
      pendingDraw: this.pendingDraw,
      gameOver: this.gameOver,
      loserId: this.loserId,
      finishOrder: this.finished.slice(),
      lastAction: this.lastAction,
      players,
      deckCount: this.deck.length,
    };
  }
}

function isWildCard(kind) { return WILD_KINDS.has(kind); }
function shortName(id) { return id ? String(id).split("#")[0] : "?"; }
