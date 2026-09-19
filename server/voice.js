import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_TEXT = 4000;

export class VoiceManager {
  constructor(runtime, { ffmpeg, whisper, model = 'base', language = 'en' }) {
    this.runtime = runtime;
    this.ffmpeg = ffmpeg;
    this.whisper = whisper;
    this.model = model;
    this.language = language;
    this.generation = 0;
    this.available = Boolean(ffmpeg && whisper && existsSync(ffmpeg) && existsSync(whisper));
    runtime.voice = this;
    runtime.context.voice = { state: 'idle', available: this.available, transcript: null, error: null };
  }
  publish(state, extra = {}) {
    this.runtime.context.voice = { ...this.runtime.context.voice, state, ...extra };
    this.runtime.publish(`Voice: ${state}`);
  }
  async start() {
    if (!this.available) throw new Error('Local microphone transcription tools are unavailable.');
    if (!this.runtime.context.vscode.connected || !this.runtime.context.vscode.agent_terminal_open) throw new Error('Open the Codex terminal in VS Code first.');
    if (!this.runtime.context.vscode.voice_supported) throw new Error('Reload the SIX VS Code extension to enable voice input.');
    if (['starting', 'recording', 'transcribing'].includes(this.runtime.context.voice.state)) throw new Error('Voice capture is already active.');
    const generation = ++this.generation;
    this.dir = await mkdtemp(path.join(os.tmpdir(), 'six-voice-'));
    this.file = path.join(this.dir, 'voice.wav');
    this.publish('starting', { transcript: null, error: null });
    const child = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-i', ':default', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', this.file], { stdio: ['pipe', 'ignore', 'pipe'] });
    this.recorder = child;
    let errors = '';
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    child.on('error', error => { if (generation === this.generation) this.fail(`Microphone could not start: ${error.message}`); });
    child.on('close', code => {
      if (generation !== this.generation || !['starting', 'recording'].includes(this.runtime.context.voice.state)) return;
      this.fail(`Microphone stopped unexpectedly${errors ? `: ${errors.trim().slice(-600)}` : ` (exit ${code})`}.`);
    });
    const startedAt = Date.now();
    this.pollTimer = setInterval(async () => {
      if (generation !== this.generation) return;
      try {
        if ((await stat(this.file)).size > 44) {
          clearInterval(this.pollTimer); this.pollTimer = null;
          this.publish('recording');
        }
      } catch {}
      if (Date.now() - startedAt > 60000 && generation === this.generation) this.fail('Microphone did not begin recording. Check macOS Microphone permission.');
    }, 250);
    return { message: 'Starting microphone' };
  }
  async stop() {
    if (this.runtime.context.voice.state !== 'recording' || !this.recorder) throw new Error('No microphone recording is active.');
    const generation = this.generation;
    this.publish('transcribing');
    const child = this.recorder;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.stdin.write('q');
    child.stdin.end();
    const force = setTimeout(() => child.kill('SIGINT'), 3000);
    await closed; clearTimeout(force);
    if (generation !== this.generation) return { message: 'Recording cancelled' };
    try {
      if ((await stat(this.file)).size < 1000) throw new Error('Recording was too short or silent.');
      await this.transcribe(generation);
      return { message: 'Transcription complete' };
    } catch (error) {
      if (generation === this.generation) this.fail(`Transcription failed: ${error.message}`);
      throw error;
    }
  }
  async transcribe(generation) {
    const child = spawn(this.whisper, [this.file, '--model', this.model, '--language', this.language, '--output_format', 'txt', '--output_dir', this.dir, '--verbose', 'False', '--fp16', 'False'], { stdio: ['ignore', 'ignore', 'pipe'] });
    this.transcriber = child;
    let errors = '';
    const result = await new Promise((resolve, reject) => {
      child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error(errors.trim().slice(-600) || `Whisper exited ${code}`)));
      this.transcribeTimeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Whisper timed out.')); }, 180000);
    }).finally(() => clearTimeout(this.transcribeTimeout));
    if (generation !== this.generation) return result;
    const transcript = (await readFile(path.join(this.dir, 'voice.txt'), 'utf8')).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!transcript) throw new Error('No speech was detected.');
    this.publish('ready', { transcript, error: null });
    await this.cleanupFiles();
  }
  async insert() {
    if (this.runtime.context.voice.state !== 'ready') throw new Error('No transcript is ready.');
    const text = this.runtime.context.voice.transcript;
    await this.runtime.editor.execute('editor_agent_insert', { text });
    this.publish('idle', { transcript: null, error: null });
    return { message: 'Transcript inserted into Codex terminal; review it and press Enter there.' };
  }
  async review() {
    if (this.runtime.context.voice.state !== 'ready') throw new Error('No transcript is ready.');
    return this.runtime.editor.execute('editor_voice_review', { text: this.runtime.context.voice.transcript });
  }
  async cancel() {
    ++this.generation;
    clearInterval(this.pollTimer); clearTimeout(this.transcribeTimeout);
    this.recorder?.kill('SIGTERM'); this.transcriber?.kill('SIGTERM');
    this.recorder = null; this.transcriber = null;
    await this.cleanupFiles();
    this.publish('idle', { transcript: null, error: null });
    return { message: 'Voice capture cancelled' };
  }
  async cleanupFiles() {
    const dir = this.dir; this.dir = null;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  fail(message) {
    ++this.generation;
    clearInterval(this.pollTimer); clearTimeout(this.transcribeTimeout);
    this.recorder?.kill('SIGTERM'); this.transcriber?.kill('SIGTERM');
    this.recorder = null; this.transcriber = null;
    this.cleanupFiles();
    this.publish('error', { transcript: null, error: message });
  }
  close() { ++this.generation; clearInterval(this.pollTimer); clearTimeout(this.transcribeTimeout); this.recorder?.kill('SIGTERM'); this.transcriber?.kill('SIGTERM'); this.cleanupFiles(); }
}
