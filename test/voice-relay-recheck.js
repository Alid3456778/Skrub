// Unit test for VoiceMesh's "escape TURN relay" logic in isolation - no
// real server, sockets, or WebRTC needed. Verifies:
//   1. Landing on a relay path schedules a retry
//   2. Each retry, while still on relay, schedules another - up to the cap
//   3. After the cap, it stops trying (no more scheduled retries)
//   4. Landing on a DIRECT path at any point clears everything and stops
// Uses a fake timer queue instead of real setTimeout delays so the test
// runs instantly rather than waiting ~4 x 45s in real time.

// --- Fake timer queue (must be installed before importing voice.js) ---
let timerQueue = [];
let nextId = 1;
global.setTimeout = (fn, ms) => {
  const id = nextId++;
  timerQueue.push({ id, fn, ms });
  return id;
};
global.clearTimeout = (id) => {
  timerQueue = timerQueue.filter(t => t.id !== id);
};
async function fireNextTimer() {
  const t = timerQueue.shift();
  if (!t) throw new Error('No timer was scheduled when one was expected');
  await t.fn();
}

let passed = 0, failed = 0;
function report(result, desc) {
  console.log(`${result ? 'PASS' : 'FAIL'}: ${desc}`);
  if (result) passed += 1; else failed += 1;
}

function relayStats() {
  return new Map([
    ['pair1', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local1' }],
    ['local1', { candidateType: 'relay' }]
  ]);
}
function directStats() {
  return new Map([
    ['pair1', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local1' }],
    ['local1', { candidateType: 'srflx' }]
  ]);
}

(async () => {
  const { VoiceMesh } = await import('../public/js/voice.js');
  const fakeSocket = { on: () => {}, emit: () => {} };
  const mesh = new VoiceMesh(fakeSocket, 'me');

  let renegotiateCalls = 0;
  mesh._renegotiate = async () => { renegotiateCalls += 1; };

  // Baseline for scenarios A-C: DRAWING phase, peer not in the lounge with
  // me - i.e. we're muted to them, a safe window for the gate to allow
  // through. (Scenario D/E below deliberately override this to test the
  // gate itself.)
  mesh._phase = 'DRAWING';
  mesh._lounge = ['me'];

  // --- Scenario A: stuck on relay the whole time -> retries up to the cap, then stops ---
  const pcA = { iceConnectionState: 'connected', getStats: async () => relayStats() };
  mesh.peers.set('peerA', pcA);

  await mesh._reportPeerState('peerA', pcA);
  report(timerQueue.length === 1, 'Landing on relay schedules exactly one retry');

  for (let i = 1; i <= 4; i++) {
    await fireNextTimer();
    report(renegotiateCalls === i, `Retry ${i}/4 actually attempted renegotiation`);
    report(mesh.relayRecheckAttempts.get('peerA') === i, `Attempt counter is ${i} after retry ${i}`);
    // Simulate: still on relay after that renegotiation attempt.
    await mesh._reportPeerState('peerA', pcA);
  }
  report(renegotiateCalls === 4, 'Stopped at exactly 4 renegotiation attempts (the cap), not more');
  report(timerQueue.length === 0, 'No further retry scheduled once the cap is reached');

  // --- Scenario B: upgrades to a direct path partway through -> stops immediately ---
  timerQueue = [];
  renegotiateCalls = 0;
  const pcB = { iceConnectionState: 'connected', getStats: async () => relayStats() };
  mesh.peers.set('peerB', pcB);

  await mesh._reportPeerState('peerB', pcB); // relay -> schedules retry 1
  await fireNextTimer();                     // retry 1 fires
  report(mesh.relayRecheckAttempts.get('peerB') === 1, 'Peer B: one retry attempted so far');

  // Now the retry succeeded and the pair is on a direct path.
  pcB.getStats = async () => directStats();
  await mesh._reportPeerState('peerB', pcB);
  report(!mesh.relayRecheckTimers.has('peerB'), 'Peer B: no retry left scheduled after upgrading to direct');
  report(!mesh.relayRecheckAttempts.has('peerB'), 'Peer B: attempt counter cleared after upgrading to direct');
  report(timerQueue.length === 0, 'Peer B: nothing left in the timer queue after upgrading');

  // --- Scenario C: teardown mid-wait cancels the pending retry cleanly ---
  timerQueue = [];
  const pcC = { iceConnectionState: 'connected', getStats: async () => relayStats(), close: () => {} };
  mesh.peers.set('peerC', pcC);
  await mesh._reportPeerState('peerC', pcC);
  report(timerQueue.length === 1, 'Peer C: retry scheduled before teardown');
  mesh._teardownPeer('peerC');
  report(!mesh.relayRecheckTimers.has('peerC'), 'Peer C: retry state cleaned up on teardown');

  // --- Scenario D: SAFETY GATE - never renegotiates while this pair could
  // currently hear each other (live audio would be at risk). Must defer
  // without spending an attempt, then proceed once they're muted. ---
  timerQueue = [];
  renegotiateCalls = 0;
  const pcD = { iceConnectionState: 'connected', getStats: async () => relayStats(), close: () => {} };
  mesh.peers.set('peerD', pcD);

  // Simulate: DRAWING phase, and peerD IS in the lounge with me right now -
  // i.e. we could actively be mid-conversation with them.
  mesh._phase = 'DRAWING';
  mesh._lounge = ['me', 'peerD'];
  await mesh._reportPeerState('peerD', pcD); // schedules first check
  await fireNextTimer(); // fires -> should see we CAN talk to peerD -> defer, not renegotiate
  report(renegotiateCalls === 0, 'Gate: did NOT renegotiate while this pair could hear each other');
  report(!mesh.relayRecheckAttempts.get('peerD'), 'Gate: no attempt was spent on the deferred check');
  report(timerQueue.length === 1, 'Gate: automatically rescheduled itself for a later, safer check');

  // Now they're no longer in the lounge together (muted to each other) -
  // this IS a safe window, so the deferred check should proceed this time.
  mesh._lounge = ['me']; // peerD not in it anymore
  await fireNextTimer();
  report(renegotiateCalls === 1, 'Gate: proceeded with renegotiation once this pair was actually muted');
  report(mesh.relayRecheckAttempts.get('peerD') === 1, 'Gate: attempt counter only increments on a real (non-deferred) attempt');

  // --- Scenario E: open-channel phases (lobby/review/word-select) are
  // always "could talk" - the gate must defer there too, not just DRAWING ---
  timerQueue = [];
  renegotiateCalls = 0;
  const pcE = { iceConnectionState: 'connected', getStats: async () => relayStats(), close: () => {} };
  mesh.peers.set('peerE', pcE);
  mesh._phase = 'REVIEW'; // open channel - _canSendTo is always true here
  mesh._lounge = null;
  await mesh._reportPeerState('peerE', pcE);
  await fireNextTimer();
  report(renegotiateCalls === 0, 'Gate: also defers during open-channel phases like REVIEW, not just an active DRAWING lounge');

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})();
