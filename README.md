---
title: UNO Online
emoji: 🃏
colorFrom: red
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

# 🃏 UNO Online

A full multiplayer UNO game you can play with friends anywhere.
**No npm install needed** — uses only built-in Node.js!

---

## 🚀 Run locally

1. Install **Node.js** (v18+) → https://nodejs.org
2. In this folder run:
   ```
   node server.js
   ```
3. Open `http://localhost:3000` (friends on the same Wi-Fi can use the Network URL printed in the terminal).

## ☁️ Deploy on Hugging Face Spaces

1. Create a new Space → SDK **Docker** (blank template).
2. Push this repo to the Space (`Dockerfile`, `README.md`, `server.js`, `client.html`, `package.json`).
3. That's it. The header at the top of this README tells Spaces to expose port `7860`, which the `Dockerfile` sets via `PORT`.

Optional environment variables (Space settings → Variables):

| Variable           | Default  | Meaning                                                        |
|--------------------|----------|----------------------------------------------------------------|
| `PLAYER_GRACE_MS`  | `180000` | How long a disconnected player keeps their seat (3 min)        |
| `HOST_GRACE_MS`    | `60000`  | How long the host has to come back before the room closes      |
| `TURN_AUTOPASS_MS` | `20000`  | Wait on a disconnected player's turn before auto-drawing them  |

---

## 🎮 How to Play

1. One person clicks **Create Room** → gets a 6-letter room code
2. Others enter the code and click **Join Room**
3. Host clicks **▶ Start Game** (need at least 2 players)
4. Play UNO! Click a card to play it, click the deck to draw

### Rules implemented
- ✅ All number cards (0-9)
- ✅ Skip, Reverse, Draw 2
- ✅ Wild, Wild Draw 4
- ✅ Draw stacking (draw 2 + draw 2, wild4 on draw 2)
- ✅ UNO callout (press U or click UNO! button)
- ✅ Catch UNO button
- ✅ Up to 15 players per room
- ✅ Rematch + win scoreboard

### Online / disconnect handling
- 🔁 **Rejoin**: refresh the page, lose Wi-Fi or lock your phone — your seat is kept for 3 minutes and you land back in the same game with the same hand.
- ⏭️ If it's a disconnected player's turn, the game waits 20 s and then draws for them and moves on.
- 👑 If the **host** disconnects, they get 60 s to come back; otherwise the room closes and everyone is told the game ended. If the host clicks **Leave**, the room closes immediately.
- 🚪 Players who leave on purpose (or get kicked) are removed right away.

---

## 🛑 To Stop the Server
Press `Ctrl+C` in the terminal.
