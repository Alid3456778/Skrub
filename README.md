# Skrub

Real-time multiplayer drawing & guessing game. Vanilla HTML5 Canvas + CSS +
JS on the frontend, Node/Express + Socket.io on the backend, zero database
(all state lives in-memory per room on the server).

## What's implemented (Phase 1 — core game, stability-first)

- Public matchmaking (auto-fills rooms up to 8 players) and private rooms
  with a non-guessable room code and a host settings panel (rounds 2–10,
  draw time 30–180s, word mode Standard / Hidden / Custom).
- Server-authoritative state machine: Lobby → Word Select (15s) → Drawing →
  Turn Review (7s) → loop → Podium, with auto-pick of word option #1 on
  select timeout.
- Canvas drawing synced over Socket.io, palette (16 colors), brush size,
  Undo (removes the last stroke), Clear, mouse + touch support.
- Guessing: exact match scores and ends the guesser's turn instantly;
  Levenshtein distance 1–2 triggers a private "You're close!" hint;
  correct guessers move to a private text channel with the artist.
- Progressive hint reveal (letters unlock at 75% / 50% / 25% time remaining).
- Linear guesser scoring (`round(timeLeft/totalTime * 500)`) and artist
  scoring (`correctGuessers * 5`), live scoreboard, end-of-game podium,
  host-triggered "Play Again".
- Reconnection: a persistent `clientId` (stored in `localStorage`, not the
  Socket.io session id) lets a dropped player rebind to their seat, resume
  the round timer, and get the canvas replayed — server holds the seat for
  30s.
- **Leave Room**: a "Leave" button in the lobby/game/podium screens lets a
  player exit immediately (no 30s grace period — that's only for accidental
  disconnects) and return to the home screen to join or create another room.
  If the leaving player was the host, the room migrates host to the next
  player automatically; if they were mid-turn as the artist, the turn is
  skipped to the next player.
- Spectator mode for players who join mid-round; they're promoted into the
  active pool at the start of the next round.
- Host migration if the room owner disconnects.
- Live ping indicator (🟢/🟡/🔴) via a heartbeat round-trip.
- Responsive layout: canvas stacks above chat on portrait/mobile, side-by-side
  on wider viewports.
- **WebRTC mesh voice chat is now active** (`public/js/voice.js`), with the
  server-enforced muting routine from the spec:
  - Lobby / word-select / turn-review: open channel, everyone can hear
    everyone.
  - Drawing phase: the artist and all guessers start muted (their outgoing
    audio track is swapped to `null` per-peer-connection, not just
    disabled locally, so it's enforced at the WebRTC layer). The moment a
    guesser answers correctly, the server broadcasts an updated "lounge"
    list (`[artistId, ...correctGuesserIds]`) and each lounge member's
    client selectively re-enables its outgoing track *only* toward other
    lounge members — so the artist and winners can talk privately without
    leaking to players still guessing.
  - Players opt in via an "Enable Voice Chat" button (mic permission
    requires a user gesture in every browser, so this can't be automatic).
  A small icon in the game top bar shows the current state (🔊 open / 🔇
  muted-while-guessing / 🎙️ in the winners' lounge).

## Voice chat notes / what to verify yourself

I can't test real microphone/WebRTC audio from this sandboxed environment —
there's no browser with mic access here. The signaling, peer-connection
lifecycle, and the mute-routing logic (`_canSendTo` in `voice.js`) are
implemented and reviewed carefully, but **please test with 2+ real browser
tabs/devices before relying on it**, specifically:

1. Two tabs on the same wifi network — should just work with STUN alone.
2. One device on wifi + one on mobile data — this is the case most likely to
   fail without a TURN server (see the comment block at the top of
   `voice.js` for where to add one; a few providers have free tiers).
3. Confirm the artist can't be heard by guessers but *can* be heard by
   players who already guessed correctly, and that muted guessers truly
   produce no audio to anyone (open each tab's devtools console — there are
   no visual indicators for remote peers beyond the status icon, so audio
   bugs are easiest to catch by ear with real people testing).

## Running locally

```bash
npm install
npm start
# open http://localhost:3000 in a few browser tabs/windows to test multiplayer
```

There's also a headless integration test that spins up 3 fake players and
plays a couple of turns end-to-end (useful after you make changes):

```bash
npm install --save-dev socket.io-client   # already in devDependencies if you cloned this as-is
node server.js &                          # in one terminal
node test/sim.js                          # in another
```

## Deploying to Render (free tier)

1. Push this repo to GitHub.
2. In Render: **New → Web Service**, connect the repo. Render will detect
   `render.yaml` automatically, or set manually:
   - Build command: `npm install`
   - Start command: `node server.js`
   - Health check path: `/health`
3. Deploy. First load after any period of inactivity will be slow (see below)
   — that's expected on the free tier, not a bug.

### Free-tier constraints and how this project handles them

- **Spin-down after ~15 min idle, then a ~30–50s cold start on the next
  request.** The client shows a "waking up the server…" banner while the
  Socket.io handshake is pending, so it doesn't look broken. If you want to
  avoid cold starts entirely, point an external uptime pinger (e.g. a free
  cron-job service) at `/health` every ~10 minutes — that keeps the instance
  warm, at the cost of using more of your free monthly hours.
- **Single instance, no shared state store.** This is actually a non-issue
  here because there's no database and all room state is in-memory — Render
  free tier doesn't horizontally scale a single service anyway, so you don't
  need Redis/sticky sessions the way you would with multiple instances.
- **A restart wipes all rooms.** Render free services do occasionally
  restart. Any in-progress games are lost when that happens — there's no
  persistence layer by design (per spec). Reconnect logic only survives
  *socket* drops, not a full server restart.
- **512MB RAM / limited CPU.** Draw events are sent as small per-segment
  JSON payloads rather than full canvas snapshots, and nothing buffers
  unbounded history (per-turn stroke history is cleared every turn), so
  memory stays flat regardless of how long the server runs.
- **WebSocket support**: Render's free tier does support WebSockets (unlike
  some serverless platforms), so Socket.io will upgrade off long-polling
  normally — no extra configuration needed.

## Project structure

```
server.js               Express app + Socket.io wiring, all socket event routing
server/constants.js      Tunable timings/limits
server/words.js          Word dictionary + custom-word sanitization
server/levenshtein.js    Used for "You're close!" detection
server/Room.js           The authoritative per-room state machine
server/RoomManager.js    Room creation, public matchmaking
public/index.html        All screens (home/lobby/game/podium)
public/css/style.css     Responsive styling
public/js/main.js        App orchestration, identity, socket event handlers
public/js/canvas.js      Drawing input (mouse+touch) and remote stroke replay
public/js/ping.js        RTT heartbeat → connection-quality dot
public/js/voice.js       WebRTC mesh scaffold (disabled by default)
test/sim.js              Headless 3-player game simulation for regression testing
```

## Suggested next steps

1. Test voice chat with real people on different networks (see "Voice chat
   notes" above) before treating it as production-ready.
2. Add a TURN provider's credentials to `voice.js` if you find players on
   stricter networks (corporate wifi, some mobile carriers) can't hear each
   other — that's the STUN-only NAT traversal limitation, not a code bug.
3. If a room needs to survive a Render restart, you'd need to add real
   persistence (e.g. Render's free Postgres or Redis) — that's a deliberate
   trade-off against the "zero database" requirement in the spec, so only do
   it if losing in-progress games on redeploy becomes a real problem.
