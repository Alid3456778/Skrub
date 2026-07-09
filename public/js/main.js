import { DrawingCanvas, PALETTE } from './canvas.js';
import { startPingIndicator } from './ping.js';
import { VoiceMesh } from './voice.js';

const WORD_SELECT_TOTAL_MS = 15000;
const REVIEW_TOTAL_MS = 7000;

// ---------- Identity (persisted in localStorage) ----------
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

let clientId = localStorage.getItem('skrub_clientId');
if (!clientId) { clientId = uuid(); localStorage.setItem('skrub_clientId', clientId); }

let profile = JSON.parse(localStorage.getItem('skrub_profile') || '{}');
profile = { name: profile.name || '', avatar: profile.avatar || { color: '#ff5c5c', eyes: 'round', mouth: 'smile' } };

function saveProfile() { localStorage.setItem('skrub_profile', JSON.stringify(profile)); }

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const screens = {
  home: $('screen-home'), lobby: $('screen-lobby'), game: $('screen-game'), podium: $('screen-podium')
};
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// ---------- Avatar preview ----------
function renderAvatarPreview(el, avatar) {
  el.style.background = avatar.color;
  el.textContent = avatar.eyes === 'wide' ? 'O O' : (avatar.eyes === 'sleepy' ? '- -' : '• •');
}

$('input-name').value = profile.name;
$('avatar-color').value = profile.avatar.color;
$('avatar-eyes').value = profile.avatar.eyes;
$('avatar-mouth').value = profile.avatar.mouth;
renderAvatarPreview($('avatar-preview'), profile.avatar);

['avatar-color', 'avatar-eyes', 'avatar-mouth'].forEach(id => {
  $(id).addEventListener('change', () => {
    profile.avatar = { color: $('avatar-color').value, eyes: $('avatar-eyes').value, mouth: $('avatar-mouth').value };
    renderAvatarPreview($('avatar-preview'), profile.avatar);
    saveProfile();
  });
});
$('input-name').addEventListener('input', () => { profile.name = $('input-name').value.trim(); saveProfile(); });

function requireName() {
  if (!profile.name) {
    $('home-error').textContent = 'Please enter a name first.';
    $('home-error').classList.remove('hidden');
    return false;
  }
  $('home-error').classList.add('hidden');
  return true;
}

// ---------- Socket setup ----------
const wakeBanner = $('server-wake-banner');
const wakeTimer = setTimeout(() => wakeBanner.classList.remove('hidden'), 2500);

const socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, timeout: 20000 });

let currentRoomId = localStorage.getItem('skrub_roomId');
let roomState = null;
let syncPayload = null;

// 'connect' fires both on first page load and after any network reconnect,
// so a single check here covers page refresh, dropped wifi, and Render cold
// starts uniformly.
socket.on('connect', () => {
  clearTimeout(wakeTimer);
  wakeBanner.classList.add('hidden');
  if (currentRoomId) {
    socket.emit('rejoin', { clientId, roomId: currentRoomId });
  }
});

socket.on('disconnect', () => {
  wakeBanner.textContent = 'Connection lost — attempting to reconnect…';
  wakeBanner.classList.remove('hidden');
});

socket.on('join-error', ({ message }) => {
  $('home-error').textContent = message;
  $('home-error').classList.remove('hidden');
  currentRoomId = null;
  localStorage.removeItem('skrub_roomId');
  showScreen('home');
});

startPingIndicator(socket, $('ping-indicator'));
const voice = new VoiceMesh(socket, clientId);

// ---------- Home actions ----------
$('btn-quick-play').addEventListener('click', () => {
  if (!requireName()) return;
  socket.emit('quick-play', { clientId, name: profile.name, avatar: profile.avatar });
});

$('btn-create-room').addEventListener('click', () => {
  if (!requireName()) return;
  socket.emit('create-room', { clientId, name: profile.name, avatar: profile.avatar, settings: {} });
});

$('btn-join-room').addEventListener('click', () => {
  if (!requireName()) return;
  const code = $('input-room-code').value.trim();
  if (!code) return;
  socket.emit('join-room', { clientId, roomId: code, name: profile.name, avatar: profile.avatar });
});

socket.on('joined-room', ({ roomId }) => {
  currentRoomId = roomId;
  localStorage.setItem('skrub_roomId', roomId);
});

// ---------- Room state ----------
socket.on('room-update', (state) => {
  roomState = state;
  renderRoomByPhase(state);
});

socket.on('sync-state', (payload) => {
  syncPayload = payload;
  if (payload.state) {
    roomState = payload.state;
    renderRoomByPhase(payload.state);
  }
  if (payload.strokes && payload.strokes.length) {
    canvas.replayStrokes(payload.strokes);
  }
  // Catch up a rejoining/reconnecting client on the in-progress turn: mask,
  // drawer tools, and the timer bar, without waiting for the next phase-change.
  const st = payload.state;
  if (st && (st.phase === 'DRAWING' || st.phase === 'WORD_SELECT' || st.phase === 'REVIEW')) {
    hideAllOverlays();
    canvas.setDrawer(payload.isDrawer && st.phase === 'DRAWING');
    $('toolbar').classList.toggle('hidden', !(payload.isDrawer && st.phase === 'DRAWING'));
    if (st.phase === 'DRAWING') {
      updateWordDisplay(payload.mask);
      const totalMs = (st.settings?.drawTimeSec || 80) * 1000;
      if (st.phaseEndTime) startTimerBar(st.phaseEndTime, totalMs);
      if (payload.word) $('word-display').textContent = payload.word.toUpperCase();
    } else if (st.phase === 'WORD_SELECT') {
      if (payload.isDrawer) {
        // word-options will arrive shortly after via a dedicated emit if still selecting;
        // otherwise this client just waits for the next phase-change.
      } else {
        $('waiting-text').textContent = 'Waiting for the artist to choose a word…';
        $('waiting-overlay').classList.remove('hidden');
      }
      if (st.phaseEndTime) startTimerBar(st.phaseEndTime, WORD_SELECT_TOTAL_MS);
    }
  }
});

socket.on('host-changed', () => { /* room-update follows immediately with fresh hostId */ });

function renderRoomByPhase(state) {
  if (state.phase === 'LOBBY') {
    showScreen('lobby');
    renderLobby(state);
  } else if (state.phase === 'PODIUM') {
    showScreen('podium');
    renderPodium(state);
  } else {
    showScreen('game');
    renderGamePlayerList(state);
    $('game-round-num').textContent = state.roundNum;
    $('game-total-rounds').textContent = state.settings.rounds;
  }
}

// ---------- Lobby ----------
$('setting-rounds').addEventListener('input', () => { $('rounds-val').textContent = $('setting-rounds').value; pushSettings(); });
$('setting-draw-time').addEventListener('input', () => { $('draw-time-val').textContent = $('setting-draw-time').value; pushSettings(); });
$('setting-word-mode').addEventListener('change', () => {
  $('setting-custom-words').classList.toggle('hidden', $('setting-word-mode').value !== 'Custom');
  pushSettings();
});
$('setting-custom-words').addEventListener('change', pushSettings);

let settingsDebounce = null;
function pushSettings() {
  clearTimeout(settingsDebounce);
  settingsDebounce = setTimeout(() => {
    socket.emit('update-settings', {
      rounds: $('setting-rounds').value,
      drawTimeSec: $('setting-draw-time').value,
      wordMode: $('setting-word-mode').value,
      customWords: $('setting-custom-words').value
    });
  }, 300);
}

$('btn-start-game').addEventListener('click', () => socket.emit('start-game'));
$('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard?.writeText(currentRoomId || '');
});

function renderLobby(state) {
  $('lobby-room-code').textContent = state.isPublic ? 'Public match' : state.roomId;
  const isHost = state.hostId === clientId;
  $('lobby-settings').classList.toggle('hidden', !isHost || state.isPublic);
  $('lobby-wait-msg').classList.toggle('hidden', isHost && !state.isPublic);

  $('setting-rounds').value = state.settings.rounds;
  $('rounds-val').textContent = state.settings.rounds;
  $('setting-draw-time').value = state.settings.drawTimeSec;
  $('draw-time-val').textContent = state.settings.drawTimeSec;
  $('setting-word-mode').value = state.settings.wordMode;

  $('lobby-player-count').textContent = state.players.length;
  const list = $('lobby-player-list');
  list.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot ${p.id === state.hostId ? 'host' : ''}"></span>
      <span class="name ${p.connected ? '' : 'offline'}">${escapeHtml(p.name)}${p.id === clientId ? ' (you)' : ''}</span>`;
    list.appendChild(li);
  });
}

// ---------- Game screen ----------
const canvasEl = $('draw-canvas');
const canvas = new DrawingCanvas(canvasEl, {
  onLocalStroke: (seg) => socket.emit('draw-data', seg)
});

const palette = $('palette');
PALETTE.forEach((c, i) => {
  const sw = document.createElement('div');
  sw.className = 'swatch' + (i === 0 ? ' active' : '');
  sw.style.background = c;
  sw.addEventListener('click', () => {
    canvas.setColor(c);
    [...palette.children].forEach(el => el.classList.remove('active'));
    sw.classList.add('active');
  });
  palette.appendChild(sw);
});
$('brush-size').addEventListener('input', (e) => canvas.setSize(parseInt(e.target.value, 10)));
$('btn-undo').addEventListener('click', () => socket.emit('undo'));
$('btn-clear').addEventListener('click', () => { canvas.clear(); socket.emit('clear-canvas'); });

socket.on('draw-data', (seg) => canvas.applyRemoteSegment(seg));
socket.on('clear-canvas', () => canvas.clear());
socket.on('undo-stroke', ({ replay }) => canvas.replayStrokes(replay));

let timerInterval = null;
function startTimerBar(endTime, totalMs) {
  clearInterval(timerInterval);
  const fill = $('timer-bar-fill');
  function tick() {
    const remaining = Math.max(0, endTime - Date.now());
    fill.style.width = `${Math.max(0, (remaining / totalMs) * 100)}%`;
    if (remaining <= 0) clearInterval(timerInterval);
  }
  tick();
  timerInterval = setInterval(tick, 200);
}

socket.on('phase-change', (data) => {
  hideAllOverlays();
  const isDrawer = data.drawerId === clientId;

  if (data.phase === 'WORD_SELECT') {
    canvas.clear();
    canvas.setDrawer(false);
    $('toolbar').classList.add('hidden');
    $('word-display').textContent = '';
    startTimerBar(data.phaseEndTime, WORD_SELECT_TOTAL_MS);
    if (isDrawer) {
      // word-options event will populate + show the picker overlay
    } else {
      $('waiting-text').textContent = `${escapeHtml(data.drawerName || 'The artist')} is choosing a word…`;
      $('waiting-overlay').classList.remove('hidden');
    }
  }

  if (data.phase === 'DRAWING') {
    canvas.setDrawer(isDrawer);
    $('toolbar').classList.toggle('hidden', !isDrawer);
    updateWordDisplay(data.mask);
    const totalMs = (roomState?.settings?.drawTimeSec || 80) * 1000;
    startTimerBar(data.phaseEndTime, totalMs);
    clearChatSystemNote();
  }

  if (data.phase === 'REVIEW') {
    clearInterval(timerInterval);
    $('toolbar').classList.add('hidden');
    $('review-word').textContent = data.word;
    const list = $('review-scores');
    list.innerHTML = '';
    (data.scores || []).slice(0, 8).forEach(p => {
      const li = document.createElement('li');
      li.textContent = `${p.name}: ${p.score}`;
      list.appendChild(li);
    });
    $('review-overlay').classList.remove('hidden');
    startTimerBar(data.phaseEndTime, REVIEW_TOTAL_MS);
  }

  if (data.phase === 'PODIUM') {
    showScreen('podium');
    renderPodiumFromPhaseChange(data);
  }

  if (data.phase === 'LOBBY') {
    showScreen('lobby');
  }
});

socket.on('word-options', ({ options }) => {
  const container = $('word-options');
  container.innerHTML = '';
  options.forEach(w => {
    const btn = document.createElement('button');
    btn.textContent = w;
    btn.addEventListener('click', () => {
      socket.emit('select-word', { word: w });
      $('word-select-overlay').classList.add('hidden');
    });
    container.appendChild(btn);
  });
  $('word-select-overlay').classList.remove('hidden');
});

socket.on('your-word', ({ word }) => {
  $('word-display').textContent = word.toUpperCase();
});

socket.on('hint-update', ({ mask }) => updateWordDisplay(mask));

function updateWordDisplay(mask) {
  if (!mask) return;
  $('word-display').textContent = mask.join(' ');
}

function hideAllOverlays() {
  $('word-select-overlay').classList.add('hidden');
  $('waiting-overlay').classList.add('hidden');
  $('review-overlay').classList.add('hidden');
}

// ---------- Chat ----------
$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  input.value = '';
});

socket.on('chat-message', ({ from, text, private: isPrivate }) => {
  appendChat(`${escapeHtml(from)}: ${escapeHtml(text)}`, isPrivate ? 'private' : '');
});

socket.on('correct-guess', ({ playerName, points }) => {
  appendChat(`${escapeHtml(playerName)} guessed the word! (+${points})`, 'correct');
});

socket.on('close-guess', ({ message }) => {
  appendChat(message, 'system');
});

function appendChat(text, cls) {
  const log = $('chat-log');
  const div = document.createElement('div');
  div.className = 'msg' + (cls ? ' ' + cls : '');
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function clearChatSystemNote() { /* placeholder for future per-turn chat resets */ }

// ---------- Player list (in-game) ----------
function renderGamePlayerList(state) {
  const list = $('game-player-list');
  list.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    const tag = p.id === state.currentDrawerId ? ' ✏️' : (p.isSpectator ? ' (spectating)' : '');
    li.innerHTML = `<span class="dot ${p.id === state.hostId ? 'host' : ''}"></span>
      <span class="name ${p.connected ? '' : 'offline'}">${escapeHtml(p.name)}${tag}</span>
      <span class="score">${p.score}</span>`;
    list.appendChild(li);
  });
}

// ---------- Podium ----------
function renderPodium(state) {
  renderPodiumFromPhaseChange({ podium: state.players.sort((a, b) => b.score - a.score).slice(0, 3) });
}
function renderPodiumFromPhaseChange(data) {
  const list = $('podium-list');
  list.innerHTML = '';
  (data.podium || []).forEach((p, i) => {
    const li = document.createElement('li');
    li.textContent = `#${i + 1} ${p.name} — ${p.score} pts`;
    list.appendChild(li);
  });
  const isHost = roomState && roomState.hostId === clientId;
  $('btn-play-again').classList.toggle('hidden', !isHost);
  $('podium-wait-msg').classList.toggle('hidden', isHost);
}
$('btn-play-again').addEventListener('click', () => socket.emit('play-again'));

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
