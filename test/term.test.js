'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { waitFor } = require('./helpers');

let nodePty = null;
let loadErr = null;
try { nodePty = require('node-pty'); } catch (e) { loadErr = e; }
const skip = nodePty ? false : 'node-pty failed to load under plain node: ' + (loadErr && loadErr.message);

const { MasterTerminal, lineRuns, PALETTE } = require('../main/pty');

const rowText = (row) => row.map((r) => r.t).join('');

test('PALETTE has 256 entries with known anchors', () => {
  assert.equal(PALETTE.length, 256);
  assert.equal(PALETTE[16], '#000000');
  assert.equal(PALETTE[21], '#0000ff');
  assert.equal(PALETTE[231], '#ffffff');
  assert.equal(PALETTE[232], '#080808');
});

test('real pty: scrollback > rows, ANSI colours, input, resize', { skip, timeout: 60000 }, async () => {
  const t = new MasterTerminal({
    file: process.execPath, args: [path.join(__dirname, 'term-script.js')], cwd: __dirname, cols: 100, rows: 10, throttleMs: 10,
  });
  try {
    const snaps = [];
    t.on('snapshot', (s) => snaps.push(s));
    await waitFor(() => t.text().includes('END'), 20000, 'script output');
    await waitFor(() => snaps.length > 0, 5000, 'snapshot event');

    const s = t.snapshot();
    assert.equal(s.cols, 100);
    assert.equal(s.rows, 10);
    assert.equal(s.altScreen, false);
    assert.ok(s.lines.length > s.rows, 'buffer includes scrollback: ' + s.lines.length);
    assert.ok(s.baseY > 0, 'baseY > 0 once output scrolled');
    assert.equal(s.lines.length, s.baseY + s.rows);
    assert.equal(typeof s.cursor.x, 'number');
    assert.equal(s.cursor.absY, s.baseY + s.cursor.y);
    assert.equal(s.cursor.visible, true);

    const texts = s.lines.map(rowText);
    assert.ok(texts.includes('line 001'), 'first line kept in scrollback');
    assert.ok(texts.includes('line 080'));
    assert.ok(texts.indexOf('line 001') < s.baseY, 'line 001 is in scrollback, above the viewport');
    assert.ok(texts.indexOf('END') >= 0);

    const colored = s.lines.find((r) => rowText(r).includes('RED'));
    assert.ok(colored, 'coloured row present');
    const seg = (txt) => colored.find((r) => r.t.includes(txt));
    assert.equal(seg('RED').fg, '#cd3131'); // ANSI red from palette
    assert.equal(seg('TRUE').fg, '#0a141e'); // 24-bit colour
    // ConPTY re-encodes some attributes (bold/italic/inverse), so only the robust ones are asserted
    // here; exact attribute handling is covered by the fake-pty test below.
    assert.ok(seg('BOLDUL') && seg('INV') && seg('ITAL'));
    assert.equal(seg('BLUEBG').bg, '#0000ff'); // 256-colour bg index 21
    assert.equal(seg('plain').fg, null);
    assert.equal(seg('plain').bg, null);
    assert.ok(!seg('plain').b);

    // second snapshot reuses scrollback cache and must be identical
    assert.deepEqual(t.snapshot().lines, s.lines);

    // input reaches the process
    t.input('ping' + String.fromCharCode(13));
    await waitFor(() => t.text().includes('GOT:"ping'), 10000, 'echoed input');
    assert.ok(t.lastKey > 0);

    // resize
    t.resize(80, 12);
    const r = t.snapshot();
    assert.equal(r.cols, 80);
    assert.equal(r.rows, 12);
  } finally { t.kill(); }
});

test('headless buffer handles alt screen + hidden cursor sequences', async () => {
  let dataCb = () => {};
  const fakePty = { spawn: () => ({ onData: (cb) => { dataCb = cb; }, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} }) };
  const t = new MasterTerminal({ file: 'x', pty: fakePty, cols: 60, rows: 8, throttleMs: 5 });
  dataCb('base\r\n\x1b[?1049h\x1b[?25lALT SCREEN');
  await waitFor(() => t.snapshot().altScreen, 3000, 'alt screen');
  const s = t.snapshot();
  assert.equal(s.lines.length, 8);
  assert.ok(s.lines.map(rowText).some((x) => x.includes('ALT SCREEN')));
  assert.equal(s.cursor.visible, false);
});

test('fake pty: exact attribute / colour mapping, wide chars, cursor, title, query replies', async () => {
  const written = [];
  let dataCb = () => {};
  const fakePty = {
    spawn: () => ({
      onData: (cb) => { dataCb = cb; }, onExit: () => {}, write: (d) => written.push(d), resize: () => {}, kill: () => {},
    }),
  };
  const t = new MasterTerminal({ file: 'x', pty: fakePty, cols: 40, rows: 5, throttleMs: 5 });
  const titles = [];
  t.on('title', (x) => titles.push(x));
  dataCb('\x1b]0;my title\x07\x1b[1mB\x1b[0m\x1b[3mI\x1b[0m\x1b[4mU\x1b[0m\x1b[7mV\x1b[0m\x1b[2mD\x1b[0m\x1b[91mbright\x1b[0m 世界 \x1b[38;5;196mR196\x1b[0m\r\nsecond');
  await waitFor(() => t.text().includes('second'), 3000, 'write');
  const s = t.snapshot();
  const row = s.lines[0];
  const f = (txt) => row.find((r) => r.t.includes(txt));
  assert.equal(f('B').b, true);
  assert.equal(f('I').i, true);
  assert.equal(f('U').u, true);
  assert.equal(f('V').inv, true);
  assert.equal(f('D').d, true);
  assert.equal(f('bright').fg, PALETTE[9]);
  assert.equal(f('R196').fg, '#ff0000');
  assert.ok(rowText(row).includes('世界'));
  assert.equal(s.cursor.y, 1);
  assert.equal(s.cursor.x, 6);
  assert.deepEqual(titles, ['my title']);
  // terminal queries get answered through the pty (DSR cursor position)
  dataCb('\x1b[6n');
  await waitFor(() => written.some((w) => /\x1b\[\d+;\d+R/.test(w)), 3000, 'DSR reply');
  t.kill();
});

test('lineRuns trims trailing blanks but keeps coloured blanks (fake buffer line)', () => {
  const mk = (cells) => ({
    length: cells.length,
    getCell(x, c) { c._c = cells[x]; return c; },
  });
  const cell = {
    _c: null,
    getWidth() { return 1; }, getChars() { return this._c.ch; },
    isFgDefault() { return true; }, isFgRGB() { return false; }, isFgPalette() { return false; }, getFgColor() { return 0; },
    isBgDefault() { return !this._c.bg; }, isBgRGB() { return false; }, isBgPalette() { return !!this._c.bg; }, getBgColor() { return this._c.bg || 0; },
    isBold() { return 0; }, isItalic() { return 0; }, isUnderline() { return 0; }, isInverse() { return 0; }, isDim() { return 0; },
  };
  const a = lineRuns(mk([{ ch: 'a' }, { ch: ' ' }, { ch: '' }]), 3, cell);
  assert.deepEqual(a, [{ t: 'a', fg: null, bg: null }]);
  const b = lineRuns(mk([{ ch: 'a' }, { ch: ' ', bg: 4 }]), 2, cell);
  assert.deepEqual(b.map((r) => [r.t, r.bg]), [['a', null], [' ', '#2472c8']]);
});
