const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const players = ['alice', 'bob', 'carol'].map(name => ({
  name,
  clientId: 'test-' + name,
  socket: io(URL, { transports: ['websocket'] })
}));

let roomId = null;
let errors = [];

function log(who, ...args) { console.log(`[${who}]`, ...args); }

players.forEach((p, i) => {
  p.socket.on('connect', () => {
    log(p.name, 'connected');
    if (i === 0) {
      p.socket.emit('create-room', { clientId: p.clientId, name: p.name, avatar: {}, settings: { rounds: 2, drawTimeSec: 30 } });
    }
  });

  p.socket.on('joined-room', ({ roomId: rid }) => {
    log(p.name, 'joined-room', rid);
    if (i === 0) {
      roomId = rid;
      setTimeout(() => {
        players.slice(1).forEach(other => {
          other.socket.emit('join-room', { clientId: other.clientId, roomId, name: other.name, avatar: {} });
        });
      }, 200);
    }
  });

  p.socket.on('join-error', (e) => { errors.push(`${p.name}: ${JSON.stringify(e)}`); log(p.name, 'JOIN ERROR', e); });

  p.socket.on('room-update', (state) => {
    log(p.name, 'room-update phase=', state.phase, 'players=', state.players.map(pl => pl.name + (pl.connected ? '' : '(off)')));
    if (i === 0 && state.phase === 'LOBBY' && state.players.length === 3 && !p._started) {
      p._started = true;
      setTimeout(() => p.socket.emit('start-game'), 300);
    }
  });

  p.socket.on('phase-change', (data) => {
    log(p.name, 'phase-change ->', data.phase, data.mask ? data.mask.join('') : '', data.word || '');
    if (data.phase === 'PODIUM') {
      log(p.name, 'PODIUM', JSON.stringify(data.podium));
    }
  });

  p.socket.on('word-options', ({ options }) => {
    log(p.name, 'word-options', options);
    setTimeout(() => p.socket.emit('select-word', { word: options[0] }), 200);
  });

  p.socket.on('your-word', ({ word }) => {
    p._word = word;
    global.__testWord = word; // side-channel just for this simulation script
    log(p.name, 'my word is', word);
    // simulate a couple of draw strokes
    p.socket.emit('draw-data', { strokeId: 1, x1: 10, y1: 10, x2: 50, y2: 50, color: '#000', size: 4 });
    p.socket.emit('draw-data', { strokeId: 1, x1: 50, y1: 50, x2: 90, y2: 90, color: '#000', size: 4 });
  });

  p.socket.on('hint-update', ({ mask }) => log(p.name, 'hint-update', mask.join('')));

  p.socket.on('draw-data', (seg) => { /* log(p.name, 'draw-data', seg); */ });

  p.socket.on('correct-guess', (d) => log(p.name, 'correct-guess', JSON.stringify(d)));
  p.socket.on('close-guess', (d) => log(p.name, 'close-guess', JSON.stringify(d)));
  p.socket.on('chat-message', (d) => log(p.name, 'chat', JSON.stringify(d)));
  p.socket.on('host-changed', (d) => log(p.name, 'host-changed', JSON.stringify(d)));

  // Non-drawers guess the word shortly after seeing the mask
  p.socket.on('phase-change', (data) => {
    if (data.phase === 'DRAWING' && data.drawerId !== p.clientId) {
      setTimeout(() => {
        // guess something wrong first (should NOT be revealed as close/correct publicly)
        p.socket.emit('chat-message', { text: 'notarealword' });
      }, 500);
      // The 2nd non-drawer guesses correctly a bit later, using the shared test word.
      if (p.name === 'bob' || p.name === 'carol') {
        setTimeout(() => {
          if (global.__testWord) p.socket.emit('chat-message', { text: global.__testWord });
        }, 1500 + (p.name === 'carol' ? 800 : 0));
      }
    }
  });
});

setTimeout(() => {
  console.log('\n=== TEST SUMMARY ===');
  console.log('Errors:', errors.length ? errors : 'none');
  process.exitCode = errors.length ? 1 : 0;
  players.forEach(p => p.socket.close());
}, 15000);

// After the first round finishes, have the host (alice) leave mid-lobby-wait
// and confirm the room survives with a migrated host.
setTimeout(() => {
  const alice = players[0];
  log('TEST', 'alice leaving room...');
  alice.socket.emit('leave-room');
}, 12000);
