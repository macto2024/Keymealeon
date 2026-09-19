// Layer selection follows the precedence table in PLAN.md: an explicit operation (voice, a test run) owns the
// keys, then agent state, then test results, then ordinary editing. Every layer carries the reason it
// won, so a transition can be explained. This module is also served to a display client — no node imports.

const VOICE_IDS = { starting: ['voice_starting', 'voice_cancel'], recording: ['voice_stop', 'voice_cancel'], transcribing: ['voice_transcribing', 'voice_cancel'], ready: ['voice_insert', 'voice_review', 'voice_retry', 'voice_cancel'], error: ['voice_retry', 'voice_cancel'] };
const pad = ids => [...ids, ...Array(Math.max(0, 6 - ids.length)).fill(null)];
const name = provider => (provider === 'claude' ? 'Claude' : 'Codex');
const short = (text, limit = 60) => (typeof text === 'string' && text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

export function resolveLayer(context, page = 0) {
  const voice = context.voice || { state: 'idle', available: false };
  const editor = context.vscode || {};
  const agent = context.agent || { state: 'none', patched_files: [] };
  const tests = context.tests || { state: 'idle' };
  const mode = context.keyboard?.mode;
  const running = tests.state === 'running';
  const failed = tests.state === 'failed' && !tests.stale;
  const passed = tests.state === 'passed' && !tests.stale;
  const preferred = agent.preferred === 'claude' ? 'claude' : 'codex';
  const patched = agent.patched_files?.length ? agent.patched_files[agent.patched_files.length - 1] : null;
  // Watching the agent only works when SIX owns the terminal it runs in.
  const watch = editor.agent_terminal_open ? 'editor_agent_focus' : 'editor_focus';

  if (VOICE_IDS[voice.state]) return { id: `voice_${voice.state}`, reason: `Voice capture is ${voice.state}`, ids: pad(VOICE_IDS[voice.state]) };
  if (mode === 'home') return { id: 'home', reason: `No project keys while ${context.active_app} is focused`, ids: page
    ? ['app_terminal', 'app_finder', 'view_context', 'app_chrome', 'more', 'back']
    : ['app_vscode', preferred === 'claude' ? 'app_claude' : 'app_codex', 'app_chrome', 'app_terminal', 'more', 'app_finder'] };
  if (mode === 'agent') return { id: 'agent_terminal', reason: `${name(context.keyboard?.provider || preferred)} terminal is open in VS Code`, ids: page
    ? ['editor_open', 'editor_diff', 'editor_test_output', 'git_diff', 'more', 'agent_back']
    : ['editor_agent_focus', running ? 'tests_stop' : 'run_tests', 'editor_problems', 'voice_start', 'more', 'agent_back'] };
  if (page === 2) return { id: 'project_more_2', reason: 'Additional project actions', ids: ['editor_open', 'editor_diff', 'git_log', 'view_context', 'more', 'back'] };
  if (page === 1) return { id: 'project_more_1', reason: 'Additional editor actions', ids: ['editor_terminal', 'editor_test_output', 'editor_problems', 'editor_focus', 'more', 'back'] };
  if (running) return { id: 'tests_running', reason: 'A test process is running', ids: ['test_output', 'tests_stop', 'git_diff', 'agent_launch', 'more', 'view_context'] };
  if (agent.state === 'working') return { id: 'agent_working', reason: `${name(agent.provider)} is working on: ${short(agent.last_user_message) || 'the current request'}`, ids: [watch, 'git_diff', 'editor_problems', 'test_output', 'more', 'view_context'] };
  if (agent.state === 'idle' && patched && context.git?.dirty) return { id: 'agent_review', reason: `${name(agent.provider)} finished and changed ${agent.patched_files.length} file${agent.patched_files.length === 1 ? '' : 's'}`, ids: ['editor_diff', 'run_tests', 'git_diff', 'editor_problems', 'more', 'view_context'], params: { editor_diff: { file: patched } } };
  if (failed) return { id: 'tests_failed', reason: `Tests failed with exit ${tests.exit_code}`, ids: ['run_tests', 'git_diff', 'test_output', 'agent_launch', 'more', 'view_context'] };
  if (passed) return { id: 'tests_passed', reason: 'Tests passed against the saved files', ids: ['git_diff', 'run_tests', 'test_output', 'agent_launch', 'more', 'view_context'] };
  return { id: 'project', reason: tests.stale ? 'Source changed since the last test run' : 'Editing the connected project', ids: ['run_tests', 'git_diff', 'test_output', 'agent_launch', 'more', 'view_context'] };
}

// Why a key cannot be pressed right now. A key with a reason is shown disabled with that reason, never
// hidden and never silently non-functional.
function unavailable(id, context, params) {
  const editor = context.vscode || {};
  const voice = context.voice || { state: 'idle', available: false };
  const agent = context.agent || {};
  if (id === 'voice_start') {
    if (!voice.available) return 'Local FFmpeg and Whisper are required for voice input.';
    if (!editor.voice_supported) return 'Reload the SIX VS Code extension to enable voice input.';
    if (!editor.agent_terminal_open) return `Open the ${name(agent.provider || agent.preferred)} terminal first.`;
  }
  if (id === 'agent_launch' || id === 'editor_agent_focus') {
    if (!editor.connected) return 'Connect the SIX VS Code extension first.';
    if (!editor.agent_terminal_supported) return 'Reload the SIX VS Code extension to enable this key.';
    if (id === 'editor_agent_focus' && !editor.agent_terminal_open) return 'No agent terminal is open. Launch one first.';
  }
  if (id.startsWith('editor_') && !editor.connected) return 'Connect the SIX VS Code extension first.';
  if (['git_diff', 'git_log', 'test_output', 'view_context', 'run_tests'].includes(id) && !editor.connected) return 'Connect the SIX VS Code extension to show results there.';
  if (['git_diff', 'git_log', 'view_context'].includes(id) && !editor.external_actions_supported) return 'Reload the SIX VS Code extension to enable this key.';
  if (id === 'run_tests') {
    if (!context.test_command_available) return 'No test command configured for this project.';
    if (editor.unsaved_files) return 'Save your VS Code files before running tests.';
  }
  if (id === 'editor_problem' && !editor.diagnostics?.length) return 'No editor diagnostics available.';
  if (['editor_open', 'editor_diff'].includes(id) && !params?.file && !editor.active_file) return 'Open a project file in VS Code first.';
  if ((id.startsWith('git_') || id === 'editor_diff') && !context.git?.available) return 'The selected project has no usable Git repository.';
  return null;
}

function present(id, context, params) {
  const agent = context.agent || {};
  const preferred = agent.preferred === 'claude' ? 'claude' : 'codex';
  const provider = name(context.keyboard?.provider || agent.provider || preferred);
  const labels = {
    editor_terminal: ['Terminal', '>_', 'Open a reusable interactive terminal in the project folder'],
    editor_test_output: ['Test Output', '≡', 'Show actual test output in the VS Code terminal'],
    editor_focus: ['VS Code', '⌘', 'Focus the active VS Code editor group'],
    editor_problems: ['Problems', '!', 'Open the VS Code Problems panel'],
    editor_open: ['Open File', '↗', 'Open the active project file in VS Code'],
    editor_diff: ['Editor Diff', '±', params?.file ? `Compare ${params.file} with Git HEAD in VS Code` : 'Compare the active file with Git HEAD in VS Code'],
    editor_problem: ['Problem', '!', 'Jump to the first editor diagnostic'],
    editor_agent_focus: [`${provider} Terminal`, '✦', `Focus the ${provider} terminal in VS Code`],
    agent_launch: [`${name(preferred)} in Terminal`, '✦', `Open or reuse interactive ${name(preferred)} in the VS Code project terminal`],
    agent_back: ['Project Keys', '↩', `Return to project keys without closing ${provider}`],
    voice_start: ['Talk to Agent', '●', `Record speech for the open ${provider} terminal`],
    voice_starting: ['Starting Mic', '◌', 'Waiting for microphone permission and audio'],
    voice_stop: ['Stop & Transcribe', '■', 'Stop recording and transcribe locally'],
    voice_transcribing: ['Transcribing', '⋯', 'Whisper is transcribing your recording'],
    voice_cancel: ['Cancel', '×', context.voice?.error || 'Discard the recording or transcript'],
    voice_insert: ['Insert in Terminal', '↗', `Insert the transcript into ${provider} without pressing Enter`],
    voice_review: ['Review Text', '≡', 'Show the transcript in the VS Code Output panel'],
    voice_retry: ['Record Again', '●', 'Discard this transcript and record again'],
    app_vscode: ['VS Code', '⌘', 'Open Visual Studio Code'],
    app_codex: ['Codex', '✦', 'Open the Codex desktop app'],
    app_claude: ['Claude', '✦', 'Open the Claude desktop app'],
    app_chrome: ['Chrome', '◎', 'Open Google Chrome'],
    app_terminal: ['Terminal', '>_', 'Open Terminal'],
    app_finder: ['Finder', '▦', 'Open Finder'],
    run_tests: ['Run Tests', '▷', params?.after ? `Run the configured tests after ${provider}'s changes` : 'Run the configured tests against saved files'],
    tests_stop: ['Stop Tests', '■', 'Cancel the active test process'],
    test_output: ['Output', '≡', 'Open actual test output in the VS Code terminal'],
    git_diff: ['Git Diff', '±', 'Run git diff in a project-scoped VS Code terminal'],
    git_log: ['Git Log', '≡', 'Inspect recent commits in a project-scoped VS Code terminal'],
    view_context: ['Context', '◎', 'Open SIX context in the VS Code Output panel'],
    more: ['More', '→', 'Show more project actions'],
    back: ['Back', '←', 'Return to the first page'],
  };
  // Every id produced by resolveLayer has an entry above. A miss is a layer/label mismatch, not a
  // runtime condition, so surface it on the key rather than rendering a blank cap.
  const [label, icon, description] = labels[id] || [id, '?', 'This key has no label definition.'];
  return { id, label, icon, description };
}

export function liveLayout(context, page = 0) {
  const layer = resolveLayer(context, page);
  return layer.ids.map(id => {
    if (!id) return null;
    const params = layer.params?.[id];
    const reason = unavailable(id, context, params);
    const action = present(id, context, params);
    return { ...action, layer: layer.id, params, disabled: Boolean(reason || ['voice_starting', 'voice_transcribing'].includes(id)), description: reason || action.description };
  });
}

export class LiveClient {
  constructor(update, connection) { this.update = update; this.connection = connection; this.generation = 0; }
  async connect() {
    const generation = ++this.generation;
    this.connection(false, 'Connecting…');
    try {
      const response = await fetch('/api/context'); if (!response.ok) throw new Error('Live backend unavailable');
      const data = await response.json(); if (generation !== this.generation) return;
      this.token = data.token; this.update(data);
      this.stream = new EventSource('/api/events');
      this.stream.onmessage = event => { if (generation !== this.generation) return; const snapshot = JSON.parse(event.data); if (snapshot.token) this.token = snapshot.token; this.connection(true, 'Connected'); this.update(snapshot); };
      this.stream.onerror = () => { if (generation === this.generation) this.connection(false, 'Disconnected — reconnecting'); };
    } catch (error) { if (generation === this.generation) this.connection(false, `${error.message}. Start npm start and reconnect.`); }
  }
  disconnect() { this.generation++; this.stream?.close(); }
  async action(id, revision, payload = {}) {
    const response = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Six-Token': this.token }, body: JSON.stringify({ id, revision, ...payload }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }
  async press(slot, revision) {
    const response = await fetch('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Six-Token': this.token }, body: JSON.stringify({ slot, revision }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error); return result;
  }
  async popupFocus(focused) {
    const response = await fetch('/api/surface/focus', { method: 'POST', keepalive: !focused, headers: { 'Content-Type': 'application/json', 'X-Six-Token': this.token }, body: JSON.stringify({ focused }) });
    if (!response.ok) throw new Error((await response.json()).error);
  }
}
