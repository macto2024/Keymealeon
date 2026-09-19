import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Runtime } from '../server/runtime.js';
import { VoiceManager } from '../server/voice.js';
import { liveLayout } from '../live.js';

async function waitFor(check) {
  const until = Date.now() + 5000;
  while (!check()) { if (Date.now() > until) throw new Error('Voice state did not change'); await new Promise(resolve => setTimeout(resolve, 25)); }
}

test('voice keys follow real record, transcribe, review, insert and cancel states', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'six-voice-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const recorder = path.join(dir, 'recorder.cjs');
  const transcriber = path.join(dir, 'transcriber.cjs');
  await writeFile(recorder, `#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(process.argv.at(-1),Buffer.alloc(2000));process.stdin.on('data',data=>{if(data.includes('q'))process.exit(0)});`);
  await writeFile(transcriber, `#!/usr/bin/env node\nconst fs=require('fs'),path=require('path');const d=process.argv[process.argv.indexOf('--output_dir')+1];fs.writeFileSync(path.join(d,'voice.txt'),'Please fix the failing test.');`);
  await chmod(recorder, 0o755); await chmod(transcriber, 0o755);
  const runtime = new Runtime({ root: dir, command: null });
  runtime.context.keyboard.mode = 'agent';
  runtime.context.vscode = { connected: true, agent_terminal_open: true, voice_supported: true };
  const commands = [];
  runtime.editor = { execute: async (action, payload) => { commands.push({ action, payload }); return { message: 'VS Code completed the action' }; } };
  const voice = new VoiceManager(runtime, { ffmpeg: recorder, whisper: transcriber });
  t.after(() => { voice.close(); runtime.close(); });
  assert.equal(liveLayout(runtime.context)[3].id, 'voice_start');
  await runtime.action('voice_start', runtime.context.revision);
  assert.equal(liveLayout(runtime.context)[0].id, 'voice_starting');
  await waitFor(() => runtime.context.voice.state === 'recording');
  assert.deepEqual(liveLayout(runtime.context).slice(0, 2).map(key => key.id), ['voice_stop', 'voice_cancel']);
  await runtime.action('voice_stop', runtime.context.revision);
  assert.equal(runtime.context.voice.state, 'ready');
  assert.equal(liveLayout(runtime.context)[0].id, 'voice_insert');
  await runtime.action('voice_review', runtime.context.revision);
  assert.equal(commands[0].action, 'editor_voice_review');
  await runtime.action('voice_insert', runtime.context.revision);
  assert.deepEqual(commands[1], { action: 'editor_agent_insert', payload: { text: 'Please fix the failing test.' } });
  assert.equal(runtime.context.voice.state, 'idle');
  await runtime.action('voice_start', runtime.context.revision);
  await runtime.action('voice_cancel', runtime.context.revision);
  assert.equal(runtime.context.voice.state, 'idle');
});
