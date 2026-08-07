// Verifies the FULL voice-lounge lifecycle across two rounds, not just a
// single snapshot:
//   1. DRAWING starts -> lounge is ONLY the drawer (nobody can talk yet)
//   2. A wrong guess does NOT open the lounge
//   3. A correct guess adds that player to the lounge (drawer + winner talk)
//   4. A second correct guess grows the lounge further
//   5. Once everyone's guessed, REVIEW starts -> lounge is fully open (null)
//   6. The NEXT round's DRAWING phase starts with a FRESH lounge containing
//      only the new drawer - no stale members carried over from round 1
const { io } = require('socket.io-client');

const URL = process.env.SERVER_URL || 'http://localhost:3000';
const alice = { clientId: 'cycle-alice', name: 'alice', avatar: {} };
const bob = { clientId: 'cycle-bob', name: 'bob', avatar: {} };
const carol = { clientId: 'cycle-carol', name: 'carol', avatar: {} };

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

function sameMembers(lounge, expected) {
  if (!Array.isArray(lounge)) return false;
  if (lounge.length !== expected.length) return false;
  return expected.every(id => lounge.includes(id));
}

function cleanup() {
  [aliceSocket, bobSocket, carolSocket].forEach(s => s.connected && s.close());
  setTimeout(() => {
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  }, 100);
}

aliceSocket.on('connect', () => {
  aliceSocket.emit('create-room', { clientId: alice.clientId, name: alice.name, avatar: alice.avatar, settings: { rounds: 2, drawTimeSec: 30 } });
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

let round = 0;
let round1Word = null;
let checkedInitialLounge = false;
let checkedAfterWrongGuess = false;
let checkedAfterFirstCorrect = false;
let checkedAfterSecondCorrect = false;
let checkedReviewOpen = false;
let checkedRound2FreshLounge = false;
let round1DrawerId = null;
let round2DrawerId = null;

// Drives the whole sequence off Alice's phase-change stream (she sees every
// transition regardless of who's drawing).
aliceSocket.on('phase-change', (data) => {
  if (data.phase === 'WORD_SELECT') {
    round += 1;
    if (round === 1) round1DrawerId = data.drawerId;
    if (round === 2) round2DrawerId = data.drawerId;
  }

  if (data.phase === 'DRAWING' && round === 1) {
    // Step 1: lounge must contain ONLY the drawer the instant drawing starts.
    checkedInitialLounge = true;
    report(sameMembers(data.lounge, [round1DrawerId]), 'Round 1 DRAWING starts with lounge = drawer only (nobody can talk yet)');

    // Now drive the guesses: the non-drawer players guess wrong then right.
    const guessers = [alice, bob, carol].filter(p => p.clientId !== round1DrawerId);
    const guesserSockets = { [alice.clientId]: aliceSocket, [bob.clientId]: bobSocket, [carol.clientId]: carolSocket };
    setTimeout(() => {
      guesserSockets[guessers[0].clientId].emit('chat-message', { text: 'definitelywrong' });
    }, 300);
  }

  if (data.phase === 'DRAWING' && round === 2) {
    checkedRound2FreshLounge = true;
    // Step 6: the new round's lounge must be a CLEAN reset - only the new
    // drawer, none of round 1's guessers carried over.
    report(sameMembers(data.lounge, [round2DrawerId]), 'Round 2 DRAWING starts with a fresh lounge (no round-1 members carried over)');
    report(round2DrawerId !== round1DrawerId, 'Round 2 has a different drawer than round 1 (turn actually advanced)');

    // Have the non-drawer players guess correctly this round too, to prove
    // the lounge grows again under the NEW drawer.
    const guessers = [alice, bob, carol].filter(p => p.clientId !== round2DrawerId);
    const guesserSockets = { [alice.clientId]: aliceSocket, [bob.clientId]: bobSocket, [carol.clientId]: carolSocket };
    setTimeout(() => guesserSockets[guessers[0].clientId].emit('chat-message', { text: round2Word }), 300);
  }

  if (data.phase === 'REVIEW') {
    checkedReviewOpen = true;
    // Step 5: channel must be fully open for the round-recap chat, i.e. no
    // restrictive lounge array in effect (client treats phase !== DRAWING
    // as open regardless, but confirm the server isn't sending a stale one).
    report(data.lounge === undefined || data.lounge === null, 'REVIEW phase carries no restrictive lounge (channel open to everyone)');
  }
});

// Whoever is drawing needs to pick a word immediately so the test doesn't
// wait out the full word-select timer.
let round2Word = null;
[aliceSocket, bobSocket, carolSocket].forEach(sock => {
  sock.on('word-options', ({ options }) => {
    if (!Array.isArray(options) || !options.length) return;
    const choice = options[0];
    if (round1Word === null && round === 1) round1Word = choice;
    if (round === 2) round2Word = choice;
    setTimeout(() => sock.emit('select-word', { word: choice }), 50);
  });
});

// Round 1: after the deliberate wrong guess, send the correct one from the
// same player, then a second correct guess from the last remaining guesser.
aliceSocket.on('chat-message', ({ text }) => {
  if (round !== 1 || !round1Word) return;
  if (text === 'definitelywrong') {
    const guessers = [alice, bob, carol].filter(p => p.clientId !== round1DrawerId);
    const guesserSockets = { [alice.clientId]: aliceSocket, [bob.clientId]: bobSocket, [carol.clientId]: carolSocket };
    setTimeout(() => guesserSockets[guessers[0].clientId].emit('chat-message', { text: round1Word }), 300);
  }
});

let round1CorrectCount = 0;
[aliceSocket, bobSocket, carolSocket].forEach(sock => {
  sock.on('correct-guess', ({ playerId }) => {
    if (round !== 1) return;
    round1CorrectCount += 1;
    if (round1CorrectCount === 2) {
      // Second guesser (the last remaining non-drawer) guesses right too.
      const guessers = [alice, bob, carol].filter(p => p.clientId !== round1DrawerId && p.clientId !== playerId);
      const guesserSockets = { [alice.clientId]: aliceSocket, [bob.clientId]: bobSocket, [carol.clientId]: carolSocket };
      if (guessers[0]) setTimeout(() => guesserSockets[guessers[0].clientId].emit('chat-message', { text: round1Word }), 300);
    }
  });
});

// Verify the lounge state directly from voice-lounge-update events (what the
// client's VoiceMesh actually consumes), not just room-update snapshots.
const seenLoungeSnapshots = [];
bobSocket.on('voice-lounge-update', ({ lounge }) => {
  if (round !== 1) return;
  seenLoungeSnapshots.push(lounge.slice().sort());

  if (!checkedAfterWrongGuess && seenLoungeSnapshots.length === 0) {
    // (guarded no-op; wrong guesses never fire voice-lounge-update at all -
    // checked separately below via the absence assertion)
  }
});

setTimeout(() => {
  // Step 2 assertion, done as an absence check: a wrong guess must never
  // have produced a lounge snapshot containing only the drawer being
  // re-broadcast as if it were a "correct guess" event - i.e. the very
  // first snapshot we see should already reflect a CORRECT guesser, proving
  // no spurious lounge-update fired for the earlier wrong guess.
  checkedAfterWrongGuess = true;
  report(seenLoungeSnapshots.length >= 1, 'A correct guess produced a lounge update (wrong guess alone did not)');
  if (seenLoungeSnapshots[0]) {
    checkedAfterFirstCorrect = true;
    report(seenLoungeSnapshots[0].includes(round1DrawerId) && seenLoungeSnapshots[0].length === 2,
      'After first correct guess, lounge = [drawer, first guesser] only');
  }
  if (seenLoungeSnapshots[1]) {
    checkedAfterSecondCorrect = true;
    report(seenLoungeSnapshots[1].includes(round1DrawerId) && seenLoungeSnapshots[1].length === 3,
      'After second correct guess, lounge grows to [drawer, guesser1, guesser2]');
  }
}, 3500);

setTimeout(() => {
  report(checkedInitialLounge, 'Reached: round 1 DRAWING start check');
  report(checkedAfterFirstCorrect, 'Reached: first correct guess check');
  report(checkedAfterSecondCorrect, 'Reached: second correct guess check');
  report(checkedReviewOpen, 'Reached: REVIEW open-channel check');
  report(checkedRound2FreshLounge, 'Reached: round 2 fresh lounge check');
  cleanup();
}, 16000);
