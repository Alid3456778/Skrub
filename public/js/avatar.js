// Skribbl.io-style avatar system: a friendly "blob" character built from
// SVG, with cycle-able face presets and colors. Avatars are stored fully
// descriptively (not as indices) so they render identically across every
// client/version and stay small + safe to send through the socket.

export const AVATAR_COLORS = [
  '#8a94a6', // classic skribbl grey
  '#ff6b6b', '#ff9f43', '#feca57', '#1dd1a1',
  '#54a0ff', '#5f27cd', '#ff6bcb', '#00d2d3', '#c8d600'
];

export const AVATAR_FACES = [
  { key: 'classic',  label: 'Classic',  eyes: 'round',  mouth: 'smile',    accessory: 'none' },
  { key: 'chill',     label: 'Chill',    eyes: 'sleepy', mouth: 'flat',     accessory: 'none' },
  { key: 'shocked',   label: 'Shocked',  eyes: 'wide',   mouth: 'open',     accessory: 'none' },
  { key: 'cheeky',    label: 'Cheeky',   eyes: 'wink',   mouth: 'grin',     accessory: 'none' },
  { key: 'blushing',  label: 'Blushing', eyes: 'happy',  mouth: 'smile',    accessory: 'blush' },
  { key: 'silly',     label: 'Silly',    eyes: 'round',  mouth: 'tongue',   accessory: 'none' },
  { key: 'dapper',    label: 'Dapper',   eyes: 'round',  mouth: 'smile',    accessory: 'mustache' },
  { key: 'fancy',     label: 'Fancy',    eyes: 'round',  mouth: 'flat',     accessory: 'monocle' },
  { key: 'party',     label: 'Party',    eyes: 'happy',  mouth: 'open',     accessory: 'partyhat' },
  { key: 'cool',      label: 'Cool',     eyes: 'wide',   mouth: 'flat',     accessory: 'sunglasses' }
];

// Every arrow click moves to the next combined (color, face) pairing. The
// step of 7 (coprime with 10) means consecutive clicks don't just walk the
// color list in order - it feels like a fresh look each time, same as
// scrolling through skribbl.io's preset gallery.
const COMBOS = AVATAR_COLORS.length * AVATAR_FACES.length;
function comboAt(index) {
  const i = ((index % COMBOS) + COMBOS) % COMBOS;
  const faceIndex = i % AVATAR_FACES.length;
  const colorIndex = (i * 7 + Math.floor(i / AVATAR_FACES.length)) % AVATAR_COLORS.length;
  return { color: AVATAR_COLORS[colorIndex], ...AVATAR_FACES[faceIndex] };
}

export function defaultAvatar() {
  return comboAt(0);
}

export function randomAvatar() {
  return comboAt(Math.floor(Math.random() * COMBOS));
}

// Find the closest combo index for an existing avatar (used to seed the
// arrow-cycle position from a previously-saved profile).
export function nearestComboIndex(avatar) {
  for (let i = 0; i < COMBOS; i++) {
    const c = comboAt(i);
    if (c.color === avatar.color && c.eyes === avatar.eyes && c.mouth === avatar.mouth && c.accessory === avatar.accessory) {
      return i;
    }
  }
  return 0;
}

export function comboByIndex(index) { return comboAt(index); }
export const COMBO_COUNT = COMBOS;

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, (n >> 16) + amt));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 0xff) + amt));
  const b = Math.min(255, Math.max(0, (n & 0xff) + amt));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function eyesSvg(style) {
  switch (style) {
    case 'sleepy':
      return `<path d="M38 55 q7 6 14 0" stroke="#1a1a1a" stroke-width="4" fill="none" stroke-linecap="round"/>
              <path d="M68 55 q7 6 14 0" stroke="#1a1a1a" stroke-width="4" fill="none" stroke-linecap="round"/>`;
    case 'wide':
      return `<ellipse cx="45" cy="54" rx="11" ry="13" fill="#fff" stroke="#1a1a1a" stroke-width="2.5"/>
              <ellipse cx="75" cy="54" rx="11" ry="13" fill="#fff" stroke="#1a1a1a" stroke-width="2.5"/>
              <circle cx="46" cy="56" r="4.5" fill="#1a1a1a"/><circle cx="76" cy="56" r="4.5" fill="#1a1a1a"/>`;
    case 'wink':
      return `<circle cx="45" cy="55" r="7" fill="#1a1a1a"/>
              <path d="M68 55 q7 5 14 0" stroke="#1a1a1a" stroke-width="4" fill="none" stroke-linecap="round"/>`;
    case 'happy':
      return `<path d="M36 58 q9 -12 18 0" stroke="#1a1a1a" stroke-width="4" fill="none" stroke-linecap="round"/>
              <path d="M66 58 q9 -12 18 0" stroke="#1a1a1a" stroke-width="4" fill="none" stroke-linecap="round"/>`;
    case 'round':
    default:
      return `<circle cx="45" cy="55" r="7.5" fill="#1a1a1a"/>
              <circle cx="75" cy="55" r="7.5" fill="#1a1a1a"/>
              <circle cx="47.5" cy="52.5" r="2" fill="#fff"/><circle cx="77.5" cy="52.5" r="2" fill="#fff"/>`;
  }
}

function mouthSvg(style) {
  switch (style) {
    case 'flat':
      return `<line x1="48" y1="80" x2="72" y2="80" stroke="#1a1a1a" stroke-width="4" stroke-linecap="round"/>`;
    case 'open':
      return `<ellipse cx="60" cy="82" rx="10" ry="8" fill="#5c2b2b" stroke="#1a1a1a" stroke-width="3"/>`;
    case 'grin':
      return `<path d="M45 78 q15 14 30 0 q-3 10 -15 10 q-12 0 -15 -10 Z" fill="#fff" stroke="#1a1a1a" stroke-width="2.5"/>`;
    case 'tongue':
      return `<ellipse cx="60" cy="81" rx="11" ry="9" fill="#5c2b2b" stroke="#1a1a1a" stroke-width="3"/>
              <path d="M52 84 q8 10 16 0 q-8 4 -16 0 Z" fill="#ff8aa8"/>`;
    case 'smile':
    default:
      return `<path d="M46 76 q14 14 28 0" stroke="#1a1a1a" stroke-width="4" fill="none" stroke-linecap="round"/>`;
  }
}

function accessorySvg(style, color) {
  switch (style) {
    case 'mustache':
      return `<path d="M40 70 q10 -8 20 0 q10 -8 20 0 q-8 6 -20 2 q-12 4 -20 -2 Z" fill="#2b2b2b"/>`;
    case 'monocle':
      return `<circle cx="75" cy="55" r="13" fill="none" stroke="#d4af37" stroke-width="2.5"/>
              <line x1="86" y1="63" x2="94" y2="80" stroke="#d4af37" stroke-width="2"/>`;
    case 'partyhat':
      return `<path d="M60 4 L78 34 L42 34 Z" fill="#ff6bcb" stroke="#1a1a1a" stroke-width="2.5"/>
              <circle cx="60" cy="4" r="4" fill="#feca57" stroke="#1a1a1a" stroke-width="1.5"/>
              <circle cx="50" cy="20" r="2.5" fill="#1dd1a1"/><circle cx="68" cy="16" r="2.5" fill="#54a0ff"/>`;
    case 'sunglasses':
      return `<rect x="32" y="47" width="22" height="14" rx="5" fill="#1a1a1a"/>
              <rect x="66" y="47" width="22" height="14" rx="5" fill="#1a1a1a"/>
              <line x1="54" y1="53" x2="66" y2="53" stroke="#1a1a1a" stroke-width="3"/>`;
    case 'blush':
      return `<ellipse cx="38" cy="68" rx="7" ry="4.5" fill="${shade(color, -30)}" opacity="0.55"/>
              <ellipse cx="82" cy="68" rx="7" ry="4.5" fill="${shade(color, -30)}" opacity="0.55"/>`;
    case 'none':
    default:
      return '';
  }
}

// Builds a full avatar SVG string ready to drop into innerHTML.
export function avatarSVG(avatar) {
  const a = avatar || defaultAvatar();
  const color = a.color || AVATAR_COLORS[0];
  const belly = shade(color, 28);
  return `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="avatar">
    <path d="M60 8
      C 92 8 106 30 106 62
      C 106 96 86 112 60 112
      C 34 112 14 96 14 62
      C 14 30 28 8 60 8 Z"
      fill="${color}" stroke="#1a1a1a" stroke-width="3.5"/>
    <ellipse cx="60" cy="70" rx="30" ry="24" fill="${belly}" opacity="0.5"/>
    ${eyesSvg(a.eyes)}
    ${mouthSvg(a.mouth)}
    ${accessorySvg(a.accessory, color)}
  </svg>`;
}

export function renderAvatarInto(el, avatar) {
  if (el) el.innerHTML = avatarSVG(avatar);
}
