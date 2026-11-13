'use strict';
// Control channel: the master runs `amctl <cmd>` from its shell; each call drops a JSON file in
// <root>/.agentmanager/ctl/ that the app polls (and fs.watch-es) and executes.
const fs = require('fs');
const path = require('path');

const USAGE = `usage: amctl <command>
  goal TEXT                  set a concise statement of the overall goal (shown in the UI)
  spawn NAME SUMMARY PROMPT  create a worktree + headless worker; SUMMARY is one short line
                             shown above its pane, PROMPT is its full instructions
  message NAME TEXT          interrupt worker NAME and give it new instructions
  summary NAME TEXT          change the one-line summary shown for worker NAME
  kill NAME                  stop worker NAME
  goal-done                  declare the overall goal complete (after merge + cleanup)
  status                     print the goal and every worker's state
  Any TEXT/PROMPT argument may be @path/to/file to read the text from a file (use this for
  long or multi-line prompts).
  (internal: master-state idle|busy|exited, prepare claude|codex, print FILE)`;

function ctlDir(root) {
  const d = path.join(root, '.agentmanager', 'ctl');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

let seq = 0;
function writeCommand(root, cmd, { name = '', text = '', summary = '', repo = '' } = {}) {
  const d = ctlDir(root);
  const id = `${process.hrtime.bigint()}-${process.pid}-${seq++}`;
  const tmp = path.join(d, id + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ cmd, name, text, summary, repo }), 'utf8');
  fs.renameSync(tmp, path.join(d, id + '.json'));
}

/** Return and delete all pending commands, oldest first. */
function poll(root) {
  const d = ctlDir(root);
  const cmds = [];
  const files = fs.readdirSync(d).filter((f) => f.endsWith('.json'))
    .sort((a, b) => {
      const [ta] = a.split('-'); const [tb] = b.split('-');
      const x = BigInt(ta); const y = BigInt(tb);
      if (x !== y) return x < y ? -1 : 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  for (const f of files) {
    const p = path.join(d, f);
    try { cmds.push(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch { /* skip bad file */ }
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
  return cmds;
}

/** Expand "@file" arguments (a literal leading @ can be written @@). */
function expand(arg, cwd) {
  if (typeof arg !== 'string' || !arg.startsWith('@')) return arg;
  if (arg.startsWith('@@')) return arg.slice(1);
  const p = path.resolve(cwd || process.cwd(), arg.slice(1));
  try { return fs.readFileSync(p, 'utf8').replace(/^﻿/, '').replace(/\s+$/, ''); } catch { return arg; }
}

/**
 * Parse argv (without node/script) into a command. Returns {command} or {usage:true}.
 * command = {cmd, name, text, summary, repo}; local-only commands are {local:'status'|'print'|'prepare', ...}.
 */
function parse(argv, env = process.env, cwd = process.cwd()) {
  const n = argv.length;
  const cmd = argv[0] || '';
  const repo = env.AGENTMANAGER_REPO || '';
  const join = (a) => a.map((x) => expand(x, cwd)).join(' ');
  if (cmd === 'spawn' && n >= 4) {
    return { command: { cmd, name: argv[1], text: join(argv.slice(3)), summary: expand(argv[2], cwd), repo } };
  }
  if ((cmd === 'message' || cmd === 'summary') && n >= 3) {
    return { command: { cmd, name: argv[1], text: join(argv.slice(2)), summary: '', repo: '' } };
  }
  if (cmd === 'kill' && n === 2) return { command: { cmd, name: argv[1], text: '', summary: '', repo: '' } };
  if (cmd === 'goal' && n >= 2) return { command: { cmd, name: '', text: join(argv.slice(1)), summary: '', repo } };
  if (cmd === 'goal-done' && n === 1) return { command: { cmd, name: '', text: '', summary: '', repo: '' } };
  if (cmd === 'master-state' && n === 2 && ['idle', 'busy', 'exited'].includes(argv[1])) {
    return { command: { cmd, name: '', text: argv[1], summary: '', repo: '' }, silent: true };
  }
  if (cmd === 'status' && n === 1) return { local: 'status' };
  if (cmd === 'print' && n === 2) return { local: 'print', file: argv[1] };
  if (cmd === 'prepare' && n === 2 && ['claude', 'codex'].includes(argv[1])) return { local: 'prepare', cli: argv[1] };
  return { usage: true };
}

function homeDir(env = process.env, cwd = process.cwd()) {
  return env.AGENTMANAGER_HOME || env.AGENTMANAGER_ROOT || cwd;
}

/** CLI entry. io = {out(str), err(str)}; returns exit code. `prepare` is injected by bin/amctl.js. */
function main(argv, { env = process.env, cwd = process.cwd(), io = { out: console.log, err: console.error }, prepare } = {}) {
  const root = homeDir(env, cwd);
  const r = parse(argv, env, cwd);
  if (r.usage) { io.out(USAGE); return 1; }
  if (r.local === 'status') {
    try { io.out(fs.readFileSync(path.join(root, '.agentmanager', 'status.txt'), 'utf8').trimEnd()); } catch {
      io.out('no goal yet (Agent Manager has not written any state)');
    }
    return 0;
  }
  if (r.local === 'print') {
    try { io.out(fs.readFileSync(r.file, 'utf8').replace(/^﻿/, '').replace(/\n$/, '')); } catch { /* silent: hook */ }
    return 0;
  }
  if (r.local === 'prepare') {
    if (!prepare) { io.err('prepare unavailable'); return 1; }
    io.out(prepare(r.cli, { root, env, cwd }));
    return 0;
  }
  writeCommand(root, r.command.cmd, r.command);
  if (!r.silent) io.out(`ok: ${r.command.cmd} queued`);
  return 0;
}

module.exports = { USAGE, ctlDir, writeCommand, poll, parse, expand, main, homeDir };
