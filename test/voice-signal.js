const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const alice = { clientId: 'voice-alice', name: 'alice', avatar: {} };
const bob = { clientId: 'voice-bob', name: 'bob', avatar: {} };

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
  aliceSocket.emit('create-room', { clientId: alice.clientId, name: alice.name, avatar: alice.avatar, settings: { rounds: 2, drawTimeSec: 30 } });
});

aliceSocket.on('joined-room', ({ roomId: rid }) => {
  roomId = rid;
  setTimeout(() => {
    bobSocket.emit('join-room', { clientId: bob.clientId, roomId, name: bob.name, avatar: bob.avatar });
  }, 100);
});

bobSocket.on('joined-room', ({ roomId: rid }) => {
  const ok = rid === roomId;
  report(ok, 'Bob joined the same room Alice created');
  if (!ok) return;
  setTimeout(() => {
    aliceSocket.emit('voice-enabled');
    bobSocket.emit('voice-enabled');
  }, 100);
});

bobSocket.on('connect', () => {
  // no-op until room is ready
});

bobSocket.on('voice-signal', ({ fromClientId, signal }) => {
  report(fromClientId === alice.clientId && signal && signal.marker === 'test', 'Bob received relayed voice-signal from Alice');
  cleanup();
});

aliceSocket.on('voice-signal', ({ fromClientId, signal }) => {
  if (fromClientId === bob.clientId && signal && signal.marker === 'response') {
    report(true, 'Alice received voice-signal response from Bob');
    cleanup();
  }
});

aliceSocket.on('room-update', (state) => {
  if (state.players.length === 2) {
    setTimeout(() => {
      aliceSocket.emit('voice-signal', { toClientId: bob.clientId, signal: { marker: 'test' } });
    }, 100);
  }
});

bobSocket.on('room-update', (state) => {
  if (roomId && state.players.length === 2 && state.hostId === alice.clientId) {
    setTimeout(() => {
      bobSocket.emit('voice-signal', { toClientId: alice.clientId, signal: { marker: 'response' } });
    }, 200);
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
  report(false, 'Voice signal relay test timed out');
  cleanup();
}, 5000);
