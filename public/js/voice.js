// WebRTC mesh voice chat.
//
// Render's free tier has no TURN server, so P2P audio can fail for players
// behind restrictive/symmetric NATs (common on some mobile carriers/corporate
// wifi) with STUN alone. Add a TURN provider's credentials below (e.g. a free
// tier from Metered.ca, Twilio, or Cloudflare Calls) for reliable connectivity
// across all networks. Voice still works fine on typical home networks
// without one.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
  // { urls: 'turn:your-turn-host:3478', username: '...', credential: '...' }
];

export class VoiceMesh {
  constructor(socket, myClientId) {
    this.socket = socket;
    this.myClientId = myClientId;
    this.peers = new Map();   // clientId -> RTCPeerConnection
    this.senders = new Map(); // clientId -> RTCRtpSender (audio)
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
      return true;
    } catch (err) {
      console.warn('Microphone permission denied or unavailable:', err);
      return false;
    }
  }

  // Establish a mesh connection to a peer. Deterministic initiator selection
  // (lower clientId offers) avoids both sides racing to send an offer.
  async connectTo(peerClientId) {
    if (!this.enabled || this.peers.has(peerClientId) || peerClientId === this.myClientId) return;
    const isInitiator = this.myClientId < peerClientId;
    await this._openConnection(peerClientId, isInitiator);
  }

  async _openConnection(peerClientId, isInitiator) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peers.set(peerClientId, pc);

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
    };

    // Robust reconnection: renegotiate if ICE drops due to a network hop change.
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        this._renegotiate(peerClientId, pc);
      }
    };

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('voice-signal', { toClientId: peerClientId, signal: { sdp: pc.localDescription } });
    }

    // Apply current mute rules immediately so a late-joining peer doesn't get
    // a moment of unintended audio before the next state update arrives.
    this._applyMuteRulesToPeer(peerClientId);
  }

  async _renegotiate(peerClientId, pc) {
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      this.socket.emit('voice-signal', { toClientId: peerClientId, signal: { sdp: pc.localDescription } });
    } catch (err) {
      console.warn('Voice renegotiation failed:', err);
    }
  }

  async _handleSignal(fromClientId, signal) {
    if (!this.enabled) return; // haven't opted into voice yet - ignore incoming offers
    let pc = this.peers.get(fromClientId);
    if (!pc) {
      await this._openConnection(fromClientId, false);
      pc = this.peers.get(fromClientId);
    }
    if (signal.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      if (signal.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('voice-signal', { toClientId: fromClientId, signal: { sdp: pc.localDescription } });
      }
      this._applyMuteRulesToPeer(fromClientId);
    } else if (signal.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (e) { /* benign race, ignore */ }
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
