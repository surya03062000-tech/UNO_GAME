// UNO game engine — pure logic, no networking.
// A "game" lives inside a room. The room layer (server.js) handles players/sockets.

const COLORS = ["red", "yellow", "green", "blue"];

// Build a standard 108-card UNO deck.
export function buildDeck() {
  const deck = [];
  let id = 0;
  const card = (props) => ({ id: id++, ...props });

  for (const color of COLORS) {
    // One 0 per color
    deck.push(card({ color, kind: "number", value: 0 }));
    // Two each of 1-9
    for (let v = 1; v <= 9; v++) {
      deck.push(card({ color, kind: "number", value: v }));
      deck.push(card({ color, kind: "number", value: v }));
    }
    // Two each of skip / reverse / draw2
    for (const kind of ["skip", "reverse", "draw2"]) {
      deck.push(card({ color, kind }));
      deck.push(card({ color, kind }));
    }
  }
  // 4 wild + 4 wild draw four
  for (let i = 0; i < 4; i++) {
    deck.push(card({ color: "wild", kind: "wild" }));
    deck.push(card({ color: "wild", kind: "wild4" }));
  }
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

// Can `card` be played on top of the current discard / chosen color?
export function canPlay(card, topCard, activeColor) {
  if (card.color === "wild") return true; // wild + wild4 always playable
  if (card.color === activeColor) return true;
  if (topCard.kind === "number" && card.kind === "number") {
    return card.value === topCard.value;
  }
  // matching action kind (skip on skip, etc.)
  return card.kind === topCard.kind && card.kind !== "number";
}

export class UnoGame {
  constructor(playerIds) {
    this.playerOrder = [...playerIds]; // array of player ids
    this.hands = {};                    // id -> [cards]
    this.deck = [];
    this.discard = [];
    this.activeColor = null;            // color in effect (handles wild choice)
    this.currentIndex = 0;              // index into playerOrder
    this.direction = 1;                 // 1 or -1
    this.pendingDraw = 0;               // accumulated from draw2/draw4 (no stacking by default)
    this.started = false;
    this.winnerId = null;
    this.lastAction = "Game starting…";
    this.unoCalled = {};                // id -> bool, true if they correctly declared UNO
  }

  start() {
    this.deck = shuffle(buildDeck());
    for (const id of this.playerOrder) {
      this.hands[id] = this.deck.splice(0, 7);
      this.unoCalled[id] = false;
    }
    // Flip first card; reshuffle if it's a wild4 (UNO rule), keep simple for others.
    let first = this.deck.shift();
    while (first.kind === "wild4") {
      this.deck.push(first);
      this.deck = shuffle(this.deck);
      first = this.deck.shift();
    }
    this.discard = [first];
    this.activeColor = first.color === "wild" ? COLORS[0] : first.color;
    this.started = true;
    // Apply effect of the very first card to the starting player.
    this._applyStartCard(first);
    this.lastAction = "Game started! First card flipped.";
    return this;
  }

  _applyStartCard(first) {
    if (first.kind === "reverse") this.direction = -1;
    if (first.kind === "skip") this.currentIndex = this._nextIndex();
    if (first.kind === "draw2") this.pendingDraw = 2;
  }

  get topCard() {
    return this.discard[this.discard.length - 1];
  }

  get currentPlayerId() {
    return this.playerOrder[this.currentIndex];
  }

  _nextIndex(steps = 1) {
    const n = this.playerOrder.length;
    return ((this.currentIndex + this.direction * steps) % n + n) % n;
  }

  _advance(steps = 1) {
    this.currentIndex = this._nextIndex(steps);
  }

  _refillDeckIfNeeded() {
    if (this.deck.length === 0) {
      const top = this.discard.pop();
      this.deck = shuffle(this.discard);
      this.discard = [top];
    }
  }

  _drawCards(playerId, count) {
    const drawn = [];
    for (let i = 0; i < count; i++) {
      this._refillDeckIfNeeded();
      if (this.deck.length === 0) break; // truly out of cards
      const c = this.deck.shift();
      this.hands[playerId].push(c);
      drawn.push(c);
    }
    this.unoCalled[playerId] = false; // drawing resets uno safety
    return drawn;
  }

  // A player plays a card from their hand. chosenColor required for wilds.
  playCard(playerId, cardId, chosenColor) {
    if (!this.started) return { ok: false, error: "Game not started." };
    if (this.winnerId) return { ok: false, error: "Game already over." };
    if (playerId !== this.currentPlayerId) return { ok: false, error: "Not your turn." };

    const hand = this.hands[playerId];
    const idx = hand.findIndex((c) => c.id === cardId);
    if (idx === -1) return { ok: false, error: "Card not in your hand." };
    const card = hand[idx];

    // If there's a pending draw, the player must draw (handled via drawCard), can't play normally.
    if (this.pendingDraw > 0) {
      return { ok: false, error: `You must draw ${this.pendingDraw} card(s) first.` };
    }

    if (!canPlay(card, this.topCard, this.activeColor)) {
      return { ok: false, error: "That card can't be played right now." };
    }
    if (card.color === "wild" && !COLORS.includes(chosenColor)) {
      return { ok: false, error: "Pick a color for the wild card." };
    }

    // Remove card from hand, place on discard.
    hand.splice(idx, 1);
    this.discard.push(card);
    this.activeColor = card.color === "wild" ? chosenColor : card.color;
    const playerName = playerId;
    this.lastAction = `Played ${this._cardLabel(card, chosenColor)}.`;

    // Win check (before applying effects to others).
    if (hand.length === 0) {
      this.winnerId = playerId;
      this.lastAction = `${playerId} played their last card and WON! 🏆`;
      return { ok: true, won: true };
    }

    // Apply card effects.
    let skipNext = false;
    if (card.kind === "skip") skipNext = true;
    if (card.kind === "reverse") {
      if (this.playerOrder.length === 2) {
        skipNext = true; // reverse acts like skip in 2-player
      } else {
        this.direction *= -1;
      }
    }
    if (card.kind === "draw2") this.pendingDraw += 2;
    if (card.kind === "wild4") this.pendingDraw += 4;

    // Advance turn (skip = move 2).
    this._advance(skipNext ? 2 : 1);
    return { ok: true };
  }

  // Current player draws. If pendingDraw>0 they take that penalty and lose turn.
  drawCard(playerId) {
    if (!this.started) return { ok: false, error: "Game not started." };
    if (this.winnerId) return { ok: false, error: "Game already over." };
    if (playerId !== this.currentPlayerId) return { ok: false, error: "Not your turn." };

    if (this.pendingDraw > 0) {
      const n = this.pendingDraw;
      this._drawCards(playerId, n);
      this.pendingDraw = 0;
      this.lastAction = `Drew ${n} penalty card(s) and lost the turn.`;
      this._advance(1);
      return { ok: true, drew: n, penalty: true };
    }

    const [c] = this._drawCards(playerId, 1);
    // If the drawn card is playable, leave the turn with the player (they may play it or pass).
    if (c && canPlay(c, this.topCard, this.activeColor)) {
      this.lastAction = "Drew a card (playable).";
      return { ok: true, drew: 1, canPlayDrawn: true, drawnCardId: c.id };
    }
    this.lastAction = "Drew a card and passed.";
    this._advance(1);
    return { ok: true, drew: 1 };
  }

  // After drawing a playable card the player may choose to pass.
  pass(playerId) {
    if (playerId !== this.currentPlayerId) return { ok: false, error: "Not your turn." };
    if (this.winnerId) return { ok: false, error: "Game already over." };
    this._advance(1);
    this.lastAction = "Passed.";
    return { ok: true };
  }

  callUno(playerId) {
    if (this.hands[playerId]?.length === 1) {
      this.unoCalled[playerId] = true;
      this.lastAction = `${playerId} called UNO!`;
      return { ok: true };
    }
    return { ok: false, error: "You can only call UNO with one card left." };
  }

  _cardLabel(card, chosenColor) {
    if (card.kind === "number") return `${card.color} ${card.value}`;
    if (card.kind === "wild") return `Wild (→ ${chosenColor})`;
    if (card.kind === "wild4") return `Wild Draw 4 (→ ${chosenColor})`;
    const names = { skip: "Skip", reverse: "Reverse", draw2: "Draw 2" };
    return `${card.color} ${names[card.kind]}`;
  }

  // Public state for a specific player (hides other hands).
  // If `godView` is true (admin/spectator) all hands are revealed.
  stateFor(playerId, godView = false) {
    const players = this.playerOrder.map((id) => ({
      id,
      handCount: this.hands[id].length,
      // reveal cards if it's you, or god view
      hand: id === playerId || godView ? this.hands[id] : null,
      isCurrent: id === this.currentPlayerId,
      saidUno: this.unoCalled[id],
    }));
    return {
      started: this.started,
      topCard: this.topCard || null,
      activeColor: this.activeColor,
      direction: this.direction,
      currentPlayerId: this.currentPlayerId,
      pendingDraw: this.pendingDraw,
      winnerId: this.winnerId,
      lastAction: this.lastAction,
      players,
      deckCount: this.deck.length,
    };
  }
}
