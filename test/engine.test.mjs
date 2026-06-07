// Automated tests for the UNO engine. Run with: npm test  (node --test)
import { test } from "node:test";
import assert from "node:assert/strict";
import { UnoGame, buildDeck, canPlay, isWild, shuffle } from "../game.js";

// Helper: a fresh game with a deterministic board.
function game(ids, opts) {
  const g = new UnoGame(ids, opts).start();
  g.activeColor = "red";
  g.discard = [{ id: -1, color: "red", kind: "number", value: 3 }];
  g.pendingDraw = 0;
  g.challengeInfo = null;
  g.currentIndex = 0;
  return g;
}

test("deck has 116 cards by default (108 + mercy + skipAll)", () => {
  const d = buildDeck();
  assert.equal(d.length, 108 + 9 + 2);
});

test("deck respects mercy/skipAll options", () => {
  const d = buildDeck({ mercy: false, skipAll: false });
  assert.equal(d.length, 108);
  assert.ok(!d.some((c) => ["draw6", "draw8", "draw10", "skipAll"].includes(c.kind)));
});

test("canPlay: color match, value match, wilds", () => {
  const top = { color: "red", kind: "number", value: 5 };
  assert.ok(canPlay({ color: "red", kind: "number", value: 9 }, top, "red"));
  assert.ok(canPlay({ color: "blue", kind: "number", value: 5 }, top, "red"));
  assert.ok(!canPlay({ color: "blue", kind: "number", value: 9 }, top, "red"));
  assert.ok(canPlay({ color: "wild", kind: "wild" }, top, "red"));
});

test("isWild covers all wild-type cards", () => {
  for (const k of ["wild", "wild4", "draw6", "draw8", "draw10", "skipAll"]) {
    assert.ok(isWild({ color: "wild", kind: k }), k);
  }
  assert.ok(!isWild({ color: "red", kind: "draw2" }));
});

test("start deals the configured starting hand", () => {
  const g = new UnoGame(["A", "B"], { startingHand: 5 }).start();
  assert.equal(g.hands["A"].length, 5);
  assert.equal(g.hands["B"].length, 5);
});

test("playing a number card advances the turn", () => {
  const g = game(["A", "B"]);
  g.hands["A"] = [{ id: 1, color: "red", kind: "number", value: 7 }, { id: 2, color: "blue", kind: "number", value: 1 }];
  const r = g.playCard("A", 1, null);
  assert.ok(r.ok);
  assert.equal(g.currentPlayerId, "B");
});

test("wild card requires a chosen color", () => {
  const g = game(["A", "B"]);
  g.hands["A"] = [{ id: 1, color: "wild", kind: "wild" }, { id: 2, color: "red", kind: "number", value: 2 }];
  assert.ok(!g.playCard("A", 1, null).ok);
  assert.ok(g.playCard("A", 1, "blue").ok);
  assert.equal(g.activeColor, "blue");
});

test("draw stacking: +2 then +4, victim draws 6", () => {
  const g = game(["A", "B", "C"]);
  g.hands["A"] = [{ id: 1, color: "red", kind: "draw2" }, { id: 9, color: "blue", kind: "number", value: 1 }];
  g.hands["B"] = [{ id: 2, color: "wild", kind: "wild4" }, { id: 8, color: "green", kind: "number", value: 2 }];
  assert.ok(g.playCard("A", 1, null).ok);
  assert.equal(g.pendingDraw, 2);
  assert.ok(g.playCard("B", 2, "blue").ok);
  assert.equal(g.pendingDraw, 6);
  const before = g.hands["C"].length;
  g.drawCard("C");
  assert.equal(g.hands["C"].length - before, 6);
});

test("stacking disabled rejects a stack", () => {
  const g = game(["A", "B"], { stacking: false });
  g.hands["A"] = [{ id: 1, color: "red", kind: "draw2" }, { id: 3, color: "blue", kind: "number", value: 1 }];
  g.hands["B"] = [{ id: 2, color: "wild", kind: "wild4" }, { id: 4, color: "green", kind: "number", value: 5 }];
  g.playCard("A", 1, null);
  assert.ok(!g.playCard("B", 2, "red").ok);
});

test("challenge: bluff caught -> player draws; legal -> challenger draws +2", () => {
  // Bluff: player kept a matching color.
  let g = game(["P", "Q"]);
  g.activeColor = "red";
  g.hands["P"] = [{ id: 1, color: "wild", kind: "wild4" }, { id: 2, color: "red", kind: "number", value: 8 }];
  g.playCard("P", 1, "blue");
  const pBefore = g.hands["P"].length;
  const r = g.challenge("Q");
  assert.ok(r.won);
  assert.equal(g.hands["P"].length - pBefore, 4);

  // Legal: no matching color.
  g = game(["M", "N"]);
  g.activeColor = "red";
  g.hands["M"] = [{ id: 1, color: "wild", kind: "wild4" }, { id: 2, color: "blue", kind: "number", value: 8 }];
  g.playCard("M", 1, "green");
  const nBefore = g.hands["N"].length;
  const r2 = g.challenge("N");
  assert.ok(!r2.won);
  assert.equal(g.hands["N"].length - nBefore, 6);
});

test("cannot finish on an action card (draws and stays in)", () => {
  const g = game(["A", "B", "C"]);
  g.hands["A"] = [{ id: 1, color: "red", kind: "skip" }];
  const r = g.playCard("A", 1, null);
  assert.ok(r.blockedFinish);
  assert.equal(g.finished.length, 0);
  assert.equal(g.hands["A"].length, 1);
});

test("can finish on a number card and 2-player game ends", () => {
  const g = game(["A", "B"]);
  g.hands["A"] = [{ id: 1, color: "red", kind: "number", value: 5 }];
  const r = g.playCard("A", 1, null);
  assert.ok(r.finished && r.gameOver);
  assert.equal(g.loserId, "B");
});

test("elimination: finishers ranked, last one loses", () => {
  const g = game(["A", "B", "C"]);
  g.hands["A"] = [{ id: 1, color: "red", kind: "number", value: 5 }];
  g.currentIndex = 0;
  g.playCard("A", 1, null); // A finishes #1, B and C continue
  assert.deepEqual(g.finished, ["A"]);
  assert.ok(!g.gameOver);
  g.hands["B"] = [{ id: 2, color: "red", kind: "number", value: 6 }];
  g.activeColor = "red"; g.discard = [{ id: -2, color: "red", kind: "number", value: 1 }];
  g.currentIndex = g.playerOrder.indexOf("B");
  g.playCard("B", 2, null); // B finishes -> only C left -> over
  assert.ok(g.gameOver);
  assert.equal(g.loserId, "C");
});

test("35-card overflow eliminates a player", () => {
  const g = game(["A", "B"]);
  g.hands["A"] = Array.from({ length: 35 }, (_, i) => ({ id: 1000 + i, color: "red", kind: "number", value: 1 }));
  g.pendingDraw = 2;
  g.currentIndex = 0;
  g.drawCard("A"); // 35 + 2 -> eliminated
  assert.ok(g.eliminated.includes("A"));
  assert.ok(g.gameOver);
});

test("deck auto-refills when empty", () => {
  const g = game(["A", "B"]);
  g.deck = [];
  g.discard = [{ id: 1, color: "red", kind: "number", value: 3 }];
  g._refillDeckIfNeeded();
  assert.ok(g.deck.length > 0);
});

test("UNO catch makes the target draw 2", () => {
  const g = game(["A", "B"]);
  g.hands["A"] = [{ id: 1, color: "red", kind: "number", value: 5 }];
  g.unoCalled["A"] = false;
  const r = g.catchUno("A", "B");
  assert.ok(r.ok);
  assert.equal(g.hands["A"].length, 3);
  // not catchable once UNO is called
  g.hands["B"] = [{ id: 2, color: "red", kind: "number", value: 5 }];
  g.unoCalled["B"] = true;
  assert.ok(!g.catchUno("B", "A").ok);
});

test("admin powers: set top, give, remove, change", () => {
  const g = game(["A", "B"]);
  assert.ok(g.adminSetTopCard({ color: "green", kind: "number", value: 9 }).ok);
  assert.equal(g.topCard.color, "green");
  const before = g.hands["A"].length;
  g.adminGiveCard("A", { color: "blue", kind: "skip" });
  assert.equal(g.hands["A"].length, before + 1);
  const cid = g.hands["A"][0].id;
  g.adminChangeCard("A", cid, { kind: "draw10" });
  assert.equal(g.hands["A"][0].kind, "draw10");
  g.adminRemoveCard("A", g.hands["A"][0].id);
  assert.equal(g.hands["A"].length, before);
});

test("removePlayer takes someone out mid-game", () => {
  const g = game(["A", "B", "C"]);
  g.removePlayer("A");
  assert.ok(g.eliminated.includes("A"));
  assert.notEqual(g.currentPlayerId, "A");
});

test("peek: only out players can see a chosen hand", () => {
  const g = game(["A", "B", "C"]);
  g.eliminated = ["A"];
  const out = g.stateFor("A", false, "B");
  assert.ok(Array.isArray(out.players.find((p) => p.id === "B").hand));
  assert.equal(out.players.find((p) => p.id === "C").hand, null);
  // active player can't peek
  const active = g.stateFor("C", false, "B");
  assert.equal(active.players.find((p) => p.id === "B").hand, null);
});

test("autoMove drives a 3-player game to completion", () => {
  const g = new UnoGame(["A", "B", "C"]).start();
  let guard = 0;
  while (!g.gameOver && guard++ < 8000) g.autoMove(g.currentPlayerId);
  assert.ok(g.gameOver);
  assert.ok(g.loserId !== null);
});

test("shuffle keeps the same multiset", () => {
  const a = [1, 2, 3, 4, 5];
  const b = shuffle(a);
  assert.deepEqual([...b].sort(), [...a].sort());
  assert.equal(a.length, 5); // original not mutated in length
});
