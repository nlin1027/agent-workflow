'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { claudeParser, codexParser, makeParser, providerBin } = require('../main/agents');

test('claude: assistant text + tool_use become lines', () => {
  const p = claudeParser();
  const r = p({ type: 'assistant', session_id: 's1', message: { content: [
    { type: 'text', text: 'line a\nline b' },
    { type: 'tool_use', name: 'Bash', input: { command: 'npm   test' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: 'src/x.js' } },
    { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
  ] } });
  assert.deepEqual(r.lines, ['line a', 'line b', '▸ Bash npm test', '▸ Edit src/x.js', '▸ Grep foo']);
  assert.equal(r.sessionId, 's1');
  assert.equal(r.final, undefined);
});

test('claude: result success / error', () => {
  const p = claudeParser();
  assert.deepEqual(p({ type: 'result', is_error: false, result: 'all good' }),
    { lines: ['✔ finished'], final: 'done', result: 'all good' });
  const e = p({ type: 'result', is_error: true, result: 'bad' });
  assert.equal(e.final, 'failed');
  assert.match(e.lines[0], /^✖ error: bad/);
});

test('claude: unknown events and odd content are ignored', () => {
  const p = claudeParser();
  assert.deepEqual(p({ type: 'system', subtype: 'init', session_id: 'x' }).lines, []);
  assert.deepEqual(p({ type: 'assistant', message: { content: 'plain string' } }).lines, []);
  assert.deepEqual(p({ type: 'assistant' }).lines, []);
});

test('codex: item events', () => {
  const p = codexParser();
  assert.equal(p({ type: 'thread.started', thread_id: 't9' }).sessionId, 't9');
  assert.deepEqual(p({ type: 'item.started', item: { id: '1', type: 'command_execution', command: 'ls  -la' } }).lines, ['▸ ls -la']);
  // completion of an already-announced command adds nothing unless it failed
  assert.deepEqual(p({ type: 'item.completed', item: { id: '1', type: 'command_execution', command: 'ls -la', exit_code: 0 } }).lines, []);
  assert.deepEqual(p({ type: 'item.completed', item: { id: '1', type: 'command_execution', command: 'ls -la', exit_code: 2 } }).lines, ['  ✖ exit 2']);
  // never announced -> shown on completion
  assert.deepEqual(p({ type: 'item.completed', item: { id: '5', type: 'command_execution', command: 'pwd', exit_code: 0 } }).lines, ['▸ pwd']);
  const m = p({ type: 'item.completed', item: { id: '2', type: 'agent_message', text: 'hello\nworld' } });
  assert.deepEqual(m.lines, ['hello', 'world']);
  assert.equal(m.result, 'hello\nworld');
  assert.deepEqual(p({ type: 'item.completed', item: { id: '3', type: 'file_change', changes: [{ path: 'a.js', kind: 'update' }, { path: 'b.js', kind: 'add' }] } }).lines,
    ['▸ update a.js', '▸ add b.js']);
  assert.match(p({ type: 'item.completed', item: { id: '4', type: 'reasoning', text: 'thinking hard' } }).lines[0], /thinking hard/);
});

test('codex: turn / error events', () => {
  const p = codexParser();
  assert.deepEqual(p({ type: 'turn.completed', usage: {} }), { lines: ['✔ finished'], final: 'done' });
  const f = p({ type: 'turn.failed', error: { message: 'nope' } });
  assert.equal(f.final, 'failed');
  assert.equal(f.lines[0], '✖ error: nope');
  const e = p({ type: 'error', message: 'stream broke' });
  assert.equal(e.final, undefined);
  assert.equal(e.lines[0], '✖ error: stream broke');
});

test('codex: legacy msg-shaped events', () => {
  const p = codexParser();
  assert.deepEqual(p({ id: '0', msg: { type: 'agent_message', message: 'hi' } }).lines, ['hi']);
  const t = p({ id: '1', msg: { type: 'task_complete', last_agent_message: 'bye' } });
  assert.equal(t.final, 'done');
  assert.equal(t.result, 'bye');
});

test('makeParser picks by provider; providerBin honours overrides and env', () => {
  assert.equal(typeof makeParser('codex'), 'function');
  assert.deepEqual(providerBin('claude', {}, { claude: ['x', 'y'] }), ['x', 'y']);
  assert.deepEqual(providerBin('codex', { AM_CODEX_BIN: '["node","c.js"]' }), ['node', 'c.js']);
  assert.deepEqual(providerBin('claude', { AM_CLAUDE_BIN: 'C:/c.exe' }), ['C:/c.exe']);
});
