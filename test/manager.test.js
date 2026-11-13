'use strict';
// End-to-end worker path with fake claude/codex executables and real git worktrees.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store } = require('../main/state');
const { Manager } = require('../main/manager');
const ctl = require('../main/ctl');
const P = require('../main/prompts');
const { tmpdir, makeRepo, sh, waitFor, FAKE_CLAUDE, FAKE_CODEX, cleanup } = require('./helpers');

function setup(opts = {}) {
  const repo = makeRepo();
  const root = tmpdir('am-root-');
  const log = path.join(root, 'fake.log');
  const store = new Store(root, { persist: false });
  const submitted = [];
  const written = [];
  const term = {
    lastKey: 0,
    alive: () => true,
    write: (d) => written.push(d),
    submit: async (t) => { submitted.push(t); },
  };
  const manager = new Manager({
    root, store, term, typingGrace: 0, pollMs: 50, pingMs: 100000,
    bins: { claude: FAKE_CLAUDE, codex: FAKE_CODEX }, env: { ...process.env, FAKE_LOG: log }, ...opts,
  });
  const notices = [];
  manager.on('notice', (n) => notices.push(n));
  const logs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const done = async () => { await manager.stop(); cleanup(root); cleanup(repo); };
  const drop = (cmd, f) => ctl.writeCommand(root, cmd, { repo, ...f });
  const status = (n) => store.getWorker(n) && store.getWorker(n).status;
  return { repo, root, store, term, manager, notices, logs, done, submitted, written, drop, status };
}

const finished = (s) => (n) => waitFor(() => ['done', 'failed', 'killed'].includes(s.status(n)), 15000, `${n} to finish`);

test('ctl spawn: worktree + branch + headless claude worker, events parsed to lines', async () => {
  const s = setup();
  try {
    s.drop('goal', { text: 'Overall goal' });
    s.drop('spawn', { name: 'w1', summary: 'my summary', text: 'do the thing\nsecond line' });
    await s.manager.pollCtl();
    await finished(s)('w1');
    assert.deepEqual(s.store.toState().goal, { text: 'Overall goal', repo: s.repo, done: false });
    const w = s.store.toState().workers[0];
    assert.equal(w.name, 'w1');
    assert.equal(w.summary, 'my summary');
    assert.equal(w.status, 'done');
    assert.equal(w.provider, 'claude');
    assert.equal(w.branch, 'agent/w1');
    assert.equal(fs.realpathSync(w.worktree), fs.realpathSync(path.join(s.repo, '.agentmanager', 'worktrees', 'w1')));
    assert.ok(fs.existsSync(path.join(w.worktree, 'README.md')));
    assert.equal(sh(w.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'agent/w1');
    assert.equal(w.result, 'done: do the thing');
    assert.deepEqual(w.lines, ['working on: do the thing', '▸ Bash echo hi', '✔ finished']);
    assert.equal(w.prompt, 'do the thing\nsecond line');
    const start = s.logs().find((l) => l.args);
    assert.ok(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']
      .every((a) => start.args.includes(a)), JSON.stringify(start.args));
    assert.equal(fs.realpathSync(start.cwd), fs.realpathSync(w.worktree));
    // .agentmanager/ is excluded from the repo's git status
    assert.equal(sh(s.repo, 'status', '--porcelain'), '');
  } finally { await s.done(); }
});

test('codex worker: exec --json --full-auto, prompt on stdin, resume on message', async () => {
  const s = setup();
  try {
    s.store.setProvider('codex');
    s.drop('spawn', { name: 'c1', summary: 's', text: 'codex task' });
    await s.manager.pollCtl();
    await finished(s)('c1');
    const w = s.store.getWorker('c1');
    assert.equal(w.provider, 'codex');
    assert.deepEqual(w.lines, ['▸ echo hi', 'codex done: codex task', '✔ finished']);
    assert.equal(w.result, 'codex done: codex task');
    const first = s.logs().find((l) => l.args);
    assert.deepEqual(first.args.slice(0, 3), ['exec', '--json', '--full-auto']);
    assert.equal(first.args[first.args.length - 1], '-');
    assert.ok(s.logs().some((l) => l.prompt === 'codex task'));
    // message => resume the same thread
    await s.manager.message('c1', 'follow up');
    await waitFor(() => s.logs().filter((l) => l.args).length === 2, 5000, 'second process');
    await finished(s)('c1');
    await waitFor(() => s.store.getWorker('c1').lines.includes('codex done: follow up'), 10000, 'resumed output');
    const second = s.logs().filter((l) => l.args)[1];
    const ri = second.args.indexOf('resume');
    assert.ok(ri > 0);
    assert.match(second.args[ri + 1], /^thr-/);
    assert.ok(s.store.getWorker('c1').lines.some((l) => l.startsWith('⚡ interrupted')));
  } finally { await s.done(); }
});

test('claude: failure result, kill, and message (resume with --resume SESSION)', async () => {
  const s = setup();
  try {
    s.drop('spawn', { name: 'bad', summary: 's', text: 'please FAIL' });
    s.drop('spawn', { name: 'slow', summary: 's', text: 'SLEEP forever' });
    await s.manager.pollCtl();
    await finished(s)('bad');
    assert.equal(s.status('bad'), 'failed');
    assert.equal(s.store.getWorker('bad').result, 'boom');
    assert.ok(s.store.getWorker('bad').lines.some((l) => l.startsWith('✖ error: boom')));

    await waitFor(() => s.store.getWorker('slow').lines.length >= 2, 10000, 'slow output');
    assert.equal(s.status('slow'), 'running');
    await s.manager.message('slow', 'new plan');
    await waitFor(() => s.status('slow') === 'done', 15000, 'slow resumed and finished');
    const starts = s.logs().filter((l) => l.args && l.cwd.endsWith('slow'));
    assert.equal(starts.length, 2);
    assert.ok(!starts[0].args.includes('--resume'));
    assert.equal(starts[1].args[starts[1].args.indexOf('--resume') + 1].startsWith('sess-'), true);
    assert.ok(s.store.getWorker('slow').lines.includes('⚡ interrupted. New instructions: new plan'));

    s.drop('spawn', { name: 'slow2', summary: 's', text: 'SLEEP again' });
    s.drop('kill', { name: 'slow2' });
    await s.manager.pollCtl();
    await finished(s)('slow2');
    assert.equal(s.status('slow2'), 'killed');
  } finally { await s.done(); }
});

test('ctl: bad / duplicate names, unknown workers, summary, goal-done, master-state', async () => {
  const s = setup();
  try {
    s.drop('spawn', { name: 'bad name!', summary: 's', text: 'x' });
    s.drop('spawn', { name: 'ok', summary: 's', text: 'x' });
    s.drop('spawn', { name: 'ok', summary: 's', text: 'x' });
    s.drop('message', { name: 'ghost', text: 'hi' });
    s.drop('summary', { name: 'ok', text: 'new summary' });
    await s.manager.pollCtl();
    assert.ok(s.notices.some((n) => /bad worker name/.test(n)));
    assert.ok(s.notices.some((n) => /already exists/.test(n)));
    assert.ok(s.notices.some((n) => /unknown worker/.test(n)));
    assert.equal(s.store.workers.length, 1);
    assert.equal(s.store.getWorker('ok').summary, 'new summary');
    await finished(s)('ok');
    s.manager.finished = []; // keep the idle transition below from triggering a ping
    s.drop('master-state', { text: 'idle' });
    await s.manager.pollCtl();
    assert.equal(s.store.masterState, 'idle');
    s.drop('master-state', { text: 'exited' });
    await s.manager.pollCtl();
    assert.equal(s.store.masterState, 'none');
    assert.equal(s.store.masterCli, 'none');
    s.drop('goal-done', {});
    await s.manager.pollCtl();
    assert.equal(s.store.goal.done, true);
  } finally { await s.done(); }
});

test('pings: held until master idle; per-worker ping, then one final ping when all finished', async () => {
  const s = setup();
  try {
    s.drop('goal', { text: 'Ship it' });
    s.drop('spawn', { name: 'a', summary: 'sa', text: 'task a' });
    s.drop('spawn', { name: 'b', summary: 'sb', text: 'SLEEP task b' });
    await s.manager.pollCtl();
    await finished(s)('a');
    await s.manager.flushPings();
    assert.deepEqual(s.submitted, [], 'master not idle -> nothing typed');
    s.store.setMaster('claude', 'idle');
    await s.manager.flushPings();
    assert.equal(s.submitted.length, 1);
    assert.match(s.submitted[0], /^\[AGENTMANAGER PING\] Worker 'a' finished with status done\./);
    assert.ok(s.submitted[0].includes('Branch: agent/a'));
    assert.ok(s.submitted[0].includes('Its final message: done: task a'));
    assert.equal(s.store.masterState, 'busy', 'master marked busy after a ping');
    await s.manager.flushPings();
    assert.equal(s.submitted.length, 1, 'busy master is not pinged again');

    // last worker finishes (killed) while master idle -> final ping with everything
    s.store.setMaster(undefined, 'idle');
    await s.manager.kill('b');
    await waitFor(() => s.submitted.length === 2, 5000, 'final ping');
    assert.match(s.submitted[1], /^\[AGENTMANAGER PING\] ALL workers have finished\. Repo: .*Overall goal: Ship it\./);
    assert.ok(s.submitted[1].includes('a [done]') && s.submitted[1].includes('b [killed]'));
    assert.equal(s.store.masterState, 'busy');
  } finally { await s.done(); }
});

test('pings: not while the user is typing; not when the master terminal is dead; not for finished goals', async () => {
  const s = setup({ typingGrace: 400 });
  try {
    s.drop('spawn', { name: 'a', summary: 'sa', text: 'task a' });
    await s.manager.pollCtl();
    await finished(s)('a');
    s.store.setMaster('claude', 'idle');
    s.term.lastKey = Date.now();
    await s.manager.flushPings();
    assert.equal(s.submitted.length, 0, 'user typed just now');
    await waitFor(async () => { await s.manager.flushPings(); return s.submitted.length === 1; }, 5000, 'ping after grace');
    // dead terminal
    s.store.setMaster(undefined, 'idle');
    s.term.alive = () => false;
    s.manager.finished.push(['a', 'done']);
    await s.manager.flushPings();
    assert.equal(s.submitted.length, 1);
  } finally { await s.done(); }
});

test('delete: only finished workers; worktree+branch removed only when clean and merged', async () => {
  const s = setup();
  try {
    const names = ['run', 'clean', 'dirty', 'unmerged', 'merged', 'gone'];
    s.drop('spawn', { name: 'run', summary: '', text: 'SLEEP' });
    for (const n of names.slice(1)) s.drop('spawn', { name: n, summary: '', text: 'quick ' + n });
    await s.manager.pollCtl();
    for (const n of names.slice(1)) await finished(s)(n);
    const wt = (n) => s.store.getWorker(n).worktree;
    const branches = () => sh(s.repo, 'branch', '--list', 'agent/*').split('\n').map((x) => x.trim().replace(/^[*+] /, ''));

    // running -> refused, nothing changes
    const r0 = await s.manager.deleteWorker('run');
    assert.equal(r0.ok, false);
    assert.ok(s.store.getWorker('run'));
    assert.deepEqual(await s.manager.deleteWorker('nope'), { ok: false, error: 'no such worker' });

    // clean + nothing unmerged -> everything removed
    const w1 = wt('clean');
    const r1 = await s.manager.deleteWorker('clean');
    assert.equal(r1.ok, true);
    assert.equal(r1.removed, true);
    assert.equal(s.store.getWorker('clean'), null);
    assert.ok(!fs.existsSync(w1));
    assert.ok(!branches().includes('agent/clean'));

    // dirty worktree -> entry removed, worktree + branch kept
    fs.writeFileSync(path.join(wt('dirty'), 'wip.txt'), 'uncommitted');
    const r2 = await s.manager.deleteWorker('dirty');
    assert.equal(r2.ok, true);
    assert.equal(r2.removed, false);
    assert.match(r2.kept.join(), /uncommitted/);
    assert.equal(s.store.getWorker('dirty'), null);
    assert.ok(fs.existsSync(path.join(s.repo, '.agentmanager', 'worktrees', 'dirty', 'wip.txt')));
    assert.ok(branches().includes('agent/dirty'));

    // committed but not merged -> kept
    fs.writeFileSync(path.join(wt('unmerged'), 'new.txt'), 'work');
    sh(wt('unmerged'), 'add', '-A');
    sh(wt('unmerged'), '-c', 'user.email=t@e.x', '-c', 'user.name=t', 'commit', '-q', '-m', 'work');
    const r3 = await s.manager.deleteWorker('unmerged');
    assert.equal(r3.removed, false);
    assert.match(r3.kept.join(), /not merged/);
    assert.ok(branches().includes('agent/unmerged'));

    // committed and merged into the main checkout -> removed
    fs.writeFileSync(path.join(wt('merged'), 'm.txt'), 'merged work');
    sh(wt('merged'), 'add', '-A');
    sh(wt('merged'), '-c', 'user.email=t@e.x', '-c', 'user.name=t', 'commit', '-q', '-m', 'm');
    sh(s.repo, '-c', 'user.email=t@e.x', '-c', 'user.name=t', 'merge', '-q', '--no-edit', 'agent/merged');
    const w5 = wt('merged');
    const r4 = await s.manager.deleteWorker('merged');
    assert.equal(r4.removed, true);
    assert.ok(!fs.existsSync(w5));
    assert.ok(!branches().includes('agent/merged'));

    // the master already cleaned up the worktree and branch itself
    sh(s.repo, 'worktree', 'remove', '--force', wt('gone'));
    sh(s.repo, 'branch', '-D', 'agent/gone');
    const r5 = await s.manager.deleteWorker('gone');
    assert.equal(r5.ok, true);
    assert.equal(s.store.getWorker('gone'), null);

    // re-spawning a name whose kept worktree still exists is refused (never clobber kept work)
    s.drop('spawn', { name: 'dirty', summary: '', text: 'again' });
    await s.manager.pollCtl();
    assert.equal(s.store.getWorker('dirty'), null);
    assert.ok(s.notices.some((n) => /worktree failed/.test(n)));
    // ...but once its worktree is gone and only the branch remains, the branch is reused
    sh(s.repo, 'worktree', 'remove', '--force', path.join(s.repo, '.agentmanager', 'worktrees', 'dirty'));
    s.drop('spawn', { name: 'dirty', summary: '', text: 'again' });
    await s.manager.pollCtl();
    await finished(s)('dirty');
    assert.equal(s.status('dirty'), 'done');
  } finally { await s.done(); }
});

test('startMaster types the wrapped launcher for the chosen provider, once', async () => {
  const s = setup();
  try {
    assert.equal(s.manager.startMaster('claude', { repo: s.repo }), true);
    assert.equal(s.written.length, 1);
    assert.match(s.written[0], /^powershell .* -File ".*launch-claude\.ps1"\r$/);
    assert.equal(s.store.masterCli, 'claude');
    assert.ok(fs.existsSync(path.join(s.root, '.agentmanager', 'master_prompt.md')));
    // running master (hook said idle) -> refuse to type into it
    s.store.setMaster('claude', 'idle');
    assert.equal(s.manager.startMaster('claude'), false);
    s.store.setMaster('none', 'none');
    assert.equal(s.manager.startMaster('codex', { repo: s.repo }), true);
    assert.match(s.written[1], /launch-codex\.ps1"\r$/);
    assert.equal(s.store.masterCli, 'codex');
  } finally { await s.done(); }
});

test('codex master has no busy hook: Enter while idle marks it busy', async () => {
  const s = setup();
  try {
    s.store.setMaster('codex', 'idle');
    s.manager.onUserInput('abc');
    assert.equal(s.store.masterState, 'idle');
    s.manager.onUserInput('\r');
    assert.equal(s.store.masterState, 'busy');
    s.store.setMaster('claude', 'idle');
    s.manager.onUserInput('\r');
    assert.equal(s.store.masterState, 'idle'); // claude uses hooks
  } finally { await s.done(); }
});

test('manager.start(): picks up dropped ctl files by itself (watch/poll)', async () => {
  const s = setup();
  try {
    s.manager.start();
    s.drop('goal', { text: 'auto' });
    await waitFor(() => s.store.goal && s.store.goal.text === 'auto', 5000, 'goal via watcher');
  } finally { await s.done(); }
});
