'use strict';
// Stand-in for `claude -p --input-format stream-json --output-format stream-json --verbose`.
// Directives in the prompt: SLEEP (never finish), FAIL (error result). FAKE_LOG=<file> logs argv + prompts.
const fs = require('fs');
const readline = require('readline');

const args = process.argv.slice(2);
const log = (o) => { if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(o) + '\n'); };
const ri = args.indexOf('--resume');
const session = ri >= 0 ? args[ri + 1] : 'sess-' + process.pid;
log({ who: 'claude', args, cwd: process.cwd() });
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const text = String(msg.message.content);
  log({ who: 'claude', prompt: text });
  emit({ type: 'system', subtype: 'init', session_id: session });
  emit({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: 'working on: ' + text.split('\n')[0] }] } });
  emit({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] } });
  if (text.includes('SLEEP')) { setInterval(() => {}, 1000); return; }
  if (text.includes('FAIL')) emit({ type: 'result', session_id: session, is_error: true, result: 'boom' });
  else emit({ type: 'result', session_id: session, is_error: false, result: 'done: ' + text.split('\n')[0] });
});
rl.on('close', () => { if (!process.argv.includes('--keep')) setTimeout(() => process.exit(0), 20); });
