const crypto = require('crypto');
const Room = require('./Room');
const { PUBLIC_ROOM_CAP, DEFAULT_ROUNDS, DEFAULT_DRAW_TIME } = require('./constants');

function generateRoomId() {
  // Non-guessable but short enough to share verbally/in a link.
  return crypto.randomBytes(4).toString('hex');
}

class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map(); // roomId -> Room
  }

  _defaultSettings(overrides = {}) {
    return {
      rounds: DEFAULT_ROUNDS,
      drawTimeSec: DEFAULT_DRAW_TIME,
      wordMode: 'Standard',
      customWords: [],
      ...overrides
    };
  }

  createPrivateRoom(settings) {
    let id;
    do { id = generateRoomId(); } while (this.rooms.has(id));
    const room = new Room(id, false, this.io, this._defaultSettings(settings), (rid) => this.rooms.delete(rid));
    this.rooms.set(id, room);
    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  // Finds (or creates) a public room with space in the LOBBY phase.
  findOrCreatePublicRoom() {
    for (const room of this.rooms.values()) {
      if (room.isPublic && room.phase === 'LOBBY' && room.players.size < PUBLIC_ROOM_CAP) {
        return room;
      }
    }
    let id;
    do { id = 'pub-' + generateRoomId(); } while (this.rooms.has(id));
    const room = new Room(id, true, this.io, this._defaultSettings({ rounds: 3, drawTimeSec: 80 }), (rid) => this.rooms.delete(rid));
    this.rooms.set(id, room);
    return room;
  }

  roomCount() {
    return this.rooms.size;
  }
}

module.exports = RoomManager;
