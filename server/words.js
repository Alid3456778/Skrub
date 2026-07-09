// Standard dictionary used for "Standard" and "Hidden" word modes.
const WORDS = [
  'apple', 'banana', 'guitar', 'elephant', 'rocket', 'castle', 'dragon', 'laptop',
  'bicycle', 'umbrella', 'volcano', 'penguin', 'sandwich', 'tornado', 'skeleton',
  'mountain', 'butterfly', 'telescope', 'waterfall', 'dinosaur', 'submarine',
  'astronaut', 'lighthouse', 'pineapple', 'kangaroo', 'snowman', 'campfire',
  'helicopter', 'jellyfish', 'octopus', 'pyramid', 'robot', 'skateboard',
  'spaceship', 'tractor', 'windmill', 'zombie', 'ghost', 'wizard', 'pirate',
  'ninja', 'vampire', 'mermaid', 'unicorn', 'dragonfly', 'scorpion', 'cactus',
  'igloo', 'compass', 'anchor', 'balloon', 'bridge', 'candle', 'diamond',
  'feather', 'guitar', 'hammer', 'island', 'jacket', 'kettle', 'ladder',
  'magnet', 'necklace', 'orange', 'palette', 'quilt', 'rainbow', 'saddle',
  'thunder', 'violin', 'wagon', 'xylophone', 'yacht', 'zeppelin', 'avalanche',
  'blizzard', 'chimney', 'desert', 'earthquake', 'forest', 'glacier', 'harbor',
  'jungle', 'canyon', 'meadow', 'oasis', 'prairie', 'reef', 'swamp', 'tundra',
  'basketball', 'football', 'tennis', 'hockey', 'karate', 'boxing', 'surfing',
  'chess', 'piano', 'trumpet', 'drum', 'flute', 'harp', 'saxophone'
];

function sanitizeWord(w) {
  return String(w).trim().toLowerCase().replace(/[^a-z\-\s]/g, '');
}

function getWordOptions(count, mode, customWords) {
  let pool = WORDS;
  if (mode === 'Custom' && Array.isArray(customWords) && customWords.length > 0) {
    pool = customWords.map(sanitizeWord).filter(w => w.length >= 2);
    if (pool.length === 0) pool = WORDS;
  }
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const n = Math.min(count, shuffled.length);
  return shuffled.slice(0, n);
}

module.exports = { WORDS, getWordOptions, sanitizeWord };
