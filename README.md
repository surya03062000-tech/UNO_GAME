# 🎴 Private UNO Game

A real-time, multiplayer UNO card game you can run for your friends. **Invite-only**: only
people you give an access code to can join. You (the **admin**) get a secret **god view**
where you can see *everyone's* cards. Runs in a normal browser window, so you can keep it
small in a corner and play while you work.

---

## ✨ Features

- **Real-time multiplayer** (2–8 players) using Socket.IO
- **Access-code rooms** — admin creates a room, shares the 5-letter code; only people with the code can join
- **👑 Admin god view & controls** — admin sees every player's hand live, can **change the discard top card**, and **give/remove cards** from any player. Can also spectate any room with `Watch`.
- **Full UNO rules** — numbers, Skip, Reverse, Draw 2, Wild, Wild Draw 4, direction, draw pile auto-reshuffle, UNO call
- **Mercy-style extra cards** — **+6, +8, +10** wild draw cards (pick a color, next player draws that many)
- **Elimination play** — when you empty your hand you *finish* (ranked 🥇🥈🥉). The rest keep playing until only **one player is left** — that last player loses and the game ends. Then **anyone can start a new round**.
- **Anyone can start** — admin or any player can press Start (2+ players needed)
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
