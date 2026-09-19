import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Runtime } from '../server/runtime.js';
import { EditorBridge, relativeFile } from '../server/editor.js';
import { liveLayout } from '../live.js';
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'six-editor-'));
  await writeFile(path.join(root, 'main.js'), 'const x = 1;');
  const runtime = new Runtime({ root, command: [process.execPath, '-e', ''] });
  const bridge = new EditorBridge(runtime); runtime.editor = bridge;
  t.after(async () => { bridge.close(); runtime.close(); await rm(root, { recursive: true, force: true }); });
  const packet = { root, session: 'one', state: { active_file: 'main.js', language: 'javascript', diagnostics: [] } };
  return { root, runtime, bridge, packet };
}
test('editor heartbeat preserves active tests, drops invalid paths, expires connection', async t => {
  const { runtime, bridge, packet } = await setup(t);
  runtime.context.tests.state = 'running';
  await bridge.update({ ...packet, state: { ...packet.state, diagnostics: [{ file: '../secret', message: 'bad' }], has_selection: true, selection_lines: 3 } });
  assert.equal(runtime.context.workflow_state, 'tests_running'); assert.equal(runtime.context.vscode.diagnostics.length, 0); assert.equal(runtime.context.vscode.has_selection, true);
  const revision = runtime.context.revision;
  await bridge.update({ ...packet, state: { ...packet.state, diagnostics: [], has_selection: true, selection_lines: 3 } });
  assert.equal(runtime.context.revision, revision);
  bridge.lastSeen = 0; bridge.expire(); assert.equal(runtime.context.vscode.connected, false);
});
test('workspace mismatch and second window rejected', async t => {
  const { bridge, packet } = await setup(t);
  await assert.rejects(bridge.update({ ...packet, root: os.tmpdir() }), /workspace must match/);
  await bridge.update(packet); await assert.rejects(bridge.update({ ...packet, session: 'two' }), /Another VS Code/);
});
test('command is delivered once and waits for matching acknowledgment', async t => {
  const { bridge, packet } = await setup(t); await bridge.update(packet);
  const result = bridge.execute('editor_open');
  // Resolve filesystem validation before polling the command queue.
  while (!bridge.pending.size) await new Promise(resolve => setTimeout(resolve, 5));
  const { commands } = await bridge.update(packet); assert.equal(commands.length, 1);
  assert.equal((await bridge.update(packet)).commands.length, 0);
  assert.throws(() => bridge.ack({ id: commands[0].id, session: 'wrong' }), /Unknown/);
  bridge.ack({ id: commands[0].id, session: 'one' }); assert.match((await result).message, /completed/);
});
test('unsaved files block tests and symlink escapes block editor actions', async t => {
  const { root, runtime, bridge, packet } = await setup(t);
  await bridge.update({ ...packet, state: { ...packet.state, unsaved_files: 1 } });
  assert.equal(liveLayout(runtime.context)[0].disabled, true); await assert.rejects(runtime.runTests(), /Save your VS Code/);
  await symlink(os.tmpdir(), path.join(root, 'outside'));
  await bridge.update({ ...packet, state: { active_file: 'outside' } });
  await assert.rejects(bridge.execute('editor_open'), /outside/);
  assert.equal(relativeFile('../private'), null); assert.equal(relativeFile('.git/config'), null); assert.equal(relativeFile('/tmp/file'), null);
});

test('terminal and editor navigation work without an active file and carry no shell input', async t => {
  const { bridge, packet } = await setup(t);
  const empty = { ...packet, state: { active_file: null } };
  await bridge.update(empty);
  for (const action of ['editor_terminal', 'editor_test_output', 'editor_focus', 'editor_problems', 'editor_agent_launch', 'editor_agent_focus', 'editor_git_diff', 'editor_git_log', 'editor_context']) {
    const result = bridge.execute(action);
    const { commands, tests, test_command } = await bridge.update(empty);
    assert.equal(commands.length, 1); assert.equal(commands[0].action, action);
    assert.equal(commands[0].file, undefined); assert.equal(commands[0].command, undefined);
    assert.equal(tests.state, 'idle'); assert.ok(Array.isArray(test_command));
    bridge.ack({ id: commands[0].id, session: 'one' }); await result;
  }
});
test('live output and context keys complete in VS Code without monitor content', async t => {
  const { runtime, bridge, packet } = await setup(t);
  const capable = { ...packet, state: { ...packet.state, external_actions_supported: true } };
  await bridge.update(capable);
  for (const [key, expected] of [['test_output', 'editor_test_output'], ['view_context', 'editor_context']]) {
    const result = runtime.action(key, runtime.context.revision);
    const { commands } = await bridge.update(capable);
    assert.equal(commands[0].action, expected);
    bridge.ack({ id: commands[0].id, session: 'one' });
    assert.equal((await result).body, undefined);
  }
});
test('Codex launch switches six keys only after VS Code acknowledges opening its terminal', async t => {
  const { runtime, bridge, packet } = await setup(t); await bridge.update(packet);
  await assert.rejects(runtime.action('agent_launch', runtime.context.revision), /Reload the SIX/);
  const capable = { ...packet, state: { ...packet.state, agent_terminal_supported: true } };
  await bridge.update(capable);
  const action = runtime.action('agent_launch', runtime.context.revision);
  const { commands } = await bridge.update(capable);
  assert.equal(commands[0].action, 'editor_agent_launch');
  assert.equal(runtime.context.keyboard.mode, 'project');
  bridge.ack({ session: 'one', id: commands[0].id }); await action;
  assert.equal(runtime.context.keyboard.mode, 'agent');
  assert.deepEqual(liveLayout(runtime.context).map(item => item.id), ['editor_agent_focus', 'run_tests', 'editor_problems', 'voice_start', 'more', 'agent_back']);
  assert.equal(liveLayout(runtime.context, 1)[0].id, 'editor_open');
  await bridge.update({ ...capable, state: { ...capable.state, agent_terminal_open: true } });
  assert.equal(runtime.context.keyboard.mode, 'agent');
  await bridge.update(capable);
  assert.equal(runtime.context.keyboard.mode, 'project');
  const again = runtime.action('agent_launch', runtime.context.revision);
  const command = await bridge.update(capable);
  bridge.ack({ session: 'one', id: command.commands[0].id }); await again;
  await runtime.action('agent_back', runtime.context.revision);
  assert.equal(runtime.context.keyboard.mode, 'project');
  const failed = runtime.action('agent_launch', runtime.context.revision);
  const next = await bridge.update(capable);
  bridge.ack({ session: 'one', id: next.commands[0].id, error: 'Codex terminal unavailable' });
  await assert.rejects(failed, /unavailable/);
  assert.equal(runtime.context.keyboard.mode, 'project');
});
