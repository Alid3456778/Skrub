// WebRTC mesh voice chat.
//
// STUN alone only works when at least one side has a simple/consistent NAT.
// Two players on different networks (e.g. one on home wifi, one on mobile
// data) very often can't connect with STUN alone - that's almost certainly
// why voice "isn't working": the signaling succeeds but the actual media
// connection (ICE) never completes. A TURN server relays the audio when a
// direct P2P path can't be found, which fixes this.
//
// The entries below use the Open Relay Project's public demo TURN server
// (openrelay.metered.ca) - free, no signup, fine for testing and small
// groups. It's a shared public server with no uptime guarantee, so for a
// real deployment you should get your own free-tier TURN credentials (e.g.
// from metered.ca, Twilio, or Cloudflare Calls) and swap them in here.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

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
  }

  async _openConnection(peerClientId, isInitiator) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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
        document.body.appendChild(audioEl);
      }
      audioEl.srcObject = e.streams[0];
      this._playWithRetry(audioEl);
    };

    // Robust reconnection: renegotiate if ICE drops due to a network hop change.
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        this._renegotiate(peerClientId, pc, { iceRestart: true });
      }
    };

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('voice-signal', { toClientId: peerClientId, signal: { sdp: pc.localDescription } });
    }

    this._applyMuteRulesToPeer(peerClientId);
  }

  // Called after enable() succeeds, to attach our track to any connection
  // that was opened receive-only (we answered someone's offer before we had
  // a microphone) and to renegotiate so the other side starts receiving us.
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
      this._lounge = lounge || [];
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
