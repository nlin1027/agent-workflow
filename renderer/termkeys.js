/* Pure keyboard -> terminal escape sequence mapping. UMD: window.TermKeys / require(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TermKeys = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CURSOR = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
  const TILDE = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6 };
  const FN_SS3 = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' };
  const FN_TILDE = { F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
  const CTRL_PUNCT = { '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '_': '\x1f', '/': '\x1f', '@': '\x00', ' ': '\x00', '2': '\x00', '3': '\x1b', '4': '\x1c', '5': '\x1d', '6': '\x1e', '7': '\x1f', '8': '\x7f' };

  function modParam(e) {
    return 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0) + (e.metaKey ? 8 : 0);
  }

  /**
   * Returns the string to send to the pty for a keydown event, or null when
   * the event should not be forwarded (modifier alone, IME, browser shortcuts).
   * opts.appCursor: DECCKM application cursor keys.
   */
  function keyToSequence(e, opts) {
    opts = opts || {};
    if (e.isComposing || e.key === 'Process' || e.key === 'Dead') return null;
    const k = e.key;
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'CapsLock' ||
        k === 'AltGraph' || k === 'NumLock' || k === 'ScrollLock' || k === 'ContextMenu') return null;
    const mod = modParam(e);
    const hasMod = mod > 1;

    if (CURSOR[k]) {
      if (hasMod) return '\x1b[1;' + mod + CURSOR[k];
      return (opts.appCursor ? '\x1bO' : '\x1b[') + CURSOR[k];
    }
    if (TILDE[k]) return '\x1b[' + TILDE[k] + (hasMod ? ';' + mod : '') + '~';
    if (FN_SS3[k]) return hasMod ? '\x1b[1;' + mod + FN_SS3[k] : '\x1bO' + FN_SS3[k];
    if (FN_TILDE[k]) return '\x1b[' + FN_TILDE[k] + (hasMod ? ';' + mod : '') + '~';

    switch (k) {
      case 'Enter':
        if (e.shiftKey || e.altKey) return '\x1b\r'; // newline-in-prompt for claude/codex
        return '\r';
      case 'Backspace':
        if (e.ctrlKey) return '\x17';
        return e.altKey ? '\x1b\x7f' : '\x7f';
      case 'Tab':
        return e.shiftKey ? '\x1b[Z' : '\t';
      case 'Escape':
        return '\x1b';
      default:
    }

    if (k.length >= 1 && [...k].length === 1) {
      if (e.ctrlKey && !e.altKey) {
        const lower = k.toLowerCase();
        if (lower >= 'a' && lower <= 'z') return String.fromCharCode(lower.charCodeAt(0) - 96);
        if (CTRL_PUNCT[k] !== undefined) return CTRL_PUNCT[k];
        return null;
      }
      if (e.altKey && !e.ctrlKey) return '\x1b' + k;
      if (e.ctrlKey && e.altKey) {
        const lower = k.toLowerCase();
        if (lower >= 'a' && lower <= 'z') return '\x1b' + String.fromCharCode(lower.charCodeAt(0) - 96);
        return null;
      }
      if (e.metaKey) return null;
      return k;
    }
    return null;
  }

  /** Prepare pasted text. Newlines become CR; wrap in bracketed-paste markers if enabled. */
  function preparePaste(text, bracketed) {
    let t = String(text).replace(/\r\n?|\n/g, '\r');
    if (bracketed) t = '\x1b[200~' + t.replace(/\x1b\[20[01]~/g, '') + '\x1b[201~';
    return t;
  }

  return { keyToSequence, preparePaste, modParam };
});
