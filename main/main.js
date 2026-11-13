'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('./state');
const { MasterTerminal } = require('./pty');
const { Manager } = require('./manager');
const prompts = require('./prompts');
const gitmod = require('./git');

const SMOKE = process.argv.includes('--smoke');
const MOCK = process.argv.includes('--mock');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

/** Where state lives and the shell starts: --root, $AGENTMANAGER_HOME, cwd (home dir when packaged/launched from an install dir). */
function pickRoot() {
  const r = argValue('--root') || process.env.AGENTMANAGER_HOME;
  if (r) return path.resolve(r);
  if (SMOKE) return fs.mkdtempSync(path.join(os.tmpdir(), 'am-smoke-'));
  return app.isPackaged ? os.homedir() : process.cwd();
}

let win = null;
let store, term, manager;
let lastSnapshot = null;

function send(channel, ...args) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args);
}

function shellEnv(root) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const bin = prompts.defaultBinDir();
  env.PATH = bin + path.delimiter + (env.PATH || env.Path || '');
  env.Path = env.PATH;
  env.AGENTMANAGER_HOME = root;
  env.AGENTMANAGER_NODE = process.execPath;
  env.COLORTERM = 'truecolor';
  return env;
}

async function boot() {
  const root = pickRoot();
  fs.mkdirSync(path.join(root, '.agentmanager'), { recursive: true });
  const config = prompts.loadConfig(root);
  store = new Store(root);
  term = new MasterTerminal({
    file: config.shell, args: config.shellArgs, cwd: root, env: shellEnv(root), cols: 120, rows: 30,
  });
  manager = new Manager({ root, store, term, bins: config.workerBins });
  manager.start();

  term.on('snapshot', (s) => {
    lastSnapshot = s;
    send('term:snapshot', s);
    if (SMOKE) smokeSnapshots += 1;
  });
  term.on('title', (t) => send('term:title', t));
  store.on('change', (s) => send('state:change', s));
  store.on('line', (n, l) => send('worker:line', n, l));
  manager.on('notice', (t) => send('notice', t));

  ipcMain.on('term:input', (_e, data) => { term.input(String(data)); manager.onUserInput(String(data)); });
  ipcMain.on('term:resize', (_e, cols, rows) => term.resize(cols, rows));
  ipcMain.handle('term:getSnapshot', () => lastSnapshot || term.snapshot());
  ipcMain.handle('state:get', () => store.toState());
  ipcMain.handle('worker:kill', (_e, name) => manager.kill(String(name)));
  ipcMain.handle('worker:message', (_e, name, text) => manager.message(String(name), String(text)));
  ipcMain.handle('worker:delete', (_e, name) => manager.deleteWorker(String(name)));
  ipcMain.handle('provider:set', (_e, p) => { store.setProvider(p); return true; });
  ipcMain.handle('master:start', async () => {
    const repo = (await gitmod.toplevel(root)) || root;
    return manager.startMaster(store.provider, { repo });
  });
}

let smokeSnapshots = 0;
let windowReady = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 900, minHeight: 600, backgroundColor: '#0f1115', show: !SMOKE,
    title: 'Agent Manager',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.setMenuBarVisibility(false);
  const index = path.join(__dirname, '..', 'renderer', 'index.html');
  if (fs.existsSync(index)) win.loadFile(index, MOCK ? { query: { mock: '1' } } : undefined);
  else win.loadURL('data:text/html,<body style="background:%23111;color:%23ccc;font:14px sans-serif">renderer/index.html missing</body>');
  win.webContents.on('did-finish-load', () => {
    windowReady = true;
    send('state:change', store.toState());
    if (lastSnapshot) send('term:snapshot', lastSnapshot);
  });
  win.on('closed', () => { win = null; });
}

function smokeWatch() {
  const started = Date.now();
  const t = setInterval(() => {
    if (windowReady && smokeSnapshots > 0) { clearInterval(t); console.log('SMOKE OK snapshots=' + smokeSnapshots); shutdown(0); }
    else if (Date.now() - started > 30000) { clearInterval(t); console.error('SMOKE TIMEOUT window=' + windowReady + ' snapshots=' + smokeSnapshots); shutdown(1); }
  }, 200);
}

let quitting = false;
async function shutdown(code) {
  if (quitting) return;
  quitting = true;
  try { if (manager) await manager.stop(); } catch { /* ignore */ }
  try { if (term) term.kill(); } catch { /* ignore */ }
  app.exit(code);
}

const lock = SMOKE || app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.whenReady().then(async () => {
    await boot();
    createWindow();
    if (SMOKE) smokeWatch();
  });
  app.on('window-all-closed', () => shutdown(0));
  app.on('before-quit', (e) => { if (!quitting) { e.preventDefault(); shutdown(0); } });
}
