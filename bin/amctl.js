#!/usr/bin/env node
'use strict';
// amctl: control CLI used by the master agent. Runs under plain node or ELECTRON_RUN_AS_NODE.
const path = require('path');

// In the packaged app bin/ is unpacked from the asar while main/ stays inside it.
function load(name) {
  try { return require(path.join(__dirname, '..', 'main', name)); } catch (e) {
    const alt = path.join(__dirname, '..', '..', 'app.asar', 'main', name);
    try { return require(alt); } catch { throw e; }
  }
}

const ctl = load('ctl.js');
const code = ctl.main(process.argv.slice(2), {
  prepare: (cli, ctx) => load('prompts.js').prepare(cli, ctx),
});
process.exitCode = code;
