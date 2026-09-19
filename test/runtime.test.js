import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Runtime } from '../server/runtime.js';
import { EditorBridge } from '../server/editor.js';
import { liveLayout } from '../live.js';

async function fixture(t, code, command, timeoutMs) {
  const root = await mkdtemp(path.join(tmpdir(), 'six-runtime-'));
  await writeFile(path.join(root, 'test.cjs'), code);
  const runtime = new Runtime({ root, command: command || [process.execPath, '--test', '--test-reporter=tap', 'test.cjs'], timeoutMs });
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  await runtime.refresh(); return runtime;
}
function finished(runtime) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { runtime.off('snapshot', listener); reject(new Error('Run did not finish')); }, 7000);
    const listener = ({ context }) => { if (context.tests.state !== 'running') { clearTimeout(timeout); runtime.off('snapshot', listener); resolve(context.tests); } };
    runtime.on('snapshot', listener);
  });
}
test('real process pass/fail and edits invalidate prior results', async t => {
  const runtime = await fixture(t, "require('node:test')('addition', () => require('node:assert').equal(1 + 1, 2));");
  await runtime.runTests(); assert.equal((await finished(runtime)).state, 'passed');
  await writeFile(path.join(runtime.config.root, 'test.cjs'), "require('node:test')('addition', () => require('node:assert').equal(1 + 1, 3));");
  await runtime.refresh(); assert.equal(runtime.context.tests.stale, true); assert.equal(runtime.context.workflow_state, 'coding');
  await runtime.runTests(); const result = await finished(runtime);
  assert.equal(result.state, 'failed'); assert.equal(result.exit_code, 1); assert.match(result.output, /addition/); assert.equal(runtime.context.workflow_state, 'tests_failed');
});
test('launch failure is a runner error, never a failing assertion', async t => {
  const runtime = await fixture(t, '', ['/nonexistent/six-test-command']);
  await runtime.runTests(); assert.equal((await finished(runtime)).state, 'error');
});
test('cancel, timeout, and duplicate launch handling', async t => {
  const runtime = await fixture(t, 'setTimeout(() => {}, 30000);', [process.execPath, 'test.cjs'], 2000);
  await runtime.runTests(); await assert.rejects(runtime.runTests(), /already running/);
  const done = finished(runtime); runtime.stop('cancelled'); assert.equal((await done).state, 'cancelled');
  runtime.config.timeoutMs = 40; await runtime.runTests(); assert.equal((await finished(runtime)).state, 'timed_out');
});
test('edits during a run preserve running state and make its eventual result stale', async t => {
  const runtime = await fixture(t, "require('node:test')('slow', async () => new Promise(r => setTimeout(r, 300))); ");
  await runtime.runTests(); const done = finished(runtime);
  await writeFile(path.join(runtime.config.root, 'source.js'), 'export const value = 2;'); await runtime.refresh();
  assert.equal(runtime.context.workflow_state, 'tests_running');
  const result = await done; assert.equal(result.state, 'passed'); assert.equal(result.stale, true); assert.equal(runtime.context.workflow_state, 'coding');
});
test('Git reads real tracked changes and does not stage or commit', async t => {
  const runtime = await fixture(t, ''); const root = runtime.config.root;
  execFileSync('git', ['init', root]);
  execFileSync('git', ['-C', root, 'add', 'test.cjs']);
  execFileSync('git', ['-C', root, '-c', 'user.name=SIX test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
  await writeFile(path.join(root, 'test.cjs'), 'const changed = true;'); await runtime.refresh();
  assert.equal(runtime.context.git.available, true); assert.equal(runtime.context.git.changed_files, 1);
  assert.match(await runtime.git(['diff']), /const changed = true/);
  const bridge = new EditorBridge(runtime); runtime.editor = bridge;
  t.after(() => bridge.close());
  const packet = { session: 'one', root, state: { external_actions_supported: true } };
  await bridge.update(packet);
  const result = runtime.action('git_diff', runtime.context.revision);
  const { commands } = await bridge.update(packet);
  assert.equal(commands[0].action, 'editor_git_diff');
  assert.equal(commands[0].command, undefined);
  bridge.ack({ id: commands[0].id, session: 'one' });
  assert.equal((await result).body, undefined);
  assert.equal(execFileSync('git', ['-C', root, 'diff', '--cached'], { encoding: 'utf8' }), '');
  await assert.rejects(runtime.action('git_commit', runtime.context.revision), /not available/);
  await assert.rejects(runtime.action('run_tests', -1), /Context changed/);
});
test('live keys require VS Code for Codex and Git for diff', async t => {
  const runtime = await fixture(t, ''); const layout = liveLayout(runtime.context);
  assert.equal(layout[0].id, 'run_tests'); assert.equal(layout[1].disabled, true); assert.equal(layout[3].disabled, true);
  runtime.context.vscode.connected = true;
  assert.equal(liveLayout(runtime.context)[3].disabled, true);
  runtime.context.vscode.agent_terminal_supported = true;
  assert.equal(liveLayout(runtime.context)[3].label, 'Codex in Terminal');
  assert.equal(liveLayout(runtime.context, 1)[5].id, 'back');
});
