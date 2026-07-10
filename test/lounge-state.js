const { io } = require('socket.io-client');

const URL = process.env.SERVER_URL || 'http://localhost:3000';
const alice = { clientId: 'lounge-alice', name: 'alice', avatar: {} };
const bob = { clientId: 'lounge-bob', name: 'bob', avatar: {} };
const carol = { clientId: 'lounge-carol', name: 'carol', avatar: {} };

const aliceSocket = io(URL, { transports: ['websocket'], reconnection: false });
const bobSocket = io(URL, { transports: ['websocket'], reconnection: false });
const carolSocket = io(URL, { transports: ['websocket'], reconnection: false });

let roomId;
let passed = 0;
let failed = 0;

function report(result, desc) {
  console.log(`${result ? 'PASS' : 'FAIL'}: ${desc}`);
  if (result) passed += 1; else failed += 1;
}

function cleanup() {
  [aliceSocket, bobSocket, carolSocket].forEach(s => s.connected && s.close());
  setTimeout(() => {
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  }, 100);
}

aliceSocket.on('connect', () => {
  aliceSocket.emit('create-room', { clientId: alice.clientId, name: alice.name, avatar: alice.avatar, settings: { rounds: 1, drawTimeSec: 30 } });
});

aliceSocket.on('joined-room', ({ roomId: rid }) => {
  roomId = rid;
  setTimeout(() => {
    bobSocket.emit('join-room', { clientId: bob.clientId, roomId, name: bob.name, avatar: bob.avatar });
    carolSocket.emit('join-room', { clientId: carol.clientId, roomId, name: carol.name, avatar: carol.avatar });
  }, 50);
});

const joined = new Set();
function maybeStartGame() {
  if (joined.has('alice') && joined.has('bob') && joined.has('carol')) {
    setTimeout(() => aliceSocket.emit('start-game'), 100);
  }
}

aliceSocket.on('joined-room', () => { joined.add('alice'); maybeStartGame(); });
bobSocket.on('joined-room', () => { joined.add('bob'); maybeStartGame(); });
carolSocket.on('joined-room', () => { joined.add('carol'); maybeStartGame(); });

let currentDrawer;
let word;

aliceSocket.on('phase-change', (data) => {
  if (data.phase === 'WORD_SELECT' && data.drawerId === alice.clientId) {
    currentDrawer = 'alice';
  }
});

aliceSocket.on('word-options', ({ options }) => {
  if (Array.isArray(options) && options.length > 0) {
    const choice = options[0];
    word = choice;
    setTimeout(() => aliceSocket.emit('select-word', { word: choice }), 50);
  }
});

bobSocket.on('phase-change', (data) => {
  if (data.phase === 'DRAWING' && data.drawerId === alice.clientId) {
    setTimeout(() => bobSocket.emit('chat-message', { text: 'notright' }), 50);
  }
});

carolSocket.on('phase-change', (data) => {
  if (data.phase === 'DRAWING' && data.drawerId === alice.clientId) {
    setTimeout(() => carolSocket.emit('chat-message', { text: word }), 150);
  }
});

let sawLoungeUpdate = false;
let receivedRoomUpdateWithLounge = false;
let loungeMatches = false;

bobSocket.on('voice-lounge-update', ({ lounge }) => {
  sawLoungeUpdate = true;
  const correctLounge = Array.isArray(lounge) && lounge.includes(alice.clientId) && lounge.includes(carol.clientId) && !lounge.includes(bob.clientId);
  report(correctLounge, 'Bob received lounge update showing only drawer and correct guesser');
});

bobSocket.on('room-update', (state) => {
  if (state.phase === 'DRAWING' && state.lounge) {
    receivedRoomUpdateWithLounge = true;
    report(Array.isArray(state.lounge) && state.lounge.includes(alice.clientId) && state.lounge.includes(carol.clientId) && !state.lounge.includes(bob.clientId), 'Room update includes lounge for DRAWING phase with correct guesser only');
  }
});

carolSocket.on('voice-lounge-update', ({ lounge }) => {
  const correctLounge = Array.isArray(lounge) && lounge.includes(alice.clientId) && lounge.includes(carol.clientId) && !lounge.includes(bob.clientId);
  report(correctLounge, 'Carol received lounge update for correct guesser only');
});

aliceSocket.on('correct-guess', () => {});

bobSocket.on('correct-guess', () => {});
carolSocket.on('correct-guess', () => {});

setTimeout(() => {
  report(sawLoungeUpdate, 'Lounge update event was emitted after a correct guess');
  report(receivedRoomUpdateWithLounge, 'Room update carried lounge state');
  cleanup();
}, 6000);
