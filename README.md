# 🎴 Private UNO Game

A real-time, multiplayer UNO card game you can run for your friends. **Invite-only**: only
people you give an access code to can join. You (the **admin**) get a secret **god view**
where you can see *everyone's* cards. Runs in a normal browser window, so you can keep it
small in a corner and play while you work.

---

## ✨ Features

- **Real-time multiplayer** (2–8 players) using Socket.IO
- **Access-code rooms** — admin creates a room, shares the 5-letter code; only people with the code can join
- **👑 Admin god view** — admin sees every player's hand live (and can spectate any room with `Watch`)
- **Full UNO rules** — numbers, Skip, Reverse, Draw 2, Wild, Wild Draw 4, direction, draw pile auto-reshuffle, UNO call, win detection
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

The app is one Node server, so any Node host works. **Render** has a free tier and is easiest:

### Option A — Render (recommended, free)
1. Push this repo to GitHub (already done if you're reading this there 🙂).
2. Go to [render.com](https://render.com) → **New** → **Web Service** → connect this repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Environment variable:** `ADMIN_PASSWORD` = *your secret password*
4. Deploy. You get a public URL like `https://your-uno.onrender.com`.
5. Share that URL + the room access code with your friends. Done!

### Option B — Railway / Fly.io / any VPS
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
