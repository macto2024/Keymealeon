import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, utimes, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Runtime } from '../server/runtime.js';
import { AgentObserver, claudeSlug } from '../server/agents.js';

const lines = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'six-agent-root-')));
  const home = await mkdtemp(path.join(os.tmpdir(), 'six-agent-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const codexDir = path.join(home, '.codex', 'sessions', '2026', '09', '19');
  const claudeDir = path.join(home, '.claude', 'projects', claudeSlug(root));
  await mkdir(codexDir, { recursive: true });
  await mkdir(claudeDir, { recursive: true });
  return { root, home, codexDir, claudeDir };
}

function observer(root, home) {
  const runtime = new Runtime({ root, command: null });
  return { runtime, agents: new AgentObserver(runtime, { home }) };
}

test('codex rollout events become workflow facts scoped to the project', async t => {
  const { root, home, codexDir } = await fixture(t);
  const file = path.join(codexDir, 'rollout-2026-09-19T10-00-00-aaaa.jsonl');
  await writeFile(file, lines([
    { timestamp: '2026-09-19T10:00:00Z', type: 'session_meta', payload: { id: 'aaaa', cwd: root } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' }, timestamp: '2026-09-19T10:00:01Z' },
    { type: 'event_msg', payload: { type: 'user_message', message: 'fix the failing profile test' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Looking at profile.js' } },
    { type: 'event_msg', payload: { type: 'exec_command_end', command: ['bash', '-lc', 'npm test'], exit_code: 1 } },
    { type: 'event_msg', payload: { type: 'patch_apply_end', success: true, changes: { [path.join(root, 'profile.js')]: { type: 'update' } } } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Fixed the status code.' } },
  ]));
  // A concurrent session in another folder must never leak into this project's keys.
  await writeFile(path.join(codexDir, 'rollout-2026-09-19T09-00-00-bbbb.jsonl'), lines([
    { type: 'session_meta', payload: { id: 'bbbb', cwd: path.join(home, 'elsewhere') } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'unrelated work' } },
  ]));

  const { runtime, agents } = observer(root, home);
  t.after(() => runtime.close());
  const fact = await agents.poll();
  assert.equal(fact.provider, 'codex');
  assert.equal(fact.state, 'idle');
  assert.equal(fact.last_user_message, 'fix the failing profile test');
  assert.equal(fact.last_agent_message, 'Fixed the status code.');
  assert.deepEqual(fact.last_command, { command: 'bash -lc npm test', exit_code: 1 });
  assert.deepEqual(fact.patched_files, ['profile.js'], 'patched files are published relative to the project');
  assert.equal(fact.turn_started_at, '2026-09-19T10:00:01Z');
  assert.equal(runtime.context.agent.provider, 'codex');
  assert.equal(runtime.context.agent.sessions.codex, 'idle');

  // Appended events are read from the stored cursor, not by re-parsing the file.
  await appendFile(file, lines([{ type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' }, timestamp: '2026-09-19T10:05:00Z' }]));
  const next = await agents.poll();
  assert.equal(next.state, 'working');
  assert.equal(next.last_user_message, 'fix the failing profile test');
});

test('claude transcripts report turn state, prompts, and edited files', async t => {
  const { root, home, claudeDir } = await fixture(t);
  const file = path.join(claudeDir, 'session-1.jsonl');
  await writeFile(file, lines([
    { type: 'user', cwd: root, isMeta: true, message: { role: 'user', content: '<local-command-caveat>ignore me</local-command-caveat>' } },
    { type: 'user', cwd: root, timestamp: '2026-09-19T11:00:00Z', message: { role: 'user', content: 'add a test for empty input' } },
    { type: 'user', cwd: root, isSidechain: true, message: { role: 'user', content: 'subagent chatter' } },
    { type: 'assistant', cwd: root, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', cwd: root, toolUseResult: { filePath: path.join(root, 'profile.test.js') }, message: { role: 'user', content: [{ type: 'tool_result' }] } },
  ]));

  const { runtime, agents } = observer(root, home);
  t.after(() => runtime.close());
  const working = await agents.poll();
  assert.equal(working.provider, 'claude');
  assert.equal(working.state, 'working');
  assert.equal(working.last_user_message, 'add a test for empty input');
  assert.deepEqual(working.last_command, { command: 'npm test', exit_code: null });
  assert.deepEqual(working.patched_files, ['profile.test.js']);

  // A text-only assistant message ends the turn.
  await appendFile(file, lines([{ type: 'assistant', cwd: root, message: { role: 'assistant', content: [{ type: 'text', text: 'Added the empty-input case.' }] } }]));
  const done = await agents.poll();
  assert.equal(done.state, 'idle');
  assert.equal(done.last_agent_message, 'Added the empty-input case.');
});

test('the most recent session wins and usage counts set the preferred agent', async t => {
  const { root, home, codexDir, claudeDir } = await fixture(t);
  const codexFile = path.join(codexDir, 'rollout-2026-09-19T08-00-00-cccc.jsonl');
  await writeFile(codexFile, lines([
    { type: 'session_meta', payload: { id: 'cccc', cwd: root } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'older codex request' } },
  ]));
  for (const name of ['a.jsonl', 'b.jsonl']) {
    await writeFile(path.join(claudeDir, name), lines([
      { type: 'user', cwd: root, message: { role: 'user', content: `newer claude request in ${name}` } },
      { type: 'assistant', cwd: root, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]));
  }
  const older = new Date(Date.now() - 120000);
  await utimes(codexFile, older, older);

  const { runtime, agents } = observer(root, home);
  t.after(() => runtime.close());
  const fact = await agents.poll();
  assert.equal(fact.provider, 'claude', 'the most recently touched transcript is the active session');
  assert.equal(fact.sessions.codex, 'working', 'other providers stay visible even when not active');
  assert.deepEqual(fact.usage, { codex: 1, claude: 2 });
  assert.equal(fact.preferred, 'claude');
});

test('no transcripts leaves the fact empty instead of guessing', async t => {
  const { root, home } = await fixture(t);
  const { runtime, agents } = observer(root, home);
  t.after(() => runtime.close());
  const fact = await agents.poll();
  assert.equal(fact.provider, null);
  assert.equal(fact.state, 'none');
  assert.equal(fact.preferred, null);
  assert.equal(fact.error, null);
});
