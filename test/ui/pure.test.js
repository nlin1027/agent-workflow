'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const TermKeys = require('../../renderer/termkeys.js');
const TermView = require('../../renderer/termview.js');
const Workers = require('../../renderer/workers.js');
const View = require('../../renderer/view.js');

const ev = (key, o) => Object.assign({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, o);
const K = (key, o) => TermKeys.keyToSequence(ev(key, o));

test('printable and basic keys', () => {
  assert.equal(K('a'), 'a');
  assert.equal(K('A', { shiftKey: true }), 'A');
  assert.equal(K('Enter'), '\r');
  assert.equal(K('Enter', { shiftKey: true }), '\x1b\r');
  assert.equal(K('Backspace'), '\x7f');
  assert.equal(K('Tab'), '\t');
  assert.equal(K('Tab', { shiftKey: true }), '\x1b[Z');
  assert.equal(K('Escape'), '\x1b');
  assert.equal(K('Shift'), null);
  assert.equal(K('Process', {}), null);
});

test('ctrl / alt combos', () => {
  assert.equal(K('c', { ctrlKey: true }), '\x03');
  assert.equal(K('D', { ctrlKey: true }), '\x04');
  assert.equal(K('z', { ctrlKey: true }), '\x1a');
  assert.equal(K('[', { ctrlKey: true }), '\x1b');
  assert.equal(K(' ', { ctrlKey: true }), '\x00');
  assert.equal(K('b', { altKey: true }), '\x1bb');
  assert.equal(K('Backspace', { ctrlKey: true }), '\x17');
});

test('cursor, navigation and function keys', () => {
  assert.equal(K('ArrowUp'), '\x1b[A');
  assert.equal(TermKeys.keyToSequence(ev('ArrowUp'), { appCursor: true }), '\x1bOA');
  assert.equal(K('ArrowLeft', { ctrlKey: true }), '\x1b[1;5D');
  assert.equal(K('ArrowRight', { shiftKey: true, altKey: true }), '\x1b[1;4C');
  assert.equal(K('Home'), '\x1b[H');
  assert.equal(K('End'), '\x1b[F');
  assert.equal(K('Delete'), '\x1b[3~');
  assert.equal(K('PageUp'), '\x1b[5~');
  assert.equal(K('PageDown'), '\x1b[6~');
  assert.equal(K('Insert'), '\x1b[2~');
  assert.equal(K('F1'), '\x1bOP');
  assert.equal(K('F4'), '\x1bOS');
  assert.equal(K('F5'), '\x1b[15~');
  assert.equal(K('F12'), '\x1b[24~');
  assert.equal(K('F5', { ctrlKey: true }), '\x1b[15;5~');
});

test('paste preparation', () => {
  assert.equal(TermKeys.preparePaste('a\nb\r\nc', false), 'a\rb\rc');
  assert.equal(TermKeys.preparePaste('x', true), '\x1b[200~x\x1b[201~');
  assert.ok(!TermKeys.preparePaste('a\x1b[201~b', true).slice(6, -6).includes('\x1b[201~'));
});

const H = TermView.helpers;
test('segStyle handles colors, attributes and inverse', () => {
  assert.equal(H.segStyle({ t: 'x', fg: '#f00' }), 'color:#f00;');
  assert.match(H.segStyle({ t: 'x', b: true, i: true, u: true }), /font-weight:700;font-style:italic;text-decoration:underline;/);
  assert.equal(H.segStyle({ t: 'x', fg: '#111', bg: '#222', inv: true }), 'color:#222;background:#111;');
  assert.equal(H.segStyle({ t: 'x', inv: true }), 'color:var(--term-bg);background:var(--term-fg);');
});

test('rowSpans splits around the cursor cell', () => {
  const segs = [{ t: 'hello', fg: '#0f0' }, { t: ' world' }];
  const sp = H.rowSpans(segs, 2);
  assert.deepEqual(sp.map(s => s.text), ['he', 'l', 'lo', ' world']);
  assert.deepEqual(sp.map(s => s.cursor), [false, true, false, false]);
  const end = H.rowSpans([{ t: 'ab' }], 5);
  assert.deepEqual(end.map(s => s.text), ['ab', '   ', ' ']);
  assert.ok(end[2].cursor);
  assert.deepEqual(H.rowSpans([], 0).map(s => [s.text, s.cursor]), [[' ', true]]);
  assert.equal(H.rowSpans([{ t: 'ab' }], null).length, 1);
});

test('detectShift finds scrollback trimming', () => {
  const old = Array.from({ length: 50 }, (_, i) => 'k' + i);
  const nw = old.slice(5).concat(['n1', 'n2', 'n3', 'n4', 'n5']);
  assert.equal(H.detectShift(old, nw), 5);
  assert.equal(H.detectShift(old, old.slice()), 0);
  assert.equal(H.detectShift(old, old.map(k => 'z' + k)), 0);
});

test('computeGrid / cleanCopy / isAtBottom', () => {
  assert.deepEqual(H.computeGrid(800, 360, 8, 18), { cols: 100, rows: 20 });
  assert.deepEqual(H.computeGrid(0, 0, 0, 0), { cols: 80, rows: 24 });
  assert.equal(H.cleanCopy('a   \nb  \n\n'), 'a\nb');
  assert.ok(H.isAtBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }));
  assert.ok(!H.isAtBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 400 }));
});

const WH = Workers.helpers;
test('worker status rules', () => {
  for (const s of ['done', 'failed', 'killed']) { assert.ok(WH.canDelete({ status: s })); assert.ok(!WH.canKill({ status: s })); }
  for (const s of ['new', 'running', 'idle']) { assert.ok(!WH.canDelete({ status: s })); assert.ok(WH.canKill({ status: s })); }
  assert.equal(WH.classifyLine('error: boom'), 'err');
  assert.equal(WH.classifyLine('[tool] Bash ls'), 'tool');
  assert.equal(WH.classifyLine('hello'), '');
});

test('window geometry', () => {
  const r = WH.clampRect({ x: -50, y: 5000, w: 50, h: 50 }, 900, 600);
  assert.equal(r.x, 0); assert.equal(r.y, 560); assert.equal(r.w, WH.MIN_W); assert.equal(r.h, WH.MIN_H);
  const s = { x: 100, y: 100, w: 400, h: 300 };
  assert.deepEqual(WH.resizeRect(s, 'se', 50, 20), { x: 100, y: 100, w: 450, h: 320 });
  assert.deepEqual(WH.resizeRect(s, 'nw', 30, 10), { x: 130, y: 110, w: 370, h: 290 });
  assert.equal(WH.resizeRect(s, 'w', 999, 0).w, WH.MIN_W);
  assert.notDeepEqual(WH.cascadeRect(0, 900, 600), WH.cascadeRect(1, 900, 600));
});

test('goal and master view models', () => {
  assert.equal(View.goalView(null).empty, true);
  assert.deepEqual(View.goalView({ goal: { text: 'ship it', repo: '/r', done: true } }), { text: 'ship it', repo: '/r', done: true, empty: false });
  assert.equal(View.masterView({ masterCli: 'none' }).canStart, true);
  assert.equal(View.masterView({ masterCli: 'claude', masterState: 'busy' }).text, 'claude · busy');
  assert.deepEqual(View.workerCounts({ workers: [{ status: 'running' }, { status: 'done' }, { status: 'idle' }] }), { total: 3, active: 2, finished: 1 });
});
