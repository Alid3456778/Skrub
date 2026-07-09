export const PALETTE = [
  '#000000', '#ffffff', '#888888', '#ff0000', '#ff9c00', '#ffe600',
  '#3ddc3d', '#00c2c2', '#0066ff', '#7a29ff', '#ff29c9', '#a05a2c',
  '#ffb3c6', '#c9ffb3', '#b3d9ff', '#5c2d00'
];

export class DrawingCanvas {
  constructor(canvasEl, { onLocalStroke } = {}) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.onLocalStroke = onLocalStroke || (() => {});
    this.color = '#000000';
    this.size = 6;
    this.isDrawer = false;
    this.drawing = false;
    this.last = null;
    this.strokeId = 0;

    this._resizeToDisplaySize();
    window.addEventListener('resize', () => this._resizeToDisplaySize(true));

    this.canvas.addEventListener('mousedown', (e) => this._start(this._pos(e)));
    this.canvas.addEventListener('mousemove', (e) => this._move(this._pos(e)));
    window.addEventListener('mouseup', () => this._end());

    this.canvas.addEventListener('touchstart', (e) => { e.preventDefault(); this._start(this._pos(e.touches[0])); }, { passive: false });
    this.canvas.addEventListener('touchmove', (e) => { e.preventDefault(); this._move(this._pos(e.touches[0])); }, { passive: false });
    this.canvas.addEventListener('touchend', (e) => { e.preventDefault(); this._end(); }, { passive: false });
  }

  setDrawer(isDrawer) { this.isDrawer = isDrawer; }
  setColor(c) { this.color = c; }
  setSize(s) { this.size = s; }

  _resizeToDisplaySize(preserve) {
    // Canvas is drawn in a fixed logical coordinate space (800x600) and scaled
    // via CSS, so normalized coordinates stay consistent across screen sizes.
    this.logicalWidth = 800;
    this.logicalHeight = 600;
    if (this.canvas.width !== this.logicalWidth) this.canvas.width = this.logicalWidth;
    if (this.canvas.height !== this.logicalHeight) this.canvas.height = this.logicalHeight;
  }

  _pos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }

  _start(p) {
    if (!this.isDrawer) return;
    this.drawing = true;
    this.strokeId = Date.now() + Math.floor(Math.random() * 1000);
    this.last = p;
    // Draw a dot for single clicks
    this._drawSegment(p.x, p.y, p.x, p.y);
    this._emit(p.x, p.y, p.x, p.y);
  }

  _move(p) {
    if (!this.isDrawer || !this.drawing) return;
    this._drawSegment(this.last.x, this.last.y, p.x, p.y);
    this._emit(this.last.x, this.last.y, p.x, p.y);
    this.last = p;
  }

  _end() {
    this.drawing = false;
    this.last = null;
  }

  _drawSegment(x1, y1, x2, y2, color, size) {
    const ctx = this.ctx;
    ctx.strokeStyle = color || this.color;
    ctx.lineWidth = size || this.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  _emit(x1, y1, x2, y2) {
    this.onLocalStroke({
      strokeId: this.strokeId, x1, y1, x2, y2, color: this.color, size: this.size
    });
  }

  // Called for strokes arriving from the server (own or remote).
  applyRemoteSegment(seg) {
    this._drawSegment(seg.x1, seg.y1, seg.x2, seg.y2, seg.color, seg.size);
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  replayStrokes(strokes) {
    this.clear();
    strokes.forEach(s => this.applyRemoteSegment(s));
  }
}
