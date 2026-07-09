const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const RoomManager = require('./server/RoomManager');
const { sanitizeWord } = require('./server/words');
const { MAX_PLAYERS_PRIVATE } = require('./server/constants');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Faster dead-connection detection than the defaults: on a flaky mobile
  // connection or a Render free-tier hiccup, a socket can go silently dead
  // for a while before Socket.io notices and reconnects it - during that
  // window, broadcasts (phase-change, room-update) are lost. Shorter
  // intervals mean the client reconnects and re-syncs sooner instead of
  // being stuck showing a stale screen.
  pingInterval: 6000,
  pingTimeout: 8000
});

const roomManager = new RoomManager(io);

app.use(express.static(path.join(__dirname, 'public')));

// Health endpoint - also useful as an uptime-monitor ping target to reduce
// Render free-tier cold starts if you wire an external pinger to it.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: roomManager.roomCount(), uptime: process.uptime() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  socket.data.clientId = null;
  socket.data.roomId = null;

  function currentRoom() {
    if (!socket.data.roomId) return null;
    return roomManager.getRoom(socket.data.roomId);
  }

  socket.on('quick-play', ({ clientId, name, avatar }) => {
    if (!clientId) return;
    const room = roomManager.findOrCreatePublicRoom();
    joinRoomSocket(room, clientId, name, avatar);
  });

  socket.on('create-room', ({ clientId, name, avatar, settings }) => {
    if (!clientId) return;
    const room = roomManager.createPrivateRoom(settings || {});
    joinRoomSocket(room, clientId, name, avatar);
  });

  socket.on('join-room', ({ clientId, roomId, name, avatar }) => {
    if (!clientId || !roomId) return;
    const room = roomManager.getRoom(roomId);
    if (!room) {
      socket.emit('join-error', { message: 'Room not found.' });
      return;
    }
    if (!room.players.has(clientId) && room.players.size >= MAX_PLAYERS_PRIVATE) {
      socket.emit('join-error', { message: 'Room is full.' });
      return;
    }
    joinRoomSocket(room, clientId, name, avatar);
  });

  socket.on('rejoin', ({ clientId, roomId }) => {
    const room = roomManager.getRoom(roomId);
    if (!room || !room.players.has(clientId)) {
      socket.emit('join-error', { message: 'Session expired.' });
      return;
    }
    room.reconnectPlayer(clientId, socket.id);
    socket.data.clientId = clientId;
    socket.data.roomId = roomId;
    socket.join(roomId);
    room.broadcastRoomUpdate();
    socket.emit('sync-state', room.getSyncPayload(clientId));
    if (room.phase === 'WORD_SELECT' && room.currentDrawerId === clientId) {
      socket.emit('word-options', { options: room.wordOptions });
    }
  });

  // Cheap self-heal: the client can call this any time (periodically, on tab
  // refocus, etc.) to pull a fresh snapshot in case a broadcast was missed
  // during a silent connection hiccup, without needing a full disconnect/
  // reconnect cycle to be detected first.
  socket.on('request-state', () => {
    const room = currentRoom();
    if (!room || !socket.data.clientId) return;
    socket.emit('sync-state', room.getSyncPayload(socket.data.clientId));
    if (room.phase === 'WORD_SELECT' && room.currentDrawerId === socket.data.clientId) {
      socket.emit('word-options', { options: room.wordOptions });
    }
  });

  function joinRoomSocket(room, clientId, name, avatar) {
    const existing = room.players.get(clientId);
    let player;
    if (existing) {
      player = room.reconnectPlayer(clientId, socket.id);
    } else {
      player = room.addPlayer(clientId, socket.id, name, avatar);
    }
    socket.data.clientId = clientId;
    socket.data.roomId = room.id;
    socket.join(room.id);

    room.broadcastRoomUpdate();
    socket.emit('joined-room', { roomId: room.id, isPublic: room.isPublic, you: player });
    socket.emit('sync-state', room.getSyncPayload(clientId));
    if (room.phase === 'WORD_SELECT' && room.currentDrawerId === clientId) {
      socket.emit('word-options', { options: room.wordOptions });
    }
  }

  socket.on('update-settings', (settings) => {
    const room = currentRoom();
    if (room) room.updateSettings(socket.data.clientId, settings);
  });

  socket.on('start-game', () => {
    const room = currentRoom();
    if (!room) return;
    const result = room.startGame(socket.data.clientId);
    if (!result.ok) {
      socket.emit('action-error', { message: result.reason });
    }
  });

  socket.on('play-again', () => {
    const room = currentRoom();
    if (!room) return;
    const result = room.playAgain(socket.data.clientId);
    if (!result.ok) {
      socket.emit('action-error', { message: result.reason });
    }
  });

  socket.on('select-word', ({ word }) => {
    const room = currentRoom();
    if (room) room.selectWord(socket.data.clientId, sanitizeWord(word));
  });

  socket.on('draw-data', (data) => {
    const room = currentRoom();
    if (room) room.handleDrawData(socket.data.clientId, data);
  });

  socket.on('clear-canvas', () => {
    const room = currentRoom();
    if (room) room.handleClearCanvas(socket.data.clientId);
  });

  socket.on('undo', () => {
    const room = currentRoom();
    if (room) room.handleUndo(socket.data.clientId);
  });

  socket.on('chat-message', ({ text }) => {
    const room = currentRoom();
    if (room) room.handleChatMessage(socket.data.clientId, text);
  });

  socket.on('leave-room', () => {
    const room = currentRoom();
    if (room && socket.data.clientId) {
      socket.leave(room.id);
      room.removePlayerPermanently(socket.data.clientId);
    }
    socket.data.roomId = null;
  });

  // --- Latency heartbeat (drives the client's ping indicator) ---
  socket.on('heartbeat', (ts) => {
    socket.emit('heartbeat-ack', ts);
  });

  // --- WebRTC signaling relay (scaffolded; inert until client enables voice) ---
  socket.on('voice-signal', ({ toClientId, signal }) => {
    const room = currentRoom();
    if (!room) return;
    const target = room.players.get(toClientId);
    if (target && target.socketId) {
      io.to(target.socketId).emit('voice-signal', { fromClientId: socket.data.clientId, signal });
    }
  });

  socket.on('disconnect', () => {
    const room = currentRoom();
    if (room && socket.data.clientId) {
      room.disconnectPlayer(socket.data.clientId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Skrub server listening on port ${PORT}`);
});
