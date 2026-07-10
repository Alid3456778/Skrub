const { PHASES, WORD_SELECT_TIME_MS, REVIEW_TIME_MS, RECONNECT_GRACE_MS,
  WORD_OPTIONS_COUNT, HINT_THRESHOLDS } = require('./constants');
const { getWordOptions } = require('./words');
const levenshtein = require('./levenshtein');

let strokeCounter = 1;

class Room {
  constructor(id, isPublic, io, settings, onEmpty) {
    this.id = id;
    this.isPublic = isPublic;
    this.io = io;
    this.onEmpty = onEmpty; // callback(roomId) when room should be destroyed

    this.settings = settings; // { rounds, drawTimeSec, wordMode, customWords, maxPlayers }
    this.hostId = null; // clientId
    this.players = new Map(); // clientId -> player
    this.disconnectTimers = new Map(); // clientId -> Timeout

    this.phase = PHASES.LOBBY;
    this.roundNum = 0;
    this.drawOrder = []; // clientIds
    this.turnIndex = -1;
    this.currentDrawerId = null;
    this.currentWord = null;
    this.wordOptions = [];
    this.revealedIndices = new Set();
    this.correctGuesserIds = new Set();
    this.strokes = []; // { strokeId, points: [...], color, size }
    this.phaseEndTime = null;

    this.phaseTimer = null;
    this.hintTimers = [];
  }

  // ---------- Player management ----------

  addPlayer(clientId, socketId, name, avatar) {
    let player = this.players.get(clientId);
    const isMidRound = this.phase !== PHASES.LOBBY && this.phase !== PHASES.PODIUM;

    if (player) {
      // Reconnect path handled separately; this is a fresh join with a stored id collision - treat as new.
    }

    player = {
      id: clientId,
      socketId,
      name: (name || 'Player').slice(0, 20),
      avatar: avatar || {},
      score: 0,
      connected: true,
      isSpectator: isMidRound, // joins mid-round are spectators until next turn
      hasDrawnThisGame: false,
      voiceEnabled: false
    };
    this.players.set(clientId, player);

    if (!this.hostId) this.hostId = clientId;

    return player;
  }

  reconnectPlayer(clientId, newSocketId) {
    const player = this.players.get(clientId);
    if (!player) return null;
    player.socketId = newSocketId;
    player.connected = true;
    // Any prior WebRTC mesh state is gone after a page reload; the client
    // will re-broadcast 'voice-enabled' if/when it turns its mic back on.
    player.voiceEnabled = false;
    const t = this.disconnectTimers.get(clientId);
    if (t) { clearTimeout(t); this.disconnectTimers.delete(clientId); }
    return player;
  }

  disconnectPlayer(clientId) {
    const player = this.players.get(clientId);
    if (!player) return;
    player.connected = false;

    const timer = setTimeout(() => {
      this.removePlayerPermanently(clientId);
    }, RECONNECT_GRACE_MS);
    this.disconnectTimers.set(clientId, timer);

    if (this.hostId === clientId) {
      this._migrateHost();
    }

    this.broadcastRoomUpdate();

    // If the disconnected player was mid-draw, keep game running; guessers just can't
    // get new strokes. Turn will end naturally on timeout.
  }

  removePlayerPermanently(clientId) {
    const wasHost = this.hostId === clientId;
    this.players.delete(clientId);
    this.disconnectTimers.delete(clientId);
    this.drawOrder = this.drawOrder.filter(id => id !== clientId);

    if (wasHost) this._migrateHost();

    if (this.players.size === 0) {
      this._clearAllTimers();
      if (this.onEmpty) this.onEmpty(this.id);
      return;
    }

    // If the artist left permanently mid-turn, skip to next turn.
    if (this.currentDrawerId === clientId && (this.phase === PHASES.DRAWING || this.phase === PHASES.WORD_SELECT)) {
      this._endTurnAndAdvance();
    }

    this.broadcastRoomUpdate();
  }

  _migrateHost() {
    const next = [...this.players.values()].find(p => p.connected && p.id !== this.hostId);
    this.hostId = next ? next.id : (this.players.size > 0 ? [...this.players.keys()][0] : null);
    if (this.hostId) {
      this.io.to(this.id).emit('host-changed', { hostId: this.hostId });
    }
  }

  activePlayers() {
    return [...this.players.values()].filter(p => !p.isSpectator);
  }

  // ---------- Settings / lobby ----------

  updateSettings(clientId, newSettings) {
    if (clientId !== this.hostId) return false;
    if (this.phase !== PHASES.LOBBY) return false;
    const { MIN_ROUNDS, MAX_ROUNDS, MIN_DRAW_TIME, MAX_DRAW_TIME } = require('./constants');
    if (newSettings.rounds != null) {
      this.settings.rounds = Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, parseInt(newSettings.rounds, 10) || this.settings.rounds));
    }
    if (newSettings.drawTimeSec != null) {
      this.settings.drawTimeSec = Math.max(MIN_DRAW_TIME, Math.min(MAX_DRAW_TIME, parseInt(newSettings.drawTimeSec, 10) || this.settings.drawTimeSec));
    }
    if (newSettings.wordMode && ['Standard', 'Hidden', 'Custom'].includes(newSettings.wordMode)) {
      this.settings.wordMode = newSettings.wordMode;
    }
    if (typeof newSettings.customWords === 'string') {
      this.settings.customWords = newSettings.customWords.split(',').map(w => w.trim()).filter(Boolean);
    }
    this.broadcastRoomUpdate();
    return true;
  }

  // ---------- Game flow ----------

  startGame(clientId) {
    if (clientId !== this.hostId) return { ok: false, reason: 'Only the host can start the game.' };
    if (this.phase !== PHASES.LOBBY) return { ok: false, reason: 'The game has already started.' };
    if (this.activePlayers().length < 2) return { ok: false, reason: 'Need at least 2 players to start.' };

    this.roundNum = 1;
    this.turnIndex = -1;
    this.players.forEach(p => { p.score = 0; p.hasDrawnThisGame = false; p.isSpectator = false; });
    this.drawOrder = this.activePlayers().map(p => p.id);
    this._advanceTurn();
    return { ok: true };
  }

  _advanceTurn() {
    this._clearAllTimers();
    this.turnIndex++;

    if (this.turnIndex >= this.drawOrder.length) {
      this.roundNum++;
      if (this.roundNum > this.settings.rounds) {
        this._endGame();
        return;
      }
      this.turnIndex = 0;
      // Promote any spectators into the active pool for the new round.
      this.players.forEach(p => { if (p.isSpectator) p.isSpectator = false; });
      this.drawOrder = this.activePlayers().map(p => p.id);
      if (this.drawOrder.length === 0) { this._endGame(); return; }
    }

    // Skip disconnected players who never reconnected but weren't yet purged
    let attempts = 0;
    while (attempts < this.drawOrder.length) {
      const candidateId = this.drawOrder[this.turnIndex];
      const candidate = this.players.get(candidateId);
      if (candidate && candidate.connected) break;
      this.turnIndex = (this.turnIndex + 1) % this.drawOrder.length;
      attempts++;
    }

    this.currentDrawerId = this.drawOrder[this.turnIndex];
    this._startWordSelection();
  }

  _endTurnAndAdvance() {
    this._advanceTurn();
  }

  _startWordSelection() {
    this.phase = PHASES.WORD_SELECT;
    this.currentWord = null;
    this.correctGuesserIds = new Set();
    this.strokes = [];
    this.revealedIndices = new Set();
    this.wordOptions = getWordOptions(WORD_OPTIONS_COUNT, this.settings.wordMode, this.settings.customWords);
    this.phaseEndTime = Date.now() + WORD_SELECT_TIME_MS;

    const drawer = this.players.get(this.currentDrawerId);

    this.io.to(this.id).emit('phase-change', {
      phase: this.phase,
      drawerId: this.currentDrawerId,
      drawerName: drawer ? drawer.name : '???',
      roundNum: this.roundNum,
      totalRounds: this.settings.rounds,
      phaseEndTime: this.phaseEndTime
    });

    if (drawer && drawer.socketId) {
      this.io.to(drawer.socketId).emit('word-options', { options: this.wordOptions });
    }

    this.phaseTimer = setTimeout(() => {
      this.selectWord(this.currentDrawerId, this.wordOptions[0]);
    }, WORD_SELECT_TIME_MS);
  }

  selectWord(clientId, word) {
    if (this.phase !== PHASES.WORD_SELECT) return false;
    if (clientId !== this.currentDrawerId) return false;
    if (!this.wordOptions.includes(word)) word = this.wordOptions[0];
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this._startDrawingPhase(word);
    return true;
  }

  _startDrawingPhase(word) {
    this.phase = PHASES.DRAWING;
    this.currentWord = word;
    const drawTimeMs = this.settings.drawTimeSec * 1000;
    this.phaseEndTime = Date.now() + drawTimeMs;

    this.io.to(this.id).emit('phase-change', {
      phase: this.phase,
      drawerId: this.currentDrawerId,
      mask: this._buildMaskPayload(),
      phaseEndTime: this.phaseEndTime,
      wordLength: word.length,
      lounge: [this.currentDrawerId, ...this.correctGuesserIds]
    });

    const drawer = this.players.get(this.currentDrawerId);
    if (drawer && drawer.socketId) {
      this.io.to(drawer.socketId).emit('your-word', { word: this.currentWord });
    }

    this._scheduleHints(drawTimeMs);

    this.phaseTimer = setTimeout(() => this._startReviewPhase(), drawTimeMs);
  }

  _buildMaskPayload() {
    if (!this.currentWord) return [];
    return this.currentWord.split('').map((ch, i) => {
      if (ch === ' ' || ch === '-') return ch;
      return this.revealedIndices.has(i) ? ch : '_';
    });
  }

  _scheduleHints(drawTimeMs) {
    const wordLen = this.currentWord.length;
    const revealableIndices = [...this.currentWord.split('')].map((c, i) => i)
      .filter(i => this.currentWord[i] !== ' ' && this.currentWord[i] !== '-');
    if (revealableIndices.length <= 1) return;

    // Shuffle candidate reveal order once, then reveal one per threshold reached.
    const shuffled = [...revealableIndices].sort(() => Math.random() - 0.5);
    let revealCount = 0;
    const maxReveals = Math.max(1, Math.floor(revealableIndices.length / 2));

    HINT_THRESHOLDS.forEach((fraction) => {
      const delay = drawTimeMs * (1 - fraction);
      const timer = setTimeout(() => {
        if (this.phase !== PHASES.DRAWING) return;
        if (revealCount >= maxReveals) return;
        this.revealedIndices.add(shuffled[revealCount]);
        revealCount++;
        this.io.to(this.id).emit('hint-update', { mask: this._buildMaskPayload() });
      }, delay);
      this.hintTimers.push(timer);
    });
  }

  // ---------- Drawing ----------

  handleDrawData(clientId, data) {
    if (this.phase !== PHASES.DRAWING || clientId !== this.currentDrawerId) return;
    const segment = {
      strokeId: data.strokeId || 0,
      x1: data.x1, y1: data.y1, x2: data.x2, y2: data.y2,
      color: data.color, size: data.size, type: data.type || 'draw'
    };
    this.strokes.push(segment);
    this.io.to(this.id).emit('draw-data', segment);
  }

  handleClearCanvas(clientId) {
    if (this.phase !== PHASES.DRAWING || clientId !== this.currentDrawerId) return;
    this.strokes = [];
    this.io.to(this.id).emit('clear-canvas');
  }

  handleUndo(clientId) {
    if (this.phase !== PHASES.DRAWING || clientId !== this.currentDrawerId) return;
    const lastStrokeId = this.strokes.length ? this.strokes[this.strokes.length - 1].strokeId : null;
    if (lastStrokeId == null) return;
    this.strokes = this.strokes.filter(s => s.strokeId !== lastStrokeId);
    this.io.to(this.id).emit('undo-stroke', { strokeId: lastStrokeId, replay: this.strokes });
  }

  // ---------- Chat / guessing ----------

  handleChatMessage(clientId, text) {
    const player = this.players.get(clientId);
    if (!player || !text) return;
    text = String(text).slice(0, 200);

    const isGuesser = this.phase === PHASES.DRAWING && clientId !== this.currentDrawerId && !player.isSpectator;
    const alreadyCorrect = this.correctGuesserIds.has(clientId);

    if (isGuesser && !alreadyCorrect && this.currentWord) {
      const normalizedGuess = text.trim().toLowerCase();
      const normalizedWord = this.currentWord.trim().toLowerCase();

      if (normalizedGuess === normalizedWord) {
        this._handleCorrectGuess(clientId);
        return;
      }

      const dist = levenshtein(normalizedGuess, normalizedWord);
      if (dist > 0 && dist <= 2 && Math.abs(normalizedGuess.length - normalizedWord.length) <= 2) {
        const p = this.players.get(clientId);
        if (p && p.socketId) {
          this.io.to(p.socketId).emit('close-guess', { message: "You're close!" });
        }
        // Close guesses are not shown publicly to avoid leaking the word.
        return;
      }
    }

    if (alreadyCorrect && this.phase === PHASES.DRAWING) {
      // Private channel: only other winners + drawer see this.
      const recipients = [this.currentDrawerId, ...this.correctGuesserIds];
      recipients.forEach(id => {
        const p = this.players.get(id);
        if (p && p.socketId) {
          this.io.to(p.socketId).emit('chat-message', { from: player.name, text, private: true });
        }
      });
      return;
    }

    this.io.to(this.id).emit('chat-message', { from: player.name, text, private: false });
  }

  _handleCorrectGuess(clientId) {
    this.correctGuesserIds.add(clientId);
    const player = this.players.get(clientId);
    const timeLeft = Math.max(0, this.phaseEndTime - Date.now());
    const totalTime = this.settings.drawTimeSec * 1000;
    const points = Math.round((timeLeft / totalTime) * 500);
    player.score += points;

    this.io.to(this.id).emit('correct-guess', {
      playerId: clientId,
      playerName: player.name,
      points
    });

    // Bridge into winner's audio lounge (scaffolded, no-op unless voice is enabled client-side)
    this.io.to(this.id).emit('voice-lounge-update', { lounge: [this.currentDrawerId, ...this.correctGuesserIds] });

    const guessers = this.activePlayers().filter(p => p.id !== this.currentDrawerId);
    const allGuessed = guessers.length > 0 && guessers.every(p => this.correctGuesserIds.has(p.id) || !p.connected);
    if (allGuessed) {
      if (this.phaseTimer) clearTimeout(this.phaseTimer);
      this._startReviewPhase();
    }
  }

  // ---------- Review / scoring ----------

  _startReviewPhase() {
    this._clearAllTimers();
    this.phase = PHASES.REVIEW;
    this.phaseEndTime = Date.now() + REVIEW_TIME_MS;

    const drawer = this.players.get(this.currentDrawerId);
    if (drawer) {
      const artistPoints = this.correctGuesserIds.size * 5;
      drawer.score += artistPoints;
      drawer.hasDrawnThisGame = true;
    }

    this.io.to(this.id).emit('phase-change', {
      phase: this.phase,
      word: this.currentWord,
      phaseEndTime: this.phaseEndTime,
      scores: this._scoreSnapshot()
    });

    this.phaseTimer = setTimeout(() => this._advanceTurn(), REVIEW_TIME_MS);
  }

  _scoreSnapshot() {
    return [...this.players.values()]
      .map(p => ({ id: p.id, name: p.name, score: p.score, avatar: p.avatar }))
      .sort((a, b) => b.score - a.score);
  }

  _endGame() {
    this._clearAllTimers();
    this.phase = PHASES.PODIUM;
    const podium = this._scoreSnapshot().slice(0, 3);
    this.io.to(this.id).emit('phase-change', {
      phase: this.phase,
      podium,
      scores: this._scoreSnapshot()
    });
  }

  playAgain(clientId) {
    if (clientId !== this.hostId) return { ok: false, reason: 'Only the host can restart the game.' };
    if (this.phase !== PHASES.PODIUM) return { ok: false, reason: 'The game is still in progress.' };
    this._clearAllTimers();
    this.phase = PHASES.LOBBY;
    this.roundNum = 0;
    this.turnIndex = -1;
    this.currentDrawerId = null;
    this.currentWord = null;
    this.strokes = [];
    this.players.forEach(p => { p.score = 0; p.isSpectator = false; p.hasDrawnThisGame = false; });
    this.broadcastRoomUpdate();
    this.io.to(this.id).emit('phase-change', { phase: this.phase });
    return { ok: true };
  }

  // ---------- Utility ----------

  _clearAllTimers() {
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = null;
    this.hintTimers.forEach(t => clearTimeout(t));
    this.hintTimers = [];
  }

  setVoiceEnabled(clientId, enabled) {
    const player = this.players.get(clientId);
    if (!player) return;
    player.voiceEnabled = !!enabled;
    this.broadcastRoomUpdate();
  }

  broadcastRoomUpdate() {
    this.io.to(this.id).emit('room-update', this.getPublicState());
  }

  getPublicState() {
    return {
      roomId: this.id,
      isPublic: this.isPublic,
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      roundNum: this.roundNum,
      currentDrawerId: this.currentDrawerId,
      phaseEndTime: this.phaseEndTime,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, avatar: p.avatar, score: p.score,
        connected: p.connected, isSpectator: p.isSpectator, voiceEnabled: !!p.voiceEnabled
      }))
    };
  }

  // Full re-sync payload sent to a rejoining/reconnecting client so it can
  // catch up on canvas + mask + timer state without a full page context loss.
  getSyncPayload(forClientId) {
    const isCorrect = this.correctGuesserIds.has(forClientId);
    return {
      state: this.getPublicState(),
      strokes: this.strokes,
      mask: this.phase === PHASES.DRAWING ? this._buildMaskPayload() : null,
      word: (forClientId === this.currentDrawerId || isCorrect) ? this.currentWord : null,
      isDrawer: forClientId === this.currentDrawerId
    };
  }
}

module.exports = Room;
