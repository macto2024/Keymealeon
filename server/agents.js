import { readdir, stat, open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Coding agents append their own session transcripts to disk. Reading those logs gives SIX the
// real agent lifecycle — working, finished, which files were patched, what the user asked — without
// driving the CLI or scraping terminal output. Every fact here is reported by the agent itself.
//   Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl  (cwd in the session_meta record)
//   Claude: ~/.claude/projects/<slugged cwd>/<session>.jsonl        (cwd on every record)

const ACTIVE_MS = 15 * 60 * 1000; // a transcript untouched for longer is history, not a live session
const USAGE_MS = 14 * 24 * 60 * 60 * 1000; // lookback for the "which agent does this developer use" prior
const MAX_TAIL = 1024 * 1024; // bytes read per file per poll
const MAX_HEAD = 65536; // bytes scanned to find a transcript's cwd
const MAX_HEADS_PER_POLL = 25; // bound the first-run cost of indexing old Codex transcripts
const MAX_TEXT = 500;
const MAX_PATCHED = 20;

const clip = (value, limit = MAX_TEXT) => (typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : null);
export const claudeSlug = root => root.replace(/[^A-Za-z0-9]/g, '-');
// Agents report absolute paths. SIX can only act on files inside the selected project.
export function insideProject(root, file) {
  if (!root || typeof file !== 'string') return null;
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : null;
}

async function sortedNames(dir, limit) {
  try { return (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort((a, b) => b.localeCompare(a)).slice(0, limit); }
  catch { return []; }
}

// Codex partitions transcripts by date, so descending through year/month/day yields newest first.
async function codexDayDirs(base, limit) {
  const dirs = [];
  for (const year of await sortedNames(base, 3)) {
    for (const month of await sortedNames(path.join(base, year), 13)) {
      for (const day of await sortedNames(path.join(base, year, month), 32)) {
        dirs.push(path.join(base, year, month, day));
        if (dirs.length >= limit) return dirs;
      }
    }
  }
  return dirs;
}

async function readRange(file, start, end) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, Math.min(end - start, MAX_TAIL)));
    if (!buffer.length) return '';
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

export function emptyAgentFact() {
  return { available: false, provider: null, state: 'none', session_id: null, last_user_message: null, last_agent_message: null, last_command: null, patched_files: [], turn_started_at: null, updated_at: null, idle_seconds: null, preferred: null, usage: { codex: 0, claude: 0 }, sessions: {}, error: null };
}

export class AgentObserver {
  constructor(runtime, { home = os.homedir(), now = () => Date.now() } = {}) {
    this.runtime = runtime;
    this.codexBase = path.join(home, '.codex', 'sessions');
    this.claudeBase = path.join(home, '.claude', 'projects');
    this.now = now;
    this.cursors = new Map(); // transcript path -> { provider, cwd, offset, partial, session }
    this.roots = new Map(); // transcript path -> cwd string, or null when the head is unreadable
    this.usageScannedAt = 0;
    this.usage = { codex: 0, claude: 0 };
    runtime.agents = this;
    runtime.context.agent = emptyAgentFact();
  }

  async poll() {
    const fact = emptyAgentFact();
    let root = null;
    try { root = this.runtime.config.root ? await realpath(this.runtime.config.root) : null; } catch { root = this.runtime.config.root; }
    try {
      const files = [...await this.codexFiles(), ...await this.claudeFiles(root)];
      fact.available = files.length > 0 || Boolean(root);
      if (root) {
        let budget = MAX_HEADS_PER_POLL;
        const live = [];
        for (const entry of files) {
          if (this.now() - entry.mtimeMs > ACTIVE_MS) continue;
          const cwd = this.roots.get(entry.file) ?? (budget-- > 0 ? await this.indexRoot(entry) : undefined);
          if (cwd !== root) continue;
          live.push(await this.tail(entry));
        }
        for (const session of live.filter(Boolean)) {
          const current = fact.sessions[session.provider];
          if (!current || session.updated_at > current.updated_at) fact.sessions[session.provider] = session;
        }
        const active = Object.values(fact.sessions).sort((a, b) => b.updated_at - a.updated_at)[0];
        if (active) Object.assign(fact, {
          provider: active.provider, state: active.state, session_id: active.id,
          last_user_message: active.last_user_message, last_agent_message: active.last_agent_message,
          last_command: active.last_command, patched_files: active.patched_files.map(file => insideProject(root, file)).filter(Boolean).slice(-MAX_PATCHED),
          turn_started_at: active.turn_started_at, updated_at: new Date(active.updated_at).toISOString(),
          idle_seconds: Math.round((this.now() - active.updated_at) / 1000),
        });
        await this.scanUsage(root);
      }
    } catch (error) { fact.error = error.message; }
    fact.usage = { ...this.usage };
    fact.preferred = fact.usage.claude > fact.usage.codex ? 'claude' : fact.usage.codex > 0 ? 'codex' : null;
    // Sessions carry raw transcript text; keep them out of the published snapshot.
    const published = { ...fact, sessions: Object.fromEntries(Object.entries(fact.sessions).map(([key, value]) => [key, value.state])) };
    if (JSON.stringify(published) !== JSON.stringify(this.runtime.context.agent)) {
      this.runtime.context.agent = published;
      this.runtime.publish(published.provider ? `${published.provider} session ${published.state}` : 'Agent sessions updated');
    }
    return published;
  }

  async codexFiles() {
    const files = [];
    for (const dir of await codexDayDirs(this.codexBase, 3)) {
      for (const name of await readdir(dir).catch(() => [])) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        const info = await stat(file).catch(() => null);
        if (info?.isFile()) files.push({ provider: 'codex', file, mtimeMs: info.mtimeMs, size: info.size });
      }
    }
    return files;
  }

  async claudeFiles(root) {
    if (!root) return [];
    const dir = path.join(this.claudeBase, claudeSlug(root));
    const files = [];
    for (const name of await readdir(dir).catch(() => [])) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info?.isFile()) files.push({ provider: 'claude', file, mtimeMs: info.mtimeMs, size: info.size });
    }
    return files;
  }

  async indexRoot(entry) {
    let cwd = null;
    try {
      for (const line of (await readRange(entry.file, 0, MAX_HEAD)).split('\n')) {
        let record; try { record = JSON.parse(line); } catch { continue; }
        const value = entry.provider === 'codex' ? record?.payload?.cwd : record?.cwd;
        if (typeof value === 'string' && value) { cwd = await realpath(value).catch(() => value); break; }
      }
    } catch { cwd = null; }
    this.roots.set(entry.file, cwd);
    return cwd;
  }

  async tail(entry) {
    let cursor = this.cursors.get(entry.file);
    if (!cursor || cursor.offset > entry.size) {
      cursor = { provider: entry.provider, offset: 0, partial: '', session: { provider: entry.provider, id: path.basename(entry.file, '.jsonl'), state: 'idle', last_user_message: null, last_agent_message: null, last_command: null, patched_files: [], turn_started_at: null, updated_at: entry.mtimeMs } };
      this.cursors.set(entry.file, cursor);
    }
    if (entry.size > cursor.offset) {
      const end = Math.min(entry.size, cursor.offset + MAX_TAIL);
      const text = cursor.partial + await readRange(entry.file, cursor.offset, end);
      cursor.offset = end;
      const lines = text.split('\n');
      cursor.partial = end === entry.size ? lines.pop() : '';
      if (end !== entry.size) lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let record; try { record = JSON.parse(line); } catch { continue; }
        if (entry.provider === 'codex') reduceCodex(cursor.session, record);
        else reduceClaude(cursor.session, record);
      }
    }
    cursor.session.updated_at = entry.mtimeMs;
    return cursor.session;
  }

  async scanUsage(root) {
    if (this.now() - this.usageScannedAt < 60000) return;
    this.usageScannedAt = this.now();
    const usage = { codex: 0, claude: 0 };
    const cutoff = this.now() - USAGE_MS;
    let budget = MAX_HEADS_PER_POLL;
    for (const dir of await codexDayDirs(this.codexBase, 15)) {
      for (const name of await readdir(dir).catch(() => [])) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        const info = await stat(file).catch(() => null);
        if (!info?.isFile() || info.mtimeMs < cutoff) continue;
        const cwd = this.roots.get(file) ?? (budget-- > 0 ? await this.indexRoot({ provider: 'codex', file }) : undefined);
        if (cwd === root) usage.codex++;
      }
    }
    for (const entry of await this.claudeFiles(root)) if (entry.mtimeMs >= cutoff) usage.claude++;
    this.usage = usage;
  }
}

function reduceCodex(session, record) {
  const payload = record?.payload;
  if (!payload || record.type !== 'event_msg') return;
  if (payload.type === 'task_started') { session.state = 'working'; session.turn_started_at = record.timestamp || null; }
  else if (payload.type === 'task_complete') { session.state = 'idle'; session.last_agent_message = clip(payload.last_agent_message) || session.last_agent_message; }
  else if (payload.type === 'user_message') { session.last_user_message = clip(payload.message) || session.last_user_message; session.state = 'working'; }
  else if (payload.type === 'agent_message') session.last_agent_message = clip(payload.message) || session.last_agent_message;
  else if (payload.type === 'exec_command_end') session.last_command = { command: clip(Array.isArray(payload.command) ? payload.command.join(' ') : payload.command, 200), exit_code: Number.isInteger(payload.exit_code) ? payload.exit_code : null };
  else if (payload.type === 'patch_apply_end' && payload.success) addPatched(session, Object.keys(payload.changes || {}));
}

// Claude Code has no explicit turn-complete record. An assistant message carrying no tool_use block
// ends the turn; anything else (a tool call, or a tool result coming back) means work is in flight.
function reduceClaude(session, record) {
  if (record?.isSidechain || record?.isMeta) return;
  const content = record?.message?.content;
  const blocks = Array.isArray(content) ? content : [];
  if (record.type === 'user') {
    const file = record.toolUseResult?.filePath;
    if (typeof file === 'string') addPatched(session, [file]);
    if (blocks.some(block => block?.type === 'tool_result') || record.toolUseResult) { session.state = 'working'; return; }
    const text = typeof content === 'string' ? content : blocks.filter(block => block?.type === 'text').map(block => block.text).join(' ');
    if (clip(text)) { session.last_user_message = clip(text); session.state = 'working'; session.turn_started_at = record.timestamp || null; }
  } else if (record.type === 'assistant') {
    const call = blocks.find(block => block?.type === 'tool_use');
    if (call) {
      session.state = 'working';
      const input = call.input || {};
      if (call.name === 'Bash' && typeof input.command === 'string') session.last_command = { command: clip(input.command, 200), exit_code: null };
      if (typeof input.file_path === 'string' && ['Edit', 'Write', 'NotebookEdit'].includes(call.name)) addPatched(session, [input.file_path]);
      return;
    }
    const text = blocks.filter(block => block?.type === 'text').map(block => block.text).join(' ');
    if (clip(text)) { session.last_agent_message = clip(text); session.state = 'idle'; }
  }
}

function addPatched(session, files) {
  for (const file of files) {
    if (typeof file !== 'string' || !file) continue;
    if (!session.patched_files.includes(file)) session.patched_files.push(file);
    if (session.patched_files.length > MAX_PATCHED) session.patched_files.shift();
  }
}
