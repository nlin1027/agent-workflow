'use strict';
// Master injection (ORCHESTRATOR.md + runtime notes), launcher scripts, and ping texts.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const NOTES = `RUNTIME NOTES (appended automatically by the Agent Manager; override any conflicting detail above):
You are the master agent running inside the Agent Manager terminal, in the git repo named by
$AGENTMANAGER_REPO. Do NOT use your built-in Agent/subagent tool to create workers. Use these shell
commands (they work from any directory):
  amctl goal "TEXT"                     # concise overall goal, shown at the top of the UI. DO THIS FIRST for every new task.
  amctl spawn NAME "SUMMARY" "PROMPT"   # worktree <repo>/.agentmanager/worktrees/NAME on branch agent/NAME + headless worker.
                                        # SUMMARY = one short line shown above that worker's window; PROMPT = full instructions
  amctl message NAME "TEXT"             # interrupts worker NAME and gives it updated instructions
  amctl summary NAME "TEXT"             # update the one-line summary if the worker's job changes
  amctl kill NAME
  amctl status                          # goal + every worker's state, branch and worktree
  amctl goal-done                       # declare the goal complete (only after merge + cleanup)
Any TEXT/PROMPT argument may be written as @path/to/file.txt to read it from a file; do that for long or
multi-line prompts (write the prompt to a file first, e.g. in a temp dir outside the repo).
NAME must match [A-Za-z0-9_-]+ and be unique; use fresh names (e.g. api-r2) when
re-spawning in a later round. Workers appear live in the UI.

DO NOT WAIT for workers and do not poll: after spawning, end your turn. The
Agent Manager will type a message starting with "[AGENTMANAGER PING]" into this session
  - each time a worker finishes: review its work (git log/diff in its worktree),
    run tests; if wrong, \`amctl message\` it. Do not merge yet.
  - when ALL workers have finished: verify the overall goal, check for conflicts,
    merge the agent/* branches into the main branch, remove the worktrees
    (\`git worktree remove --force PATH\`, \`git branch -D agent/NAME\`), then run
    \`amctl goal-done\`. If the goal is NOT met, spawn a new round of workers
    instead (no goal-done) and you will be pinged again when they finish.
If a later user message changes the requirements for a running worker, relay
it with \`amctl message\`.
`;

const REMINDER_HEADER = '[Reminder - orchestrator workflow; follow it when the task fits]\n';

// ---------------------------------------------------------------- locating + composing the text
/** Candidates: <repo>/ORCHESTRATOR.md, <repo>/../ORCHESTRATOR.md, <root>/ORCHESTRATOR.md, bundled assets copy. */
function orchestratorCandidates({ repo, root, appDir }) {
  const c = [];
  if (repo) { c.push(path.join(repo, 'ORCHESTRATOR.md')); c.push(path.join(path.dirname(repo), 'ORCHESTRATOR.md')); }
  if (root) c.push(path.join(root, 'ORCHESTRATOR.md'));
  if (appDir) c.push(path.join(appDir, 'assets', 'ORCHESTRATOR.md'));
  return c;
}

function findOrchestrator(ctx) {
  for (const p of orchestratorCandidates(ctx)) {
    try {
      const text = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
      return { path: p, text };
    } catch { /* next */ }
  }
  return { path: null, text: '' };
}

function buildMasterPrompt({ orchText, notes = NOTES }) {
  return (orchText ? orchText.replace(/\s+$/, '') + '\n\n' : '') + notes;
}

/** What the UserPromptSubmit hook prints on every prompt (Claude). */
function reminderText(promptText) { return REMINDER_HEADER + promptText; }

// ---------------------------------------------------------------- Claude
const fwd = (p) => String(p).replace(/\\/g, '/');

function claudeSettings({ amctlCmd, injectFile }) {
  const state = (s) => [{ hooks: [{ type: 'command', command: `"${fwd(amctlCmd)}" master-state ${s}` }] }];
  const inject = [{ hooks: [{ type: 'command', command: `"${fwd(amctlCmd)}" print "${fwd(injectFile)}"` }] }];
  return {
    hooks: {
      SessionStart: state('idle'),
      UserPromptSubmit: [...state('busy'), ...inject],
      Stop: state('idle'),
    },
  };
}

function claudeArgs({ promptFile, settingsFile, extra = [] }) {
  return ['--append-system-prompt-file', promptFile, '--settings', settingsFile, ...extra];
}

// ---------------------------------------------------------------- Codex
/**
 * TOML basic string using only safe characters; everything else is \\uXXXX-escaped. That keeps the
 * value free of quotes/newlines/cmd.exe metacharacters so it survives being passed as one argv entry.
 */
function tomlString(text) {
  let o = '"';
  for (const ch of String(text).replace(/\r\n?/g, '\n')) {
    const c = ch.codePointAt(0);
    if (/[A-Za-z0-9 .,_\-/:;()=]/.test(ch)) o += ch;
    else if (c > 0xffff) o += '\\U' + c.toString(16).padStart(8, '0');
    else o += '\\u' + c.toString(16).padStart(4, '0');
  }
  return o + '"';
}

/**
 * `-c` override values for the codex master, one per entry.
 * mode 'developer' (default): developer_instructions = ORCHESTRATOR+notes (kept alongside codex's own prompt)
 * mode 'file': model_instructions_file = <promptFile> (REPLACES codex's built-in instructions)
 * Also registers `notify` so the app learns when a turn finished (master idle).
 */
function codexConfig({ mode = 'developer', promptText, promptFile, amctlCmd }) {
  const lines = [];
  if (mode === 'file') lines.push(`model_instructions_file=${tomlString(fwd(promptFile))}`);
  else lines.push(`developer_instructions=${tomlString(promptText)}`);
  lines.push(`notify=[${[fwd(amctlCmd), 'master-state', 'idle'].map(tomlString).join(',')}]`);
  return lines;
}

// ---------------------------------------------------------------- launcher scripts (PowerShell)
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const CLEAR = "Clear-Host\n[Console]::Write([string][char]27 + '[2J' + [char]27 + '[3J' + [char]27 + '[H')\n";

function claudeLauncher({ amctlCmd, promptFile, settingsFile, extra = [] }) {
  return `$ErrorActionPreference = 'Continue'
$repo = (git rev-parse --show-toplevel 2>$null)
if (-not $repo) { $repo = (Get-Location).ProviderPath }
$env:AGENTMANAGER_REPO = $repo
try { $exe = (Get-Command claude -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source } catch { Write-Host 'claude not found on PATH'; $exe = $null }
if ($exe) {
  & ${psq(amctlCmd)} prepare claude | Out-Null
  & $exe --append-system-prompt-file ${psq(promptFile)} --settings ${psq(settingsFile)} ${extra.map(psq).join(' ')}
}
& ${psq(amctlCmd)} master-state exited
${CLEAR}`;
}

function codexLauncher({ amctlCmd, argsFile, extra = [] }) {
  return `$ErrorActionPreference = 'Continue'
$repo = (git rev-parse --show-toplevel 2>$null)
if (-not $repo) { $repo = (Get-Location).ProviderPath }
$env:AGENTMANAGER_REPO = $repo
try { $exe = (Get-Command codex -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source } catch { Write-Host 'codex not found on PATH'; $exe = $null }
if ($exe) {
  & ${psq(amctlCmd)} prepare codex | Out-Null
  $argv = @()
  foreach ($l in (Get-Content -Encoding utf8 ${psq(argsFile)})) {
    if ($l.Trim()) {
      if ($PSVersionTable.PSVersion.Major -lt 7) { $l = $l.Replace('"', '\\"') }
      $argv += @('-c', $l)
    }
  }
  & ${psq(amctlCmd)} master-state idle
  & $exe @argv ${extra.map(psq).join(' ')}
}
& ${psq(amctlCmd)} master-state exited
${CLEAR}`;
}

// ---------------------------------------------------------------- config + support files
function loadConfig(root, env = process.env) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(path.join(root, '.agentmanager', 'config.json'), 'utf8')); } catch { /* defaults */ }
  return {
    shell: env.AM_SHELL || c.shell || 'powershell.exe',
    shellArgs: c.shellArgs || ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass'],
    codexMode: env.AM_CODEX_MODE || c.codexMode || 'developer',
    claudeArgs: c.claudeArgs || [],
    codexArgs: c.codexArgs || [],
    workerBins: c.workerBins || {},
  };
}

function defaultBinDir() { return path.join(__dirname, '..', 'bin').replace('app.asar', 'app.asar.unpacked'); }
function defaultAppDir() { return path.join(__dirname, '..'); }

function amctlCmdPath(binDir) { return path.join(binDir, process.platform === 'win32' ? 'amctl.cmd' : 'amctl'); }

/** Write everything the launchers need under <root>/.agentmanager. Returns paths + the composed text. */
function writeSupportFiles({ root, repo, cli, appDir = defaultAppDir(), binDir = defaultBinDir(), config, env = process.env }) {
  config = config || loadConfig(root, env);
  const d = path.join(root, '.agentmanager');
  fs.mkdirSync(d, { recursive: true });
  const orch = findOrchestrator({ repo, root, appDir });
  const promptText = buildMasterPrompt({ orchText: orch.text });
  const amctlCmd = amctlCmdPath(binDir);
  const p = {
    promptFile: path.join(d, 'master_prompt.md'),
    injectFile: path.join(d, 'master_inject.md'),
    settingsFile: path.join(d, 'settings.json'),
    codexArgsFile: path.join(d, 'codex_args.txt'),
    claudeLauncher: path.join(d, 'launch-claude.ps1'),
    codexLauncher: path.join(d, 'launch-codex.ps1'),
  };
  // Unchanged files are not rewritten: `amctl prepare` runs from inside a running launcher script.
  writeIfChanged(p.promptFile, promptText);
  writeIfChanged(p.injectFile, reminderText(promptText));
  writeIfChanged(p.settingsFile, JSON.stringify(claudeSettings({ amctlCmd, injectFile: p.injectFile })));
  const codexLines = codexConfig({ mode: config.codexMode, promptText, promptFile: p.promptFile, amctlCmd });
  writeIfChanged(p.codexArgsFile, codexLines.join('\n') + '\n');
  writeIfChanged(p.claudeLauncher, claudeLauncher({ amctlCmd, promptFile: p.promptFile, settingsFile: p.settingsFile, extra: config.claudeArgs }));
  writeIfChanged(p.codexLauncher, codexLauncher({ amctlCmd, argsFile: p.codexArgsFile, extra: config.codexArgs }));
  return { ...p, amctlCmd, promptText, orchestratorPath: orch.path, codexLines };
}

function writeIfChanged(f, text) {
  try { if (fs.readFileSync(f, 'utf8') === text) return; } catch { /* write it */ }
  fs.writeFileSync(f, text, 'utf8');
}

function gitToplevelSync(cwd) {
  try {
    const out = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out.trim() ? path.resolve(out.trim()) : '';
  } catch { return ''; }
}

/** `amctl prepare <cli>`: regenerate support files for the repo of the current directory; prints the repo. */
function prepare(cli, { root, env = process.env, cwd = process.cwd() }) {
  const repo = env.AGENTMANAGER_REPO || gitToplevelSync(cwd) || cwd;
  writeSupportFiles({ root, repo, cli, env });
  return repo;
}

/** Command typed into the shell to start the master (works from powershell, pwsh, and cmd). */
function launchCommand(cli, files) {
  const f = cli === 'codex' ? files.codexLauncher : files.claudeLauncher;
  return `powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${f}"`;
}

// ---------------------------------------------------------------- pings (single line each)
const oneLine = (s, limit) => (String(s || '').split(/\s+/).filter(Boolean).join(' ') || '(none)').slice(0, limit);

function workerPing(w, status) {
  return `[AGENTMANAGER PING] Worker '${w.name}' finished with status ${status}. ` +
    `Summary: ${w.summary}. Branch: ${w.branch}. Worktree: ${w.worktree}. ` +
    `Its final message: ${oneLine(w.result, 1500)} ` +
    '-- Review its work now (git log/diff in the worktree) and run tests. If it is wrong, ' +
    '`amctl message` it. Do NOT merge yet; other workers are still running and you will ' +
    'get another ping when all are finished.';
}

function finalPing(goal, workers) {
  const rows = workers.map((w) => `${w.name} [${w.status}] branch=${w.branch} worktree=${w.worktree} ` +
    `summary: ${w.summary} final message: ${oneLine(w.result, 500)}`).join(' | ');
  return `[AGENTMANAGER PING] ALL workers have finished. Repo: ${goal.repo}. ` +
    `Overall goal: ${goal.text}. Workers: ${rows} ` +
    '-- Now: verify the overall goal is met (review diffs, run tests), check the branches ' +
    'for conflicts, merge them into the main branch, remove the worktrees and agent/* branches, ' +
    'then run `amctl goal-done`. If the goal is NOT met, do not run goal-done: spawn a ' +
    'new round of workers (fresh names) to fix it and end your turn; you will be ' +
    'pinged again.';
}

module.exports = {
  NOTES, REMINDER_HEADER, orchestratorCandidates, findOrchestrator, buildMasterPrompt, reminderText,
  claudeSettings, claudeArgs, tomlString, codexConfig, claudeLauncher, codexLauncher, loadConfig,
  writeSupportFiles, prepare, launchCommand, workerPing, finalPing, oneLine, defaultBinDir, defaultAppDir,
  amctlCmdPath, psq,
};
