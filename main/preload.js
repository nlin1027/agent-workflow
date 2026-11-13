'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Subscribe helper: returns an unsubscribe function.
const on = (channel, cb) => {
  const h = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('am', {
  term: {
    input: (s) => ipcRenderer.send('term:input', s),
    resize: (cols, rows) => ipcRenderer.send('term:resize', cols, rows),
    onSnapshot: (cb) => on('term:snapshot', cb),
    onTitle: (cb) => on('term:title', cb),
    getSnapshot: () => ipcRenderer.invoke('term:getSnapshot'), // extra: pull the latest snapshot on demand
  },
  state: {
    get: () => ipcRenderer.invoke('state:get'),
    onChange: (cb) => on('state:change', cb),
  },
  worker: {
    onLine: (cb) => on('worker:line', cb),
    kill: (name) => ipcRenderer.invoke('worker:kill', name),
    message: (name, text) => ipcRenderer.invoke('worker:message', name, text),
    delete: (name) => ipcRenderer.invoke('worker:delete', name), // -> {ok, removed, kept, error}
  },
  provider: {
    set: (p) => ipcRenderer.invoke('provider:set', p),
  },
  master: {
    start: () => ipcRenderer.invoke('master:start'),
  },
  onNotice: (cb) => on('notice', cb), // extra: short status messages from the backend
});
