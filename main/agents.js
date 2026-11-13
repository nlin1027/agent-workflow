'use strict';
// Headless workers: parse claude / codex JSON event streams into display lines and run the processes.
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- event parsing
// A parser takes one decoded JSON event and returns
//   {lines:[string], sessionId?, result?, final?: 'done'|'failed'}
function claudeParser() {
  return (ev) => {
    const out = { lines: [] };
    if (ev.session_id) out.sessionId = ev.session_id;
    if (ev.type === 'assistant') {
      const content = (ev.message && ev.message.content) || [];
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'text' && b.text) out.lines.push(...String(b.text).split(/\r?\n/));
        else if (b.type === 'tool_use') {
          const inp = b.input || {};
          const detail = inp.command || inp.file_path || inp.pattern || inp.path || inp.url || '';
          out.lines.push(`▸ ${b.name} ${String(detail).replace(/\s+/g, ' ').slice(0, 120)}`.trimEnd());
        }
      }
    } else if (ev.type === 'result') {
      if (ev.is_error) {
        out.lines.push(`✖ error: ${ev.result || ev.subtype || ''}`.slice(0, 200));
        out.final = 'failed';
      } else {
        out.lines.push('✔ finished');
        out.final = 'done';
      }
      out.result = ev.result || '';
    }
    return out;
  };
}

function codexParser() {
  const started = new Set();
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  return (ev) => {
    const out = { lines: [] };
    const t = ev.type;
    if (t === 'thread.started') { out.sessionId = ev.thread_id; return out; }
    if (t === 'item.started' || t === 'item.completed' || t === 'item.updated') {
      const it = ev.item || {};
      const done = t === 'item.completed';
      switch (it.type) {
        case 'agent_message':
          if (done && it.text) { out.lines.push(...String(it.text).split(/\r?\n/)); out.result = it.text; }
          break;
        case 'reasoning':
          if (done && it.text) out.lines.push(`💭 ${clip(it.text, 160)}`);
          break;
        case 'command_execution':
          if (!started.has(it.id)) { started.add(it.id); out.lines.push(`▸ ${clip(it.command, 120)}`); }
          if (done && typeof it.exit_code === 'number' && it.exit_code !== 0) out.lines.push(`  ✖ exit ${it.exit_code}`);
          break;
        case 'file_change':
          if (done) for (const c of it.changes || []) out.lines.push(`▸ ${c.kind || 'edit'} ${c.path}`);
          break;
        case 'mcp_tool_call':
          if (!started.has(it.id)) { started.add(it.id); out.lines.push(`▸ ${it.server || 'mcp'}.${it.tool || ''}`); }
          break;
        case 'web_search':
          if (!started.has(it.id)) { started.add(it.id); out.lines.push(`▸ search ${clip(it.query, 100)}`); }
          break;
        case 'error':
          out.lines.push(`✖ ${clip(it.message, 200)}`);
          break;
        default: break;
      }
      return out;
    }
    if (t === 'turn.completed') { out.lines.push('✔ finished'); out.final = 'done'; return out; }
    if (t === 'turn.failed') {
      out.lines.push(`✖ error: ${clip(ev.error && ev.error.message, 200)}`);
      out.final = 'failed';
      return out;
    }
    if (t === 'error') { out.lines.push(`✖ error: ${clip(ev.message, 200)}`); return out; }
    // older event shape: {id, msg:{type, ...}}
    const m = ev.msg;
    if (m && m.type) {
      if (m.type === 'agent_message' && m.message) { out.lines.push(...String(m.message).split(/\r?\n/)); out.result = m.message; }
      else if (m.type === 'exec_command_begin') out.lines.push(`▸ ${clip(Array.isArray(m.command) ? m.command.join(' ') : m.command, 120)}`);
      else if (m.type === 'task_complete') { out.lines.push('✔ finished'); out.final = 'done'; if (m.last_agent_message) out.result = m.last_agent_message; }
      else if (m.type === 'error') { out.lines.push(`✖ error: ${clip(m.message, 200)}`); out.final = 'failed'; }
    }
    return out;
  };
}

function makeParser(provider) { return provider === 'codex' ? codexParser() : claudeParser(); }

// ---------------------------------------------------------------- process helpers
function resolveExecutable(name, env = process.env) {
  if (path.isAbsolute(name) && fs.existsSync(name)) return name;
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const e of ['', ...(process.platform === 'win32' ? exts : [])]) {
      const p = path.join(d, name + e);
      try { if (fs.statSync(p).isFile() && (process.platform !== 'win32' || e)) return p; } catch { /* next */ }
    }
  }
  return name;
}

/** Command for a provider as [file, ...prefixArgs]. Overridable via env AM_CLAUDE_BIN / AM_CODEX_BIN (JSON array or path). */
function providerBin(provider, env = process.env, overrides = {}) {
  if (overrides[provider]) return overrides[provider];
  const v = env[provider === 'codex' ? 'AM_CODEX_BIN' : 'AM_CLAUDE_BIN'];
  if (v) {
    if (v.trim().startsWith('[')) { try { return JSON.parse(v); } catch { /* fall through */ } }
    return [v];
  }
  return [resolveExecutable(provider, env)];
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once('close', resolve);
    if (process.platform === 'win32' && proc.pid) {
      const k = cp.spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { try { proc.kill(); } catch { /* gone */ } });
    } else { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
    setTimeout(resolve, 3000).unref();
  });
}

function spawnProc(bin, args, opts) {
  const [file, ...prefix] = bin;
  const all = [...prefix, ...args];
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return cp.spawn(`"${file}"`, all, { ...opts, shell: true });
  }
  return cp.spawn(file, all, opts);
}

// ---------------------------------------------------------------- worker agent
class WorkerAgent {
  /**
   * @param {object} o {name, provider, cwd, bin:[file,...], env, onLine(name,line), onStatus(name,status)}
   */
  constructor(o) {
    Object.assign(this, { name: o.name, provider: o.provider || 'claude', cwd: o.cwd, bin: o.bin,
      env: { ...process.env, ...(o.env || {}), PYTHONUTF8: '1' }, onLine: o.onLine, onStatus: o.onStatus });
    this.sessionId = null;
    this.proc = null;
    this.status = 'new';
    this.result = '';
    this.final = null;
  }

  _set(s) { this.status = s; this.onStatus(this.name, s); }

  async start(prompt) {
    this.final = null;
    const proc = this._spawn();
    this.proc = proc;
    this.closed = new Promise((res) => { proc.once('close', res); proc.once('error', res); });
    this._set('running');
    this._attach(proc);
    this._send(proc, prompt);
  }

  _spawn() {
    let args;
    if (this.provider === 'codex') {
      args = ['exec', '--json', '--full-auto'];
      if (this.sessionId) args.push('resume', this.sessionId);
      args.push('-');
    } else {
      args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--permission-mode', 'acceptEdits'];
      if (this.sessionId) args.push('--resume', this.sessionId);
    }
    const proc = spawnProc(this.bin, args, { cwd: this.cwd, env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    proc.on('error', (e) => {
      if (proc !== this.proc) return;
      this.onLine(this.name, `✖ failed to start ${this.provider}: ${e.message}`);
      this.result = e.message;
      this._set('failed');
    });
    return proc;
  }

  _send(proc, text) {
    proc.stdin.on('error', () => {});
    if (this.provider === 'codex') {
      proc.stdin.end(text);
    } else {
      proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    }
  }

  _attach(proc) {
    const parse = makeParser(this.provider);
    let buf = '';
    const handle = (raw) => {
      if (!raw.trim()) return;
      let ev;
      try { ev = JSON.parse(raw); } catch { this.onLine(this.name, raw.replace(/\r$/, '')); return; }
      if (proc !== this.proc) return;
      const r = parse(ev);
      if (r.sessionId) this.sessionId = r.sessionId;
      for (const l of r.lines) this.onLine(this.name, l);
      if (r.result) this.result = r.result;
      if (r.final && !this.final) {
        this.final = r.final;
        if (this.provider === 'claude') { try { proc.stdin.end(); } catch { /* closed */ } }
        this._set(r.final);
      }
    };
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); handle(l); }
    });
    proc.stdout.on('end', () => { if (buf) handle(buf); buf = ''; });
    proc.stderr.setEncoding('utf8');
    let eb = '';
    proc.stderr.on('data', (d) => {
      eb += d;
      let i;
      while ((i = eb.indexOf('\n')) >= 0) {
        const l = eb.slice(0, i).replace(/\r$/, ''); eb = eb.slice(i + 1);
        if (l.trim() && proc === this.proc) this.onLine(this.name, `[stderr] ${l}`);
      }
    });
    proc.on('close', (code) => {
      if (proc !== this.proc) return;
      if (this.final || this.status === 'killed' || this.status === 'failed') return;
      this._set(code === 0 ? 'done' : 'failed');
    });
  }

  /** Resolves once the most recently started process has exited (so its cwd is no longer in use). */
  settled(timeoutMs = 5000) {
    if (!this.closed) return Promise.resolve();
    return Promise.race([this.closed, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  /** Kill the current process (if any) and resume the same session with new instructions. */
  async interrupt(text) {
    const old = this.proc;
    this.proc = null;
    await killTree(old);
    this.onLine(this.name, `⚡ interrupted. New instructions: ${text}`);
    await this.start(text);
  }

  async kill() {
    const old = this.proc;
    this.proc = null;
    this.final = this.final || 'killed';
    await killTree(old);
    this._set('killed');
  }
}

module.exports = { claudeParser, codexParser, makeParser, resolveExecutable, providerBin, killTree, WorkerAgent };
