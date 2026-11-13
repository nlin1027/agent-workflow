'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        out: String(stdout || '').trim(),
        err: String(stderr || (err && err.message) || '').trim(),
      });
    });
  });
}

async function toplevel(cwd) {
  const r = await git(['rev-parse', '--show-toplevel'], cwd);
  return r.code === 0 && r.out ? path.resolve(r.out) : null;
}

/** Keep .agentmanager/ out of `git status` without touching the repo's .gitignore. */
async function excludeFromGit(repo) {
  try {
    const r = await git(['rev-parse', '--git-path', 'info/exclude'], repo);
    if (r.code !== 0) return;
    const f = path.resolve(repo, r.out);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes('.agentmanager/')) {
      fs.writeFileSync(f, cur + (cur === '' || cur.endsWith('\n') ? '' : '\n') + '.agentmanager/\n', 'utf8');
    }
  } catch { /* best effort */ }
}

function worktreePath(repo, name) { return path.join(repo, '.agentmanager', 'worktrees', name); }

/** Create worktree <repo>/.agentmanager/worktrees/NAME on branch agent/NAME. */
async function addWorktree(repo, name) {
  const wt = worktreePath(repo, name);
  const branch = `agent/${name}`;
  await excludeFromGit(repo);
  let r = await git(['worktree', 'add', '-b', branch, wt], repo);
  if (r.code !== 0 && /already exists/.test(r.err) && !fs.existsSync(wt)) {
    // branch kept from an earlier (unmerged) worker of the same name: reuse it
    r = await git(['worktree', 'add', wt, branch], repo);
  }
  if (r.code !== 0) return { ok: false, error: r.err || r.out };
  return { ok: true, worktree: wt, branch };
}

/**
 * Remove a worker's worktree + branch ONLY if that cannot lose work: the worktree has no
 * uncommitted changes and the branch is fully merged into the repo's current HEAD.
 * Otherwise keep both. Returns {removed, kept:[reasons]}.
 */
async function removeIfSafe(repo, worktree, branch) {
  const kept = [];
  if (!repo) return { removed: false, kept: ['no repo recorded'] };
  const exists = worktree && fs.existsSync(worktree);
  const branchExists = branch && (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo)).code === 0;
  let merged = true;
  if (branchExists) merged = (await git(['merge-base', '--is-ancestor', branch, 'HEAD'], repo)).code === 0;
  if (exists) {
    const st = await git(['status', '--porcelain'], worktree);
    if (st.code !== 0) kept.push('cannot read worktree status');
    else if (st.out) kept.push('worktree has uncommitted changes');
  }
  if (!merged) kept.push('branch has commits not merged into the main checkout');
  if (kept.length) return { removed: false, kept };
  if (exists) {
    const r = await git(['worktree', 'remove', worktree], repo);
    if (r.code !== 0) return { removed: false, kept: [r.err || 'git worktree remove failed'] };
  } else {
    await git(['worktree', 'prune'], repo);
  }
  if (branchExists) {
    const r = await git(['branch', '-d', branch], repo);
    if (r.code !== 0) return { removed: !exists ? false : true, kept: [r.err || 'git branch -d failed'] };
  }
  return { removed: true, kept: [] };
}

module.exports = { git, toplevel, excludeFromGit, addWorktree, removeIfSafe, worktreePath };
