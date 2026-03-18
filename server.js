#!/usr/bin/env node
/**
 * 🃏 Local UNO Server
 * No npm install needed — uses only Node.js built-ins!
 * Run: node server.js
 * Then open http://localhost:3000 in your browser
 * Friends on your Wi-Fi: http://YOUR-IP:3000
 */

const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

// ─── UNO Game Logic ────────────────────────────────────────────────────────────

const COLORS = ["red", "yellow", "green", "blue"];
const SPECIAL = ["skip", "reverse", "draw2"];
const WILD_CARDS = ["wild", "wild4"];

function buildDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push({ color, value: "0" });
    for (let i = 1; i <= 9; i++) {
      deck.push({ color, value: String(i) });
      deck.push({ color, value: String(i) });
    }
    for (const s of SPECIAL) {
      deck.push({ color, value: s });
      deck.push({ color, value: s });
    }
  }
  for (const w of WILD_CARDS) {
    for (let i = 0; i < 4; i++) deck.push({ color: "wild", value: w });
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardId(card) {
  return `${card.color}-${card.value}`;
}

function canPlay(card, topCard, currentColor) {
  if (card.value === "wild" || card.value === "wild4") return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

// ─── Room/Game State ───────────────────────────────────────────────────────────

const rooms = {}; // roomCode -> room
const players = {}; // socketId -> { roomCode, name, socketId }

function createRoom(hostId, hostName) {
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  rooms[code] = {
    code,
    hostId,
    players: [{ id: hostId, name: hostName, hand: [], connected: true }],
    state: "lobby", // lobby | playing | ended
    deck: [],
    discard: [],
    currentColor: null,
    currentPlayerIndex: 0,
    direction: 1, // 1=clockwise, -1=counter
    drawPending: 0,
    mustCallUno: null, // playerId who just played to 1 card without calling UNO early
    unoCalledWith2: [], // playerIds who called UNO while holding 2 cards
    winner: null,
  };
  players[hostId].roomCode = code;
  return code;
}

function getRoom(code) {
  return rooms[code];
}

function getRoomPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

function startGame(room) {
  // Use 2 decks for 9+ players so the deck doesn't run dry
  room.deck = shuffle(room.players.length >= 9 ? [...buildDeck(), ...buildDeck()] : buildDeck());
  room.discard = [];
  room.currentPlayerIndex = 0;
  room.direction = 1;
  room.drawPending = 0;
  room.winner = null;
  room.state = "playing";
  room.mustCallUno = null;
  room.unoCalledWith2 = [];

  // Deal 7 cards each
  for (const p of room.players) {
    p.hand = [];
    for (let i = 0; i < 7; i++) p.hand.push(room.deck.pop());
  }

  // Flip first card (skip wilds as starting card)
  let first;
  do {
    first = room.deck.pop();
    if (first.value === "wild" || first.value === "wild4") {
      room.deck.unshift(first);
      first = null;
    }
  } while (!first);

  room.discard.push(first);
  room.currentColor = first.color;

  // Apply first card effects
  if (first.value === "skip") {
    room.currentPlayerIndex = nextIndex(room, room.currentPlayerIndex);
  } else if (first.value === "reverse") {
    room.direction = -1;
    if (room.players.length === 2) {
      room.currentPlayerIndex = nextIndex(room, room.currentPlayerIndex);
    }
  } else if (first.value === "draw2") {
    room.drawPending = 2;
  }
}

function nextIndex(room, from) {
  const n = room.players.length;
  return ((from + room.direction) % n + n) % n;
}

function drawCards(room, playerId, count) {
  const player = getRoomPlayer(room, playerId);
  if (!player) return [];
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (room.deck.length === 0) {
      // Reshuffle discard except top
      const top = room.discard.pop();
      room.deck = shuffle(room.discard);
      room.discard = [top];
    }
    if (room.deck.length > 0) {
      const card = room.deck.pop();
      player.hand.push(card);
      drawn.push(card);
    }
  }
  return drawn;
}

// ─── WebSocket Server (pure Node built-in) ─────────────────────────────────────

// We implement a minimal WebSocket server using Node's net module
const net = require("net");

const wsClients = {}; // socketId -> { socket, send, id }

function wsHandshake(socket, request) {
  const key = request.match(/Sec-WebSocket-Key: (.+)/i)?.[1]?.trim();
  if (!key) return false;
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return true;
}

function wsDecode(buffer) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0];
  const b1 = buffer[1];
  const masked = (b1 & 0x80) !== 0;
  let payloadLen = b1 & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + (masked ? 4 : 0) + payloadLen) return null;
  let data;
  if (masked) {
    const mask = buffer.slice(offset, offset + 4);
    offset += 4;
    data = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) data[i] = buffer[offset + i] ^ mask[i % 4];
  } else {
    data = buffer.slice(offset, offset + payloadLen);
  }
  const opcode = b0 & 0x0f;
  return { opcode, data };
}

function wsEncode(message) {
  const data = Buffer.from(message, "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function sendTo(socketId, obj) {
  const client = wsClients[socketId];
  if (client) {
    try {
      client.socket.write(wsEncode(JSON.stringify(obj)));
    } catch (e) {}
  }
}

function broadcast(room, obj, excludeId) {
  for (const p of room.players) {
    if (p.id !== excludeId) sendTo(p.id, obj);
  }
}

function broadcastAll(room, obj) {
  for (const p of room.players) sendTo(p.id, obj);
}

function roomPublicState(room) {
  return {
    code: room.code,
    state: room.state,
    currentColor: room.currentColor,
    topCard: room.discard[room.discard.length - 1] || null,
    currentPlayerIndex: room.currentPlayerIndex,
    direction: room.direction,
    drawPending: room.drawPending,
    deckSize: room.deck.length,
    winner: room.winner,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      handSize: p.hand.length,
      connected: p.connected,
    })),
  };
}

function fullStateFor(room, playerId) {
  const pub = roomPublicState(room);
  const me = getRoomPlayer(room, playerId);
  pub.myHand = me ? me.hand : [];
  pub.myId = playerId;
  return pub;
}

function advanceTurn(room) {
  room.currentPlayerIndex = nextIndex(room, room.currentPlayerIndex);
}

function handleMessage(socketId, msg) {
  let data;
  try {
    data = JSON.parse(msg);
  } catch {
    return;
  }

  const { type } = data;

  // ── JOIN / CREATE ─────────────────────────────────────────────────────────
  if (type === "create") {
    const name = String(data.name || "Player").slice(0, 20);
    players[socketId] = { id: socketId, name, roomCode: null };
    const code = createRoom(socketId, name);
    sendTo(socketId, { type: "created", code });
    sendTo(socketId, { type: "state", ...fullStateFor(rooms[code], socketId) });
    return;
  }

  if (type === "join") {
    const name = String(data.name || "Player").slice(0, 20);
    const code = String(data.code || "").toUpperCase();
    const room = getRoom(code);
    if (!room) return sendTo(socketId, { type: "error", msg: "Room not found" });
    if (room.state !== "lobby") return sendTo(socketId, { type: "error", msg: "Game already started" });
    if (room.players.length >= 15) return sendTo(socketId, { type: "error", msg: "Room full (max 15)" });

    players[socketId] = { id: socketId, name, roomCode: code };
    room.players.push({ id: socketId, name, hand: [], connected: true });
    sendTo(socketId, { type: "joined", code });
    broadcastAll(room, { type: "state", ...fullStateFor(room, socketId) });
    // send individual states so each sees their own hand (empty in lobby)
    for (const p of room.players) {
      sendTo(p.id, { type: "state", ...fullStateFor(room, p.id) });
    }
    return;
  }

  const player = players[socketId];
  if (!player) return;
  const room = getRoom(player.roomCode);
  if (!room) return;

  // ── START GAME ────────────────────────────────────────────────────────────
  if (type === "start") {
    if (room.hostId !== socketId) return sendTo(socketId, { type: "error", msg: "Only host can start" });
    if (room.players.length < 2) return sendTo(socketId, { type: "error", msg: "Need at least 2 players" });
    if (room.state !== "lobby") return;
    startGame(room);
    for (const p of room.players) {
      sendTo(p.id, { type: "state", ...fullStateFor(room, p.id) });
    }
    return;
  }

  // ── PLAY CARD ─────────────────────────────────────────────────────────────
  if (type === "play") {
    if (room.state !== "playing") return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socketId) return sendTo(socketId, { type: "error", msg: "Not your turn" });

    const { cardIndex, chosenColor } = data;
    const hand = currentPlayer.hand;
    const card = hand[cardIndex];
    if (!card) return sendTo(socketId, { type: "error", msg: "Invalid card" });

    const topCard = room.discard[room.discard.length - 1];

    // If draw is pending, player must draw unless stacking
    if (room.drawPending > 0) {
      if (card.value === "draw2" && topCard.value === "draw2") {
        // stack allowed
      } else if (card.value === "wild4") {
        // stack wild4 on draw2? We allow wild4 stacking
      } else {
        return sendTo(socketId, { type: "error", msg: "You must draw cards first" });
      }
    }

    if (!canPlay(card, topCard, room.currentColor)) {
      return sendTo(socketId, { type: "error", msg: "Card cannot be played" });
    }

    // Remove from hand
    hand.splice(cardIndex, 1);
    room.discard.push(card);

    // Set color
    if (card.value === "wild" || card.value === "wild4") {
      if (!COLORS.includes(chosenColor)) return sendTo(socketId, { type: "error", msg: "Choose a color" });
      room.currentColor = chosenColor;
    } else {
      room.currentColor = card.color;
    }

    // Check win
    if (hand.length === 0) {
      room.state = "ended";
      room.winner = socketId;
      for (const p of room.players) {
        sendTo(p.id, { type: "state", ...fullStateFor(room, p.id) });
      }
      return;
    }

    // Check UNO (1 card left) — if player called UNO while at 2 cards, they're safe
    if (hand.length === 1) {
      const calledEarly = room.unoCalledWith2.includes(socketId);
      if (calledEarly) {
        room.unoCalledWith2 = room.unoCalledWith2.filter(id => id !== socketId);
        room.mustCallUno = null;
      } else {
        room.mustCallUno = socketId;
      }
    } else {
      room.mustCallUno = null;
      room.unoCalledWith2 = room.unoCalledWith2.filter(id => id !== socketId);
    }

    // Apply effects
    if (card.value === "skip") {
      advanceTurn(room); // skip next
      advanceTurn(room);
    } else if (card.value === "reverse") {
      room.direction *= -1;
      if (room.players.length === 2) {
        advanceTurn(room);
        advanceTurn(room);
      } else {
        advanceTurn(room);
      }
    } else if (card.value === "draw2") {
      room.drawPending += 2;
      advanceTurn(room);
    } else if (card.value === "wild4") {
      room.drawPending += 4;
      advanceTurn(room);
    } else {
      advanceTurn(room);
    }

    for (const p of room.players) {
      sendTo(p.id, { type: "state", ...fullStateFor(room, p.id) });
    }
    return;
  }

  // ── DRAW ──────────────────────────────────────────────────────────────────
  if (type === "draw") {
    if (room.state !== "playing") return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== socketId) return sendTo(socketId, { type: "error", msg: "Not your turn" });

    const count = room.drawPending > 0 ? room.drawPending : 1;
    room.drawPending = 0;
    drawCards(room, socketId, count);

    // After drawing, turn ends (can't play drawn card automatically)
    advanceTurn(room);

    for (const p of room.players) {
      sendTo(p.id, { type: "state", ...fullStateFor(room, p.id) });
    }
    return;
  }

  // ── CALL UNO ──────────────────────────────────────────────────────────────
  if (type === "uno") {
    const me = getRoomPlayer(room, socketId);
    if (!me) return;

    // Standard UNO call after playing to 1 card
    if (room.mustCallUno === socketId) {
      room.mustCallUno = null;
      broadcastAll(room, { type: "chat", msg: `🗣️ ${player.name} says UNO!` });
      return;
    }

    // Allow calling UNO early when player has 2 cards and at least one is playable
    if (room.state === "playing" && me.hand.length === 2) {
      const topCard = room.discard[room.discard.length - 1];
      if (topCard && me.hand.some(c => canPlay(c, topCard, room.currentColor))) {
        if (!room.unoCalledWith2.includes(socketId)) {
          room.unoCalledWith2.push(socketId);
          broadcastAll(room, { type: "chat", msg: `🗣️ ${player.name} says UNO!` });
        }
      }
    }
    return;
  }

  // ── CATCH UNO ─────────────────────────────────────────────────────────────
  if (type === "catch") {
    if (room.mustCallUno && room.mustCallUno !== socketId) {
      const caught = getRoomPlayer(room, room.mustCallUno);
      if (caught) {
        drawCards(room, room.mustCallUno, 2);
        broadcastAll(room, { type: "chat", msg: `😱 ${caught.name} was caught not saying UNO! +2 cards` });
        room.mustCallUno = null;
        for (const p of room.players) {
          sendTo(p.id, { type: "state", ...fullStateFor(room, p.id) });
        }
      }
    }
    return;
  }

  // ── CANCEL (send all players back to lobby) ───────────────────────────────
  if (type === "cancel") {
    if (room.hostId !== socketId) return;
    if (room.state === "lobby") return;
    room.state = "lobby";
    room.winner = null;
    room.deck = [];
    room.discard = [];
    room.mustCallUno = null;
    room.unoCalledWith2 = [];
    for (const p of room.players) p.hand = [];
    broadcastAll(room, { type: "chat", msg: `🚪 Host cancelled the game.` });
    for (const p of room.players) {
      sendTo(p.id, { type: "state", ...fullStateFor(room, p.id) });
    }
    return;
  }

  // ── RESTART (immediate new game, no lobby) ────────────────────────────────
  if (type === "restart") {
    if (room.hostId !== socketId) return;
    if (room.state === "lobby") return;
    startGame(room);
    broadcastAll(room, { type: "chat", msg: `🔄 Host restarted the game!` });
    for (const p of room.players) {
      sendTo(p.id, { type: "state", ...fullStateFor(room, p.id) });
    }
    return;
  }

  // ── REMATCH ───────────────────────────────────────────────────────────────
  if (type === "rematch") {
    if (room.hostId !== socketId) return;
    room.state = "lobby";
    room.winner = null;
    room.deck = [];
    room.discard = [];
    room.mustCallUno = null;
    room.unoCalledWith2 = [];
    for (const p of room.players) p.hand = [];
    for (const p of room.players) {
      sendTo(p.id, { type: "state", ...fullStateFor(room, p.id) });
    }
    return;
  }

  // ── CHAT ──────────────────────────────────────────────────────────────────
  if (type === "chat") {
    const text = String(data.text || "").slice(0, 200);
    broadcastAll(room, { type: "chat", msg: `💬 ${player.name}: ${text}` });
    return;
  }
}

// ─── HTTP + WebSocket Server ───────────────────────────────────────────────────

const clientHTML = require("fs").readFileSync(__dirname + "/client.html", "utf8");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(clientHTML);
});

server.on("upgrade", (req, socket, head) => {
  const buf = Buffer.concat([head]);
  let request = req.headers["sec-websocket-key"]
    ? `GET ${req.url} HTTP/1.1\r\nSec-WebSocket-Key: ${req.headers["sec-websocket-key"]}\r\n\r\n`
    : "";

  if (!wsHandshake(socket, request)) {
    socket.destroy();
    return;
  }

  const socketId = crypto.randomBytes(8).toString("hex");
  let buffer = Buffer.alloc(0);

  wsClients[socketId] = { socket, id: socketId };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 1) {
      const frame = wsDecode(buffer);
      if (!frame) break;
      if (frame.opcode === 8) {
        // close
        handleDisconnect(socketId);
        socket.destroy();
        return;
      }
      if (frame.opcode === 9) {
        // ping -> pong
        const pong = Buffer.alloc(2);
        pong[0] = 0x8a;
        pong[1] = 0;
        socket.write(pong);
      }
      if (frame.opcode === 1) {
        handleMessage(socketId, frame.data.toString("utf8"));
      }
      // advance buffer past this frame
      const b1 = buffer[1];
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) { payloadLen = buffer.readUInt16BE(2); offset = 4; }
      else if (payloadLen === 127) { payloadLen = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      offset += (masked ? 4 : 0) + payloadLen;
      buffer = buffer.slice(offset);
    }
  });

  socket.on("close", () => handleDisconnect(socketId));
  socket.on("error", () => handleDisconnect(socketId));
});

function handleDisconnect(socketId) {
  const player = players[socketId];
  if (player) {
    const room = getRoom(player.roomCode);
    if (room) {
      const pIdx = room.players.findIndex((p) => p.id === socketId);
      if (pIdx !== -1) {
        const rp = room.players[pIdx];

        if (room.state === "playing") {
          // Return the disconnected player's cards to the deck
          room.deck.push(...rp.hand);
          room.players.splice(pIdx, 1);

          // Clear UNO tracking for this player
          if (room.mustCallUno === socketId) room.mustCallUno = null;
          room.unoCalledWith2 = room.unoCalledWith2.filter((id) => id !== socketId);

          const remaining = room.players.length;
          if (remaining < 2) {
            // Not enough players to continue
            room.state = "ended";
            room.winner = remaining === 1 ? room.players[0].id : null;
          } else {
            // Adjust currentPlayerIndex to account for the removed slot
            if (pIdx < room.currentPlayerIndex) {
              room.currentPlayerIndex--;
            } else if (pIdx === room.currentPlayerIndex) {
              // Was their turn — the next player naturally slides into this index
              room.currentPlayerIndex = room.currentPlayerIndex % remaining;
            }
          }
        } else {
          room.players.splice(pIdx, 1);
        }

        if (room.players.length === 0) {
          delete rooms[room.code];
        } else {
          // If the host left, promote the first remaining player
          if (room.hostId === socketId) room.hostId = room.players[0].id;
          broadcast(room, { type: "chat", msg: `⚠️ ${player.name} left the game` });
          for (const p of room.players) {
            sendTo(p.id, { type: "state", ...fullStateFor(room, p.id) });
          }
        }
      }
    }
    delete players[socketId];
  }
  delete wsClients[socketId];
}

server.listen(PORT, "0.0.0.0", () => {
  const { networkInterfaces } = require("os");
  const nets = networkInterfaces();
  let localIP = "localhost";
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        localIP = net.address;
        break;
      }
    }
  }
  console.log(`\n🃏 UNO Server running!`);
  console.log(`\n   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${localIP}:${PORT}  ← share this with friends on your Wi-Fi\n`);
});
