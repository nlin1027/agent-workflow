/* Worker dock chips + floating worker windows. UMD: window.Workers / require(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Workers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_LINES = 2000;
  const MIN_W = 300, MIN_H = 170;
  const FINISHED = ['done', 'failed', 'killed'];
  const LIVE = ['new', 'running', 'idle'];

  // ---------- pure helpers ----------
  const canDelete = (w) => FINISHED.includes(w.status);
  const canKill = (w) => LIVE.includes(w.status);
  const canMessage = (w) => LIVE.includes(w.status);
  function statusLabel(s) {
    return ({ new: 'starting', running: 'running', idle: 'idle', done: 'done', failed: 'failed', killed: 'killed' })[s] || String(s || '?');
  }
  function classifyLine(line) {
    const l = String(line);
    if (/^\s*(error|✗|✘|fatal|traceback)/i.test(l) || /\b(failed|exception)\b/i.test(l.slice(0, 60))) return 'err';
    if (/^\s*(\[tool|→|\$ |>\s|tool:|running:|⚙)/i.test(l)) return 'tool';
    if (/^\s*(✓|✔|done|result:|\[result|completed)/i.test(l)) return 'ok';
    if (/^\s*(you:|\[you|→ you|message:|\[message)/i.test(l)) return 'user';
    return '';
  }
  function clampRect(r, bw, bh) {
    const w = Math.max(MIN_W, Math.min(r.w, Math.max(MIN_W, bw)));
    const h = Math.max(MIN_H, Math.min(r.h, Math.max(MIN_H, bh)));
    const x = Math.min(Math.max(0, r.x), Math.max(0, bw - 80));   // keep a grabbable part visible
    const y = Math.min(Math.max(0, r.y), Math.max(0, bh - 40));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }
  function resizeRect(start, dir, dx, dy) {
    let { x, y, w, h } = start;
    if (dir.includes('e')) w = start.w + dx;
    if (dir.includes('s')) h = start.h + dy;
    if (dir.includes('w')) { w = start.w - dx; if (w < MIN_W) { w = MIN_W; } x = start.x + start.w - w; }
    if (dir.includes('n')) { h = start.h - dy; if (h < MIN_H) { h = MIN_H; } y = start.y + start.h - h; }
    return { x, y, w: Math.max(MIN_W, w), h: Math.max(MIN_H, h) };
  }
  function cascadeRect(index, bw, bh) {
    const w = Math.min(560, Math.max(MIN_W, bw - 60)), h = Math.min(360, Math.max(MIN_H, bh - 60));
    const off = (index % 8) * 30;
    return clampRect({ x: 40 + off, y: 30 + off, w, h }, bw, bh);
  }

  // ---------- manager ----------
  class Workers {
    /**
     * @param {{layer:HTMLElement, dock:HTMLElement, api:{kill,message,delete}, storage?:Storage}} o
     */
    constructor(o) {
      this.layer = o.layer;
      this.dock = o.dock;
      this.api = o.api;
      this.doc = o.layer.ownerDocument;
      this.storage = o.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      this.items = new Map();     // name -> item
      this.pending = new Map();   // name -> lines that arrived before the worker existed
      this.zTop = 10;
      this.order = 0;
      this.dockEmpty = this.doc.createElement('span');
      this.dockEmpty.className = 'dock-empty';
      this.dockEmpty.textContent = 'No workers yet — ask the master to spawn some.';
      this.dock.appendChild(this.dockEmpty);
    }

    // ----- public -----
    update(workers) {
      const seen = new Set();
      for (const w of workers || []) {
        seen.add(w.name);
        let it = this.items.get(w.name);
        if (!it) it = this._create(w);
        this._refresh(it, w);
      }
      for (const [name, it] of [...this.items]) {
        if (!seen.has(name)) this._destroy(it);
      }
      this.dockEmpty.style.display = this.items.size ? 'none' : '';
    }

    appendLine(name, line) {
      const it = this.items.get(name);
      if (!it) {
        const p = this.pending.get(name) || [];
        p.push(line); if (p.length > MAX_LINES) p.shift();
        this.pending.set(name, p);
        return;
      }
      this._addLines(it, [line]);
    }

    isOpen(name) { const it = this.items.get(name); return !!(it && it.open); }
    open(name) { const it = this.items.get(name); if (it) this._setOpen(it, true); }
    minimize(name) { const it = this.items.get(name); if (it) this._setOpen(it, false); }
    toggle(name) { const it = this.items.get(name); if (it) this._setOpen(it, !it.open); }
    names() { return [...this.items.keys()]; }

    // ----- internals -----
    _create(w) {
      const d = this.doc;
      const it = { name: w.name, open: false, rect: null, w, order: this.order++, atBottom: true, lineCount: 0 };
      // chip
      const chip = d.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.name = w.name;
      chip.innerHTML = '<span class="dot"></span><span class="chip-name"></span><span class="chip-st"></span>';
      chip.addEventListener('click', () => this.toggle(w.name));
      this.dock.appendChild(chip);
      // window
      const win = d.createElement('section');
      win.className = 'wwin hidden';
      win.dataset.name = w.name;
      win.innerHTML =
        '<header class="whead">' +
          '<span class="dot"></span>' +
          '<div class="wtitle"><span class="wname"></span><span class="wsum"></span></div>' +
          '<span class="wstatus"></span>' +
          '<div class="wbtns">' +
            '<button type="button" class="wb b-msg" title="Send a message to this worker">Message</button>' +
            '<button type="button" class="wb b-kill" title="Kill this worker">Kill</button>' +
            '<button type="button" class="wb b-min" title="Minimize">–</button>' +
            '<button type="button" class="wb b-del" title="Delete (when finished)">Delete</button>' +
          '</div>' +
        '</header>' +
        '<div class="wmeta"><span class="wbranch"></span><details class="wprompt"><summary>prompt</summary><pre></pre></details></div>' +
        '<div class="wlog" tabindex="0"></div>' +
        '<div class="wresult hidden"></div>' +
        '<form class="wmsg hidden"><input type="text" placeholder="Message to worker…" autocomplete="off"><button type="submit">Send</button></form>' +
        '<i class="rz rz-n" data-dir="n"></i><i class="rz rz-s" data-dir="s"></i><i class="rz rz-e" data-dir="e"></i><i class="rz rz-w" data-dir="w"></i>' +
        '<i class="rz rz-ne" data-dir="ne"></i><i class="rz rz-nw" data-dir="nw"></i><i class="rz rz-se" data-dir="se"></i><i class="rz rz-sw" data-dir="sw"></i>';
      this.layer.appendChild(win);
      it.chip = chip; it.win = win;
      it.log = win.querySelector('.wlog');
      it.form = win.querySelector('.wmsg');
      it.input = it.form.querySelector('input');
      it.log.addEventListener('scroll', () => { it.atBottom = it.log.scrollHeight - it.log.scrollTop - it.log.clientHeight <= 4; });
      win.addEventListener('pointerdown', () => this._front(it), true);
      win.querySelector('.b-min').addEventListener('click', () => this._setOpen(it, false));
      win.querySelector('.b-kill').addEventListener('click', () => { if (canKill(it.w)) this.api.kill(it.name); });
      win.querySelector('.b-del').addEventListener('click', () => { if (canDelete(it.w)) this.api.delete(it.name); });
      win.querySelector('.b-msg').addEventListener('click', () => {
        if (!canMessage(it.w)) return;
        const show = it.form.classList.contains('hidden');
        it.form.classList.toggle('hidden', !show);
        if (show) it.input.focus();
      });
      it.form.addEventListener('submit', (e) => {
        e.preventDefault();
        const t = it.input.value.trim();
        if (!t) return;
        this.api.message(it.name, t);
        this._addLines(it, ['you: ' + t]);
        it.input.value = '';
      });
      this._bindDrag(it);
      this._bindResize(it);

      this.items.set(w.name, it);
      // initial backlog; live lines that arrived early follow
      this._addLines(it, w.lines || []);
      const p = this.pending.get(w.name);
      if (p) { this._addLines(it, p); this.pending.delete(w.name); }
      const saved = this._loadRect(w.name);
      it.rect = saved || cascadeRect(it.order, this.layer.clientWidth || 900, this.layer.clientHeight || 600);
      this._applyRect(it);
      return it;
    }

    _refresh(it, w) {
      it.w = w;
      const win = it.win;
      const st = w.status || 'new';
      for (const el of [win, it.chip]) {
        el.className = el.className.replace(/\bst-\w+\b/g, '').trim() + ' st-' + st;
      }
      it.chip.querySelector('.chip-name').textContent = w.name;
      it.chip.querySelector('.chip-st').textContent = statusLabel(st);
      it.chip.title = (w.summary || w.name) + ' — ' + statusLabel(st);
      win.querySelector('.wname').textContent = w.name;
      win.querySelector('.wsum').textContent = w.summary || '';
      win.querySelector('.wsum').title = w.summary || '';
      win.querySelector('.wstatus').textContent = statusLabel(st);
      win.querySelector('.wbranch').textContent = [w.provider, w.branch].filter(Boolean).join(' · ');
      win.querySelector('.wprompt pre').textContent = w.prompt || '(no prompt)';
      win.querySelector('.wprompt').style.display = w.prompt ? '' : 'none';
      const kill = win.querySelector('.b-kill'), del = win.querySelector('.b-del'), msg = win.querySelector('.b-msg');
      kill.style.display = canKill(w) ? '' : 'none';
      msg.disabled = !canMessage(w);
      del.disabled = !canDelete(w);
      del.title = canDelete(w) ? 'Delete this worker (worktree removed only if clean/merged)' : 'Only finished workers can be deleted';
      if (!canMessage(w)) it.form.classList.add('hidden');
      const res = win.querySelector('.wresult');
      if (FINISHED.includes(st) && w.result) { res.textContent = w.result; res.classList.remove('hidden'); }
      else { res.textContent = ''; res.classList.add('hidden'); }
    }

    _destroy(it) {
      it.chip.remove();
      it.win.remove();
      this.items.delete(it.name);
      this.pending.delete(it.name);
      if (this.storage) { try { this.storage.removeItem('am.win.' + it.name); } catch (_) {} }
    }

    _setOpen(it, open) {
      it.open = open;
      it.win.classList.toggle('hidden', !open);
      it.chip.classList.toggle('open', open);
      if (open) {
        this._applyRect(it);
        this._front(it);
        it.log.scrollTop = it.log.scrollHeight; it.atBottom = true;
      }
    }

    _front(it) { it.win.style.zIndex = ++this.zTop; }

    _addLines(it, lines) {
      if (!lines.length) return;
      const frag = this.doc.createDocumentFragment();
      for (const l of lines) {
        const d = this.doc.createElement('div');
        const c = classifyLine(l);
        d.className = 'll' + (c ? ' ' + c : '');
        d.textContent = String(l);
        frag.appendChild(d);
      }
      it.log.appendChild(frag);
      it.lineCount += lines.length;
      while (it.log.childNodes.length > MAX_LINES) it.log.firstChild.remove();
      if (it.atBottom) it.log.scrollTop = it.log.scrollHeight;
    }

    _applyRect(it) {
      const bw = this.layer.clientWidth || 1e4, bh = this.layer.clientHeight || 1e4;
      it.rect = clampRect(it.rect, bw, bh);
      const s = it.win.style;
      s.left = it.rect.x + 'px'; s.top = it.rect.y + 'px'; s.width = it.rect.w + 'px'; s.height = it.rect.h + 'px';
    }

    _saveRect(it) {
      if (!this.storage) return;
      try { this.storage.setItem('am.win.' + it.name, JSON.stringify(it.rect)); } catch (_) {}
    }
    _loadRect(name) {
      if (!this.storage) return null;
      try {
        const r = JSON.parse(this.storage.getItem('am.win.' + name));
        if (r && ['x', 'y', 'w', 'h'].every(k => typeof r[k] === 'number')) return r;
      } catch (_) {}
      return null;
    }

    _bindDrag(it) {
      const head = it.win.querySelector('.whead');
      head.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button')) return;
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY, start = { ...it.rect };
        try { head.setPointerCapture(e.pointerId); } catch (_) {}
        it.win.classList.add('dragging');
        const move = (ev) => {
          it.rect = { ...start, x: start.x + ev.clientX - sx, y: start.y + ev.clientY - sy };
          this._applyRect(it);
        };
        const up = () => {
          head.removeEventListener('pointermove', move);
          head.removeEventListener('pointerup', up);
          head.removeEventListener('pointercancel', up);
          it.win.classList.remove('dragging');
          this._saveRect(it);
        };
        head.addEventListener('pointermove', move);
        head.addEventListener('pointerup', up);
        head.addEventListener('pointercancel', up);
      });
      head.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) this._setOpen(it, false); });
    }

    _bindResize(it) {
      for (const h of it.win.querySelectorAll('.rz')) {
        h.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault(); e.stopPropagation();
          this._front(it);
          const dir = h.dataset.dir, sx = e.clientX, sy = e.clientY, start = { ...it.rect };
          try { h.setPointerCapture(e.pointerId); } catch (_) {}
          const move = (ev) => {
            it.rect = resizeRect(start, dir, ev.clientX - sx, ev.clientY - sy);
            this._applyRect(it);
          };
          const up = () => {
            h.removeEventListener('pointermove', move);
            h.removeEventListener('pointerup', up);
            h.removeEventListener('pointercancel', up);
            this._saveRect(it);
          };
          h.addEventListener('pointermove', move);
          h.addEventListener('pointerup', up);
          h.addEventListener('pointercancel', up);
        });
      }
    }

    /** Re-clamp every window after the layer resizes. */
    relayout() { for (const it of this.items.values()) this._applyRect(it); }
  }

  Workers.helpers = { canDelete, canKill, canMessage, statusLabel, classifyLine, clampRect, resizeRect, cascadeRect, MIN_W, MIN_H };
  return Workers;
});
