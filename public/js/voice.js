// Voice chat is SCAFFOLDED but disabled by default. Flip VOICE_ENABLED to true
// once you're ready to test WebRTC mesh audio. Note: Render's free tier has no
// TURN server, so P2P audio may fail for players behind restrictive/symmetric
// NATs unless you add a TURN provider (e.g. a free tier from Twilio/Metered).
export const VOICE_ENABLED = false;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' }
  // Add a TURN server here for reliable connectivity across all networks, e.g.:
  // { urls: 'turn:your-turn-host:3478', username: '...', credential: '...' }
];

export class VoiceMesh {
  constructor(socket, myClientId) {
    this.socket = socket;
    this.myClientId = myClientId;
    this.peers = new Map(); // clientId -> RTCPeerConnection
    this.localStream = null;
    this.enabled = false;

    socket.on('voice-signal', ({ fromClientId, signal }) => this._handleSignal(fromClientId, signal));
    socket.on('voice-lounge-update', ({ lounge }) => this._applyLounge(lounge));
  }

  async enable() {
    if (!VOICE_ENABLED) return;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.enabled = true;
    } catch (err) {
      console.warn('Microphone permission denied or unavailable:', err);
    }
  }

  setMuted(muted) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }

  async connectTo(peerClientId, isInitiator) {
    if (!VOICE_ENABLED || !this.enabled) return;
    if (this.peers.has(peerClientId)) return;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peers.set(peerClientId, pc);

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
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

    // Robust reconnection: renegotiate if ICE drops due to a network change.
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected') {
        this._renegotiate(peerClientId, pc);
      }
    };

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('voice-signal', { toClientId: peerClientId, signal: { sdp: pc.localDescription } });
    }
  }

  async _renegotiate(peerClientId, pc) {
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      this.socket.emit('voice-signal', { toClientId: peerClientId, signal: { sdp: pc.localDescription } });
    } catch (err) {
      console.warn('Renegotiation failed:', err);
    }
  }

  async _handleSignal(fromClientId, signal) {
    if (!VOICE_ENABLED || !this.enabled) return;
    let pc = this.peers.get(fromClientId);
    if (!pc) {
      await this.connectTo(fromClientId, false);
      pc = this.peers.get(fromClientId);
    }
    if (signal.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      if (signal.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('voice-signal', { toClientId: fromClientId, signal: { sdp: pc.localDescription } });
      }
    } else if (signal.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (e) { /* ignore */ }
    }
  }

  _applyLounge(lounge) {
    // Placeholder for exclusive winner's-lounge routing logic once voice is enabled.
    // Would selectively mute/unmute per-peer connections based on lounge membership.
  }

  disconnectAll() {
    this.peers.forEach(pc => pc.close());
    this.peers.clear();
    if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
  }
}
