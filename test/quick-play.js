const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const alice = { clientId: 'quick-alice', name: 'alice', avatar: {} };
const bob = { clientId: 'quick-bob', name: 'bob', avatar: {} };

const aliceSocket = io(URL, { transports: ['websocket'], reconnection: false });
const bobSocket = io(URL, { transports: ['websocket'], reconnection: false });

let roomId;
let passed = 0;
let failed = 0;

function report(result, desc) {
  console.log(`${result ? 'PASS' : 'FAIL'}: ${desc}`);
  if (result) passed += 1; else failed += 1;
}

aliceSocket.on('connect', () => {
  aliceSocket.emit('quick-play', { clientId: alice.clientId, name: alice.name, avatar: alice.avatar });
});

aliceSocket.on('joined-room', ({ roomId: rid }) => {
  report(!!rid, 'Alice received roomId for quick-play');
  roomId = rid;
  setTimeout(() => {
    bobSocket.emit('quick-play', { clientId: bob.clientId, name: bob.name, avatar: bob.avatar });
  }, 100);
});

bobSocket.on('joined-room', ({ roomId: rid }) => {
  report(rid === roomId, 'Bob joined the same public quick-play room');
});

let aliceRoomUpdateCount = 0;

aliceSocket.on('room-update', (state) => {
  if (!roomId) return;
  aliceRoomUpdateCount += 1;
  if (state.players.length >= 2) {
    report(state.players.some(p => p.id === alice.clientId), 'Alice still in quick-play lobby');
    report(state.players.some(p => p.id === bob.clientId), 'Bob joined quick-play lobby');
    if (state.hostId === alice.clientId) {
      aliceSocket.emit('start-game');
    }
  }
});

aliceSocket.on('phase-change', (data) => {
  if (data.phase === 'WORD_SELECT') {
    report(true, 'Quick-play room started game successfully');
    cleanup();
  }
});

bobSocket.on('phase-change', (data) => {
  if (data.phase === 'WORD_SELECT') {
    report(true, 'Quick-play participant received game start');
  }
});

function cleanup() {
  if (aliceSocket.connected) aliceSocket.close();
  if (bobSocket.connected) bobSocket.close();
  setTimeout(() => {
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  }, 100);
}

setTimeout(() => {
  report(false, 'Quick-play test timed out');
  cleanup();
}, 8000);
