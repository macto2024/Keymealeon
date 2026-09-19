import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.length > 2000 || value.includes('\0') || value.includes('\\') || path.isAbsolute(value) || value.split('/').some(part => part === '..' || part === '.git')) return null;
  return value;
}
export class EditorBridge {
  constructor(runtime) { this.runtime = runtime; this.pending = new Map(); this.session = null; this.lastSeen = 0; this.timer = setInterval(() => this.expire(), 1000); }
  expire() {
    if (this.session && Date.now() - this.lastSeen > 6000) { this.session = null; this.runtime.context.vscode = { ...this.runtime.context.vscode, connected: false }; if (!this.runtime.context.os.connected) this.runtime.context.active_app = 'Desktop'; this.runtime.context.keyboard.mode = this.runtime.context.os.app === 'vscode' ? 'project' : 'home'; this.runtime.context.keyboard.page = 0; this.runtime.publish('VS Code disconnected'); }
    for (const [id, item] of this.pending) if (Date.now() - item.created > 10000) { item.reject(new Error('VS Code command timed out. Reconnect and try again.')); this.pending.delete(id); }
  }
  async update(body) {
    if (typeof body.session !== 'string' || body.session.length > 100) throw new Error('Invalid editor session.');
    const workspaceRoot = await realpath(body.root);
    const currentRoot = this.runtime.config.root ? await realpath(this.runtime.config.root) : null;
    if (!currentRoot && this.runtime.config.requireForeground && (this.runtime.context.os.app !== 'vscode' || !body.state?.focused)) throw new Error('Focus a VS Code project window to select it.');
    if (currentRoot && workspaceRoot !== currentRoot && !this.runtime.autoRoot) throw new Error('VS Code workspace must match the configured project root.');
    if (this.session && this.session !== body.session && Date.now() - this.lastSeen < 6000) {
      if (!(this.runtime.autoRoot && body.state?.focused && !this.runtime.context.vscode.focused)) throw new Error('Another VS Code window is connected. Focus the new window or disconnect the old one.');
      for (const item of this.pending.values()) item.reject(new Error('Active VS Code window changed.'));
      this.pending.clear();
    }
    this.session = body.session; this.lastSeen = Date.now();
    if (currentRoot !== workspaceRoot) {
      this.runtime.config.root = workspaceRoot; this.runtime.context.project = workspaceRoot; this.runtime.hash = null;
      this.runtime.context.tests = { state: 'idle', output: '', stale: false };
      await this.runtime.refresh(); this.runtime.publish('VS Code project selected');
    }
    const state = body.state || {};
    const diagnostics = (Array.isArray(state.diagnostics) ? state.diagnostics : []).slice(0, 50).filter(d => relativeFile(d.file)).map(d => ({ file: d.file, line: Math.max(1, Math.min(1000000, Number(d.line) || 1)), message: String(d.message).slice(0, 500), severity: Math.max(0, Math.min(3, Number(d.severity) || 0)) }));
    const normalized = { connected: true, focused: Boolean(state.focused), active_file: relativeFile(state.active_file), language: String(state.language || '').slice(0, 100), unsaved_files: Math.max(0, Math.min(10000, Number(state.unsaved_files) || 0)), has_selection: Boolean(state.has_selection), selection_lines: Math.max(0, Math.min(1000000, Number(state.selection_lines) || 0)), agent_terminal_supported: Boolean(state.agent_terminal_supported), external_actions_supported: Boolean(state.external_actions_supported), voice_supported: Boolean(state.voice_supported), agent_terminal_open: Boolean(state.agent_terminal_open), diagnostics, has_diagnostics: diagnostics.length > 0 };
    if (this.runtime.context.keyboard.mode === 'agent' && !normalized.agent_terminal_open) this.runtime.context.keyboard.mode = 'project';
    if (JSON.stringify(normalized) !== JSON.stringify(this.runtime.context.vscode)) { this.runtime.context.vscode = normalized; if (!this.runtime.context.os.connected) { this.runtime.context.active_app = 'VS Code'; if (this.runtime.context.keyboard.mode === 'home') this.runtime.context.keyboard.mode = 'project'; } this.runtime.publish('VS Code editor context updated'); }
    const commands = [];
    for (const item of this.pending.values()) if (!item.delivered && item.session === this.session) { item.delivered = true; commands.push(item.command); }
    return { commands, tests: this.runtime.context.tests, test_command: this.runtime.config.command, codex_model: this.runtime.config.codexModel || null };
  }
  ack(body) {
    const item = this.pending.get(body.id);
    if (!item || item.session !== body.session) throw new Error('Unknown editor operation.');
    this.pending.delete(body.id);
    if (body.error) item.reject(new Error(String(body.error).slice(0, 1000)));
    else item.resolve({ message: 'VS Code completed the action' });
    return { ok: true };
  }
  async execute(action, payload = {}) {
    this.expire();
    if (!this.session) throw new Error('Connect the SIX VS Code extension first.');
    if (['editor_agent_insert', 'editor_voice_review'].includes(action)) {
      if (typeof payload.text !== 'string' || !payload.text || payload.text.length > 4000 || /[\r\n\x00-\x1f\x7f]/.test(payload.text)) throw new Error('Invalid transcript.');
      return this.enqueue({ action, text: payload.text });
    }
    if (['editor_terminal', 'editor_test_output', 'editor_focus', 'editor_problems', 'editor_git_diff', 'editor_git_log', 'editor_context'].includes(action)) return this.enqueue({ action });
    if (action === 'editor_agent_launch' || action === 'editor_agent_focus') return this.enqueue({ action, provider: payload.provider === 'claude' ? 'claude' : 'codex' });
    const editor = this.runtime.context.vscode;
    const diagnostic = editor.diagnostics?.find(d => d.severity === 0) || editor.diagnostics?.[0];
    const file = action === 'editor_problem' ? diagnostic?.file : (relativeFile(payload.file) || editor.active_file);
    if (!file) throw new Error(action === 'editor_problem' ? 'No editor diagnostics are available.' : 'Open a project file in VS Code first.');
    const root = await realpath(this.runtime.config.root);
    const resolved = await realpath(path.join(root, file));
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('File is outside the configured project.');
    return this.enqueue({ action, file, line: action === 'editor_problem' ? diagnostic.line : 1 });
  }
  enqueue(command) {
    const id = randomUUID();
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, session: this.session, created: Date.now(), delivered: false, command: { ...command, id } }); });
  }
  close() { clearInterval(this.timer); for (const item of this.pending.values()) item.reject(new Error('Backend stopped.')); this.pending.clear(); }
}
