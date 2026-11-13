'use strict';
// DOM-level tests of the renderer running against renderer/mock.js. Needs jsdom (devDependency); skipped if absent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* skipped below */ }
const skip = JSDOM ? false : 'jsdom not installed';

const R = path.join(__dirname, '..', '..', 'renderer');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function boot() {
  const html = fs.readFileSync(path.join(R, 'index.html'), 'utf8').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/index.html?mock=1' });
  for (const f of ['termkeys', 'termview', 'workers', 'view', 'mock', 'app']) dom.window.eval(fs.readFileSync(path.join(R, f + '.js'), 'utf8'));
  await sleep(120);
  return dom;
}
const q = (dom, sel) => dom.window.document.querySelector(sel);
const qa = (dom, sel) => [...dom.window.document.querySelectorAll(sel)];
const chip = (dom, n) => q(dom, `.chip[data-name="${n}"]`);
const win = (dom, n) => q(dom, `.wwin[data-name="${n}"]`);
const click = (dom, el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

test('goal bar shows goal, empty placeholder and done state', { skip }, async () => {
  const dom = await boot();
  assert.match(q(dom, '#goalText').textContent, /Rebuild the Agent Manager/);
  dom.window.__mock.goalDone();
  assert.ok(q(dom, '#goal').classList.contains('done'));
  assert.ok(!q(dom, '#goalBadge').classList.contains('hidden'));
  dom.window.__mock.setGoal('');
  assert.ok(q(dom, '#goal').classList.contains('empty'));
  assert.match(q(dom, '#goalText').textContent, /No goal set/);
  dom.window.close();
});

test('dock lists all workers; chip toggles window open/minimized', { skip }, async () => {
  const dom = await boot();
  assert.equal(qa(dom, '.chip').length, 5);
  assert.equal(q(dom, '#workerCount').textContent, '5');
  assert.ok(win(dom, 'ui').classList.contains('hidden'));
  click(dom, chip(dom, 'ui'));
  assert.ok(!win(dom, 'ui').classList.contains('hidden'));
  assert.ok(chip(dom, 'ui').classList.contains('open'));
  assert.match(win(dom, 'ui').querySelector('.wsum').textContent, /Renderer/); // worker's own goal
  click(dom, chip(dom, 'ui'));
  assert.ok(win(dom, 'ui').classList.contains('hidden'));
  click(dom, chip(dom, 'ui'));
  click(dom, win(dom, 'ui').querySelector('.b-min'));
  assert.ok(win(dom, 'ui').classList.contains('hidden'));
  assert.ok(!chip(dom, 'ui').classList.contains('open'));
  dom.window.close();
});

test('log shows backlog and live lines', { skip }, async () => {
  const dom = await boot();
  click(dom, chip(dom, 'backend'));
  const log = win(dom, 'backend').querySelector('.wlog');
  const before = log.children.length;
  assert.equal(before, 80);
  dom.window.__mock.line('backend', 'live line!');
  assert.equal(log.children.length, before + 1);
  assert.equal(log.lastChild.textContent, 'live line!');
  dom.window.close();
});

test('kill and delete rules', { skip }, async () => {
  const dom = await boot();
  const m = dom.window.__mock;
  const run = win(dom, 'backend');
  assert.ok(run.querySelector('.b-del').disabled);
  assert.notEqual(run.querySelector('.b-kill').style.display, 'none');
  click(dom, run.querySelector('.b-kill'));
  assert.deepEqual(m.calls.at(-1), ['kill', 'backend']);
  assert.ok(!run.querySelector('.b-del').disabled);
  assert.equal(run.querySelector('.b-kill').style.display, 'none');
  click(dom, win(dom, 'docs').querySelector('.b-del'));
  assert.equal(win(dom, 'docs'), null);
  assert.equal(chip(dom, 'docs'), null);
  assert.equal(q(dom, '#workerCount').textContent, '4');
  click(dom, win(dom, 'ui').querySelector('.b-del')); // disabled: no effect
  assert.ok(win(dom, 'ui'));
  dom.window.close();
});

test('message form sends to worker', { skip }, async () => {
  const dom = await boot();
  const w = win(dom, 'ui');
  click(dom, w.querySelector('.b-msg'));
  assert.ok(!w.querySelector('.wmsg').classList.contains('hidden'));
  w.querySelector('.wmsg input').value = 'please hurry';
  w.querySelector('.wmsg').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.deepEqual(dom.window.__mock.calls.at(-1), ['message', 'ui', 'please hurry']);
  dom.window.close();
});

test('provider toggle', { skip }, async () => {
  const dom = await boot();
  click(dom, q(dom, '#provider [data-p="codex"]'));
  await sleep(10);
  assert.ok(q(dom, '#provider [data-p="codex"]').classList.contains('active'));
  assert.deepEqual(dom.window.__mock.calls.at(-1), ['provider', 'codex']);
  click(dom, q(dom, '#startMaster'));
  assert.equal(q(dom, '#startMaster').disabled, true);
  dom.window.close();
});

test('terminal projects snapshot, forwards keys, follows bottom unless scrolled up', { skip }, async () => {
  const dom = await boot();
  const { term } = dom.window.__ui;
  const snap = dom.window.__mock.snapshot();
  assert.equal(term.rowEls.length, snap.lines.length);
  assert.match(term.text(), /scrollback sample text/);
  assert.ok(term.content.querySelector('.cur'), 'cursor rendered');

  const s = term.scroller;
  const key = (k, o) => s.dispatchEvent(new dom.window.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, o)));
  for (const c of 'echo hi') key(c);
  key('Enter');
  await sleep(100);
  assert.match(term.text(), /PS C:\\repo> echo hi\n?[\s\S]*\nhi/);

  // user scrolls up: follow stops, jump button shows, new output does not yank the view
  Object.defineProperty(s, 'scrollHeight', { value: 5000, configurable: true });
  Object.defineProperty(s, 'clientHeight', { value: 500, configurable: true });
  s.scrollTop = 100;
  s.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(term.stick, false);
  assert.ok(!term.jump.classList.contains('hidden'));
  term.setSnapshot(dom.window.__mock.snapshot());
  await sleep(50);
  assert.equal(s.scrollTop, 100);
  // back to bottom
  s.scrollTop = 4500;
  s.dispatchEvent(new dom.window.Event('scroll'));
  assert.equal(term.stick, true);
  dom.window.close();
});
