# Backend notes

Files: `main/main.js` (window + IPC), `pty.js` (node-pty -> @xterm/headless -> snapshots), `state.js` (store),
`manager.js` (ctl commands, workers, pings), `agents.js` (claude/codex runners + event parsers), `git.js`
(worktrees), `prompts.js` (master injection, launchers, ping text), `ctl.js` + `bin/amctl*` (control CLI).

## Snapshot shape (`am.term.onSnapshot`)
`{cols, rows, cursor:{x, y, absY, visible}, altScreen, baseY, lines}`; `cursor.y` is relative to the viewport,
`absY = baseY + y` indexes into `lines`. Each line is `[{t, fg, bg, b?, i?, u?, inv?, d?}]` (falsy flags omitted;
fg/bg are `#rrggbb` or null). Extras: `am.term.getSnapshot()`, `am.onNotice(cb)`; `am.worker.delete(name)` resolves
`{ok, removed, kept:[reasons], error}`.

## Master injection
`amctl prepare <cli>` (run by the launcher script) writes `.agentmanager/{master_prompt.md, master_inject.md,
settings.json, codex_args.txt, launch-*.ps1}`. ORCHESTRATOR.md lookup: `<repo>/`, `<repo>/..`, `<root>/`, bundled
`assets/`.
- Claude: `--append-system-prompt-file master_prompt.md --settings settings.json`; the `UserPromptSubmit` hook runs
  `amctl print master_inject.md` so the text is re-added on every prompt; SessionStart/UserPromptSubmit/Stop hooks
  report idle/busy.
- Codex: `-c developer_instructions="<ORCHESTRATOR+notes>"` (default, kept next to codex's own prompt) or
  `codexMode: "file"` -> `-c model_instructions_file=...` (replaces codex's built-in prompt). `notify` reports idle;
  busy is inferred from Enter keystrokes. Configure in `<root>/.agentmanager/config.json`:
  `{shell, shellArgs, codexMode, claudeArgs, codexArgs, workerBins}` or env `AM_SHELL`, `AM_CODEX_MODE`.
- Test overrides: `AM_CLAUDE_BIN` / `AM_CODEX_BIN` (path or JSON array) replace the worker executables.
