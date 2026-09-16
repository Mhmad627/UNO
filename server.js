#!/usr/bin/env node
/**
 * 🃏 UNO Online Server
 * No npm install needed — uses only Node.js built-ins!
 * Run: node server.js   (PORT env var overrides the default 3000)
 */

const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

const envMs = (name, fallback) => (process.env[name] ? Number(process.env[name]) : fallback);
// How long a disconnected player keeps their seat before being removed
const PLAYER_GRACE_MS = envMs("PLAYER_GRACE_MS", 3 * 60 * 1000);
// How long a disconnected host gets to come back before the room is closed
const HOST_GRACE_MS = envMs("HOST_GRACE_MS", 60 * 1000);
// How long we wait on a disconnected player's turn before auto-drawing for them
const TURN_AUTOPASS_MS = envMs("TURN_AUTOPASS_MS", 20 * 1000);
// WebSocket keepalive (Hugging Face / proxies drop idle sockets)
const PING_INTERVAL_MS = envMs("PING_INTERVAL_MS", 25 * 1000);
const SOCKET_TIMEOUT_MS = envMs("SOCKET_TIMEOUT_MS", 80 * 1000);

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

function canPlay(card, topCard, currentColor) {
  if (card.value === "wild" || card.value === "wild4") return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

// ─── Identity / Room State ─────────────────────────────────────────────────────
//
// playerId  – public, stable id shown to other players (survives reconnects)
// token     – secret, stored in the player's browser, used to reclaim a seat
// socketId  – transient, changes on every (re)connection

const rooms = {};    // roomCode -> room
const players = {};  // playerId -> { id, name, token, roomCode, socketId|null }
const tokens = {};   // token -> playerId
const sockets = {};  // socketId -> playerId

function newId(bytes = 8) {
  return crypto.randomBytes(bytes).toString("hex");
}

function createPlayer(name) {
  const p = { id: newId(6), name, token: newId(16), roomCode: null, socketId: null };
  players[p.id] = p;
  tokens[p.token] = p.id;
  return p;
}

function destroyPlayer(playerId) {
  const p = players[playerId];
  if (!p) return;
  if (p.socketId && sockets[p.socketId] === playerId) delete sockets[p.socketId];
  delete tokens[p.token];
  delete players[playerId];
}

function createRoom(host) {
  let code;
  do code = crypto.randomBytes(3).toString("hex").toUpperCase(); while (rooms[code]);
  rooms[code] = {
    code,
    hostId: host.id,
    players: [{ id: host.id, name: host.name, hand: [], connected: true, dcTimer: null }],
    state: "lobby", // lobby | playing | ended
    deck: [],
    discard: [],
    currentColor: null,
    currentPlayerIndex: 0,
    direction: 1,
    drawPending: 0,
    mustCallUno: null,
    unoCalledWith2: [],
    winner: null,
    scores: {},
    hostTimer: null,
    turnTimer: null,
  };
  host.roomCode = code;
  return rooms[code];
}

function getRoom(code) {
  return rooms[code];
}

function getRoomPlayer(room, id) {
  return room.players.find((p) => p.id === id);
}

function startGame(room) {
  room.deck = shuffle(room.players.length >= 9 ? [...buildDeck(), ...buildDeck()] : buildDeck());
  room.discard = [];
  room.currentPlayerIndex = 0;
  room.direction = 1;
  room.drawPending = 0;
  room.winner = null;
  room.state = "playing";
  room.mustCallUno = null;
  room.unoCalledWith2 = [];

  for (const p of room.players) {
    p.hand = [];
    for (let i = 0; i < 7; i++) p.hand.push(room.deck.pop());
  }

  const ACTION_VALUES = new Set(["wild", "wild4", "skip", "reverse", "draw2"]);
  let first;
  do {
    first = room.deck.pop();
    if (ACTION_VALUES.has(first.value)) {
      room.deck.unshift(first);
      first = null;
    }
  } while (!first);

  room.discard.push(first);
  room.currentColor = first.color;
}

function resetToLobby(room) {
  room.state = "lobby";
  room.winner = null;
  room.deck = [];
  room.discard = [];
  room.drawPending = 0;
  room.mustCallUno = null;
  room.unoCalledWith2 = [];
  for (const p of room.players) p.hand = [];
  clearTurnTimer(room);
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

function advanceTurn(room) {
  room.currentPlayerIndex = nextIndex(room, room.currentPlayerIndex);
}

// ─── WebSocket framing (pure Node built-in) ────────────────────────────────────

const wsClients = {}; // socketId -> { socket, id, lastSeen }

function wsHandshake(socket, key) {
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

// Returns { opcode, data, frameLength } or null if the buffer holds an incomplete frame
function wsDecode(buffer) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0];
  const b1 = buffer[1];
  const masked = (b1 & 0x80) !== 0;
  let payloadLen = b1 & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const total = offset + (masked ? 4 : 0) + payloadLen;
  if (buffer.length < total) return null;
  let data;
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    data = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) data[i] = buffer[offset + i] ^ mask[i % 4];
  } else {
    data = buffer.subarray(offset, offset + payloadLen);
  }
  return { opcode: b0 & 0x0f, data, frameLength: total };
}

function wsFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "", "utf8");
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

function sendRaw(socketId, obj) {
  const client = wsClients[socketId];
  if (!client) return;
  try {
    client.socket.write(wsFrame(0x1, JSON.stringify(obj)));
  } catch (e) {}
}

function sendTo(playerId, obj) {
  const p = players[playerId];
  if (p && p.socketId) sendRaw(p.socketId, obj);
}

function broadcastAll(room, obj) {
  for (const p of room.players) sendTo(p.id, obj);
}

function roomPublicState(room) {
  return {
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    currentColor: room.currentColor,
    topCard: room.discard[room.discard.length - 1] || null,
    currentPlayerIndex: room.currentPlayerIndex,
    direction: room.direction,
    drawPending: room.drawPending,
    deckSize: room.deck.length,
    winner: room.winner,
    scores: room.scores,
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

function pushState(room) {
  for (const p of room.players) {
    sendTo(p.id, { type: "state", ...fullStateFor(room, p.id) });
  }
  checkAutoTurn(room);
}

// ─── Disconnect / reconnect handling ───────────────────────────────────────────

function clearTurnTimer(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  room.turnTimer = null;
}

// If it's a disconnected player's turn, auto-draw and pass for them after a delay
function checkAutoTurn(room) {
  if (room.state !== "playing") return clearTurnTimer(room);
  const current = room.players[room.currentPlayerIndex];
  if (!current || current.connected) return clearTurnTimer(room);
  if (room.turnTimer) return;
  const targetId = current.id;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (room.state !== "playing") return;
    const cur = room.players[room.currentPlayerIndex];
    if (!cur || cur.id !== targetId || cur.connected) return;
    const count = room.drawPending > 0 ? room.drawPending : 1;
    room.drawPending = 0;
    drawCards(room, cur.id, count);
    if (room.mustCallUno === cur.id) room.mustCallUno = null;
    advanceTurn(room);
    broadcastAll(room, { type: "chat", msg: `⏭️ ${cur.name} is away — drew ${count} and was skipped.` });
    pushState(room);
  }, TURN_AUTOPASS_MS);
}

function closeRoom(room, reason) {
  clearTurnTimer(room);
  if (room.hostTimer) clearTimeout(room.hostTimer);
  for (const p of room.players) {
    if (p.dcTimer) clearTimeout(p.dcTimer);
    sendTo(p.id, { type: "room-closed", reason });
    destroyPlayer(p.id);
  }
  delete rooms[room.code];
}

// Remove a player permanently (kick, leave, or grace period expired)
function removePlayer(room, playerId, reasonMsg) {
  const pIdx = room.players.findIndex((p) => p.id === playerId);
  if (pIdx === -1) return;
  const rp = room.players[pIdx];
  if (rp.dcTimer) clearTimeout(rp.dcTimer);

  if (room.hostId === playerId) {
    closeRoom(room, "The host left — the game has ended.");
    return;
  }

  if (room.state === "playing") {
    room.deck.push(...rp.hand);
    room.players.splice(pIdx, 1);
    if (room.mustCallUno === playerId) room.mustCallUno = null;
    room.unoCalledWith2 = room.unoCalledWith2.filter((id) => id !== playerId);
    const remaining = room.players.length;
    if (remaining < 2) {
      room.state = "ended";
      clearTurnTimer(room);
      room.winner = remaining === 1 ? room.players[0].id : null;
      if (room.winner) room.scores[room.winner] = (room.scores[room.winner] || 0) + 1;
    } else {
      if (pIdx < room.currentPlayerIndex) room.currentPlayerIndex--;
      else if (pIdx === room.currentPlayerIndex) {
        // Hand the turn to whoever would have come next in the current direction.
        // Clockwise: the player that slid into this slot. Counter-clockwise: the one before it.
        room.currentPlayerIndex = room.direction === 1
          ? pIdx % remaining
          : (pIdx - 1 + remaining) % remaining;
        clearTurnTimer(room); // the turn moved to someone else
      }
    }
  } else {
    room.players.splice(pIdx, 1);
  }
  destroyPlayer(playerId);

  if (room.players.length === 0) {
    closeRoom(room, "Room closed.");
    return;
  }
  if (reasonMsg) broadcastAll(room, { type: "chat", msg: reasonMsg });
  pushState(room);
}

function handleDisconnect(socketId) {
  const playerId = sockets[socketId];
  delete sockets[socketId];
  delete wsClients[socketId];
  if (!playerId) return;

  const player = players[playerId];
  if (!player || player.socketId !== socketId) return; // already reconnected elsewhere
  player.socketId = null;

  const room = getRoom(player.roomCode);
  if (!room) return destroyPlayer(playerId);
  const rp = getRoomPlayer(room, playerId);
  if (!rp) return destroyPlayer(playerId);

  rp.connected = false;
  broadcastAll(room, { type: "chat", msg: `⚠️ ${player.name} disconnected — waiting for them to come back...` });

  if (rp.dcTimer) clearTimeout(rp.dcTimer);
  rp.dcTimer = setTimeout(() => {
    rp.dcTimer = null;
    if (rp.connected) return;
    removePlayer(room, playerId, `🚪 ${player.name} didn't come back and left the game.`);
  }, PLAYER_GRACE_MS);

  if (room.hostId === playerId) {
    if (room.hostTimer) clearTimeout(room.hostTimer);
    room.hostTimer = setTimeout(() => {
      room.hostTimer = null;
      if (rp.connected) return;
      closeRoom(room, "The host disconnected — the game has ended.");
    }, HOST_GRACE_MS);
  }

  pushState(room);
}

function bindSocket(player, socketId) {
  // Detach any previous socket for this player (e.g. a second tab / stale connection)
  if (player.socketId && player.socketId !== socketId) {
    const old = player.socketId;
    delete sockets[old];
    const client = wsClients[old];
    if (client) {
      sendRaw(old, { type: "replaced" });
      try { client.socket.destroy(); } catch (e) {}
      delete wsClients[old];
    }
  }
  // Detach whatever this socket was bound to before
  const prev = sockets[socketId];
  if (prev && prev !== player.id) leaveRoom(prev);
  player.socketId = socketId;
  sockets[socketId] = player.id;
}

function reconnectPlayer(player, room, socketId) {
  bindSocket(player, socketId);
  const rp = getRoomPlayer(room, player.id);
  const wasDisconnected = !rp.connected;
  rp.connected = true;
  if (rp.dcTimer) clearTimeout(rp.dcTimer);
  rp.dcTimer = null;
  if (room.hostId === player.id && room.hostTimer) {
    clearTimeout(room.hostTimer);
    room.hostTimer = null;
  }
  clearTurnTimer(room);
  sendTo(player.id, { type: "rejoined", code: room.code, token: player.token, name: player.name });
  if (wasDisconnected) broadcastAll(room, { type: "chat", msg: `✅ ${player.name} is back!` });
  pushState(room);
}

// Player voluntarily leaves (or is being replaced by a fresh create/join)
function leaveRoom(playerId, announce = true) {
  const player = players[playerId];
  if (!player) return;
  const room = getRoom(player.roomCode);
  if (room && getRoomPlayer(room, playerId)) {
    removePlayer(room, playerId, announce ? `🚪 ${player.name} left the game.` : null);
  } else {
    destroyPlayer(playerId);
  }
}

// A browser that still holds a token for an old seat is starting something new:
// free that seat right away instead of waiting for the grace period.
function abandonOldSeat(token) {
  const oldId = tokens[String(token || "")];
  if (oldId && players[oldId]) leaveRoom(oldId);
}

// ─── Message handling ──────────────────────────────────────────────────────────

function handleMessage(socketId, msg) {
  let data;
  try {
    data = JSON.parse(msg);
  } catch {
    return;
  }

  const { type } = data;

  // ── REJOIN (reclaim seat with token) ──────────────────────────────────────
  if (type === "rejoin") {
    const token = String(data.token || "");
    const playerId = tokens[token];
    const player = playerId && players[playerId];
    const room = player && getRoom(player.roomCode);
    if (!player || !room || !getRoomPlayer(room, player.id)) {
      return sendRaw(socketId, { type: "error", code: "no-session", msg: "That game is no longer available." });
    }
    reconnectPlayer(player, room, socketId);
    return;
  }

  // ── CREATE ────────────────────────────────────────────────────────────────
  if (type === "create") {
    const name = String(data.name || "Player").trim().slice(0, 20) || "Player";
    abandonOldSeat(data.token);
    const player = createPlayer(name);
    bindSocket(player, socketId);
    const room = createRoom(player);
    sendTo(player.id, { type: "created", code: room.code, token: player.token, name });
    pushState(room);
    return;
  }

  // ── JOIN ──────────────────────────────────────────────────────────────────
  if (type === "join") {
    const name = String(data.name || "Player").trim().slice(0, 20) || "Player";
    const code = String(data.code || "").trim().toUpperCase();
    const room = getRoom(code);
    if (!room) return sendRaw(socketId, { type: "error", msg: "Room not found" });

    // Same browser re-joining the room it already has a seat in → treat as rejoin
    const existingId = tokens[String(data.token || "")];
    const existing = existingId && players[existingId];
    if (existing && existing.roomCode === code && getRoomPlayer(room, existing.id)) {
      reconnectPlayer(existing, room, socketId);
      return;
    }

    if (room.state !== "lobby") return sendRaw(socketId, { type: "error", msg: "Game already started" });
    if (room.players.length >= 15) return sendRaw(socketId, { type: "error", msg: "Room full (max 15)" });

    abandonOldSeat(data.token);
    const player = createPlayer(name);
    bindSocket(player, socketId);
    player.roomCode = code;
    room.players.push({ id: player.id, name, hand: [], connected: true, dcTimer: null });
    sendTo(player.id, { type: "joined", code, token: player.token, name });
    broadcastAll(room, { type: "chat", msg: `👋 ${name} joined the room.` });
    pushState(room);
    return;
  }

  const playerId = sockets[socketId];
  const player = playerId && players[playerId];
  if (!player) return sendRaw(socketId, { type: "error", code: "no-session", msg: "You're not in a game." });
  const room = getRoom(player.roomCode);
  if (!room) return;
  const isHost = room.hostId === player.id;

  // ── LEAVE ─────────────────────────────────────────────────────────────────
  if (type === "leave") {
    leaveRoom(player.id);
    sendRaw(socketId, { type: "left" });
    return;
  }

  // ── START GAME ────────────────────────────────────────────────────────────
  if (type === "start") {
    if (!isHost) return sendTo(player.id, { type: "error", msg: "Only host can start" });
    if (room.players.length < 2) return sendTo(player.id, { type: "error", msg: "Need at least 2 players" });
    if (room.state !== "lobby") return;
    startGame(room);
    pushState(room);
    return;
  }

  // ── PLAY CARD ─────────────────────────────────────────────────────────────
  if (type === "play") {
    if (room.state !== "playing") return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== player.id) return sendTo(player.id, { type: "error", msg: "Not your turn" });

    const { cardIndex, chosenColor } = data;
    const hand = currentPlayer.hand;
    const card = hand[cardIndex];
    if (!card) return sendTo(player.id, { type: "error", msg: "Invalid card" });

    const topCard = room.discard[room.discard.length - 1];

    if (room.drawPending > 0) {
      if (card.value === "draw2" && topCard.value === "draw2") {
        // stack allowed
      } else if (card.value === "wild4") {
        // wild4 stacks on anything
      } else {
        return sendTo(player.id, { type: "error", msg: "You must draw cards first" });
      }
    }

    if (!canPlay(card, topCard, room.currentColor)) {
      return sendTo(player.id, { type: "error", msg: "Card cannot be played" });
    }

    if (card.value === "wild" || card.value === "wild4") {
      if (!COLORS.includes(chosenColor)) return sendTo(player.id, { type: "error", msg: "Choose a color" });
    }

    hand.splice(cardIndex, 1);
    room.discard.push(card);
    room.currentColor = card.color === "wild" ? chosenColor : card.color;

    if (hand.length === 0) {
      room.state = "ended";
      clearTurnTimer(room);
      room.winner = player.id;
      room.scores[player.id] = (room.scores[player.id] || 0) + 1;
      pushState(room);
      return;
    }

    if (hand.length === 1) {
      const calledEarly = room.unoCalledWith2.includes(player.id);
      if (calledEarly) {
        room.unoCalledWith2 = room.unoCalledWith2.filter((id) => id !== player.id);
        room.mustCallUno = null;
      } else {
        room.mustCallUno = player.id;
      }
    } else {
      room.mustCallUno = null;
      room.unoCalledWith2 = room.unoCalledWith2.filter((id) => id !== player.id);
    }

    if (card.value === "skip") {
      advanceTurn(room);
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

    clearTurnTimer(room);
    pushState(room);
    return;
  }

  // ── DRAW ──────────────────────────────────────────────────────────────────
  if (type === "draw") {
    if (room.state !== "playing") return;
    const currentPlayer = room.players[room.currentPlayerIndex];
    if (currentPlayer.id !== player.id) return sendTo(player.id, { type: "error", msg: "Not your turn" });

    const count = room.drawPending > 0 ? room.drawPending : 1;
    room.drawPending = 0;
    drawCards(room, player.id, count);
    advanceTurn(room);
    clearTurnTimer(room);
    pushState(room);
    return;
  }

  // ── CALL UNO ──────────────────────────────────────────────────────────────
  if (type === "uno") {
    const me = getRoomPlayer(room, player.id);
    if (!me) return;

    if (room.mustCallUno === player.id) {
      room.mustCallUno = null;
      broadcastAll(room, { type: "chat", msg: `🗣️ ${player.name} says UNO!` });
      return;
    }

    if (room.state === "playing" && me.hand.length === 2) {
      const topCard = room.discard[room.discard.length - 1];
      if (topCard && me.hand.some((c) => canPlay(c, topCard, room.currentColor))) {
        if (!room.unoCalledWith2.includes(player.id)) {
          room.unoCalledWith2.push(player.id);
          broadcastAll(room, { type: "chat", msg: `🗣️ ${player.name} says UNO!` });
        }
      }
    }
    return;
  }

  // ── CATCH UNO ─────────────────────────────────────────────────────────────
  if (type === "catch") {
    if (room.mustCallUno && room.mustCallUno !== player.id) {
      const caught = getRoomPlayer(room, room.mustCallUno);
      if (caught) {
        drawCards(room, room.mustCallUno, 2);
        broadcastAll(room, { type: "chat", msg: `😱 ${caught.name} was caught not saying UNO! +2 cards` });
        room.mustCallUno = null;
        pushState(room);
      }
    }
    return;
  }

  // ── CANCEL (send all players back to lobby) ───────────────────────────────
  if (type === "cancel") {
    if (!isHost || room.state === "lobby") return;
    resetToLobby(room);
    broadcastAll(room, { type: "chat", msg: `🚪 Host cancelled the game.` });
    pushState(room);
    return;
  }

  // ── RESTART (immediate new game, no lobby) ────────────────────────────────
  if (type === "restart") {
    if (!isHost || room.state === "lobby") return;
    if (room.players.length < 2) return sendTo(player.id, { type: "error", msg: "Need at least 2 players" });
    startGame(room);
    broadcastAll(room, { type: "chat", msg: `🔄 Host restarted the game!` });
    pushState(room);
    return;
  }

  // ── REMATCH (back to lobby) ───────────────────────────────────────────────
  if (type === "rematch") {
    if (!isHost) return;
    resetToLobby(room);
    pushState(room);
    return;
  }

  // ── KICK ──────────────────────────────────────────────────────────────────
  if (type === "kick") {
    if (!isHost) return;
    const targetId = data.targetId;
    if (!targetId || targetId === player.id) return;
    const kicked = getRoomPlayer(room, targetId);
    if (!kicked) return;
    sendTo(targetId, { type: "kicked" });
    removePlayer(room, targetId, `👢 ${kicked.name} was kicked by the host.`);
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
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, rooms: Object.keys(rooms).length }));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(clientHTML);
});

server.on("upgrade", (req, socket, head) => {
  if (!wsHandshake(socket, req.headers["sec-websocket-key"])) {
    socket.destroy();
    return;
  }

  const socketId = newId(8);
  let buffer = Buffer.from(head || []);
  wsClients[socketId] = { socket, id: socketId, lastSeen: Date.now() };
  socket.setNoDelay(true);

  const processBuffer = () => {
    while (buffer.length >= 2) {
      const frame = wsDecode(buffer);
      if (!frame) break;
      buffer = buffer.subarray(frame.frameLength);
      const client = wsClients[socketId];
      if (client) client.lastSeen = Date.now();

      if (frame.opcode === 8) {
        try { socket.write(wsFrame(0x8, frame.data.subarray(0, 2))); } catch (e) {}
        handleDisconnect(socketId);
        socket.destroy();
        return;
      }
      if (frame.opcode === 9) {
        try { socket.write(wsFrame(0xa, frame.data)); } catch (e) {}
      } else if (frame.opcode === 1) {
        handleMessage(socketId, frame.data.toString("utf8"));
      }
      // opcode 10 (pong) and anything else: nothing to do beyond updating lastSeen
    }
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    processBuffer();
  });
  socket.on("close", () => handleDisconnect(socketId));
  socket.on("error", () => handleDisconnect(socketId));
  processBuffer();
});

// Keepalive: ping every client; drop sockets that have gone silent
setInterval(() => {
  const now = Date.now();
  for (const [socketId, client] of Object.entries(wsClients)) {
    if (now - client.lastSeen > SOCKET_TIMEOUT_MS) {
      handleDisconnect(socketId);
      try { client.socket.destroy(); } catch (e) {}
      continue;
    }
    try { client.socket.write(wsFrame(0x9, "")); } catch (e) {}
  }
}, PING_INTERVAL_MS);

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
  console.log(`   Network: http://${localIP}:${PORT}\n`);
});
