'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function tmpdir(prefix = 'am-test-') { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }

function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

/** A fresh git repo with one commit. */
function makeRepo() {
  const d = tmpdir('am-repo-');
  sh(d, 'init', '-q');
  sh(d, 'config', 'user.email', 't@example.com');
  sh(d, 'config', 'user.name', 'tester');
  sh(d, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(d, 'README.md'), 'hello\n');
  sh(d, 'add', '-A');
  sh(d, 'commit', '-q', '-m', 'init');
  return d;
}

async function waitFor(fn, timeoutMs = 10000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for ' + what);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const FAKE_CLAUDE = [process.execPath, path.join(__dirname, 'fake-claude.js')];
const FAKE_CODEX = [process.execPath, path.join(__dirname, 'fake-codex.js')];

function cleanup(d) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* windows locks */ } }

module.exports = { tmpdir, sh, makeRepo, waitFor, FAKE_CLAUDE, FAKE_CODEX, cleanup };
