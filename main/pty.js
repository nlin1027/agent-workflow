'use strict';
// Master pseudo-terminal: a real shell in node-pty feeding @xterm/headless; the renderer only ever
// receives snapshots (styled rows) of the headless buffer.
const { EventEmitter } = require('events');
const { Terminal } = require('@xterm/headless');

const SCROLLBACK = 10000;

// xterm default-ish 16 colour palette, then the 6x6x6 cube and the grey ramp.
const ANSI16 = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
const PALETTE = (() => {
  const p = ANSI16.slice();
  const hex = (n) => n.toString(16).padStart(2, '0');
  const lvl = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) p.push('#' + hex(lvl[Math.floor(i / 36)]) + hex(lvl[Math.floor(i / 6) % 6]) + hex(lvl[i % 6]));
  for (let i = 0; i < 24; i++) { const v = 8 + i * 10; p.push('#' + hex(v) + hex(v) + hex(v)); }
  return p;
})();

function colorOf(isDefault, isRGB, isPalette, value) {
  if (isDefault) return null;
  if (isRGB) return '#' + (value & 0xffffff).toString(16).padStart(6, '0');
  if (isPalette) return PALETTE[value] || null;
  return null;
}

/** Serialise one buffer line into run-length styled segments. Falsy flags are omitted. */
function lineRuns(line, cols, cell) {
  const runs = [];
  let cur = null;
  const end = Math.min(cols, line.length);
  for (let x = 0; x < end; x++) {
    line.getCell(x, cell);
    const w = cell.getWidth();
    if (w === 0) continue;
    const ch = cell.getChars() || ' ';
    const fg = colorOf(cell.isFgDefault(), cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor());
    const bg = colorOf(cell.isBgDefault(), cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor());
    const b = !!cell.isBold(); const i = !!cell.isItalic(); const u = !!cell.isUnderline();
    const inv = !!cell.isInverse(); const d = !!cell.isDim();
    if (cur && cur.fg === fg && cur.bg === bg && !cur.b === !b && !cur.i === !i && !cur.u === !u && !cur.inv === !inv && !cur.d === !d) {
      cur.t += ch;
    } else {
      cur = { t: ch, fg, bg };
      if (b) cur.b = true;
      if (i) cur.i = true;
      if (u) cur.u = true;
      if (inv) cur.inv = true;
      if (d) cur.d = true;
      runs.push(cur);
    }
  }
  // drop trailing unstyled blanks
  while (runs.length) {
    const r = runs[runs.length - 1];
    if (r.bg || r.inv || r.u || r.t.trim() !== '') {
      if (!r.bg && !r.inv && !r.u) r.t = r.t.replace(/\s+$/, '');
      break;
    }
    runs.pop();
  }
  return runs;
}

class MasterTerminal extends EventEmitter {
  /**
   * @param {object} o {file, args, cwd, env, cols, rows, scrollback, throttleMs, pty (injectable node-pty module)}
   */
  constructor(o = {}) {
    super();
    this.cols = o.cols || 120;
    this.rows = o.rows || 30;
    this.throttleMs = o.throttleMs === undefined ? 33 : o.throttleMs;
    this.lastKey = 0; // Date.now() of the last user keystroke
    this.title = '';
    this.exited = false;
    this._dirty = false;
    this._timer = null;
    this._cache = [];
    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: o.scrollback || SCROLLBACK, allowProposedApi: true });
    this._cell = this.term.buffer.active.getNullCell();
    this.term.onTitleChange((t) => { this.title = t; this.emit('title', t); });
    // Answer terminal queries (DA, cursor position, ...) that TUIs send.
    this.term.onData((d) => this.write(d));
    const nodePty = o.pty || require('node-pty');
    this.pty = nodePty.spawn(o.file, o.args || [], {
      name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: o.cwd, env: o.env || process.env, useConpty: true,
    });
    this.pty.onData((d) => {
      this.term.write(d, () => this._markDirty());
    });
    this.pty.onExit((e) => { this.exited = true; this.emit('exit', e); });
  }

  alive() { return !this.exited; }

  /** Raw data to the pty (does not count as user typing). */
  write(data) { if (!this.exited) { try { this.pty.write(data); } catch { /* closed */ } } }

  /** Data typed by the user. */
  input(data) { this.lastKey = Date.now(); this.write(data); }

  /** Type text then press Enter, as separate writes so a TUI doesn't treat the Enter as part of a paste. */
  async submit(text, delayMs = 400) {
    this.write(text);
    await new Promise((r) => setTimeout(r, delayMs));
    this.write('\r');
  }

  resize(cols, rows) {
    cols = Math.max(2, Math.floor(cols) || this.cols);
    rows = Math.max(1, Math.floor(rows) || this.rows);
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols; this.rows = rows;
    this.term.resize(cols, rows);
    if (!this.exited) { try { this.pty.resize(cols, rows); } catch { /* closed */ } }
    this._markDirty();
  }

  _markDirty() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (!this._dirty) return;
      this._dirty = false;
      this.emit('snapshot', this.snapshot());
    }, this.throttleMs);
  }

  /** Full snapshot: every row of the active buffer (scrollback included). */
  snapshot() {
    const buf = this.term.buffer.active;
    const cols = this.cols;
    const cell = this._cell;
    const lines = new Array(buf.length);
    const cache = this._cache;
    const next = new Array(buf.length);
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      if (!line) { lines[y] = []; next[y] = null; continue; }
      if (y < buf.baseY) { // scrollback rows are immutable once scrolled: reuse when text is unchanged
        const sig = line.translateToString(false);
        const c = cache[y];
        if (c && c.sig === sig && c.cols === cols) { lines[y] = c.runs; next[y] = c; continue; }
        const runs = lineRuns(line, cols, cell);
        next[y] = { sig, cols, runs };
        lines[y] = runs;
      } else {
        lines[y] = lineRuns(line, cols, cell);
        next[y] = null;
      }
    }
    this._cache = next;
    let hidden = false;
    try { hidden = !!this.term._core.coreService.isCursorHidden; } catch { /* internal API moved */ }
    return {
      cols, rows: this.rows,
      // y is relative to the viewport (add baseY for the absolute row in `lines`); absY is that sum.
      cursor: { x: buf.cursorX, y: buf.cursorY, absY: buf.baseY + buf.cursorY, visible: !hidden },
      altScreen: buf.type === 'alternate',
      baseY: buf.baseY,
      lines,
    };
  }

  /** Plain text of the whole buffer (handy for tests/diagnostics). */
  text() {
    const buf = this.term.buffer.active;
    const out = [];
    for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y).translateToString(true));
    return out.join('\n');
  }

  kill() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this.exited) { try { this.pty.kill(); } catch { /* gone */ } }
    this.exited = true;
  }
}

module.exports = { MasterTerminal, lineRuns, PALETTE, SCROLLBACK };
