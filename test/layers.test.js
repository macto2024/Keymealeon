import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Runtime } from '../server/runtime.js';
import { EditorBridge } from '../server/editor.js';
import { liveLayout, resolveLayer } from '../live.js';

async function setup(t, agent = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'six-layer-'));
  await writeFile(path.join(root, 'profile.js'), 'export const ok = 1;\n');
  const runtime = new Runtime({ root, command: [process.execPath, '-e', ''] });
  const bridge = new EditorBridge(runtime); runtime.editor = bridge;
  t.after(async () => { bridge.close(); runtime.close(); await rm(root, { recursive: true, force: true }); });
  const packet = { root, session: 'one', state: { active_file: 'profile.js', language: 'javascript', diagnostics: [], agent_terminal_supported: true, external_actions_supported: true } };
  await bridge.update(packet);
  runtime.context.git = { available: true, branch: 'main', dirty: true, changed_files: 1, files: [{ status: ' M', path: 'profile.js' }] };
  runtime.context.agent = { ...runtime.context.agent, ...agent };
  runtime.publish('fixture facts applied'); // every real fact update ends in a publish
  return { root, runtime, bridge, packet };
}

const ids = layout => layout.map(key => key?.id ?? null);

test('a working agent takes the keys and names the request it is working on', async t => {
  const { runtime } = await setup(t, { provider: 'codex', state: 'working', last_user_message: 'fix the failing profile test', patched_files: [] });
  const layer = resolveLayer(runtime.context);
  assert.equal(layer.id, 'agent_working');
  assert.match(layer.reason, /Codex is working on: fix the failing profile test/);
  assert.deepEqual(ids(liveLayout(runtime.context)), ['editor_focus', 'git_diff', 'editor_problems', 'test_output', 'more', 'view_context']);
  // Once SIX owns the terminal the agent runs in, the watch key targets that terminal.
  runtime.context.vscode.agent_terminal_open = true;
  assert.equal(liveLayout(runtime.context)[0].id, 'editor_agent_focus');
});

test('a finished agent with edits offers review keys aimed at the file it changed', async t => {
  const { runtime } = await setup(t, { provider: 'claude', state: 'idle', patched_files: ['profile.js'], last_agent_message: 'Fixed the status code.' });
  const layer = resolveLayer(runtime.context);
  assert.equal(layer.id, 'agent_review');
  assert.match(layer.reason, /Claude finished and changed 1 file$/);
  const layout = liveLayout(runtime.context);
  assert.deepEqual(ids(layout), ['editor_diff', 'run_tests', 'git_diff', 'editor_problems', 'more', 'view_context']);
  assert.deepEqual(layout[0].params, { file: 'profile.js' });
  assert.equal(layout[0].description, 'Compare profile.js with Git HEAD in VS Code');
  assert.equal(runtime.context.workflow_state, 'codex_review');

  // The review key works on the agent's file even when no editor tab is open.
  runtime.context.vscode.active_file = null;
  assert.equal(liveLayout(runtime.context)[0].disabled, false);
});

test('pressing the review key sends the agent-patched file to VS Code', async t => {
  const { runtime, bridge, packet } = await setup(t, { provider: 'codex', state: 'idle', patched_files: ['profile.js'] });
  const press = runtime.press(0, runtime.context.keyboard.layout_revision);
  const { commands } = await bridge.update(packet);
  assert.equal(commands[0].action, 'editor_diff');
  assert.equal(commands[0].file, 'profile.js', 'the layout parameter reaches the editor, not the active tab');
  bridge.ack({ session: 'one', id: commands[0].id });
  await press;
});

test('an explicit test run outranks agent activity', async t => {
  const { runtime } = await setup(t, { provider: 'codex', state: 'working', patched_files: ['profile.js'] });
  runtime.context.tests = { state: 'running', output: '', stale: false };
  assert.equal(resolveLayer(runtime.context).id, 'tests_running');
  assert.equal(liveLayout(runtime.context)[1].id, 'tests_stop', 'Stop must stay reachable while a process runs');

  // A stale result never outranks an agent that is still working.
  runtime.context.tests = { state: 'failed', output: '', stale: true, exit_code: 1 };
  assert.equal(resolveLayer(runtime.context).id, 'agent_working');
});

test('the launch key and home keys follow the agent this developer actually uses', async t => {
  const { runtime } = await setup(t, { preferred: 'claude', usage: { codex: 1, claude: 6 }, state: 'none' });
  const launch = liveLayout(runtime.context)[3];
  assert.equal(launch.id, 'agent_launch');
  assert.equal(launch.label, 'Claude in Terminal');

  runtime.context.keyboard.mode = 'home';
  assert.equal(liveLayout(runtime.context)[1].id, 'app_claude');
  runtime.context.agent.preferred = 'codex';
  assert.equal(liveLayout(runtime.context)[1].id, 'app_codex');
});

test('agent facts never enable keys whose integration is missing', async t => {
  const { runtime } = await setup(t, { provider: 'codex', state: 'idle', patched_files: ['profile.js'] });
  runtime.context.vscode = { connected: false };
  for (const key of liveLayout(runtime.context)) {
    if (!key || ['more', 'back'].includes(key.id)) continue;
    assert.equal(key.disabled, true, `${key.id} must be disabled without the editor bridge`);
    assert.match(key.description, /Connect the SIX VS Code extension/);
  }
});

test('a key press survives unrelated context churn but not a real layer change', async t => {
  const { runtime } = await setup(t, { provider: 'codex', state: 'working', last_user_message: 'fix the profile test' });
  const stamp = runtime.context.keyboard.layout_revision;
  const revision = runtime.context.revision;

  // The agent keeps reporting progress every second. The keys on screen do not move.
  runtime.context.agent = { ...runtime.context.agent, last_agent_message: 'still working…', idle_seconds: 2 };
  runtime.publish('agent progress');
  assert.ok(runtime.context.revision > revision, 'context revision advances');
  assert.equal(runtime.context.keyboard.layout_revision, stamp, 'a press aimed at these keys stays valid');

  // The agent finishes with edits: the layer really changes, so the stale press is refused.
  runtime.context.agent = { ...runtime.context.agent, state: 'idle', patched_files: ['profile.js'] };
  runtime.publish('agent finished');
  assert.notEqual(runtime.context.keyboard.layout_revision, stamp);
  await assert.rejects(runtime.press(0, stamp), /Keys changed/);
});
