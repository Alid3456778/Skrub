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
const LOCAL_CACHE_KEY = 'skrub_ice_servers_v1';
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
    return parsed.iceServers;
  } catch (e) {
    return null; // corrupt/unavailable localStorage - just refetch
  }
}

function writeLocalIceCache(iceServers, expiresAt) {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify({ iceServers, expiresAt }));
  } catch (e) { /* localStorage full/unavailable (e.g. private browsing) - non-fatal, just skip caching */ }
}

let iceServersPromise = null;
function getIceServers() {
  const cached = readLocalIceCache();
  if (cached) return Promise.resolve(cached);

  if (!iceServersPromise) {
    iceServersPromise = fetch('/api/turn-credentials')
      .then(r => r.json())
      .then(data => {
        const servers = (Array.isArray(data.iceServers) && data.iceServers.length) ? data.iceServers : FALLBACK_ICE_SERVERS;
        if (data.expiresAt) writeLocalIceCache(servers, data.expiresAt);
        return servers;
      })
      .catch(err => {
        console.warn('[voice] Could not fetch TURN credentials, using STUN-only fallback (will fail across strict NATs):', err.message);
        return FALLBACK_ICE_SERVERS;
      });
  }
  return iceServersPromise;
}

// How long a connection can sit unconnected before we consider it stuck and
// worth tearing down + retrying from scratch.
const STUCK_CONNECTION_MS = 8000;

export class VoiceMesh {
  constructor(socket, myClientId) {
    this.socket = socket;
    this.myClientId = myClientId;
    this.peers = new Map();          // clientId -> RTCPeerConnection
    this.senders = new Map();        // clientId -> RTCRtpSender (audio)
    this.createdAt = new Map();      // clientId -> timestamp, for stuck-connection detection
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
    if (this.onPeerStateChange) this.onPeerStateChange(peerClientId, 'closed', null);
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
