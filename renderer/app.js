/* Renderer entry: wires window.am (preload or mock) to the UI components. */
(function () {
  'use strict';
  const am = window.am;
  const $ = (id) => document.getElementById(id);
  if (!am) {
    document.body.innerHTML = '<pre style="padding:20px;color:#f66">window.am is missing (preload not loaded). Use ?mock=1 for the standalone mock.</pre>';
    return;
  }

  // ----- master pseudo-terminal -----
  const term = new TermView($('termHost'), {
    input: (s) => am.term.input(s),
    resize: (c, r) => am.term.resize(c, r),
  });
  am.term.onSnapshot((s) => term.setSnapshot(s));
  if (am.term.onTitle) am.term.onTitle((t) => { document.title = t ? t + ' — Agent Manager' : 'Agent Manager'; });
  term.focus();

  // ----- workers -----
  const workers = new Workers({
    layer: $('winLayer'),
    dock: $('dock'),
    api: {
      kill: (n) => am.worker.kill(n),
      message: (n, t) => am.worker.message(n, t),
      delete: (n) => am.worker.delete(n),
    },
  });
  am.worker.onLine((name, line) => workers.appendLine(name, line));
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => workers.relayout()).observe($('winLayer'));

  // ----- top bar -----
  function renderState(st) {
    if (!st) return;
    const g = View.goalView(st);
    $('goalText').textContent = g.text;
    $('goalRepo').textContent = g.repo;
    $('goal').classList.toggle('empty', g.empty);
    $('goal').classList.toggle('done', g.done);
    $('goal').title = g.text + (g.repo ? '\n' + g.repo : '');
    $('goalBadge').classList.toggle('hidden', !g.done);

    for (const b of $('provider').querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.p === st.provider);
    }
    const m = View.masterView(st);
    const ms = $('masterState');
    ms.textContent = m.text;
    ms.className = 'badge ' + m.cls;
    const sb = $('startMaster');
    sb.disabled = !m.canStart;
    sb.textContent = 'Start ' + (st.provider === 'codex' ? 'Codex' : 'Claude') + ' master';

    $('workerCount').textContent = View.workerCounts(st).total;
    workers.update(st.workers || []);
  }

  for (const b of $('provider').querySelectorAll('button')) {
    b.addEventListener('click', () => {
      am.provider.set(b.dataset.p);
      term.focus();
    });
  }
  $('startMaster').addEventListener('click', () => { am.master.start(); term.focus(); });

  am.state.onChange(renderState);
  am.state.get().then(renderState);

  window.__ui = { term, workers, renderState }; // for tests / debugging
})();
