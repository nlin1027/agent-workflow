/* Pure view-model helpers for the top bar. UMD: window.View / require(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.View = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function goalView(state) {
    const g = state && state.goal;
    if (!g || !g.text) return { text: 'No goal set — tell the master what you want done.', repo: '', done: false, empty: true };
    return { text: g.text, repo: g.repo || '', done: !!g.done, empty: false };
  }

  function masterView(state) {
    const cli = (state && state.masterCli) || 'none';
    const st = (state && state.masterState) || 'none';
    if (cli === 'none') return { text: 'master not running', cls: 'none', canStart: true };
    return { text: cli + ' · ' + (st === 'none' ? 'starting' : st), cls: st, canStart: false };
  }

  function workerCounts(state) {
    const c = { total: 0, active: 0, finished: 0 };
    for (const w of (state && state.workers) || []) {
      c.total++;
      if (['new', 'running', 'idle'].includes(w.status)) c.active++; else c.finished++;
    }
    return c;
  }

  return { goalView, masterView, workerCounts };
});
