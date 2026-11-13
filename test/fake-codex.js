'use strict';
// Stand-in for `codex exec --json --full-auto [resume ID] -` (prompt on stdin).
// Directives: SLEEP (never finish), FAIL (turn.failed). FAKE_LOG=<file> logs argv + prompt.
const fs = require('fs');

const args = process.argv.slice(2);
const log = (o) => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n'); };
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const ri = args.indexOf('resume');
const thread = ri >= 0 ? args[ri + 1] : 'thr-' + process.pid;
log({ who: 'codex', args, cwd: process.cwd() });

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  log({ who: 'codex', prompt: input });
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'turn.started' });
  emit({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'echo hi', status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'echo hi', exit_code: 0, status: 'completed' } });
  if (input.includes('SLEEP')) { setInterval(() => {}, 1000); return; }
  if (input.includes('FAIL')) { emit({ type: 'turn.failed', error: { message: 'boom' } }); process.exit(1); }
  emit({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'codex done: ' + input.split('\n')[0] } });
  emit({ type: 'turn.completed', usage: {} });
});
