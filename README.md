# 🎴 Private UNO Game

A real-time, multiplayer UNO card game you can run for your friends. **Invite-only**: only
people you give an access code to can join. You (the **admin**) get a secret **god view**
where you can see *everyone's* cards. Runs in a normal browser window, so you can keep it
small in a corner and play while you work.

---

## ✨ Features

- **Real-time multiplayer** (2–8 players) using Socket.IO
- **Access-code rooms** — admin creates a room, shares the 5-letter code; only people with the code can join
- **👑 Admin god view & controls** — admin sees every player's hand live, and can **change the discard top card**, **give**, **remove**, or **change** any specific card in any player's hand (e.g. turn their `4` into a `+10`). All admin edits are **silent** — players never see an "admin changed…" message. Admin can also spectate any room with `Watch`.
- **Full UNO rules** — numbers, Skip, Reverse, Draw 2, Wild, Wild Draw 4, direction, UNO call
- **Mercy-style extra cards** — **+6, +8, +10** wild draw cards (pick a color, next player draws that many), plus a **Skip All** wild card (skips everyone — you play again)
- **No finishing on an action card** — your *last* card must be a number. If you play an action/power card as your last card it resolves, but you draw a card and stay in.
- **🔊 Sound effects** — every card type has its own sound (generated in-browser, no files). Toggle with the 🔊 button.
- **🎤 Voice chat** — anyone in the room can talk over mic (WebRTC). Mute your mic or cut all incoming audio independently.
- **💬 Text chat** — in-room chat for everyone, with unread badge when collapsed.
- **🧑‍🎨 Player avatars** — pick an emoji avatar; it shows on the table, lobby, ranking and scoreboard.
- **🏆 Scoreboard** — running wins / losses / games / points across rounds, shown in the lobby and at game over.
- **📲 Installable (PWA)** — install it like a real app on a laptop or phone ("Install app" button / Add to Home Screen) and it works offline-capable.
- **🔁 Reliable reconnect** — refresh or drop and you reclaim your seat by name (kicks the stale connection). Players who don't return within **30 seconds** are removed from the round automatically.
- **⏱️ Turn timer** — optional per-turn countdown; if a player is away/too slow they auto-draw so the game never stalls.
- **🤚 UNO catch** — if someone gets to one card and forgets to call UNO, anyone can hit **Catch!** and they draw 2.
- **⚙️ Admin house rules** — toggle in the lobby: turn-timer length, starting hand size, draw-stacking, draw-until-playable, UNO-catch, Mercy cards, Skip-All.
- **🎉 Animations & themes** — card play/deal animations, win confetti, and a 🌗 dark/light theme toggle.
- **💾 Persistence** — scoreboards (and room rules) are saved to disk and reloaded on restart, so the leaderboard survives a server bounce (see note below).
- **Draw-card stacking** — facing a `+2`? Stack a `+2` or anything higher (`+4/+6/+8/+10`); the pile grows for the next player. You can only stack equal-or-higher.
- **Challenge** — when a wild draw card hits you, you can **Challenge** instead of drawing. If the player bluffed (had a matching color), *they* draw the penalty. If it was legal, *you* draw the penalty **+2 extra**.
- **Elimination play** — empty your hand and you *finish* (ranked 🥇🥈🥉) and watch on. The rest play until only **one player is left** — that last player loses and the game ends. Then **anyone can start a new round**.
- **35-card overflow** — pile up more than 35 cards and you're **eliminated** on the spot.
- **Auto reconnect** — refreshed or dropped? Just rejoin with the **same name** and you're back in your seat with your hand. (The browser also auto-reconnects you.)
- **Deck auto-refill** — when the draw pile empties it reshuffles the discards (or makes a fresh deck) automatically.
- **Next-turn indicator** — always shows whose turn is coming up next, plus the current stacked draw total.
- **Anyone can start** — admin or any player can press Start / Play Again (2+ players needed)
- **Polished card design** — classic UNO oval + corner pips, color gradients
- **Small-window friendly** UI — works alongside your work on the same laptop
- **One server**, zero database — easy & free to deploy

---

## 🕹️ How to play

### Admin (you)
1. Open the app, scroll to the **👑 Admin** box.
2. Type your admin password → **Create New Room**.
3. A **5-letter access code** appears (e.g. `ABC23`). Share it only with people you want in.
4. When everyone has joined the lobby, press **Start Game**.
5. While playing you see the **god view** at the bottom — everyone's cards.
   - To just spectate an existing room later, use **Watch** with the room's code.

### Players (the people you invite)
1. Open the same app link.
2. Enter your **name** + the **access code** you were given → **Join Game**.
3. Wait in the lobby; play when it's your turn. Click a card to play it, or **Draw**.
4. Down to one card? Hit the **UNO!** button.

---

## 💻 Run it locally (on your laptop)

You need [Node.js 18+](https://nodejs.org).

```bash
npm install
# Set your own admin password!
ADMIN_PASSWORD="my-secret-pass" npm start
```

Open **http://localhost:3000** in your browser.

> On the same Wi-Fi, others can join using your laptop's local IP, e.g. `http://192.168.1.5:3000`.
> Find your IP with `ipconfig` (Windows) or `ifconfig`/`ip addr` (Mac/Linux).
> For people **outside** your network, deploy it online (below).

---

## 🚀 Deploy online (so anyone, anywhere can play)

The app is one Node server that keeps live WebSocket (Socket.IO) connections and game
state **in memory**. So it needs a host that runs a **persistent Node server** — not a
serverless platform.

> ⚠️ **Vercel / Netlify won't work** for this game. They are serverless: they can't hold
> open WebSocket connections or keep the in-memory rooms alive between requests. The page
> would load but players could never join. Use Render (below) — it's free and built for this.

### Option A — Render, one-click Blueprint (recommended, free)
This repo includes a `render.yaml` blueprint, so Render sets everything up for you.
1. Push this repo to GitHub (already done if you're reading this there 🙂).
2. Go to [render.com](https://render.com) → **New** → **Blueprint** → connect this repo.
3. Render reads `render.yaml` and creates the web service automatically.
4. When asked, set the `ADMIN_PASSWORD` value to *your own secret password*.
5. Deploy. You get a public URL like `https://uno-game.onrender.com`.
6. Share that URL + the room access code with your friends. Done!

### Option B — Render, manual (also free)
1. [render.com](https://render.com) → **New** → **Web Service** → connect this repo.
2. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment variable:** `ADMIN_PASSWORD` = *your secret password*
3. Deploy → public URL. Share it + the room code.

> 💤 On Render's free tier the server sleeps after ~15 min idle. The first visit after that
> takes ~30s to wake up — totally fine for casual games.

### Option C — Railway / Fly.io / any VPS
Same idea: `npm install` then `npm start`, set the `ADMIN_PASSWORD` env var, expose the port
(`PORT` env var is read automatically).

---

## 🎤 Voice chat notes

- Voice uses your browser's mic via **WebRTC**. Browsers only allow mic access on a
  **secure origin** — i.e. `https://…` (Render gives you this) or `http://localhost`.
  On a plain `http://192.168.x.x` LAN address the mic will be blocked by the browser.
- It uses Google's public **STUN** servers, which works for most home networks. Some
  strict/symmetric NATs need a **TURN** server (not included). If two people can't hear
  each other across different networks, that's why — add a TURN server if you need it.
- Click **🎤 Mic** to join voice, **🔇 Muted** to stop sending your voice, and
  **Audio cut** to stop hearing others. **📞 Leave** disconnects from voice.

## 📲 Installing as an app

The game is a **PWA**, so it installs like a native app:

- **Laptop (Chrome/Edge):** open the deployed `https://…` URL → click the **📲 Install app**
  button on the home screen, or the install icon in the address bar.
- **Android (Chrome):** open the URL → menu → **Add to Home screen / Install app**.
- **iPhone (Safari):** open the URL → Share → **Add to Home Screen**.

Install works only over **HTTPS** (Render gives you that) or `http://localhost`.

## 💾 Persistence note

Scoreboards and room rule-settings are written to `data/store.json` and reloaded when
the server starts, so the leaderboard for a room code survives a restart. You can point
this elsewhere with the `DATA_DIR` env var.

> ⚠️ On **Render's free tier the disk is ephemeral** — a full redeploy wipes `data/`.
> For durable storage across deploys, attach a Render **Persistent Disk** and set
> `DATA_DIR` to its mount path (e.g. `/var/data`), or swap the JSON store for a real DB.

## 🔐 Security notes

- **Always set `ADMIN_PASSWORD`** before deploying. The default (`uno-admin-123`) is only for local testing.
- Rooms live in memory only — restarting the server clears all rooms (by design; it's a casual game).
- The access code is what keeps strangers out. Don't post it publicly.

---

## 🗂️ Project structure

```
UNO_GAME/
├── server.js        # Express + Socket.IO server, rooms, admin/god-view logic
├── game.js          # Pure UNO game engine (deck, rules, turns, win)
├── package.json
└── public/
    ├── index.html   # UI
    ├── style.css    # Styling (small-window friendly)
    └── client.js    # Browser logic (join, lobby, gameplay, god view)
```

Enjoy! 🎉
