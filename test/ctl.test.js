'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ctl = require('../main/ctl');
const { tmpdir, cleanup } = require('./helpers');

test('parse: spawn / message / summary / kill / goal / goal-done / master-state', () => {
  const env = { AGENTMANAGER_REPO: '/r' };
  assert.deepEqual(ctl.parse(['spawn', 'api', 'sum', 'do', 'the', 'thing'], env).command,
    { cmd: 'spawn', name: 'api', text: 'do the thing', summary: 'sum', repo: '/r' });
  assert.deepEqual(ctl.parse(['message', 'api', 'new', 'plan'], env).command,
    { cmd: 'message', name: 'api', text: 'new plan', summary: '', repo: '' });
  assert.equal(ctl.parse(['summary', 'api', 'x'], env).command.cmd, 'summary');
  assert.equal(ctl.parse(['kill', 'api'], env).command.name, 'api');
  assert.deepEqual(ctl.parse(['goal', 'Ship', 'it'], env).command,
    { cmd: 'goal', name: '', text: 'Ship it', summary: '', repo: '/r' });
  assert.equal(ctl.parse(['goal-done'], env).command.cmd, 'goal-done');
  const ms = ctl.parse(['master-state', 'idle'], env);
  assert.equal(ms.command.text, 'idle');
  assert.ok(ms.silent);
  assert.equal(ctl.parse(['status'], env).local, 'status');
});

test('parse: bad usage', () => {
  for (const a of [[], ['spawn', 'a', 'b'], ['kill'], ['kill', 'a', 'b'], ['goal'], ['goal-done', 'x'],
    ['master-state', 'weird'], ['bogus'], ['message', 'a']]) {
    assert.ok(ctl.parse(a, {}).usage, JSON.stringify(a));
  }
});

test('@file arguments are expanded; @@ escapes', () => {
  const d = tmpdir();
  try {
    fs.writeFileSync(path.join(d, 'p.txt'), 'line one\nline two\n');
    const r = ctl.parse(['spawn', 'w', 'sum', '@p.txt'], {}, d);
    assert.equal(r.command.text, 'line one\nline two');
    assert.equal(ctl.parse(['goal', '@@twitter'], {}, d).command.text, '@twitter');
    assert.equal(ctl.parse(['goal', '@missing.txt'], {}, d).command.text, '@missing.txt');
  } finally { cleanup(d); }
});

test('queue: commands come back oldest first and are deleted', () => {
  const d = tmpdir();
  try {
    ctl.writeCommand(d, 'goal', { text: 'g' });
    ctl.writeCommand(d, 'spawn', { name: 'a', text: 'p', summary: 's' });
    ctl.writeCommand(d, 'kill', { name: 'a' });
    const got = ctl.poll(d);
    assert.deepEqual(got.map((c) => c.cmd), ['goal', 'spawn', 'kill']);
    assert.deepEqual(ctl.poll(d), []);
    assert.deepEqual(fs.readdirSync(ctl.ctlDir(d)), []);
  } finally { cleanup(d); }
});

test('queue: malformed files are dropped, stray .tmp ignored', () => {
  const d = tmpdir();
  try {
    const dir = ctl.ctlDir(d);
    fs.writeFileSync(path.join(dir, '1-1-1.json'), '{not json');
    fs.writeFileSync(path.join(dir, '2-1-1.tmp'), '{}');
    ctl.writeCommand(d, 'goal-done');
    assert.deepEqual(ctl.poll(d).map((c) => c.cmd), ['goal-done']);
  } finally { cleanup(d); }
});

test('main(): queues a command, prints ok; usage returns 1; status reads status.txt', () => {
  const d = tmpdir();
  try {
    const out = [];
    const io = { out: (s) => out.push(s), err: (s) => out.push(s) };
    const env = { AGENTMANAGER_HOME: d };
    assert.equal(ctl.main(['kill', 'x'], { env, io }), 0);
    assert.deepEqual(out, ['ok: kill queued']);
    assert.equal(ctl.poll(d)[0].name, 'x');
    out.length = 0;
    assert.equal(ctl.main(['nope'], { env, io }), 1);
    assert.match(out[0], /usage: amctl/);
    out.length = 0;
    ctl.main(['master-state', 'busy'], { env, io });
    assert.deepEqual(out, []); // hooks stay silent
    fs.writeFileSync(path.join(d, '.agentmanager', 'status.txt'), 'goal X\n');
    ctl.main(['status'], { env, io });
    assert.equal(out[0], 'goal X');
  } finally { cleanup(d); }
});

test('bin/amctl.js works as a real process', () => {
  const d = tmpdir();
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'amctl.js'), 'goal', 'hello', 'world'],
      { env: { ...process.env, AGENTMANAGER_HOME: d }, encoding: 'utf8' });
    assert.match(out, /ok: goal queued/);
    assert.equal(ctl.poll(d)[0].text, 'hello world');
  } finally { cleanup(d); }
});
