'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../main/prompts');
const { tmpdir, cleanup } = require('./helpers');

const APP_DIR = path.join(__dirname, '..');
const BIN_DIR = path.join(APP_DIR, 'bin');

/** Decode the TOML basic string produced by tomlString (only \n-free \uXXXX escapes are used). */
function decodeToml(s) {
  assert.ok(s.startsWith('"') && s.endsWith('"'));
  return s.slice(1, -1)
    .replace(/\\U([0-9a-f]{8})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

test('tomlString: round-trips awkward text and emits only safe characters', () => {
  const text = 'He said "hi" & left | now\n\tline2 \\ back <tag> 100% ^ ünï 😀 `tick` \'q\' $x {}';
  const enc = P.tomlString(text);
  assert.equal(decodeToml(enc), text.replace(/\r\n?/g, '\n'));
  assert.ok(!/[\r\n]/.test(enc));
  assert.ok(!enc.slice(1, -1).includes('"'));
  assert.ok(!/[&|<>^%'`$]/.test(enc));
});

test('findOrchestrator: <repo>, then <repo>/.., then bundled assets copy', () => {
  const parent = tmpdir();
  try {
    const repo = path.join(parent, 'repo');
    fs.mkdirSync(repo);
    const bundled = P.findOrchestrator({ repo, root: repo, appDir: APP_DIR });
    // the parent has none yet -> falls through to something (bundled copy lives in assets/)
    assert.equal(bundled.path, path.join(APP_DIR, 'assets', 'ORCHESTRATOR.md'));
    assert.ok(bundled.text.length > 100);
    fs.writeFileSync(path.join(parent, 'ORCHESTRATOR.md'), 'PARENT');
    assert.equal(P.findOrchestrator({ repo, root: repo, appDir: APP_DIR }).text, 'PARENT');
    fs.writeFileSync(path.join(repo, 'ORCHESTRATOR.md'), '\uFEFFREPO');
    assert.equal(P.findOrchestrator({ repo, root: repo, appDir: APP_DIR }).text, 'REPO');
    assert.equal(P.findOrchestrator({ repo: null, root: null, appDir: '/nonexistent' }).path, null);
  } finally { cleanup(parent); }
});

test('master prompt = ORCHESTRATOR text + runtime notes', () => {
  const t = P.buildMasterPrompt({ orchText: 'ORCH TEXT\n\n' });
  assert.ok(t.startsWith('ORCH TEXT\n\nRUNTIME NOTES'));
  assert.match(t, /amctl spawn NAME/);
  assert.match(t, /\[AGENTMANAGER PING\]/);
  assert.ok(P.buildMasterPrompt({ orchText: '' }).startsWith('RUNTIME NOTES'));
});

test('claude injection: system-prompt file + UserPromptSubmit hook that prints the text every prompt', () => {
  const root = tmpdir();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'ORCHESTRATOR.md'), 'MY ORCHESTRATOR RULES');
    const f = P.writeSupportFiles({ root, repo, cli: 'claude', appDir: APP_DIR, binDir: BIN_DIR });
    const prompt = fs.readFileSync(f.promptFile, 'utf8');
    assert.match(prompt, /^MY ORCHESTRATOR RULES/);
    assert.ok(prompt.includes('RUNTIME NOTES'));
    // hook settings
    const settings = JSON.parse(fs.readFileSync(f.settingsFile, 'utf8'));
    const ups = settings.hooks.UserPromptSubmit.flatMap((h) => h.hooks.map((x) => x.command));
    assert.ok(ups.some((c) => /master-state busy/.test(c)));
    const printCmd = ups.find((c) => / print /.test(c));
    assert.ok(printCmd, 'a UserPromptSubmit hook prints the injection');
    assert.ok(printCmd.includes(f.injectFile.replace(/\\/g, '/')));
    assert.ok(settings.hooks.SessionStart[0].hooks[0].command.endsWith('master-state idle'));
    assert.ok(settings.hooks.Stop[0].hooks[0].command.endsWith('master-state idle'));
    // what the hook prints is the reminder + orchestrator + notes
    const inject = fs.readFileSync(f.injectFile, 'utf8');
    assert.ok(inject.startsWith(P.REMINDER_HEADER));
    assert.ok(inject.includes('MY ORCHESTRATOR RULES') && inject.includes('RUNTIME NOTES'));
    // the launcher passes both mechanisms to claude
    const ps = fs.readFileSync(f.claudeLauncher, 'utf8');
    assert.ok(ps.includes('--append-system-prompt-file'));
    assert.ok(ps.includes(P.psq(f.promptFile)));
    assert.ok(ps.includes('--settings ' + P.psq(f.settingsFile)));
    assert.ok(ps.includes('AGENTMANAGER_REPO'));
    assert.ok(ps.includes('master-state exited'));
    assert.deepEqual(P.claudeArgs({ promptFile: 'p', settingsFile: 's', extra: ['--x'] }),
      ['--append-system-prompt-file', 'p', '--settings', 's', '--x']);
  } finally { cleanup(root); }
});

test('the real hook command prints the injection (amctl print)', () => {
  const root = tmpdir();
  try {
    const f = P.writeSupportFiles({ root, repo: root, cli: 'claude', appDir: APP_DIR, binDir: BIN_DIR });
    const out = require('child_process').execFileSync(process.execPath,
      [path.join(BIN_DIR, 'amctl.js'), 'print', f.injectFile], { encoding: 'utf8' });
    assert.ok(out.startsWith('[Reminder - orchestrator workflow'));
    assert.ok(out.includes('RUNTIME NOTES'));
  } finally { cleanup(root); }
});

test('codex injection: developer_instructions carries ORCHESTRATOR + notes, notify reports idle', () => {
  const root = tmpdir();
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'ORCHESTRATOR.md'), 'CODEX "ORCH" rules & more');
    const f = P.writeSupportFiles({ root, repo, cli: 'codex', appDir: APP_DIR, binDir: BIN_DIR, config: { ...P.loadConfig(root, {}), codexMode: 'developer' } });
    const lines = fs.readFileSync(f.codexArgsFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].startsWith('developer_instructions="'));
    const decoded = decodeToml(lines[0].slice('developer_instructions='.length));
    assert.equal(decoded, f.promptText);
    assert.ok(decoded.includes('CODEX "ORCH" rules & more'));
    assert.ok(decoded.includes('RUNTIME NOTES'));
    assert.ok(lines[1].startsWith('notify=['));
    assert.ok(lines[1].includes('master-state') && lines[1].includes('idle'));
    const ps = fs.readFileSync(f.codexLauncher, 'utf8');
    assert.ok(ps.includes("'-c'") && ps.includes(P.psq(f.codexArgsFile)));
    assert.ok(ps.includes('master-state idle'));
  } finally { cleanup(root); }
});

test('codex injection mode "file": model_instructions_file; mode configurable via config.json and env', () => {
  const root = tmpdir();
  try {
    fs.mkdirSync(path.join(root, '.agentmanager'));
    fs.writeFileSync(path.join(root, '.agentmanager', 'config.json'), JSON.stringify({ codexMode: 'file', codexArgs: ['--model', 'o3'] }));
    const cfg = P.loadConfig(root, {});
    assert.equal(cfg.codexMode, 'file');
    assert.equal(P.loadConfig(root, { AM_CODEX_MODE: 'developer' }).codexMode, 'developer');
    const f = P.writeSupportFiles({ root, repo: root, cli: 'codex', appDir: APP_DIR, binDir: BIN_DIR, config: cfg });
    const first = fs.readFileSync(f.codexArgsFile, 'utf8').split('\n')[0];
    assert.ok(first.startsWith('model_instructions_file='));
    assert.equal(decodeToml(first.slice('model_instructions_file='.length)), f.promptFile.replace(/\\/g, '/'));
    assert.ok(fs.readFileSync(f.codexLauncher, 'utf8').includes("'--model' 'o3'"));
  } finally { cleanup(root); }
});

test('prepare(): regenerates files for the repo in env and returns it; unchanged files untouched', () => {
  const root = tmpdir();
  try {
    const repo = tmpdir();
    fs.writeFileSync(path.join(repo, 'ORCHESTRATOR.md'), 'R1');
    assert.equal(P.prepare('claude', { root, env: { AGENTMANAGER_REPO: repo } }), repo);
    const pf = path.join(root, '.agentmanager', 'master_prompt.md');
    assert.ok(fs.readFileSync(pf, 'utf8').startsWith('R1'));
    const ps = path.join(root, '.agentmanager', 'launch-claude.ps1');
    const m1 = fs.statSync(ps).mtimeMs;
    P.prepare('claude', { root, env: { AGENTMANAGER_REPO: repo } });
    assert.equal(fs.statSync(ps).mtimeMs, m1);
    cleanup(repo);
  } finally { cleanup(root); }
});

test('launchCommand + pings', () => {
  const files = { claudeLauncher: 'C:\\x\\c.ps1', codexLauncher: 'C:\\x\\d.ps1' };
  assert.equal(P.launchCommand('claude', files), 'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "C:\\x\\c.ps1"');
  assert.ok(P.launchCommand('codex', files).endsWith('d.ps1"'));
  const w = { name: 'api', summary: 'S', branch: 'agent/api', worktree: '/w/api', result: 'multi\nline\n\nresult  ' + 'x'.repeat(3000) };
  const p = P.workerPing(w, 'done');
  assert.ok(p.startsWith("[AGENTMANAGER PING] Worker 'api' finished with status done."));
  assert.ok(!/[\r\n]/.test(p));
  assert.ok(p.includes('multi line result'));
  assert.ok(p.length < 2500);
  assert.ok(P.workerPing({ ...w, result: '' }, 'failed').includes('final message: (none)'));
  const f = P.finalPing({ text: 'GOAL', repo: '/r' }, [{ ...w, status: 'done' }, { ...w, name: 'b', status: 'failed' }]);
  assert.ok(f.startsWith('[AGENTMANAGER PING] ALL workers have finished. Repo: /r. Overall goal: GOAL.'));
  assert.ok(f.includes('api [done]') && f.includes('b [failed]') && f.includes('amctl goal-done'));
  assert.ok(!/[\r\n]/.test(f));
});
