'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { Store, MAX_LINES } = require('../main/state');
const { tmpdir, cleanup } = require('./helpers');

test('goal lifecycle and worker bookkeeping', () => {
  const s = new Store('x', { persist: false });
  const changes = [];
  s.on('change', (st) => changes.push(st));
  assert.equal(s.toState().goal, null);
  s.setGoal('Build it', '/repo');
  assert.deepEqual(s.toState().goal, { text: 'Build it', repo: '/repo', done: false });
  s.setGoal('Build it better'); // updates in place, repo kept
  assert.deepEqual(s.toState().goal, { text: 'Build it better', repo: '/repo', done: false });
  const gid = s.goalId;
  s.addWorker({ name: 'a', summary: 'sa', prompt: 'p', branch: 'agent/a', worktree: '/w/a' });
  s.addWorker({ name: 'b', summary: 'sb' });
  assert.equal(s.getWorker('a').status, 'new');
  assert.equal(s.allFinished(), false);
  s.setStatus('a', 'running');
  s.setStatus('a', 'done', 'result a');
  assert.equal(s.allFinished(), false);
  s.setStatus('b', 'killed');
  assert.equal(s.allFinished(), true);
  const st = s.toState();
  assert.deepEqual(st.workers.map((w) => [w.name, w.status, w.result]), [['a', 'done', 'result a'], ['b', 'killed', '']]);
  assert.equal(st.workers[0].provider, 'claude');
  s.finishGoal();
  assert.equal(s.toState().goal.done, true);
  assert.equal(s.allFinished(), false); // goal finished
  s.setGoal('Next'); // new goal -> new id, old workers no longer count
  assert.equal(s.goalId, gid + 1);
  assert.equal(s.goalWorkers().length, 0);
  assert.equal(s.toState().workers.length, 2); // but still listed
  assert.ok(changes.length > 5);
});

test('lines: appended live, capped at 2000, state copy is isolated', () => {
  const s = new Store('x', { persist: false });
  s.addWorker({ name: 'a' });
  const seen = [];
  s.on('line', (n, l) => seen.push([n, l]));
  for (let i = 0; i < MAX_LINES + 50; i++) s.appendLine('a', 'l' + i);
  assert.equal(seen.length, MAX_LINES + 50);
  const st = s.toState();
  assert.equal(st.workers[0].lines.length, MAX_LINES);
  assert.equal(st.workers[0].lines[0], 'l50');
  st.workers[0].lines.push('mutate');
  assert.equal(s.getWorker('a').lines.length, MAX_LINES);
  s.appendLine('nobody', 'x'); // ignored
});

test('provider / master fields and removal', () => {
  const s = new Store('x', { persist: false });
  s.setProvider('codex');
  assert.equal(s.toState().provider, 'codex');
  assert.throws(() => s.setProvider('gpt'));
  s.setMaster('claude', 'idle');
  assert.equal(s.toState().masterCli, 'claude');
  assert.equal(s.toState().masterState, 'idle');
  s.addWorker({ name: 'a' });
  assert.equal(s.removeWorker('a'), true);
  assert.equal(s.removeWorker('a'), false);
});

test('persistence round-trip; stale running workers become killed on load', () => {
  const d = tmpdir();
  try {
    const s = new Store(d);
    s.setProvider('codex');
    s.setGoal('G', '/r');
    s.addWorker({ name: 'run', summary: 'r' });
    s.setStatus('run', 'running');
    s.addWorker({ name: 'fin' });
    s.setStatus('fin', 'done', 'ok');
    s.appendLine('fin', 'hello');
    s.flush();
    assert.ok(fs.existsSync(s.statusFile));
    assert.match(fs.readFileSync(s.statusFile, 'utf8'), /run/);
    const t = new Store(d);
    const st = t.toState();
    assert.equal(st.provider, 'codex');
    assert.equal(st.masterCli, 'none');
    assert.equal(st.goal.done, true); // abandoned
    assert.equal(st.workers.find((w) => w.name === 'run').status, 'killed');
    assert.equal(st.workers.find((w) => w.name === 'fin').result, 'ok');
    assert.deepEqual(st.workers.find((w) => w.name === 'fin').lines, ['hello']);
  } finally { cleanup(d); }
});

test('addWorker without a goal creates a placeholder goal; formatStatus', () => {
  const s = new Store('x', { persist: false });
  assert.equal(s.formatStatus(), 'no goal yet');
  s.addWorker({ name: 'a', summary: 'sum', branch: 'agent/a', worktree: '/w' });
  assert.equal(s.toState().goal.text, '(set by master)');
  assert.match(s.formatStatus(), /a\s+new\s+branch=agent\/a worktree=\/w\n\s+summary: sum/);
});
