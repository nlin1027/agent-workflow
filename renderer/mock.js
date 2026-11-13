/* Standalone mock of window.am for UI development/tests. Active only with ?mock=1 and no real preload. */
(function () {
  'use strict';
  const enabled = typeof location !== 'undefined' && /[?&]mock=1\b/.test(location.search);
  if (!enabled || window.am) return;

  const G = '#7ee787', B = '#79c0ff', Y = '#e3b341', R = '#ff7b72', M = '#d2a8ff', D = '#8b949e';
  const seg = (t, o) => Object.assign({ t, fg: null, bg: null, b: false, i: false, u: false, inv: false }, o || {});
  const listeners = { snap: [], title: [], state: [], line: [] };
  const emit = (k, ...a) => listeners[k].forEach(f => f(...a));

  // ---------- fake shell / headless buffer ----------
  const term = { cols: 100, rows: 30, buf: [], curRow: 0, cx: 0, alt: false, input: '', prompt: 'PS C:\\repo> ', altStep: 0, timer: null };
  const blank = () => [];
  function normalize() {
    const baseY = Math.max(0, term.curRow - (term.rows - 1));
    while (term.buf.length < baseY + term.rows) term.buf.push(blank());
    if (term.buf.length > baseY + term.rows) term.buf.length = baseY + term.rows;
    if (term.buf.length > 10000 + term.rows) { term.buf.splice(0, term.buf.length - 10000 - term.rows); term.curRow = term.buf.length - 1 - 0; }
    return baseY;
  }
  function putLine(segs) { term.buf[term.curRow] = segs; term.curRow++; term.buf[term.curRow] = term.buf[term.curRow] || blank(); }
  function drawPrompt() {
    term.buf[term.curRow] = [seg(term.prompt, { fg: G, b: true }), seg(term.input)];
    term.cx = term.prompt.length + term.input.length;
  }
  function schedule() {
    if (term.timer) return;
    term.timer = setTimeout(() => { term.timer = null; emit('snap', snapshot()); }, 33);
  }
  function snapshot() {
    if (term.alt) return altSnapshot();
    drawPrompt();
    const baseY = normalize();
    return {
      cols: term.cols, rows: term.rows, altScreen: false, baseY,
      cursor: { x: term.cx, y: term.curRow - baseY, visible: true },
      lines: JSON.parse(JSON.stringify(term.buf)),
    };
  }
  function altSnapshot() {
    const lines = [];
    for (let y = 0; y < term.rows; y++) lines.push([]);
    const bar = seg(' mock-tui '.padEnd(term.cols, ' '), { inv: true, b: true });
    lines[0] = [bar];
    lines[2] = [seg('  Full-screen app (alt screen). Frame ' + term.altStep, { fg: B })];
    lines[3] = [seg('  Keys received: ', { fg: D }), seg(term.altKeys || '', { fg: Y })];
    lines[term.rows - 1] = [seg(' q to quit ', { bg: '#30363d' })];
    return { cols: term.cols, rows: term.rows, altScreen: true, baseY: 0, cursor: { x: 0, y: 0, visible: false }, lines };
  }

  function banner() {
    putLine([seg('Windows PowerShell (mock)', { b: true })]);
    putLine([seg('Type ', { fg: D }), seg('help', { fg: Y }), seg(' for demo commands. This buffer has scrollback.', { fg: D })]);
    putLine([]);
    for (let i = 1; i <= 120; i++) {
      const c = [G, B, Y, M, R][i % 5];
      putLine([seg('line ' + String(i).padStart(3, '0') + ' ', { fg: D }), seg('scrollback sample text ', { fg: c }), seg(i % 7 === 0 ? 'bold!' : '', { b: true }), seg(i % 11 === 0 ? ' underlined' : '', { u: true }), seg(i % 13 === 0 ? ' italic' : '', { i: true })]);
    }
  }
  function run(cmd) {
    const c = cmd.trim();
    if (!c) return;
    const [name, ...rest] = c.split(/\s+/);
    if (name === 'help') {
      putLine([seg('Commands: ', { b: true }), seg('seq N  clear  tui  spawn NAME  goal TEXT  claude  echo ...', { fg: Y })]);
    } else if (name === 'clear') {
      term.buf = []; term.curRow = 0;
    } else if (name === 'seq') {
      const n = Math.min(parseInt(rest[0], 10) || 10, 5000);
      for (let i = 1; i <= n; i++) putLine([seg(String(i), { fg: [G, B, Y][i % 3] }), seg(' of ' + n)]);
    } else if (name === 'tui') {
      term.alt = true; term.altStep = 0; term.altKeys = '';
      clearInterval(term.altTimer);
      term.altTimer = setInterval(() => { term.altStep++; schedule(); }, 500);
    } else if (name === 'spawn') {
      api.__spawn(rest[0] || 'worker' + (state.workers.length + 1));
      putLine([seg('spawned ' + (rest[0] || ''), { fg: G })]);
    } else if (name === 'goal') {
      mock.setGoal(rest.join(' '));
    } else if (name === 'echo') {
      putLine([seg(rest.join(' '))]);
    } else if (name === 'claude' || name === 'codex') {
      api.master.start();
    } else {
      putLine([seg(name + ' : The term \'' + name + '\' is not recognized.', { fg: R })]);
    }
  }
  function termInput(s) {
    if (term.alt) {
      term.altKeys = ((term.altKeys || '') + s.replace(/\x1b/g, '^[').replace(/\r/g, '<CR>')).slice(-60);
      if (s === 'q') { term.alt = false; clearInterval(term.altTimer); }
      schedule(); return;
    }
    // naive line discipline
    for (const ch of s) {
      if (ch === '\r') { drawPrompt(); term.curRow++; term.buf[term.curRow] = []; const cmd = term.input; term.input = ''; run(cmd); }
      else if (ch === '\x7f') term.input = term.input.slice(0, -1);
      else if (ch === '\x03') { term.input = ''; putLine([seg('^C', { fg: R })]); }
      else if (ch >= ' ' && !s.startsWith('\x1b')) term.input += ch;
    }
    schedule();
  }

  // ---------- fake app state ----------
  const state = {
    goal: { text: 'Rebuild the Agent Manager as an Electron app with a pseudo-terminal master and floating worker windows.', repo: 'C:/Users/me/repo', done: false },
    masterCli: 'none', masterState: 'none', provider: 'claude',
    workers: [],
  };
  const clone = () => JSON.parse(JSON.stringify(state));
  const pushState = () => emit('state', clone());
  function mkWorker(name, status, summary, extra) {
    return Object.assign({
      name, summary, status, prompt: 'Implement ' + summary + '.\nCommit when done.', branch: 'agent/' + name,
      worktree: 'C:/Users/me/repo/.agentmanager/worktrees/' + name, result: '', provider: 'claude',
      lines: ['[tool] Read package.json', 'Looking at the project layout.', '[tool] Edit src/' + name + '.js', 'Editing files\u2026'],
    }, extra || {});
  }
  state.workers = [
    mkWorker('backend', 'running', 'IPC + pty plumbing', { lines: Array.from({ length: 80 }, (_, i) => (i % 9 === 0 ? '[tool] Bash npm test #' + i : 'working on step ' + i)) }),
    mkWorker('ui', 'idle', 'Renderer and window manager'),
    mkWorker('docs', 'done', 'README and usage docs', { result: 'README written, 3 files changed.', lines: ['[tool] Write README.md', '\u2713 done'] }),
    mkWorker('lint', 'failed', 'Fix lint errors', { result: 'error: eslint crashed', lines: ['[tool] Bash eslint .', 'error: eslint crashed'] }),
    mkWorker('old', 'killed', 'Abandoned experiment'),
  ];

  const api = {
    term: {
      input: (s) => termInput(s),
      resize: (c, r) => { term.cols = c; term.rows = r; schedule(); mock.resizes.push([c, r]); },
      onSnapshot: (f) => { listeners.snap.push(f); setTimeout(() => f(snapshot()), 0); },
      onTitle: (f) => { listeners.title.push(f); f('Mock shell'); },
    },
    state: {
      get: () => Promise.resolve(clone()),
      onChange: (f) => listeners.state.push(f),
    },
    worker: {
      onLine: (f) => listeners.line.push(f),
      kill: (n) => { const w = state.workers.find(x => x.name === n); if (w && ['new', 'running', 'idle'].includes(w.status)) { w.status = 'killed'; mock.calls.push(['kill', n]); pushState(); } },
      message: (n, t) => { mock.calls.push(['message', n, t]); },
      delete: (n) => {
        const i = state.workers.findIndex(x => x.name === n);
        if (i >= 0 && ['done', 'failed', 'killed'].includes(state.workers[i].status)) { state.workers.splice(i, 1); mock.calls.push(['delete', n]); pushState(); }
      },
    },
    provider: { set: (p) => { state.provider = p; mock.calls.push(['provider', p]); pushState(); } },
    master: { start: () => {
      mock.calls.push(['master.start']);
      state.masterCli = state.provider; state.masterState = 'idle';
      term.input = state.provider + ' --append-system-prompt-file ORCHESTRATOR.md';
      termInput('\r'); pushState();
    } },
    __spawn: (name) => { state.workers.push(mkWorker(name, 'running', 'Spawned from mock terminal')); pushState(); },
  };

  const mock = {
    calls: [], resizes: [], state, term,
    setGoal(text, done) { state.goal = text ? { text, repo: state.goal ? state.goal.repo : '', done: !!done } : null; pushState(); },
    goalDone() { if (state.goal) state.goal.done = true; pushState(); },
    addWorker(name, status, summary) { state.workers.push(mkWorker(name, status || 'running', summary || name)); pushState(); },
    setStatus(name, status) { const w = state.workers.find(x => x.name === name); if (w) { w.status = status; pushState(); } },
    line(name, text) { const w = state.workers.find(x => x.name === name); if (w) { w.lines.push(text); } emit('line', name, text); },
    snapshot,
  };
  window.__mock = mock;
  window.am = api;

  banner();
  term.input = '';
  // live worker output
  let tick = 0;
  setInterval(() => {
    tick++;
    for (const w of state.workers) {
      if (w.status === 'running') mock.line(w.name, (tick % 6 === 0 ? '[tool] Bash step ' : 'progress ') + tick);
    }
  }, 1500);
})();
