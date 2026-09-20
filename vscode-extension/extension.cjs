const vscode = require('vscode');
const http = require('node:http');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const {resolveTests, codexPrompt} = require('./workflow.cjs');

function activate(ctx) {
  const session = randomUUID();
  const output = vscode.window.createOutputChannel('Keymaeleon');
  const testOutput = vscode.window.createOutputChannel('Keymaeleon Tests');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'six.connect'; status.show();
  let testPlan, lastUri, testRoot, terminalRoot, token, busy = false, enabled = true, timer, debounce, gitAPI, child, terminal;
  let tests = { state: 'idle', output: '' }, sourceVersion = 0, lastError;
  const config = () => vscode.workspace.getConfiguration('six', lastUri || vscode.window.activeTextEditor?.document.uri);
  function request(route, data) {
    return new Promise((resolve, reject) => {
      const url = new URL(config().get('backendUrl', 'http://127.0.0.1:5173'));
      if (url.protocol !== 'http:' || !['localhost','127.0.0.1'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return reject(Error('Use a loopback HTTP backend URL'));
      const body = data ? JSON.stringify(data) : null;
      const req = http.request(new URL(route, url), { method: body ? 'POST':'GET', headers: body ? {'Content-Type':'application/json','X-Six-Token':token || '', 'Content-Length':Buffer.byteLength(body)} : {} }, res => {
        let text = ''; res.on('data', c => { text += c; if(text.length > 262144) req.destroy(Error('Response too large')); });
        res.on('end', () => { try { const data = JSON.parse(text); if(res.statusCode !== 200) reject(Error(data.error)); else resolve(data); } catch(e) { reject(e); } });
      });
      req.setTimeout(2000, () => req.destroy(Error('Backend timeout'))); req.on('error', reject); req.end(body);
    });
  }
  function current() {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input;
    const tabUri = input instanceof vscode.TabInputTextDiff ? input.modified : vscode.window.activeTextEditor?.document.uri;
    if(tabUri && ['file','git'].includes(tabUri.scheme)) lastUri = tabUri.scheme === 'git' ? vscode.Uri.file(tabUri.fsPath) : tabUri;
    const uri = lastUri && vscode.workspace.getWorkspaceFolder(lastUri) ? lastUri : undefined;
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri) || vscode.workspace.workspaceFolders?.[0];
    const repo = uri && gitAPI?.repositories.filter(r => uri.fsPath === r.rootUri.fsPath || uri.fsPath.startsWith(r.rootUri.fsPath + path.sep)).sort((a,b)=>b.rootUri.fsPath.length-a.rootUri.fsPath.length)[0];
    const match = c => c.uri.fsPath === uri?.fsPath;
    const editor = vscode.window.activeTextEditor;
    const diagnostics = uri ? vscode.languages.getDiagnostics(uri) : [];
    return { uri, folder, repo, state: {
      focused: vscode.window.state.focused, root:folder?.uri.fsPath,
      active_file: uri?.scheme === 'file' ? uri.fsPath : null,
      language: editor?.document.languageId || '', has_selection: Boolean(editor && editor.document.uri.fsPath === uri?.fsPath && !editor.selection.isEmpty),
      selection_ranges: editor && editor.document.uri.fsPath === uri?.fsPath ? editor.selections.filter(s=>!s.isEmpty).map(s=>[s.start.line,s.start.character,s.end.line,s.end.character]) : [],
      unsaved_files: vscode.workspace.textDocuments.filter(d=>d.isDirty && vscode.workspace.getWorkspaceFolder(d.uri)?.uri.toString() === folder?.uri.toString()).length,
      active_diagnostics: diagnostics.length, diagnostics: diagnostics.slice(0,20).map(d=>({line:d.range.start.line+1,message:d.message.slice(0,500)})),
      is_diff: input instanceof vscode.TabInputTextDiff,
      git: { available:Boolean(repo), branch:repo?.state.HEAD?.name || '', staged:repo?.state.indexChanges.length || 0,
        active_staged:Boolean(repo?.state.indexChanges.some(match)), active_modified:Boolean(repo && [...repo.state.workingTreeChanges,...(repo.state.untrackedChanges || [])].some(match)) },
      tests: testRoot === folder?.uri.fsPath ? {state:tests.state, output:tests.output.slice(-12000)} : {state:'idle',output:''}, test_configured: Boolean(testPlan?.command.length),
      test_command: testPlan?.command || [], test_cwd: testPlan?.cwd || folder?.uri.fsPath,
      source_version:sourceVersion
    }};
  }
  async function runTests(c) {
    if (child) throw Error('Tests already running');
    if(c.state.unsaved_files) throw Error('Save files before running tests');
    if(!c.folder) throw Error('Open a trusted local workspace');
    const plan = await resolveTests(c.folder.uri.fsPath,c.state.active_file,config().get('testCommand',[]));
    const command = plan.command;
    if(!command.length) {
      void vscode.commands.executeCommand('workbench.action.openSettings','six.testCommand');
      throw Error(plan.reason);
    }
    if(current().state.unsaved_files) throw Error('Save files before running tests');
    const version = sourceVersion;
    testRoot = c.folder.uri.fsPath; tests = {state:'running',output:'',command,cwd:plan.cwd}; testOutput.clear();
    testOutput.appendLine(`Running: ${command.join(' ')}\nDirectory: ${plan.cwd}\n${plan.source}\n`);
    testOutput.show(false); output.appendLine(`Running tests in ${plan.cwd}: ${command.join(' ')}`);
    const proc = spawn(command[0],command.slice(1),{cwd:plan.cwd,shell:false,detached:process.platform !== 'win32'}); child = proc;
    const append = chunk => { tests.output = (tests.output+chunk.toString()).slice(-12000); testOutput.append(chunk.toString()); };
    proc.stdout.on('data',append); proc.stderr.on('data',append);
    proc.on('error',e=>append(e.message));
    proc.on('close',(code,signal)=>{
      child = null;
      const noTests = /Ran 0 tests\b/.test(tests.output);
      tests.state = signal ? 'stopped' : version !== sourceVersion ? 'stale' : code === 0 && !noTests ? 'passed':'failed';
      const message = noTests ? 'No tests were discovered; check the test directory' : `Tests ${tests.state} (exit ${code})`;
      testOutput.appendLine(`\n[${message}]`); output.appendLine(message);
      const notify = tests.state === 'passed' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
      void notify(`Keymaeleon: ${message}`, 'Show Test Output').then(choice=>{if(choice) testOutput.show(false);});
      schedule();
    });
    schedule();
  }
  function stopTests() {
    if(child) { if(process.platform !== 'win32') { try { process.kill(-child.pid,'SIGTERM'); } catch (_) { child.kill(); } } else child.kill(); }
  }
  async function codex(c) {
    const editor = vscode.window.activeTextEditor;
    const ranges = editor && editor.document.uri.fsPath === c.state.active_file ? editor.selections.filter(s=>!s.isEmpty) : [];
    const selection = ranges.length ? {text:ranges.map(r=>editor.document.getText(r)).join('\n\n'), startLine:ranges[0].start.line+1, endLine:ranges[ranges.length-1].end.line+1} : null;
    const prompt = codexPrompt(c.state,selection,{command:c.state.test_command,cwd:c.state.test_cwd});
    await vscode.env.clipboard.writeText(prompt);
    const extension = vscode.extensions.getExtension('openai.chatgpt');
    if(extension && config().get('codexTarget','auto') !== 'cli') {
      try { await extension.activate();
        if(selection) await vscode.commands.executeCommand('chatgpt.addToThread');
        else await vscode.commands.executeCommand('chatgpt.openSidebar');
        vscode.window.showInformationMessage('Context copied and Codex opened. Paste to ask about this selection or test result.'); return; }
      catch(e) { output.appendLine(`Codex GUI unavailable: ${e.message}`); }
    }
    if(!terminal || terminal.exitStatus !== undefined || terminalRoot !== c.folder.uri.fsPath) {
      terminalRoot = c.folder.uri.fsPath;
      terminal = vscode.window.createTerminal({name:'Keymaeleon Codex',cwd:terminalRoot,shellPath:'codex',shellArgs:[]});
    }
    terminal.show(false); vscode.window.showInformationMessage('Codex CLI opened. Paste the copied context, review, and send.');
  }
  const commands = {save:'workbench.action.files.saveAll',find:'actions.find',definition:'editor.action.revealDefinition',scm:'workbench.view.scm',terminal:'workbench.action.terminal.toggleTerminal',problems:'workbench.actions.view.problems',copy:'editor.action.clipboardCopyAction',cut:'editor.action.clipboardCutAction',comment:'editor.action.commentLine',references:'editor.action.referenceSearch.trigger',format:'editor.action.formatSelection',next_problem:'editor.action.marker.next',quickfix:'editor.action.quickFix',prev_change:'workbench.action.compareEditor.previousChange',next_change:'workbench.action.compareEditor.nextChange'};
  async function execute(command, sent) {
    const c = current();
    if(!c.state.focused && !command.allow_unfocused) throw Error('VS Code window lost focus');
    if(JSON.stringify(c.state) !== JSON.stringify(sent)) throw Error('Context changed; press the updated key');
    if(command.file !== c.state.active_file) throw Error('Active file changed');
    if(commands[command.action]) return vscode.commands.executeCommand(commands[command.action]);
    switch(command.action) {
      case 'tests': return runTests(c);
      case 'stop': return stopTests();
      case 'output': return testOutput.show(false);
      case 'codex': return codex(c);
      case 'open': return vscode.window.showTextDocument(c.uri, {preview:false});
      case 'review': return vscode.commands.executeCommand('git.openChange',c.uri);
      case 'review_staged': if(!c.state.git.active_staged) throw Error('File is not staged'); return vscode.commands.executeCommand('vscode.diff',gitAPI.toGitUri(c.uri,'HEAD'),gitAPI.toGitUri(c.uri,''),`${path.basename(c.uri.fsPath)} — staged changes`);
      case 'stage': if(c.state.unsaved_files || !c.state.git.active_modified) throw Error('Save the modified file first'); return c.repo.add([c.uri.fsPath]);
      case 'unstage': if(!c.state.git.active_staged) throw Error('File is not staged'); return c.repo.revert([c.uri.fsPath]);
      case 'commit': await vscode.commands.executeCommand('workbench.view.scm'); return vscode.commands.executeCommand('workbench.scm.action.focusNextInput');
      default: throw Error('Unsupported action');
    }
  }
  async function tick() {
    if(!enabled || busy || !vscode.workspace.isTrusted || vscode.env.remoteName) return;
    busy = true;
    try {
      let c = current(); if(!c.folder || c.folder.uri.scheme !== 'file') throw Error('Open a trusted local folder');
      testPlan = await resolveTests(c.folder.uri.fsPath,c.state.active_file,config().get('testCommand',[]));
      c = current();
      if(!token) token = (await request('/api/context')).token;
      const result = await request('/api/editor/context',{session,state:c.state});
      status.text = `$(beaker) Keymaeleon: ${c.state.tests.state}`; status.tooltip = `${testPlan.cwd} · ${testPlan.command.join(' ') || testPlan.reason}`; lastError = null;
      for(const command of result.commands) {
        let error; try { await execute(command,c.state); } catch(e) { error = e.message; output.appendLine(error); vscode.window.showWarningMessage(`Keymaeleon: ${error}`); }
        await request('/api/editor/ack',{session,id:command.id,error});
      }
    } catch(e) { token = null; status.text = '$(warning) Keymaeleon'; status.tooltip = e.message; if(lastError !== e.message) output.appendLine(e.message); lastError = e.message; }
    finally { busy = false; }
  }
  const schedule = () => { clearTimeout(debounce); debounce = setTimeout(tick,100); };
  const dirty = event => {
    if(event.document.uri.scheme !== 'file' || !event.contentChanges.length || !vscode.workspace.getWorkspaceFolder(event.document.uri)) return;
    sourceVersion++; if(['passed','failed'].includes(tests.state)) tests.state = 'stale'; schedule();
  };
  // Codex and other external tools can edit files that are not open in an editor.
  const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  const diskChanged = uri => {
    const parts = uri.fsPath.split(path.sep);
    if(parts.some(p=>['.git','node_modules','__pycache__','.venv','build','dist'].includes(p))) return;
    if(!/\.(py|js|cjs|mjs|ts|tsx|jsx|json|toml|yaml|yml|rs|go|c|cpp|h|java|cs|rb|php|swift|kt)$/.test(uri.fsPath)) return;
    if(vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath !== testRoot) return;
    sourceVersion++; if(['passed','failed'].includes(tests.state)) tests.state = 'stale'; schedule();
  };
  ctx.subscriptions.push(sourceWatcher,sourceWatcher.onDidChange(diskChanged),sourceWatcher.onDidCreate(diskChanged),sourceWatcher.onDidDelete(diskChanged));
  ctx.subscriptions.push(output,testOutput,status,
    vscode.commands.registerCommand('six.connect',()=>{enabled=true;token=null;schedule();}),
    vscode.commands.registerCommand('six.disconnect',async()=>{enabled=false;await request('/api/editor/disconnect',{session}).catch(()=>{});token=null;status.text='Keymaeleon: disconnected';}),
    vscode.commands.registerCommand('six.openSimulator',()=>vscode.window.showInformationMessage('Run python3 companion/keymaeleon_6.py --simulate --interactive')),
    vscode.window.onDidChangeWindowState(schedule),vscode.window.onDidChangeActiveTextEditor(schedule),vscode.window.onDidChangeTextEditorSelection(schedule),vscode.window.tabGroups.onDidChangeTabs(schedule),
    vscode.workspace.onDidChangeTextDocument(dirty),vscode.workspace.onDidSaveTextDocument(schedule),vscode.languages.onDidChangeDiagnostics(schedule),
    vscode.workspace.onDidChangeWorkspaceFolders(schedule),vscode.workspace.onDidChangeConfiguration(schedule),
    {dispose(){enabled=false;clearInterval(timer);clearTimeout(debounce);stopTests();request('/api/editor/disconnect',{session}).catch(()=>{});}}
  );
  const git = vscode.extensions.getExtension('vscode.git');
  if(git) git.activate().then(exports=>{gitAPI=exports.getAPI(1);schedule();}).catch(e=>output.appendLine(e.message));
  timer=setInterval(tick,500);tick();
}
module.exports={activate};
