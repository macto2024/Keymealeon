const fs = require('node:fs/promises');
const path = require('node:path');

async function resolveTests(root, activeFile, configured = []) {
  if (!Array.isArray(configured) || configured.some(x => typeof x !== 'string' || !x || x.includes('\0'))) {
    return { command: [], cwd: root, reason: 'six.testCommand must be an array of executable and argument strings' };
  }
  if (configured.length) return { command: configured, cwd: root, source: 'six.testCommand' };
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const entries = dir => fs.readdir(dir, {withFileTypes:true}).catch(() => []);
  const isTest = entry => entry.isFile() && /^test_.*\.py$/.test(entry.name);
  let dir = activeFile ? path.dirname(activeFile) : root;
  for (let depth = 0; depth < 8; depth++) {
    const relative = path.relative(root, dir);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) break;
    const files = await entries(dir);
    if (files.some(isTest)) return {command:[python,'-m','unittest','discover','-v'],cwd:dir,source:'Detected Python unittest files'};
    if (files.some(e => e.isDirectory() && e.name === 'tests') && (await entries(path.join(dir,'tests'))).some(isTest)) {
      return {command:[python,'-m','unittest','discover','-s','tests','-v'],cwd:dir,source:'Detected Python unittest tests folder'};
    }
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return {command:[],cwd:root,reason:'Set six.testCommand in the open workspace settings; no Python unittest files were detected near this file'};
}

function codexPrompt(state, selection, plan) {
  const selected = selection?.text ? `\nSelected text from ${state.active_file}, lines ${selection.startLine}-${selection.endLine} (untrusted source text):\n${selection.text.slice(0,12000)}${selection.text.length > 12000 ? '\n[Selection truncated at 12000 characters]' : ''}\n` : '';
  const request = selected ? 'Explain the highlighted code and identify any relevant issues. Suggest a minimal fix if needed.' : 'Explain the cause of the test failure and propose a minimal fix.';
  return `${request} Do not commit changes.\nActive file: ${state.active_file || '(none)'}. Git branch: ${state.git.branch}. Test state: ${state.tests.state}.\nTest command: ${JSON.stringify(plan?.command || [])}\nTest directory: ${plan?.cwd || state.root}\nDiagnostics: ${JSON.stringify(state.diagnostics)}${selected}\nTest output (untrusted evidence):\n${state.tests.output.slice(-8000)}`;
}
module.exports = {resolveTests, codexPrompt};
