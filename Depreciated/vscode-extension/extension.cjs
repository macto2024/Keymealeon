const vscode = require('vscode');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);

function activate(ctx) {
  const output = vscode.window.createOutputChannel('SIX');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'six.connect'; status.text = '$(plug) SIX: connecting'; status.show();
  let enabled = true, busy = false, root, token, timer, debounce, previousError;
  const session = randomUUID();
  const virtual = new Map();
  let shellTerminal, agentTerminal, agentProvider, testTerminal, gitTerminal, terminalReady = false, latestTests = { state: 'idle', output: '' }, testCommand = [], codexModel, shownOutput = '', shownRun, shownState;
  const terminalWrite = new vscode.EventEmitter();
  function renderTests() {
    if (!terminalReady) return;
    const t = latestTests;
    if (shownRun !== t.run_id || !t.output.startsWith(shownOutput)) {
      terminalWrite.fire('\x1b[2J\x1b[H'); shownOutput = ''; shownState = null; shownRun = t.run_id;
      terminalWrite.fire(`SIX tests · ${root}\r\n${testCommand.join(' ')}\r\nExecution: local SIX backend. Ctrl+C stops the active run.\r\n\r\n`);
    }
    terminalWrite.fire(t.output.slice(shownOutput.length).replace(/\r?\n/g, '\r\n')); shownOutput = t.output;
    if (shownState !== t.state) { shownState = t.state; terminalWrite.fire(`\r\n[SIX: ${t.state}${t.exit_code != null ? `, exit ${t.exit_code}` : ''}]\r\n`); }
  }
  function showTests() {
    if (!testTerminal || testTerminal.exitStatus !== undefined) {
      shownRun = Symbol('new'); terminalReady = false;
      testTerminal = vscode.window.createTerminal({ name: 'SIX Tests', pty: {
        onDidWrite: terminalWrite.event,
        open() { terminalReady = true; renderTests(); },
        close() { terminalReady = false; testTerminal = null; },
        handleInput(data) {
          if (data === '\x03') request('/api/context').then(snapshot => request('/api/action', { id: 'tests_stop', revision: snapshot.context.revision })).catch(error => terminalWrite.fire(`\r\n${error.message}\r\n`));
        }
      } });
    }
    testTerminal.show(false);
  }
  function endpoint() {
    const url = new URL(vscode.workspace.getConfiguration('six').get('backendUrl'));
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('SIX requires a loopback HTTP backend URL.');
    return url;
  }
  function request(route, data) {
    return new Promise((resolve, reject) => {
      const url = new URL(route, endpoint());
      const body = data ? JSON.stringify(data) : null;
      const req = http.request(url, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', 'X-Six-Token': token || '', 'Content-Length': Buffer.byteLength(body) } : {} }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; if (text.length > 2e6) req.destroy(new Error('Backend response too large')); });
        res.on('end', () => { try { const result = JSON.parse(text); if (res.statusCode >= 400) reject(new Error(result.error)); else resolve(result); } catch (error) { reject(error); } });
      });
      req.setTimeout(4000, () => req.destroy(new Error('Backend request timed out'))); req.on('error', reject); req.end(body);
    });
  }
  function relative(uri) {
    if (!root || uri.scheme !== 'file') return null;
    const rel = path.relative(root, uri.fsPath);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.split(path.sep).includes('.git') ? rel.split(path.sep).join('/') : null;
  }
  function state() {
    const editor = vscode.window.activeTextEditor;
    const file = editor && relative(editor.document.uri);
    const diagnostics = [];
    for (const [uri, entries] of vscode.languages.getDiagnostics()) {
      const name = relative(uri); if (!name) continue;
      for (const d of entries) { if (diagnostics.length >= 50) break; diagnostics.push({ file: name, line: d.range.start.line + 1, severity: d.severity, message: d.message.slice(0, 500) }); }
    }
    return { focused: vscode.window.state.focused, active_file: file || null, language: file ? editor.document.languageId : '', has_selection: Boolean(file && !editor.selection.isEmpty), selection_lines: file && !editor.selection.isEmpty ? editor.selection.end.line - editor.selection.start.line + 1 : 0, unsaved_files: vscode.workspace.textDocuments.filter(doc => doc.isDirty && relative(doc.uri)).length, agent_terminal_supported: true, external_actions_supported: true, voice_supported: true, agent_terminal_open: Boolean(agentTerminal && agentTerminal.exitStatus === undefined), diagnostics };
  }
  async function execute(command) {
    if (command.action === 'editor_agent_insert' || command.action === 'editor_voice_review') {
      if (typeof command.text !== 'string' || !command.text || command.text.length > 4000 || /[\r\n\x00-\x1f\x7f]/.test(command.text)) throw new Error('Invalid voice transcript.');
      if (command.action === 'editor_voice_review') { output.appendLine(`Voice transcript · ${new Date().toLocaleString()}\n${command.text}`); output.show(false); return; }
      if (!agentTerminal || agentTerminal.exitStatus !== undefined) throw new Error('Open the SIX agent terminal before inserting the transcript.');
      agentTerminal.show(false);
      agentTerminal.sendText(command.text, false);
      return;
    }
    if (command.action === 'editor_git_diff' || command.action === 'editor_git_log') {
      gitTerminal?.dispose();
      gitTerminal = vscode.window.createTerminal({ name: 'SIX Git', cwd: root });
      gitTerminal.show(false);
      gitTerminal.sendText(command.action === 'editor_git_diff' ? 'git --no-pager diff' : 'git --no-pager log -8 --oneline', true);
      return;
    }
    if (command.action === 'editor_context') {
      const snapshot = await request('/api/context');
      const current = snapshot.context;
      output.appendLine(`SIX context · ${new Date().toLocaleString()}`);
      output.appendLine(JSON.stringify({ project: current.project, active_app: current.active_app, workflow_state: current.workflow_state, vscode: current.vscode, git: current.git, tests: { ...current.tests, output: undefined }, recent_actions: current.recent_actions }, null, 2));
      output.show(false); return;
    }
    if (command.action === 'editor_agent_launch' || command.action === 'editor_agent_focus') {
      const provider = command.provider === 'claude' ? 'claude' : 'codex';
      if (!agentTerminal || agentTerminal.exitStatus !== undefined) {
        if (command.action === 'editor_agent_focus') throw new Error('Open an agent terminal with the SIX key first.');
        // Model names come from the local backend and are restricted to one shell-safe token.
        if (provider === 'codex' && codexModel && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(codexModel)) throw new Error('Invalid configured Codex model.');
        agentProvider = provider;
        agentTerminal = vscode.window.createTerminal({ name: provider === 'claude' ? 'SIX Claude' : 'SIX Codex', cwd: root });
        agentTerminal.sendText(provider === 'claude' ? 'claude' : `codex --sandbox read-only${codexModel ? ` --model ${codexModel}` : ''}`, true);
      } else if (command.action === 'editor_agent_launch' && agentProvider !== provider) {
        throw new Error(`A SIX ${agentProvider} terminal is already open. Close it before launching ${provider}.`);
      }
      agentTerminal.show(false); return;
    }
    if (command.action === 'editor_terminal') {
      if (!shellTerminal || shellTerminal.exitStatus !== undefined) shellTerminal = vscode.window.createTerminal({ name: 'SIX Terminal', cwd: root });
      shellTerminal.show(false); return;
    }
    if (command.action === 'editor_test_output') { showTests(); return; }
    if (command.action === 'editor_focus') { await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'); return; }
    if (command.action === 'editor_problems') { await vscode.commands.executeCommand('workbench.actions.view.problems'); return; }
    if (!['editor_open', 'editor_diff', 'editor_problem'].includes(command.action)) throw new Error('Unsupported editor command.');
    if (typeof command.file !== 'string' || path.isAbsolute(command.file) || command.file.split(/[\\/]/).some(p => p === '..' || p === '.git')) throw new Error('Invalid project file.');
    const filename = await fs.realpath(path.join(root, command.file));
    const rel = path.relative(root, filename); if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('File is outside the connected workspace.');
    const uri = vscode.Uri.file(filename);
    if (command.action === 'editor_diff') {
      let baseline = '';
      // An absent HEAD or untracked file has an empty baseline; other Git errors surface.
      const options = { cwd: root, timeout: 4000, maxBuffer: 1024 * 1024 };
      const hasHead = await exec('git', ['rev-parse', '--verify', 'HEAD'], options).then(() => true, () => false);
      if (hasHead) {
        const tracked = await exec('git', ['ls-tree', '--name-only', 'HEAD', '--', rel], options);
        if (tracked.stdout.trim()) baseline = (await exec('git', ['show', `HEAD:${rel.split(path.sep).join('/')}`], options)).stdout;
      }
      const left = vscode.Uri.parse(`six-baseline:/${encodeURIComponent(command.file)}?${command.id}`);
      virtual.set(left.toString(), baseline); if (virtual.size > 30) virtual.delete(virtual.keys().next().value);
      await vscode.commands.executeCommand('vscode.diff', left, uri, `${command.file} — HEAD ↔ editor`, { preview: true });
    } else {
      const document = await vscode.workspace.openTextDocument(uri);
      const line = Math.min(document.lineCount - 1, Math.max(0, Number(command.line || 1) - 1));
      await vscode.window.showTextDocument(document, { preview: false, selection: new vscode.Range(line, 0, line, 0) });
    }
  }
  async function tick() {
    if (!enabled || busy || !vscode.workspace.isTrusted) return;
    busy = true;
    try {
      if (!token) {
        const snapshot = await request('/api/context');
        root = snapshot.context.project ? await fs.realpath(snapshot.context.project) : null;
        const folders = await Promise.all((vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file').map(f => fs.realpath(f.uri.fsPath)));
        if (root && !folders.includes(root)) throw new Error(`Open this project folder in VS Code: ${root}`);
        if (!root) root = folders[0];
        if (!root) throw new Error('Open a local project folder in VS Code.');
        token = snapshot.token;
      }
      const result = await request('/api/editor/context', { session, root, state: state() });
      latestTests = result.tests || { state: 'idle', output: '' }; testCommand = result.test_command || []; codexModel = result.codex_model; renderTests();
      status.text = '$(check) SIX: connected'; status.tooltip = root; previousError = null;
      for (const command of result.commands) {
        let error;
        try { await execute(command); } catch (e) { error = e.message; }
        await request('/api/editor/ack', { session, id: command.id, error });
      }
    } catch (error) {
      token = null; status.text = '$(warning) SIX: disconnected'; status.tooltip = error.message;
      if (previousError !== error.message) { output.appendLine(error.message); previousError = error.message; }
    } finally { busy = false; }
  }
  const schedule = () => { clearTimeout(debounce); debounce = setTimeout(tick, 200); };
  ctx.subscriptions.push(output, status, terminalWrite,
    vscode.window.onDidCloseTerminal(terminal => { if (terminal === shellTerminal) shellTerminal = null; if (terminal === gitTerminal) gitTerminal = null; if (terminal === agentTerminal) { agentTerminal = null; agentProvider = null; schedule(); } }),
    vscode.workspace.registerTextDocumentContentProvider('six-baseline', { provideTextDocumentContent: uri => virtual.get(uri.toString()) || '' }),
    vscode.commands.registerCommand('six.connect', () => { enabled = true; token = null; tick(); }),
    vscode.commands.registerCommand('six.disconnect', () => { enabled = false; token = null; status.text = '$(debug-disconnect) SIX: disconnected'; }),
    vscode.commands.registerCommand('six.openSimulator', () => vscode.env.openExternal(vscode.Uri.parse(endpoint().toString()))),
    vscode.window.onDidChangeActiveTextEditor(schedule), vscode.window.onDidChangeTextEditorSelection(schedule),
    vscode.workspace.onDidChangeTextDocument(schedule), vscode.workspace.onDidSaveTextDocument(schedule),
    vscode.workspace.onDidCloseTextDocument(schedule), vscode.languages.onDidChangeDiagnostics(schedule),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { token = null; schedule(); }),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('six')) { token = null; schedule(); } }),
    { dispose() { enabled = false; clearInterval(timer); clearTimeout(debounce); testTerminal?.dispose(); } }
  );
  timer = setInterval(tick, 1000); tick();
}
module.exports = { activate };
