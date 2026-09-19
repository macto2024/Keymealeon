import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { liveLayout } from '../live.js';
import { emptyAgentFact } from './agents.js';

const exec = promisify(execFile);
const ignored = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'coverage', 'dist', '.DS_Store']);
export async function fingerprint(root) {
  const hash = createHash('sha256');
  let count = 0;
  async function visit(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        if (++count > 10000) throw new Error('Project exceeds the 10,000-file demo watcher limit.');
        hash.update(path.relative(root, file)); hash.update(await readFile(file));
      }
    }
  }
  await visit(root); return hash.digest('hex');
}

export class Runtime extends EventEmitter {
  constructor(config) {
    super(); this.config = config; this.autoRoot = !config.root; this.child = null; this.refreshing = null;
    this.popupFocused = false; this.lastDeveloperMode = config.root ? 'project' : null;
    this.context = { live: true, revision: 0, project: config.root || null, active_app: config.root ? 'Local project' : 'Desktop', workflow_state: 'coding',
      os: { connected: false, bundle_id: null, app: 'home' }, vscode: { connected: false }, keyboard: { mode: config.root ? 'project' : 'home', page: 0, layout_revision: 1 }, sentry: { connected: false },
      git: { available: false, dirty: false, changed_files: 0 }, agent: emptyAgentFact(), tests: { state: 'idle', output: '', stale: false }, test_command_available: Boolean(config.command?.length), recent_actions: [], watcher_error: null };
    this.token = randomUUID();
  }
  publish(message) {
    const tests = this.context.tests;
    const agent = this.context.agent || {};
    const reviewable = agent.state === 'idle' && agent.patched_files?.length && this.context.git.dirty;
    this.context.workflow_state = tests.state === 'running' ? 'tests_running' : agent.state === 'working' || this.context.keyboard.mode === 'agent' ? 'codex_working' : reviewable ? 'codex_review' : tests.stale ? 'coding' : ({ passed: 'tests_passed', failed: 'tests_failed' })[tests.state] ?? 'coding';
    this.context.revision++;
    try {
      const signature = JSON.stringify(liveLayout(this.context, this.context.keyboard.page).map(key => key && [key.id, key.disabled]));
      if (signature !== this.layoutSignature) { this.layoutSignature = signature; this.context.keyboard.layout_revision++; }
    } catch { this.context.keyboard.layout_revision++; }
    this.emit('snapshot', { context: this.context, message });
  }
  async git(args) { return (await exec('git', ['-C', this.config.root, ...args], { timeout: 5000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout; }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshNow().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async refreshNow() {
    if (!this.config.root) return;
    let changed = false;
    try {
      const next = await fingerprint(this.config.root);
      if (this.hash && this.hash !== next) {
        if (this.context.tests.state !== 'idle') this.context.tests.stale = true;
        changed = true;
      }
      this.hash = next;
      if (this.context.watcher_error) changed = true;
      this.context.watcher_error = null;
    } catch (error) {
      changed = this.context.watcher_error !== error.message;
      this.context.watcher_error = error.message;
      this.context.tests.stale = true;
    }
    let git;
    try {
      const root = (await this.git(['rev-parse', '--show-toplevel'])).trim();
      if (await realpath(root) !== await realpath(this.config.root)) throw new Error('Selected folder is not a Git repository root.');
      const status = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      const files = []; const entries = status.split('\0').filter(Boolean);
      for (let i = 0; i < entries.length; i++) { files.push({ status: entries[i].slice(0, 2), path: entries[i].slice(3) }); if (/[RC]/.test(entries[i].slice(0, 2))) i++; }
      const branch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => this.git(['symbolic-ref', '--short', 'HEAD']))).trim();
      git = { available: true, branch, dirty: files.length > 0, changed_files: files.length, files };
    } catch (error) { git = { available: false, dirty: false, changed_files: 0, error: error.message.split('\n')[0] }; }
    if (JSON.stringify(git) !== JSON.stringify(this.context.git)) { this.context.git = git; changed = true; }
    if (changed) this.publish('Project files or Git status updated');
  }
  async start() { await this.refresh(); await this.agents?.poll().catch(() => {}); this.timer = setInterval(() => { this.refresh().catch(() => {}); this.agents?.poll().catch(() => {}); }, 1000); }
  setForeground(body) {
    const bundle = typeof body.bundle_id === 'string' ? body.bundle_id.slice(0, 200) : '';
    const app = ({ 'com.microsoft.VSCode': 'vscode', 'com.google.Chrome': 'chrome', 'com.openai.codex': 'codex', 'com.apple.Terminal': 'terminal' })[bundle] || 'home';
    if (this.context.os.bundle_id === bundle && this.context.os.connected) return { ok: true };
    if (this.context.keyboard.mode === 'project' || this.context.keyboard.mode === 'agent') this.lastDeveloperMode = this.context.keyboard.mode;
    this.context.os = { connected: true, bundle_id: bundle, app };
    const popupControlsEditor = app === 'chrome' && this.popupFocused && this.context.vscode.connected && this.lastDeveloperMode;
    this.context.active_app = popupControlsEditor ? 'VS Code via SIX popup' : ({ vscode: 'VS Code', chrome: 'Chrome', codex: 'Codex', terminal: 'Terminal', home: 'Desktop' })[app];
    this.context.keyboard.mode = popupControlsEditor ? this.lastDeveloperMode : app === 'vscode' ? (this.context.keyboard.mode === 'agent' ? 'agent' : 'project') : 'home';
    this.context.keyboard.page = 0; this.publish(`Active app: ${this.context.active_app}`);
    return { ok: true };
  }
  setPopupFocus(body) {
    if (typeof body.focused !== 'boolean') throw new Error('Invalid popup focus state.');
    this.popupFocused = body.focused;
    if (this.context.os.app !== 'chrome') return { ok: true };
    const mode = body.focused && this.context.vscode.connected ? this.lastDeveloperMode : null;
    const nextMode = mode || 'home';
    if (this.context.keyboard.mode !== nextMode || this.context.active_app !== (mode ? 'VS Code via SIX popup' : 'Chrome')) {
      this.context.keyboard.mode = nextMode;
      this.context.keyboard.page = 0;
      this.context.active_app = mode ? 'VS Code via SIX popup' : 'Chrome';
      this.publish(mode ? 'SIX popup controls VS Code' : 'SIX popup released Chrome');
    }
    return { ok: true };
  }
  async press(slot, revision) {
    if (revision !== this.context.keyboard.layout_revision) throw Object.assign(new Error('Keys changed. Try the current layout.'), { status: 409 });
    if (!Number.isInteger(slot) || slot < 0 || slot > 5) throw new Error('Invalid key.');
    const action = liveLayout(this.context, this.context.keyboard.page)[slot];
    if (!action || action.disabled) throw new Error(action?.description || 'Key unavailable.');
    if (action.id === 'more' || action.id === 'back') {
      this.context.keyboard.page = action.id === 'back' ? 0 : (this.context.keyboard.page + 1) % (this.context.keyboard.mode === 'agent' ? 2 : this.context.keyboard.mode === 'home' ? 2 : 3);
      this.publish(`Key ${slot + 1}: ${action.label}`); return { message: action.label };
    }
    return this.action(action.id, this.context.revision, action.params || {});
  }
  async action(id, revision, payload = {}) {
    if (revision !== this.context.revision) throw Object.assign(new Error('Context changed. Review the current keys and try again.'), { status: 409 });
    const allowed = ['app_vscode', 'app_codex', 'app_claude', 'app_chrome', 'app_terminal', 'app_finder', 'run_tests', 'tests_stop', 'test_output', 'git_diff', 'git_log', 'view_context', 'agent_launch', 'agent_back', 'voice_start', 'voice_stop', 'voice_cancel', 'voice_retry', 'voice_insert', 'voice_review', 'editor_agent_focus', 'editor_open', 'editor_diff', 'editor_problem', 'editor_terminal', 'editor_test_output', 'editor_focus', 'editor_problems'];
    if (!allowed.includes(id)) throw Object.assign(new Error('This integration is not available in live mode.'), { status: 400 });
    this.context.recent_actions = [...this.context.recent_actions, id].slice(-10);
    if (id.startsWith('voice_')) {
      if (!this.voice) throw new Error('Voice capture is unavailable.');
      if (id === 'voice_retry') { await this.voice.cancel(); return this.voice.start(); }
      return this.voice[({ voice_start: 'start', voice_stop: 'stop', voice_cancel: 'cancel', voice_insert: 'insert', voice_review: 'review' })[id]]();
    }
    const apps = { app_vscode: 'Visual Studio Code', app_codex: 'Codex', app_claude: 'Claude', app_chrome: 'Google Chrome', app_terminal: 'Terminal', app_finder: 'Finder' };
    if (apps[id]) { await exec('open', ['-a', apps[id]], { timeout: 5000 }); return { message: `Opened ${apps[id]}` }; }
    if (id === 'agent_launch') {
      if (!this.editor) throw new Error('Editor bridge unavailable.');
      if (!this.context.vscode.connected || !this.context.vscode.agent_terminal_supported) throw new Error('Reload the SIX VS Code extension to enable the agent terminal key.');
      const provider = this.context.agent?.preferred === 'claude' ? 'claude' : 'codex';
      const result = await this.editor.execute('editor_agent_launch', { provider });
      this.context.keyboard.mode = 'agent'; this.context.keyboard.provider = provider; this.context.keyboard.page = 0;
      this.publish(`${provider === 'claude' ? 'Claude' : 'Codex'} terminal opened in VS Code`);
      this.lastDeveloperMode = 'agent';
      return result;
    }
    if (id === 'agent_back') { this.context.keyboard.mode = 'project'; this.lastDeveloperMode = 'project'; this.context.keyboard.page = 0; this.publish('Project keys restored'); return { message: 'Project keys restored' }; }
    if (id.startsWith('editor_')) {
      if (!this.editor) throw new Error('Editor bridge unavailable.');
      return this.editor.execute(id, payload);
    }
    if (id === 'run_tests') {
      if (!this.editor || !this.context.vscode.connected) throw new Error('Connect the SIX VS Code extension to show test output there.');
      const result = await this.runTests();
      if (this.editor && this.context.vscode.connected) {
        try { await this.editor.execute('editor_test_output'); }
        catch (error) { this.publish(`Tests started; VS Code output unavailable: ${error.message}`); return { ...result, message: 'Tests started; inspect browser Output because the editor display was unavailable.' }; }
      }
      return result;
    }
    if (id === 'tests_stop') {
      if (!this.child) throw new Error('No test run is active.');
      this.stop('cancelled'); return { message: 'Cancellation requested' };
    }
    if (['test_output', 'view_context', 'git_diff', 'git_log'].includes(id) && (!this.editor || !this.context.vscode.connected)) throw new Error('Connect the SIX VS Code extension to show results there.');
    if (id === 'test_output') return this.editor.execute('editor_test_output');
    if (id === 'view_context') {
      if (!this.context.vscode.external_actions_supported) throw new Error('Reload the SIX VS Code extension to open context there.');
      return this.editor.execute('editor_context');
    }
    if (!this.context.git.available) throw new Error('Git is unavailable for the selected project.');
    if (!this.context.vscode.external_actions_supported) throw new Error('Reload the SIX VS Code extension to run Git there.');
    return this.editor.execute(id === 'git_log' ? 'editor_git_log' : 'editor_git_diff');
  }
  async runTests() {
    if (!this.config.root || !this.config.command?.length) throw new Error('No test command configured for this project.');
    if (this.context.vscode.connected && this.context.vscode.unsaved_files) throw new Error('Save your VS Code files before running tests. Tests run against files on disk.');
    if (this.child || this.starting) throw Object.assign(new Error('Tests are already running.'), { status: 409 });
    this.starting = true;
    try {
      await this.refresh();
      if (this.context.watcher_error) throw new Error(this.context.watcher_error);
      const startHash = this.hash;
      const runId = randomUUID();
      this.context.tests = { state: 'running', run_id: runId, output: '', stale: false, started_at: new Date().toISOString(), exit_code: null };
      this.publish(`Test run started: ${runId}`);
      const env = { ...process.env, FORCE_COLOR: '0' };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(this.config.command[0], this.config.command.slice(1), { cwd: this.config.root, shell: false, detached: process.platform !== 'win32', env });
      this.child = child; this.stopReason = null;
      const append = chunk => { if (this.context.tests.run_id !== runId) return; this.context.tests.output = (this.context.tests.output + chunk.toString()).slice(-100000); this.publish(); };
      child.stdout.on('data', append); child.stderr.on('data', append);
      let launchError;
      child.on('error', error => { launchError = error; append(`Runner error: ${error.message}\n`); });
      const timeout = setTimeout(() => this.stop('timed_out'), this.config.timeoutMs ?? 60000);
      child.on('close', async code => {
        clearTimeout(timeout); clearTimeout(this.killTimer);
        await this.refresh();
        if (this.context.tests.run_id !== runId) return;
        const t = this.context.tests;
        t.stale ||= startHash !== this.hash || Boolean(this.context.watcher_error);
        t.exit_code = code; t.finished_at = new Date().toISOString();
        // TAP failure totals identify failed tests; other nonzero exits are runner errors.
        t.state = this.stopReason || (launchError ? 'error' : code === 0 ? 'passed' : /^# fail [1-9]\d*\s*$/m.test(t.output) ? 'failed' : 'error');
        this.child = null; this.publish(`Tests ${t.state}${t.stale ? ' — source changed; rerun required' : ''}`);
      });
      return { message: 'Tests started', run_id: runId };
    } finally { this.starting = false; }
  }
  stop(reason) {
    if (!this.child) return;
    this.stopReason = reason;
    const child = this.child;
    const kill = signal => { try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); } catch {} };
    kill('SIGTERM'); this.killTimer = setTimeout(() => kill('SIGKILL'), 1000);
  }
  close() { clearInterval(this.timer); this.stop('cancelled'); }
}
