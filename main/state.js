'use strict';
// State store: overall goal + one record per worker. Emits 'change' (structure/status) and
// 'line' (name, line) events. Persisted (debounced) to <root>/.agentmanager/state.json.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const TERMINAL = ['done', 'failed', 'killed'];
const MAX_LINES = 2000;

class Store extends EventEmitter {
  constructor(root, { persist = true } = {}) {
    super();
    this.root = root;
    this.persist = persist;
    this.file = path.join(root, '.agentmanager', 'state.json');
    this.statusFile = path.join(root, '.agentmanager', 'status.txt');
    this.goal = null; // {text, repo, done}
    this.goalId = 0;
    this.masterCli = 'none';
    this.masterState = 'none';
    this.provider = 'claude';
    this.workers = [];
    this._timer = null;
    if (persist) this._load();
  }

  _load() {
    let data;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return; }
    if (data.provider === 'claude' || data.provider === 'codex') this.provider = data.provider;
    this.goal = data.goal || null;
    this.goalId = data.goalId || 0;
    this.workers = (data.workers || []).map((w) => ({ lines: [], ...w }));
    // Nothing from a previous run still has a process behind it.
    for (const w of this.workers) {
      if (!TERMINAL.includes(w.status)) {
        w.status = 'killed';
        w.lines.push('✖ lost: the Agent Manager was restarted');
      }
    }
    if (this.goal && !this.goal.done) this.goal = { ...this.goal, done: true };
  }

  _save() {
    if (!this.persist || this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 300);
    if (this._timer.unref) this._timer.unref();
  }

  flush() {
    if (!this.persist) return;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        provider: this.provider, goal: this.goal, goalId: this.goalId, workers: this.workers,
      }), 'utf8');
      fs.renameSync(tmp, this.file);
      fs.writeFileSync(this.statusFile, this.formatStatus() + '\n', 'utf8');
    } catch { /* best effort */ }
  }

  _changed() { this._save(); this.emit('change', this.toState()); }

  // ----- goal -----
  setGoal(text, repo = '') {
    if (this.goal && !this.goal.done) {
      this.goal = { text, repo: repo || this.goal.repo, done: false };
    } else {
      this.goal = { text, repo, done: false };
      this.goalId += 1;
    }
    this._changed();
  }

  finishGoal() {
    if (this.goal) this.goal = { ...this.goal, done: true };
    this._changed();
  }

  // ----- master -----
  setMaster(cli, state) {
    if (cli !== undefined) this.masterCli = cli;
    if (state !== undefined) this.masterState = state;
    this._changed();
  }

  setProvider(p) {
    if (p !== 'claude' && p !== 'codex') throw new Error('bad provider: ' + p);
    this.provider = p;
    this._changed();
  }

  // ----- workers -----
  getWorker(name) { return this.workers.find((w) => w.name === name) || null; }

  addWorker({ name, summary = '', prompt = '', branch = '', worktree = '', provider, repo = '' }) {
    if (!this.goal || this.goal.done) this.setGoal('(set by master)', repo);
    const w = {
      name, summary, status: 'new', prompt, branch, worktree, result: '',
      provider: provider || this.provider, repo, goalId: this.goalId, lines: [],
    };
    this.workers.push(w);
    this._changed();
    return w;
  }

  setStatus(name, status, result) {
    const w = this.getWorker(name);
    if (!w) return;
    w.status = status;
    if (result !== undefined && result !== null) w.result = result;
    this._changed();
  }

  setSummary(name, summary) {
    const w = this.getWorker(name);
    if (!w) return;
    w.summary = summary;
    this._changed();
  }

  appendLine(name, line) {
    const w = this.getWorker(name);
    if (!w) return;
    w.lines.push(line);
    if (w.lines.length > MAX_LINES) w.lines.splice(0, w.lines.length - MAX_LINES);
    this._save();
    this.emit('line', name, line);
  }

  removeWorker(name) {
    const i = this.workers.findIndex((w) => w.name === name);
    if (i < 0) return false;
    this.workers.splice(i, 1);
    this._changed();
    return true;
  }

  goalWorkers() { return this.workers.filter((w) => w.goalId === this.goalId); }

  allFinished() {
    const ws = this.goalWorkers();
    return !!this.goal && !this.goal.done && ws.length > 0 && ws.every((w) => TERMINAL.includes(w.status));
  }

  toState() {
    return {
      goal: this.goal ? { text: this.goal.text, repo: this.goal.repo, done: !!this.goal.done } : null,
      masterCli: this.masterCli,
      masterState: this.masterState,
      provider: this.provider,
      workers: this.workers.map((w) => ({
        name: w.name, summary: w.summary, status: w.status, prompt: w.prompt, branch: w.branch,
        worktree: w.worktree, result: w.result, provider: w.provider, lines: w.lines.slice(),
      })),
    };
  }

  formatStatus() {
    if (!this.goal) return 'no goal yet';
    const lines = [`goal [${this.goal.done ? 'done' : 'active'}] repo=${this.goal.repo}: ${this.goal.text}`];
    for (const w of this.goalWorkers()) {
      lines.push(`  ${w.name.padEnd(16)} ${w.status.padEnd(8)} branch=${w.branch} worktree=${w.worktree}`);
      lines.push(`    summary: ${w.summary}`);
    }
    return lines.join('\n');
  }
}

module.exports = { Store, TERMINAL, MAX_LINES };
