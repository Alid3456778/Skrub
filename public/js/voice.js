// WebRTC mesh voice chat.
//
// STUN alone only works when at least one side has a simple/consistent NAT.
// Two players on different networks (e.g. one on home wifi, one on mobile
// data) very often can't connect with STUN alone - that's almost certainly
// why voice "isn't working": the signaling succeeds but the actual media
// connection (ICE) never completes. A TURN server relays the audio when a
// direct P2P path can't be found, which fixes this.
//
// ICE servers (STUN + TURN) are fetched from our own server at
// /api/turn-credentials rather than hardcoded here, so the TURN provider's
// API key never ships in client JS. See server/turnCredentials.js for the
// provider (Metered.ca free tier) and its fallback chain.
//
// EFFICIENCY: cached in localStorage alongside the server's expiresAt, so a
// returning player (same tab reload, or a new game a few minutes later)
// reuses last time's credentials with ZERO network requests at all - not
// even to our own /api/turn-credentials - until they're actually close to
// expiring. Only then do we ask the server (which itself only asks Metered
// when *its* cache is expiring - see turnCredentials.js). Net effect: the
// real Metered API gets called roughly once per cache window, total, no
// matter how many players or page loads happen in that window.
const LOCAL_CACHE_KEY = 'skrub_ice_servers_v2';
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000; // don't start a connection on creds expiring within 5 min

const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

function readLocalIceCache() {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.iceServers) || !parsed.iceServers.length) return null;
    if (!parsed.expiresAt || Date.now() > parsed.expiresAt - EXPIRY_SAFETY_MARGIN_MS) return null; // expired or expiring soon
    return parsed;
  } catch (e) {
    return null; // corrupt/unavailable localStorage - just refetch
  }
}

function writeLocalIceCache(data) {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(data));
  } catch (e) { /* localStorage full/unavailable (e.g. private browsing) - non-fatal, just skip caching */ }
}

// Fetches (or reuses the cached) { iceServers, degraded, reason } from our
// server. `degraded` + `reason` let the UI tell players WHY voice might not
// connect across networks right now - see server/turnCredentials.js for
// what each reason means. Shared by getIceServers() (used to actually open
// peer connections) and getRelayStatus() (used by the lobby UI), so both
// come from the same single fetch/cache, not two separate ones.
let iceDataPromise = null;
function getIceData() {
  const cached = readLocalIceCache();
  if (cached) return Promise.resolve(cached);

  if (!iceDataPromise) {
    iceDataPromise = fetch('/api/turn-credentials')
      .then(r => r.json())
      .then(data => {
        const result = {
          iceServers: (Array.isArray(data.iceServers) && data.iceServers.length) ? data.iceServers : FALLBACK_ICE_SERVERS,
          degraded: !!data.degraded,
          reason: data.reason || null
        };
        if (data.expiresAt) writeLocalIceCache({ ...result, expiresAt: data.expiresAt });
        return result;
      })
      .catch(err => {
        console.warn('[voice] Could not fetch TURN credentials, using STUN-only fallback (will fail across strict NATs):', err.message);
        return { iceServers: FALLBACK_ICE_SERVERS, degraded: true, reason: 'client_fetch_failed' };
      });
  }
  return iceDataPromise;
}

function getIceServers() {
  return getIceData().then(d => d.iceServers);
}

// Used by the lobby UI to decide whether to show a "voice may not connect
// across networks right now" notice. Safe to call at any time, independent
// of whether voice chat has been enabled yet - it triggers/reuses the same
// cached fetch as getIceServers().
export function getRelayStatus() {
  return getIceData().then(d => ({ degraded: d.degraded, reason: d.reason }));
}

// How long a connection can sit unconnected before we consider it stuck and
// worth tearing down + retrying from scratch.
const STUCK_CONNECTION_MS = 8000;

// How long to wait after landing on a TURN-relayed path before trying to
// escape it, and how many times to try before giving up for the rest of
// this connection's lifetime (these connections live for a whole game, not
// just one round, so conditions genuinely can change mid-session - a wifi
// hop, a NAT re-mapping, etc). Capped so a pair that will always need
// relay (e.g. both behind symmetric NAT) doesn't retry forever for no
// benefit.
const RELAY_RECHECK_INTERVAL_MS = 45000;
const RELAY_RECHECK_MAX_ATTEMPTS = 4;

export class VoiceMesh {
  constructor(socket, myClientId) {
    this.socket = socket;
    this.myClientId = myClientId;
    this.peers = new Map();          // clientId -> RTCPeerConnection
    this.senders = new Map();        // clientId -> RTCRtpSender (audio)
    this.createdAt = new Map();      // clientId -> timestamp, for stuck-connection detection
    this.relayRecheckTimers = new Map();   // clientId -> setTimeout handle
    this.relayRecheckAttempts = new Map(); // clientId -> number of upgrade attempts so far
    this.pendingCandidates = new Map(); // clientId -> [candidate, ...] received before remote description was set
    this.localStream = null;
    this.enabled = false;
    this.onStatusChange = null; // (status: 'off'|'open'|'blocked'|'lounge') => void
    this.onPeerStateChange = null; // (peerClientId, iceConnectionState, candidateType|null) => void

    this._lounge = null; // null = open channel (lobby/review), array = drawing-phase lounge members
    this._phase = 'LOBBY';

    socket.on('voice-signal', ({ fromClientId, signal }) => this._handleSignal(fromClientId, signal));
    socket.on('voice-lounge-update', ({ lounge }) => {
      this._lounge = lounge;
      this.peers.forEach((_, peerId) => this._applyMuteRulesToPeer(peerId));
      this._notifyStatus();
    });
  }

  async enable() {
    if (this.enabled) return true;
    try {
      // Kick off the TURN credential fetch in parallel with the mic
      // permission prompt (it's not needed until the first peer connection
      // opens, but starting it now means it's usually already resolved by
      // then instead of adding latency to that first connection).
      getIceServers();
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.enabled = true;
      // Any connection that was opened receive-only (because a peer offered
      // to connect to us before we'd enabled our own mic) needs our track
      // added now, plus a fresh offer so the other side picks it up.
      this._ensureLocalTrackOnAllPeers();
      return true;
    } catch (err) {
      console.warn('Microphone permission denied or unavailable:', err);
      return false;
    }
  }

  // Establish (or repair) a mesh connection to a peer. Deterministic
  // initiator selection (lower clientId offers) avoids both sides racing to
  // send an offer. Safe to call repeatedly/periodically - it no-ops for
  // healthy connections and only rebuilds ones that are stuck or dead.
  async connectTo(peerClientId) {
    if (!this.enabled || peerClientId === this.myClientId) return;

    const existing = this.peers.get(peerClientId);
    if (existing) {
      const state = existing.iceConnectionState;
      const age = Date.now() - (this.createdAt.get(peerClientId) || 0);
      const looksStuck = (state === 'new' || state === 'checking') && age > STUCK_CONNECTION_MS;
      const looksDead = state === 'failed' || state === 'disconnected' || state === 'closed';
      if (!looksStuck && !looksDead) return; // healthy or still legitimately in progress
      this._teardownPeer(peerClientId);
    }

    const isInitiator = this.myClientId < peerClientId;
    await this._openConnection(peerClientId, isInitiator);
  }

  _teardownPeer(peerClientId) {
    const pc = this.peers.get(peerClientId);
    if (pc) pc.close();
    this.peers.delete(peerClientId);
    this.senders.delete(peerClientId);
    this.createdAt.delete(peerClientId);
    this.pendingCandidates.delete(peerClientId);
    this._clearRelayRecheck(peerClientId);
    if (this.onPeerStateChange) this.onPeerStateChange(peerClientId, 'closed', null);
  }

  _clearRelayRecheck(peerClientId) {
    const timer = this.relayRecheckTimers.get(peerClientId);
    if (timer) clearTimeout(timer);
    this.relayRecheckTimers.delete(peerClientId);
    this.relayRecheckAttempts.delete(peerClientId);
  }

  // Called whenever we learn a peer's current path is via TURN relay.
  // Schedules a later attempt to renegotiate and see if a direct path has
  // become available (network changed, NAT re-mapped, etc), so a pair
  // isn't stuck paying relay cost for an entire game if conditions improve
  // partway through. Capped at RELAY_RECHECK_MAX_ATTEMPTS - if it's still
  // relay after that many tries, it's genuinely stuck (e.g. symmetric NAT
  // on both sides) and further attempts would just waste effort.
  //
  // SAFETY: a renegotiation briefly touches the connection and, even though
  // browsers implement ICE restarts to be as seamless as possible, a short
  // audio hiccup during the handover isn't something we can 100% rule out.
  // Rather than trust "probably fine", this only ever fires while
  // _canSendTo(peerClientId) is false for THIS pair - i.e. they're already
  // muted to each other right now (mid-round, not both in the drawing-phase
  // lounge together). No live audio can be flowing in that moment, so even
  // a worst-case hiccup is a glitch on silence - inaudible, by construction.
  // If they're currently allowed to hear each other (open lobby/review/
  // word-select chat, or both in the lounge together), the check defers
  // itself without spending one of the limited attempts, and simply tries
  // again later once this pair is muted again.
  _scheduleRelayRecheck(peerClientId, pc) {
    if (this.relayRecheckTimers.has(peerClientId)) return; // already scheduled
    const attempts = this.relayRecheckAttempts.get(peerClientId) || 0;
    if (attempts >= RELAY_RECHECK_MAX_ATTEMPTS) return;

    const timer = setTimeout(async () => {
      this.relayRecheckTimers.delete(peerClientId);
      if (!this.peers.has(peerClientId)) return; // connection was torn down while we waited
      if (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') return; // let the disconnect/failed handler deal with it instead

      if (this._canSendTo(peerClientId)) {
        // This pair can currently hear each other - never touch a live
        // connection. Defer without spending an attempt; re-check later
        // once they're muted again (e.g. the round moves on).
        console.log(`[voice] ${peerClientId}: still on TURN relay, but this pair can talk right now - deferring the reconnect attempt until they're muted again`);
        this._scheduleRelayRecheck(peerClientId, pc);
        return;
      }

      this.relayRecheckAttempts.set(peerClientId, attempts + 1);
      console.log(`[voice] ${peerClientId}: still on TURN relay, attempting to renegotiate a direct path (try ${attempts + 1}/${RELAY_RECHECK_MAX_ATTEMPTS})`);
      await this._renegotiate(peerClientId, pc, { iceRestart: true });
    }, RELAY_RECHECK_INTERVAL_MS);
    this.relayRecheckTimers.set(peerClientId, timer);
  }

  async _openConnection(peerClientId, isInitiator) {
    const iceServers = await getIceServers();
    const pc = new RTCPeerConnection({ iceServers });
    this.peers.set(peerClientId, pc);
    this.createdAt.set(peerClientId, Date.now());

    if (this.localStream) {
      const track = this.localStream.getAudioTracks()[0];
      if (track) {
        const sender = pc.addTrack(track, this.localStream);
        this.senders.set(peerClientId, sender);
      }
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('voice-signal', { toClientId: peerClientId, signal: { candidate: e.candidate } });
      }
    };

    pc.ontrack = (e) => {
      let audioEl = document.getElementById(`voice-audio-${peerClientId}`);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = `voice-audio-${peerClientId}`;
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.setAttribute('playsinline', '');
        audioEl.muted = false;
        document.body.appendChild(audioEl);
      }
      audioEl.srcObject = e.streams[0];
      this._playWithRetry(audioEl);
    };

    // Robust reconnection: renegotiate if ICE drops due to a network hop change.
    pc.oniceconnectionstatechange = () => {
      this._reportPeerState(peerClientId, pc);
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        this._renegotiate(peerClientId, pc, { iceRestart: true });
      }
    };
    this._reportPeerState(peerClientId, pc);

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('voice-signal', { toClientId: peerClientId, signal: { sdp: pc.localDescription } });
    }

    this._applyMuteRulesToPeer(peerClientId);
  }

  // Reports each peer's live ICE connection state (connecting/connected/
  // failed/etc) via console + an optional UI callback, so "is voice actually
  // reachable between these two players" is answerable by looking at the
  // screen instead of guessing. When connected, also inspects getStats() to
  // report whether the media path is a direct P2P link or relayed through
  // TURN - useful for diagnosing "works on same wifi, fails across networks".
  async _reportPeerState(peerClientId, pc) {
    const state = pc.iceConnectionState;
    console.log(`[voice] ${peerClientId}: ${state}`);
    let candidateType = null;
    if (state === 'connected' || state === 'completed') {
      try {
        const stats = await pc.getStats();
        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated !== false) {
            const local = stats.get(report.localCandidateId);
            if (local) candidateType = local.candidateType; // 'host' | 'srflx' | 'relay'
          }
        });
        if (candidateType) console.log(`[voice] ${peerClientId}: media path = ${candidateType === 'relay' ? 'TURN relay' : candidateType === 'srflx' ? 'direct (STUN)' : 'direct (local)'}`);
      } catch (e) { /* getStats can fail transiently mid-negotiation, non-fatal */ }

      // Escape-TURN logic: still on relay -> queue a later retry. Landed on
      // a direct path (possibly after a retry succeeded) -> stop retrying,
      // there's nothing left to save.
      if (candidateType === 'relay') {
        this._scheduleRelayRecheck(peerClientId, pc);
      } else if (candidateType) {
        if (this.relayRecheckAttempts.get(peerClientId)) {
          console.log(`[voice] ${peerClientId}: upgraded off TURN relay to a direct path.`);
        }
        this._clearRelayRecheck(peerClientId);
      }
    }
    if (this.onPeerStateChange) this.onPeerStateChange(peerClientId, state, candidateType);
  }


  _ensureLocalTrackOnAllPeers() {
    if (!this.localStream) return;
    const track = this.localStream.getAudioTracks()[0];
    if (!track) return;
    this.peers.forEach((pc, peerId) => {
      if (!this.senders.has(peerId)) {
        const sender = pc.addTrack(track, this.localStream);
        this.senders.set(peerId, sender);
        this._applyMuteRulesToPeer(peerId);
        this._renegotiate(peerId, pc);
      }
    });
  }

  // Browsers sometimes block audio.play() even after a user gesture (most
  // often on mobile), especially for an <audio> element created moments
  // after the gesture rather than synchronously inside it. If the initial
  // attempt is blocked, retry once on the next tap/click/keypress anywhere
  // on the page instead of leaving that peer permanently silent.
  _playWithRetry(audioEl) {
    const tryPlay = () => audioEl.play().catch(() => {});
    tryPlay();
    const onGesture = () => {
      tryPlay();
      ['click', 'touchend', 'keydown'].forEach(evt => document.removeEventListener(evt, onGesture));
    };
    ['click', 'touchend', 'keydown'].forEach(evt => document.addEventListener(evt, onGesture));
  }

  async _renegotiate(peerClientId, pc, { iceRestart = false } = {}) {
    // Avoid offer/answer glare - if a negotiation is already underway, a
    // later retry sweep will pick this connection up if it's still broken.
    if (pc.signalingState !== 'stable') return;
    try {
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await pc.setLocalDescription(offer);
      this.socket.emit('voice-signal', { toClientId: peerClientId, signal: { sdp: pc.localDescription } });
    } catch (err) {
      console.warn('Voice renegotiation failed:', err);
    }
  }

  async _handleSignal(fromClientId, signal) {
    // Always accept and answer incoming signals, even before we've enabled
    // our own mic - this is the fix for the enable-order race: whoever
    // enables voice first can still successfully reach a peer who enables
    // a moment later, instead of that first offer being silently dropped.
    let pc = this.peers.get(fromClientId);
    if (!pc) {
      await this._openConnection(fromClientId, false);
      pc = this.peers.get(fromClientId);
    }

    if (signal.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

      const queued = this.pendingCandidates.get(fromClientId) || [];
      for (const candidate of queued) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { /* stale candidate, ignore */ }
      }
      this.pendingCandidates.delete(fromClientId);

      if (signal.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('voice-signal', { toClientId: fromClientId, signal: { sdp: pc.localDescription } });
      }
      this._applyMuteRulesToPeer(fromClientId);
    } else if (signal.candidate) {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (e) { /* benign race, ignore */ }
      } else {
        // Remote description isn't set yet - queue the candidate instead of
        // dropping it silently, and flush the queue once the SDP arrives.
        if (!this.pendingCandidates.has(fromClientId)) this.pendingCandidates.set(fromClientId, []);
        this.pendingCandidates.get(fromClientId).push(signal.candidate);
      }
    }
  }

  // ---------- Mute routing ----------
  // Called on every phase-change. `lounge` is only meaningful during DRAWING:
  // [drawerId, ...correctGuesserIds]. Outside DRAWING the channel is fully open.
  updateGameState(phase, lounge) {
    this._phase = phase;
    if (phase === 'DRAWING') {
      this._lounge = lounge == null ? this._lounge || [] : lounge;
    } else {
      this._lounge = null;
    }
    this.peers.forEach((_, peerId) => this._applyMuteRulesToPeer(peerId));
    this._notifyStatus();
  }

  _canSendTo(peerClientId) {
    if (this._phase !== 'DRAWING') return true; // open channel
    if (!this._lounge) return false;
    const amInLounge = this._lounge.includes(this.myClientId);
    const peerInLounge = this._lounge.includes(peerClientId);
    // Only lounge members (artist + successful guessers) can hear each other
    // while a round is in progress; everyone else transmits silence.
    return amInLounge && peerInLounge;
  }

  _applyMuteRulesToPeer(peerClientId) {
    const sender = this.senders.get(peerClientId);
    if (!sender || !this.localStream) return;
    const track = this.localStream.getAudioTracks()[0];
    const wantTrack = this._canSendTo(peerClientId) ? track : null;
    if (sender.track !== wantTrack) {
      sender.replaceTrack(wantTrack).catch(() => {});
    }
  }

  _notifyStatus() {
    if (!this.onStatusChange) return;
    if (!this.enabled) { this.onStatusChange('off'); return; }
    if (this._phase !== 'DRAWING') { this.onStatusChange('open'); return; }
    if (this._lounge && this._lounge.includes(this.myClientId)) { this.onStatusChange('lounge'); return; }
    this.onStatusChange('blocked');
  }

  disconnectAll() {
    this.peers.forEach(pc => pc.close());
    this.peers.clear();
    this.senders.clear();
    this.createdAt.clear();
    this.pendingCandidates.clear();
    document.querySelectorAll('audio[id^="voice-audio-"]').forEach(el => el.remove());
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    this.enabled = false;
    this._lounge = null;
    this._phase = 'LOBBY';
  }
}
