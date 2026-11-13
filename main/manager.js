'use strict';
// Orchestration: executes ctl commands from the master, runs workers, and types
// "[AGENTMANAGER PING]" lines into the master when it is idle (port of the old app.py logic).
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const ctl = require('./ctl');
const gitmod = require('./git');
const prompts = require('./prompts');
const { WorkerAgent, providerBin } = require('./agents');
const { TERMINAL } = require('./state');

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

class Manager extends EventEmitter {
  /**
   * @param {object} o {root, store, term, env, bins, typingGrace, pollMs, pingMs, git}
   *   term: {alive(), submit(text), lastKey}  (the master pseudo-terminal)
   *   bins: {claude:[file,...], codex:[file,...]} overrides for the worker executables
   */
  constructor(o) {
    super();
    this.root = o.root;
    this.store = o.store;
    this.term = o.term || null;
    this.env = o.env || process.env;
    this.bins = o.bins || {};
    this.git = o.git || gitmod;
    this.typingGrace = o.typingGrace === undefined ? 2000 : o.typingGrace;
    this.pollMs = o.pollMs || 500;
    this.pingMs = o.pingMs || 2000;
    this.agents = new Map();
    this.finished = []; // [name, status] not yet reported to the master
    this.pings = [];    // texts typed into the master (kept for diagnostics/tests)
    this._flushing = false;
    this._polling = false;
    this._closing = false;
    this._timers = [];
    this._watcher = null;
  }

  start() {
    ctl.poll(this.root); // drop commands left over from a previous run
    this._timers.push(setInterval(() => this.pollCtl(), this.pollMs));
    this._timers.push(setInterval(() => this.flushPings(), this.pingMs));
    try {
      this._watcher = fs.watch(ctl.ctlDir(this.root), () => this.pollCtl());
      this._watcher.on('error', () => {});
    } catch { /* polling is enough */ }
    for (const t of this._timers) if (t.unref) t.unref();
  }

  async stop() {
    this._closing = true;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    if (this._watcher) { try { this._watcher.close(); } catch { /* closed */ } this._watcher = null; }
    await Promise.all([...this.agents.values()].map((a) => a.kill().catch(() => {})));
    this.store.flush();
  }

  note(text) { this.emit('notice', text); }

  // ---------------------------------------------------------- master
  setMasterState(state) {
    this.store.setMaster(state === 'none' ? 'none' : undefined, state);
    if (state === 'idle') this.flushPings();
  }

  /** User keystrokes: a codex master has no busy hook, so an Enter while idle means busy. */
  onUserInput(data) {
    if (this.store.masterCli === 'codex' && this.store.masterState === 'idle' && /[\r\n]/.test(data)) {
      this.store.setMaster(undefined, 'busy');
    }
  }

  /** Type the wrapped launcher for the chosen provider into the shell. Returns false if a master is running. */
  startMaster(cli, { repo } = {}) {
    cli = cli || this.store.provider;
    if (this.store.masterCli !== 'none' && this.store.masterState !== 'none') return false;
    if (!this.term || !this.term.alive()) return false;
    const files = prompts.writeSupportFiles({ root: this.root, repo: repo || this.store.goal?.repo || this.root, cli, env: this.env });
    this.store.setMaster(cli, 'none');
    this.term.write(prompts.launchCommand(cli, files) + '\r');
    return true;
  }

  // ---------------------------------------------------------- ctl commands
  async pollCtl() {
    if (this._polling || this._closing) return;
    this._polling = true;
    try {
      let cmds;
      while ((cmds = ctl.poll(this.root)).length) {
        for (const c of cmds) await this.handle(c);
      }
    } finally { this._polling = false; }
  }

  async handle(c) {
    const name = c.name || '';
    try {
      switch (c.cmd) {
        case 'master-state': {
          const st = c.text;
          if (st === 'exited') this.store.setMaster('none', 'none');
          else this.setMasterState(st);
          return;
        }
        case 'goal': this.store.setGoal(c.text, c.repo || ''); return;
        case 'goal-done': this.store.finishGoal(); this.note('Goal marked done'); return;
        default: break;
      }
      if (!NAME_RE.test(name)) { this.note(`[ctl] bad worker name: ${JSON.stringify(name)}`); return; }
      if (c.cmd === 'spawn') await this.spawn({ name, prompt: c.text, summary: c.summary, repo: c.repo });
      else if (c.cmd === 'message') await this.message(name, c.text);
      else if (c.cmd === 'summary' && this.store.getWorker(name)) this.store.setSummary(name, c.text);
      else if (c.cmd === 'kill') await this.kill(name);
      else this.note(`[ctl] unknown worker/command: ${c.cmd} ${name}`);
    } catch (e) {
      this.note(`[ctl] ${c.cmd} ${name} failed: ${e.message}`);
    }
  }

  // ---------------------------------------------------------- workers
  async spawn({ name, prompt, summary = '', repo = '', provider }) {
    if (this.store.getWorker(name)) { this.note(`[ctl] worker ${name} already exists`); return null; }
    repo = repo || (await this.git.toplevel(this.root)) || this.root;
    summary = summary || (prompt.trim().split(/\r?\n/)[0] || '').slice(0, 100);
    const wt = await this.git.addWorktree(repo, name);
    if (!wt.ok) { this.note(`[ctl] git worktree failed: ${wt.error}`); return null; }
    provider = provider || this.store.provider;
    const w = this.store.addWorker({ name, summary, prompt, branch: wt.branch, worktree: wt.worktree, provider, repo });
    const agent = new WorkerAgent({
      name, provider, cwd: wt.worktree, bin: providerBin(provider, this.env, this.bins), env: this.env,
      onLine: (n, l) => this.store.appendLine(n, l),
      onStatus: (n, s) => this._onStatus(n, s),
    });
    this.agents.set(name, agent);
    await agent.start(prompt);
    return w;
  }

  _onStatus(name, status) {
    if (this._closing) return;
    const agent = this.agents.get(name);
    this.store.setStatus(name, status, agent && agent.result ? agent.result : undefined);
    if (TERMINAL.includes(status)) {
      this.finished.push([name, status]);
      this.flushPings();
    }
  }

  async message(name, text) {
    const a = this.agents.get(name);
    if (!a) { this.note(`[ctl] unknown worker: ${name}`); return false; }
    await a.interrupt(text);
    return true;
  }

  async kill(name) {
    const a = this.agents.get(name);
    if (!a) return false;
    await a.kill();
    return true;
  }

  /**
   * Remove a finished worker from the list. Its git worktree + branch are removed only if the
   * worktree is clean and the branch is merged; otherwise they are kept. -> {ok, removed, kept, error}
   */
  async deleteWorker(name) {
    const w = this.store.getWorker(name);
    if (!w) return { ok: false, error: 'no such worker' };
    if (!TERMINAL.includes(w.status)) return { ok: false, error: `worker is ${w.status}; kill it first` };
    const agent = this.agents.get(name);
    if (agent) await agent.settled();
    const r = await this.git.removeIfSafe(w.repo, w.worktree, w.branch);
    this.agents.delete(name);
    this.finished = this.finished.filter(([n]) => n !== name);
    this.store.removeWorker(name);
    return { ok: true, removed: r.removed, kept: r.kept };
  }

  // ---------------------------------------------------------- pings
  _canPing() {
    return this.finished.length > 0 && this.store.masterState === 'idle' && !!this.term && this.term.alive()
      && Date.now() - (this.term.lastKey || 0) > this.typingGrace;
  }

  async flushPings() {
    if (this._flushing || this._closing || !this._canPing()) return;
    this._flushing = true;
    try {
      await this.pollCtl(); // pick up spawns the master queued right before going idle
      if (!this._canPing()) return;
      const g = this.store.goal;
      const events = this.finished;
      this.finished = [];
      if (!g || g.done) return;
      const mine = new Set(this.store.goalWorkers().map((w) => w.name));
      const evs = events.filter(([n]) => mine.has(n));
      if (!evs.length) return;
      let text;
      if (this.store.allFinished()) text = prompts.finalPing(g, this.store.goalWorkers());
      else {
        text = evs.filter(([, s]) => s !== 'killed')
          .map(([n, s]) => prompts.workerPing(this.store.getWorker(n), s)).join(' ');
      }
      if (!text) return;
      this.note('Pinging master agent');
      this.pings.push(text);
      this.store.setMaster(undefined, 'busy');
      await this.term.submit(text);
    } finally { this._flushing = false; }
  }
}

module.exports = { Manager, NAME_RE };
