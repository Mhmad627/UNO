# 🃏 Local UNO

A full multiplayer UNO game that runs on your local network.
**No npm install needed** — uses only built-in Node.js!

---

## 🚀 How to Run

1. Make sure you have **Node.js** installed (v14+)
   → Download at https://nodejs.org

2. Open a terminal in this folder and run:
   ```
   node server.js
   ```

3. You'll see something like:
   ```
   🃏 UNO Server running!

      Local:   http://localhost:3000
      Network: http://192.168.1.5:3000  ← share this with friends on your Wi-Fi
   ```

4. **You** open `http://localhost:3000`
   **Friends on your Wi-Fi** open the Network URL shown in the terminal

---

## 🎮 How to Play

1. One person clicks **Create Room** → gets a 6-letter room code
2. Others enter the code and click **Join Room**
3. Host clicks **▶ Start Game** (need at least 2 players)
4. Play UNO! Click a card to play it, click the deck to draw

### Rules implemented:
- ✅ All number cards (0-9)
- ✅ Skip, Reverse, Draw 2
- ✅ Wild, Wild Draw 4
- ✅ Draw stacking (draw 2 + draw 2, wild4 on draw 2)
- ✅ UNO callout (press U or click UNO! button)
- ✅ Catch UNO button
- ✅ Up to 8 players per room
- ✅ Rematch

---

## 🛑 To Stop the Server
Press `Ctrl+C` in the terminal.
