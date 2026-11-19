/* Pseudo-terminal projection: renders a snapshot of the headless xterm buffer as DOM rows.
 * Pure helpers are exported for tests (window.TermView.helpers / require()). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./termkeys.js'));
  else root.TermView = factory(root.TermKeys);
})(typeof self !== 'undefined' ? self : this, function (TermKeys) {
  'use strict';

  // ---------- pure helpers ----------
  function segStyle(s) {
    let fg = s.fg || null, bg = s.bg || null;
    if (s.inv) {
      const f = fg || 'var(--term-fg)', b = bg || 'var(--term-bg)';
      fg = b; bg = f;
    }
    let css = '';
    if (fg) css += 'color:' + fg + ';';
    if (bg) css += 'background:' + bg + ';';
    if (s.b) css += 'font-weight:700;';
    if (s.i) css += 'font-style:italic;';
    if (s.u) css += 'text-decoration:underline;';
    return css;
  }

  /** Split a row's segments into span descriptors, marking the cursor cell. */
  function rowSpans(segs, cursorX) {
    const out = [];
    let pos = 0;
    const withCursor = typeof cursorX === 'number' && cursorX >= 0;
    for (const s of segs || []) {
      const text = s.t == null ? '' : String(s.t);
      const chars = [...text];
      const style = segStyle(s);
      if (withCursor && cursorX >= pos && cursorX < pos + chars.length) {
        const k = cursorX - pos;
        if (k > 0) out.push({ text: chars.slice(0, k).join(''), style, cursor: false });
        out.push({ text: chars[k], style, cursor: true });
        if (k + 1 < chars.length) out.push({ text: chars.slice(k + 1).join(''), style, cursor: false });
      } else if (chars.length) {
        out.push({ text, style, cursor: false });
      }
      pos += chars.length;
    }
    if (withCursor && cursorX >= pos) {
      if (cursorX > pos) out.push({ text: ' '.repeat(cursorX - pos), style: '', cursor: false });
      out.push({ text: ' ', style: '', cursor: true });
    }
    return out;
  }

  function rowKey(segs, cursorX) {
    return (cursorX == null || cursorX < 0 ? '' : cursorX + '|') + JSON.stringify(segs || []);
  }

  /** When scrollback is full rows shift upward; find k so newKeys[i] === oldKeys[i+k]. 0 = no shift. */
  function detectShift(oldKeys, newKeys) {
    if (!oldKeys.length || !newKeys.length || oldKeys[0] === newKeys[0]) return 0;
    const probe = Math.min(newKeys.length, 12);
    const max = Math.min(oldKeys.length - 1, 4000);
    for (let k = 1; k <= max; k++) {
      if (oldKeys[k] !== newKeys[0]) continue;
      let ok = true;
      for (let j = 1; j < probe && k + j < oldKeys.length; j++) {
        if (oldKeys[k + j] !== newKeys[j]) { ok = false; break; }
      }
      if (ok) return k;
    }
    return 0;
  }

  function computeGrid(width, height, cw, ch) {
    if (!(cw > 0) || !(ch > 0)) return { cols: 80, rows: 24 };
    return { cols: Math.max(2, Math.floor((width + 0.01) / cw)), rows: Math.max(1, Math.floor(height / ch)) };
  }

  function isAtBottom(el, slack) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= (slack == null ? 4 : slack);
  }

  /** Clean text copied from the DOM: strip trailing blanks per line and nbsp. */
  function cleanCopy(text) {
    return String(text).replace(/ /g, ' ').split(/\r?\n/).map(l => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n+$/, '');
  }

  // ---------- component ----------
  class TermView {
    /**
     * @param {HTMLElement} host   container to fill
     * @param {object} api         { input(str), resize(cols, rows) }
     */
    constructor(host, api, opts) {
      opts = opts || {};
      this.doc = host.ownerDocument;
      this.host = host;
      this.api = api;
      this.snap = null;
      this.rowEls = [];
      this.rowKeys = [];
      this.stick = true;
      this.pending = false;
      this.cw = 8; this.ch = 17;
      this.cols = 0; this.rows = 0;
      this.wheelAcc = 0;
      this.raf = opts.raf || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(window) : (f) => setTimeout(f, 16));
      this._build();
      this._bind();
      this.measure();
      this.fit();
    }

    _build() {
      const d = this.doc;
      this.host.classList.add('term');
      this.scroller = d.createElement('div');
      this.scroller.className = 'term-scroll';
      this.scroller.tabIndex = 0;
      this.scroller.setAttribute('role', 'log');
      this.scroller.setAttribute('aria-label', 'Master terminal');
      this.content = d.createElement('div');
      this.content.className = 'term-rows';
      this.scroller.appendChild(this.content);
      this.meter = d.createElement('span');
      this.meter.className = 'term-meter';
      this.meter.textContent = 'W'.repeat(50);
      this.scroller.appendChild(this.meter);
      this.jump = d.createElement('button');
      this.jump.className = 'term-jump hidden';
      this.jump.textContent = '↓ Latest';
      this.jump.type = 'button';
      this.host.appendChild(this.scroller);
      this.host.appendChild(this.jump);
    }

    _bind() {
      const s = this.scroller;
      let scrollQueued = false;
      s.addEventListener('scroll', () => {
        if (scrollQueued) return;
        scrollQueued = true;
        this.raf(() => {
          scrollQueued = false;
          this.stick = isAtBottom(s);
          this.jump.classList.toggle('hidden', this.stick);
        });
      }, { passive: true });
      this.jump.addEventListener('click', () => { this.scrollToBottom(); this.focus(); });
      s.addEventListener('focus', () => this.host.classList.add('focused'));
      s.addEventListener('blur', () => this.host.classList.remove('focused'));
      s.addEventListener('keydown', (e) => this.onKeyDown(e));
      s.addEventListener('paste', (e) => {
        e.preventDefault();
        const t = e.clipboardData && e.clipboardData.getData('text');
        if (t) this.paste(t);
      });
      s.addEventListener('copy', (e) => {
        const sel = this.doc.getSelection && this.doc.getSelection();
        if (!sel || sel.isCollapsed) return;
        e.preventDefault();
        e.clipboardData.setData('text/plain', cleanCopy(sel.toString()));
      });
      s.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
      s.addEventListener('mouseup', () => {
        const sel = this.doc.getSelection && this.doc.getSelection();
        if (!sel || sel.isCollapsed) s.focus({ preventScroll: true });
      });
      this.host.addEventListener('mousedown', () => { /* tabindex handles focus */ });
      const RO = (this.doc.defaultView || {}).ResizeObserver;
      if (RO) {
        this.ro = new RO(() => this.fit());
        this.ro.observe(this.scroller);
      }
    }

    measure() {
      const r = this.meter.getBoundingClientRect();
      if (r.width > 0) this.cw = r.width / 50;
      const cs = this.doc.defaultView && this.doc.defaultView.getComputedStyle ? this.doc.defaultView.getComputedStyle(this.meter) : null;
      let lh = cs ? parseFloat(cs.lineHeight) : NaN;
      if (!(lh > 0)) lh = r.height || 17;
      this.ch = Math.max(1, Math.round(lh));
      this.host.style.setProperty('--term-cw', this.cw + 'px');
      this.host.style.setProperty('--term-ch', this.ch + 'px');
    }

    fit() {
      const s = this.scroller;
      if (!s.clientWidth || !s.clientHeight) return false;
      this.measure();
      const g = computeGrid(s.clientWidth - this._padX(), s.clientHeight, this.cw, this.ch);
      if (g.cols !== this.cols || g.rows !== this.rows) {
        this.cols = g.cols; this.rows = g.rows;
        if (this.api && this.api.resize) this.api.resize(g.cols, g.rows);
        return true;
      }
      return false;
    }

    _padX() {
      const w = this.doc.defaultView;
      if (!w || !w.getComputedStyle) return 0;
      const cs = w.getComputedStyle(this.scroller);
      return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    }

    focus() { this.scroller.focus({ preventScroll: true }); }

    scrollToBottom() {
      this.stick = true;
      this.scroller.scrollTop = this.scroller.scrollHeight;
      this.jump.classList.add('hidden');
    }

    send(str) {
      if (!str) return;
      this.api.input(str);
      if (!this.stick) this.scrollToBottom();
    }

    paste(text) {
      this.send(TermKeys.preparePaste(text, !!(this.snap && this.snap.bracketedPaste)));
    }

    hasSelection() {
      const sel = this.doc.getSelection && this.doc.getSelection();
      return !!(sel && !sel.isCollapsed && this.scroller.contains(sel.anchorNode));
    }

    copySelection() {
      const sel = this.doc.getSelection();
      const text = cleanCopy(sel.toString());
      if (text && navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
      return text;
    }

    async pasteFromClipboard() {
      try {
        const t = await navigator.clipboard.readText();
        if (t) this.paste(t);
      } catch (_) { /* denied */ }
    }

    onKeyDown(e) {
      const key = e.key;
      const ctrl = e.ctrlKey, shift = e.shiftKey;
      // local clipboard shortcuts
      if (ctrl && shift && (key === 'C' || key === 'c')) { e.preventDefault(); this.copySelection(); return; }
      if (ctrl && !shift && (key === 'c' || key === 'C') && this.hasSelection()) { e.preventDefault(); this.copySelection(); return; }
      if ((ctrl && (key === 'v' || key === 'V')) || (shift && key === 'Insert')) { e.preventDefault(); this.pasteFromClipboard(); return; }
      // local scrollback navigation
      if (shift && !ctrl && !e.altKey && !(this.snap && this.snap.altScreen)) {
        const page = Math.max(1, (this.rows - 1)) * this.ch;
        if (key === 'PageUp') { e.preventDefault(); this.scroller.scrollTop -= page; return; }
        if (key === 'PageDown') { e.preventDefault(); this.scroller.scrollTop += page; return; }
        if (key === 'Home') { e.preventDefault(); this.scroller.scrollTop = 0; return; }
        if (key === 'End') { e.preventDefault(); this.scrollToBottom(); return; }
      }
      const seq = TermKeys.keyToSequence(e, { appCursor: !!(this.snap && this.snap.appCursor) });
      if (seq == null) return;
      e.preventDefault();
      this.send(seq);
    }

    onWheel(e) {
      if (!(this.snap && this.snap.altScreen)) return; // native scrolling over scrollback
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 1 : this.ch;
      this.wheelAcc += e.deltaY / unit;
      const n = Math.trunc(this.wheelAcc);
      if (!n) return;
      this.wheelAcc -= n;
      const up = n < 0;
      const k = (this.snap.appCursor ? '\x1bO' : '\x1b[') + (up ? 'A' : 'B');
      this.api.input(k.repeat(Math.min(Math.abs(n), 10)));
    }

    setSnapshot(snap) {
      this.snap = snap;
      if (!this.pending) {
        this.pending = true;
        this.raf(() => { this.pending = false; this.render(); });
      }
    }

    render() {
      const snap = this.snap;
      if (!snap) return;
      const lines = snap.lines || [];
      const cur = snap.cursor || {};
      const curRow = cur.visible === false ? -1 : (snap.baseY || 0) + (cur.y || 0);
      const keys = new Array(lines.length);
      for (let i = 0; i < lines.length; i++) keys[i] = rowKey(lines[i], i === curRow ? cur.x : null);

      const wasStick = this.stick;
      const shift = detectShift(this.rowKeys, keys);
      if (shift > 0) {
        for (let i = 0; i < shift; i++) { const el = this.rowEls.shift(); if (el) el.remove(); }
        this.rowKeys.splice(0, shift);
      }
      // drop extra rows
      while (this.rowEls.length > lines.length) { this.rowEls.pop().remove(); this.rowKeys.pop(); }
      const frag = this.doc.createDocumentFragment();
      for (let i = 0; i < lines.length; i++) {
        if (i < this.rowEls.length) {
          if (this.rowKeys[i] !== keys[i]) {
            this._fillRow(this.rowEls[i], lines[i], i === curRow ? cur.x : null);
            this.rowKeys[i] = keys[i];
          }
        } else {
          const el = this.doc.createElement('div');
          el.className = 'row';
          this._fillRow(el, lines[i], i === curRow ? cur.x : null);
          this.rowEls.push(el); this.rowKeys.push(keys[i]);
          frag.appendChild(el);
        }
      }
      if (frag.childNodes.length) this.content.appendChild(frag);
      this.host.classList.toggle('alt', !!snap.altScreen);
      if (wasStick) this.scrollToBottom();
    }

    _fillRow(el, segs, cursorX) {
      el.textContent = '';
      const spans = rowSpans(segs, cursorX);
      if (!spans.length) return;
      for (const sp of spans) {
        const n = this.doc.createElement('span');
        n.textContent = sp.text;
        if (sp.style) n.style.cssText = sp.style;
        if (sp.cursor) n.className = 'cur';
        el.appendChild(n);
      }
    }

    /** Plain text of the rendered buffer (for tests / debugging). */
    text() { return this.rowEls.map(r => r.textContent).join('\n'); }
  }

  TermView.helpers = { segStyle, rowSpans, rowKey, detectShift, computeGrid, isAtBottom, cleanCopy };
  return TermView;
});
