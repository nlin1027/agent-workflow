// Screenshot / smoke harness for the renderer against the mock (real Chromium).
//   npx electron test/ui/shoot.js        -> writes shots/*.png, prints checks, exits non-zero on failure
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', '..', 'shots');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' ' + extra : '')); if (!ok) failed++; };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 800, show: true, webPreferences: { contextIsolation: true } });
  await win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'), { query: { mock: '1' } });
  const ev = (js) => win.webContents.executeJavaScript(js);
  const shot = async (n) => fs.writeFileSync(path.join(out, n + '.png'), (await win.webContents.capturePage()).toPNG());
  await sleep(500);
  await shot('01-initial');

  const grid = await ev('({c: __ui.term.cols, r: __ui.term.rows, resizes: __mock.resizes.length})');
  check('grid computed from measured char size', grid.c > 40 && grid.r > 10, JSON.stringify(grid));

  // scrollback is scrollable and follows bottom
  const s1 = await ev('(() => { const s = __ui.term.scroller; return {top: s.scrollTop, h: s.scrollHeight, c: s.clientHeight}; })()');
  check('terminal has scrollback and sits at bottom', s1.h > s1.c * 2 && s1.top + s1.c >= s1.h - 4, JSON.stringify(s1));
  win.webContents.sendInputEvent({ type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: 600 });
  await sleep(200);
  const s2 = await ev('__ui.term.scroller.scrollTop');
  check('mouse wheel scrolls up', s2 < s1.top, String(s2));
  check('follow stopped + jump button visible', await ev('!__ui.term.stick && !__ui.term.jump.classList.contains("hidden")'));
  await shot('02-scrolled-up');
  await ev('__ui.term.jump.click()');
  await sleep(100);
  check('jump returns to bottom', await ev('__ui.term.stick'));

  // dock open / minimize
  await ev('document.querySelector(\'.chip[data-name="backend"]\').click(); document.querySelector(\'.chip[data-name="docs"]\').click(); document.querySelector(\'.chip[data-name="lint"]\').click()');
  await sleep(200);
  check('windows open from dock', await ev('document.querySelectorAll(".wwin:not(.hidden)").length') === 3);
  await shot('03-windows');
  await ev('document.querySelector(\'.chip[data-name="docs"]\').click()');
  check('chip toggles window minimized', await ev('document.querySelector(\'.wwin[data-name="docs"]\').classList.contains("hidden")'));
  await ev('document.querySelector(\'.chip[data-name="docs"]\').click()');

  // real drag of a window header
  const box = await ev('(() => { const r = document.querySelector(\'.wwin[data-name="backend"] .whead\').getBoundingClientRect(); return {x: r.x + 60, y: r.y + 14, left: parseFloat(document.querySelector(\'.wwin[data-name="backend"]\').style.left)}; })()');
  win.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  for (let k = 1; k <= 5; k++) { win.webContents.sendInputEvent({ type: 'mouseMove', x: box.x + 30 * k, y: box.y + 12 * k, button: 'left' }); await sleep(30); }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: box.x + 150, y: box.y + 60, button: 'left', clickCount: 1 });
  await sleep(150);
  const left2 = await ev('parseFloat(document.querySelector(\'.wwin[data-name="backend"]\').style.left)');
  check('window drags', left2 > box.left + 100, `${box.left} -> ${left2}`);

  // delete a finished worker
  await ev('document.querySelector(\'.wwin[data-name="docs"] .b-del\').click()');
  await sleep(100);
  check('delete removes finished worker', await ev('!document.querySelector(\'.chip[data-name="docs"]\') && !document.querySelector(\'.wwin[data-name="docs"]\')'));

  // keyboard goes to the pty
  await ev('__ui.term.focus()');
  for (const ch of 'seq 5') { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch }); win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch }); }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  await sleep(300);
  check('typed command reaches terminal', (await ev('__ui.term.text()')).includes('5 of 5'));
  await shot('04-after-input');

  console.log(failed ? failed + ' FAILED' : 'ALL PASSED');
  app.exit(failed ? 1 : 0);
});
