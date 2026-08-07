// TURN/STUN credentials for the voice-chat WebRTC mesh.
//
// WHY THIS EXISTS: two players on different real-world networks (e.g. home
// wifi + mobile data) often sit behind NATs that can't reach each other
// directly. A TURN server relays their audio when that happens. Without a
// working TURN server, voice chat will look fine when you test with two
// tabs on your own machine, then silently fail to connect real players.
//
// PROVIDER: Metered.ca's free tier (500MB relay/month, no credit card -
// https://www.metered.ca/stun-turn). Sign up, create an "app", and you'll
// get an app name + API key. Set them as environment variables:
//
//   METERED_APP_NAME=your-app-name
//   METERED_API_KEY=your-api-key
//
// EFFICIENCY: the 500MB/month cap is TURN *relay bandwidth* (actual audio
// data), not API call count - caching credentials doesn't reduce relay
// bandwidth by itself. What it does save is API request volume against
// Metered's `/turn/credentials` endpoint, and it means players connect
// faster (no round trip needed before voice can start). We cache on two
// levels so the real Metered API is called as rarely as possible:
//   1. Here, in memory, shared across every player on this server process -
//      one fetch serves everyone until CACHE_TTL_MS elapses.
//   2. In the browser's localStorage (see public/js/voice.js) - a returning
//      player reuses their last-cached credentials directly, with zero
//      network calls at all (not even to our own /api/turn-credentials),
//      until they expire.
// Metered's default (non-expiring-credential) endpoint doesn't return a
// per-response TTL, so CACHE_TTL_MS below is a conservative assumption, not
// a documented guarantee. If you configure custom expiring credentials via
// Metered's "create credential" API with your own expiryInSeconds, lower
// this to match (and lower it below that on the client too, in voice.js).
// Override without a code change via METERED_CACHE_HOURS.
//
// TURN relay bandwidth itself is already minimized independently of this
// cache: WebRTC's ICE negotiation always prefers a direct peer-to-peer path
// (host/STUN candidates) over relaying through TURN, and only falls back to
// TURN when a direct path genuinely isn't reachable - so most same-network
// or simple-NAT pairs never touch your Metered quota at all.
//
// FALLBACK: if those env vars aren't set (e.g. local dev, or before you've
// signed up), or the Metered request fails for any reason, this falls back
// to public Google STUN servers plus the free static Open Relay Project TURN
// credentials that were already in this codebase. That fallback still works
// for same-network testing and often for real players too, but it's a
// shared/unmetered community server, not something to depend on for a real
// audience.

const STATIC_FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

const CACHE_TTL_MS = (Number(process.env.METERED_CACHE_HOURS) || 6) * 60 * 60 * 1000;
let cache = { iceServers: null, expiresAt: 0, degraded: false, reason: null };
let inflight = null; // de-dupes concurrent cache-miss requests into one Metered call
let warnedOnce = false;

// Returns { iceServers, reason } on success, or { iceServers: null, reason }
// on failure. `reason` distinguishes WHY we're not using Metered, because
// the client-facing UI treats these differently:
//   'unconfigured' - METERED_APP_NAME/METERED_API_KEY were never set. This
//     is an expected, non-alarming state (local dev, or before you've
//     signed up) - the lobby should NOT show a scary warning for this.
//   'unreachable'  - the env vars ARE set but the request to Metered still
//     failed (timeout, non-2xx, empty response). This is the case worth
//     surfacing to players, since it means a real deployment's TURN relay
//     isn't working right now - possibly the free tier's monthly relay
//     quota is used up, possibly a transient Metered outage. We can't
//     distinguish those two from this API response alone, so the reason is
//     reported honestly as "unreachable" rather than guessing which.
async function fetchMeteredIceServers() {
  const appName = process.env.METERED_APP_NAME;
  const apiKey = process.env.METERED_API_KEY;
  if (!appName || !apiKey) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        '[turn] METERED_APP_NAME / METERED_API_KEY not set - falling back to the shared, ' +
        'best-effort Open Relay Project TURN server. Fine for testing; for real players on ' +
        'different networks, get a free key at https://www.metered.ca/stun-turn and set both ' +
        'env vars for a much more reliable relay.'
      );
    }
    return { iceServers: null, reason: 'unconfigured' };
  }

  const url = `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Metered API returned ${response.status}`);
    const iceServers = await response.json();
    if (!Array.isArray(iceServers) || iceServers.length === 0) throw new Error('Metered API returned no ICE servers');
    console.log(`[turn] Fetched fresh Metered TURN credentials, caching for ${(CACHE_TTL_MS / 3600000).toFixed(1)}h.`);
    return { iceServers, reason: null };
  } catch (err) {
    console.warn(
      '[turn] METERED_APP_NAME/METERED_API_KEY are set but the Metered API call failed - this ' +
      'usually means either a transient outage or the free tier\'s monthly relay quota is used ' +
      'up. Falling back to the shared Open Relay TURN server for now. Details:', err.message
    );
    return { iceServers: null, reason: 'unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

// Returns { iceServers, expiresAt, degraded, reason } for the client.
// `degraded` is true whenever we're not using properly-configured Metered
// credentials - the client uses this to decide whether to show players a
// "voice may not connect across networks right now" notice. Cached in
// memory between calls so we don't hit Metered's API on every single player
// connection - only once per cache window per server process, no matter how
// many players connect in that window. Concurrent cache-miss requests (e.g.
// several players joining at the same moment right as the cache expires)
// are de-duplicated into a single in-flight Metered fetch via `inflight`,
// rather than each firing its own request.
async function getIceServers() {
  if (cache.iceServers && Date.now() < cache.expiresAt) {
    return { iceServers: cache.iceServers, expiresAt: cache.expiresAt, degraded: cache.degraded, reason: cache.reason };
  }

  if (!inflight) {
    inflight = fetchMeteredIceServers().finally(() => { inflight = null; });
  }
  const { iceServers: metered, reason } = await inflight;

  if (metered) {
    cache = { iceServers: metered, expiresAt: Date.now() + CACHE_TTL_MS, degraded: false, reason: null };
    return { iceServers: metered, expiresAt: cache.expiresAt, degraded: false, reason: null };
  }

  // Don't cache the fallback for long - if Metered is configured but had a
  // transient hiccup, we want to retry soon rather than being stuck on the
  // weaker shared server for hours. Also tell the client (via expiresAt) not
  // to persist this one in localStorage for long either.
  const expiresAt = Date.now() + 60 * 1000;
  cache = { iceServers: STATIC_FALLBACK_ICE_SERVERS, expiresAt, degraded: true, reason };
  return { iceServers: STATIC_FALLBACK_ICE_SERVERS, expiresAt, degraded: true, reason };
}

module.exports = { getIceServers };
